/**
 * wd2-parser-test.js - Tests for the Portable axle scale 255-D WD2 console parser
 *
 * "+00000001B" and "+00010001A" are real frames captured from the console over
 * Bluetooth (empty, and 40 kg + 60 kg weights after a completed weighing).
 */

const MobileScaleParser = require('../src/parsers/MobileScaleParser');
const { InputManager } = require('../src/input/InputManager');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

const STX = '\x02';
const ETX = '\x03';
const EMPTY_FRAME = `${STX}+00000001B${ETX}`;
const LOADED_FRAME = `${STX}+00010001A${ETX}`;

// ── Real captured frames ──────────────────────────────────────────────────────

const parser = new MobileScaleParser({ mode: 'wd2' });

const r1 = parser.parseWd2(EMPTY_FRAME);
assert(r1 !== null, 'parses captured empty frame');
assert(r1.weight === 0, `captured empty frame is 0 kg, the 1B being checksum (got ${r1?.weight})`);

const r2 = parser.parseWd2(LOADED_FRAME);
assert(r2 !== null, 'parses captured loaded frame');
assert(r2.weight === 100, `captured loaded frame is 100 kg (got ${r2?.weight})`);
assert(r2.unit === 'kg', 'unit is kg');
assert(r2.stable === true, 'reading marked as stable');
assert(r2.scaleWeightMode === 'combined', 'weight mode is combined');
assert(r2.scaleA + r2.scaleB === 100, `scaleA + scaleB === weight (got ${r2?.scaleA} + ${r2?.scaleB})`);

assert(parser.parseWd2('+00010001A')?.weight === 100, 'parses frame without STX/ETX');
assert(parser.parseWd2(Buffer.from(LOADED_FRAME, 'latin1'))?.weight === 100, 'parses Buffer input');

// ── Decimal position ──────────────────────────────────────────────────────────

// Protocol document example: +20.00 has decimal position 2 and checksum 1B
assert(parser.parseWd2(`${STX}+00200021B${ETX}`)?.weight === 20, 'decimal position scales the digits');

// ── Streaming-mode: axle counter must NOT auto-increment ──────────────────────

const streamParser = new MobileScaleParser({ mode: 'wd2' });
streamParser.parseWd2(LOADED_FRAME);
streamParser.parseWd2(EMPTY_FRAME);
streamParser.parseWd2(LOADED_FRAME);
assert(streamParser.axles.length === 0, `axles array stays empty (got ${streamParser.axles.length})`);
assert(streamParser.currentAxle === 0, `currentAxle stays 0 (got ${streamParser.currentAxle})`);

// ── Rejection of invalid / wrong-format data ──────────────────────────────────

assert(parser.parseWd2(`${STX}+00010001B${ETX}`) === null, 'rejects bad checksum');
assert(parser.parseWd2(`${STX}+00090001A${ETX}`) === null, 'rejects corrupted digit');
assert(parser.parseWd2(`${STX}-00010001A${ETX}`) === null, 'rejects corrupted sign');
assert(parser.parseWd2('ST,GS, 0000270kg') === null, 'rejects PAW format');
assert(parser.parseWd2('=SG+0000123kR') === null, 'rejects MCGS format');
assert(parser.parseWd2('$    100       0 830') === null, 'rejects Giropes format');
assert(parser.parseWd2('') === null, 'rejects empty string');
assert(parser.parseWd2(null) === null, 'rejects null');

// ── Parser plumbing ───────────────────────────────────────────────────────────

const routeParser = new MobileScaleParser({ mode: 'wd2' });
assert(routeParser.parse(LOADED_FRAME)?.weight === 100, 'parse() routes to parseWd2()');
assert(parser.validate(LOADED_FRAME), 'validate() accepts valid frame');
assert(!parser.validate('garbage'), 'validate() rejects garbage');
assert(parser.getInfo().protocol === 'Yaohua Protocol 1', `getInfo().protocol (got "${parser.getInfo().protocol}")`);
assert(parser.getInfo().mode === 'wd2', `getInfo().mode (got "${parser.getInfo().mode}")`);

// ── InputManager framing: frames have no terminator and split across chunks ───

function runChunks(chunks) {
  const seen = [];
  const manager = new InputManager();
  manager.activeSource = 'wd2';
  manager.activeParser = new MobileScaleParser({ mode: 'wd2' });
  manager.buffer = '';
  manager._parseAndEmit = (frame) => seen.push(manager.activeParser.parse(frame)?.weight);
  chunks.forEach((chunk) => manager._handleData(Buffer.from(chunk, 'latin1')));
  return { seen, buffer: manager.buffer };
}

// Same split the console produced in the capture: STX "+" then the remainder
const split = runChunks([`${STX}+`, `00010001A${ETX}`]);
assert(split.seen.length === 1 && split.seen[0] === 100, `reassembles a split frame (got ${split.seen})`);
assert(split.buffer === '', 'buffer is empty after a complete frame');

const joined = runChunks([`${EMPTY_FRAME}${LOADED_FRAME}${STX}+000`]);
assert(joined.seen.join(',') === '0,100', `extracts joined frames in order (got ${joined.seen})`);
assert(joined.buffer === `${STX}+000`, 'keeps the trailing partial frame');

// ── ParserFactory integration ─────────────────────────────────────────────────

const ParserFactory = require('../src/parsers/ParserFactory');
setTimeout(() => {
  try {
    const fp = ParserFactory.create('WD2', {});
    assert(fp.mode === 'wd2', `factory-created parser has mode "wd2" (got "${fp.mode}")`);
    assert(fp.parse(LOADED_FRAME)?.weight === 100, 'factory parser parses weight 100');
  } catch (e) {
    assert(false, `ParserFactory.create("WD2") threw: ${e.message}`);
  }

  console.log('\nAll WD2 parser tests complete.');
  process.exit();
}, 100); // wait for ParserFactory deferred registration (setImmediate)
