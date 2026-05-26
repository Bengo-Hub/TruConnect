/**
 * giropes-parser-test.js - Tests for Giropes GI620 T8 Sipi 2 parser
 */

const MobileScaleParser = require('../src/parsers/MobileScaleParser');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

// ── Basic parsing ──────────────────────────────────────────────────────────────

const parser = new MobileScaleParser({ mode: 'giropes' });

const r1 = parser.parseGiropes('$    100       0 830');
assert(r1 !== null, 'parses valid Giropes frame');
assert(r1.weight === 100, `gross weight is first numeric field: 100 (got ${r1?.weight})`);
assert(r1.stable === true, 'reading marked as stable');
assert(r1.unit === 'kg', 'unit is kg');
assert(r1.scaleWeightMode === 'combined', 'weight mode is combined');
assert(r1.scaleA === 50, `scaleA = weight/2 = 50 (got ${r1?.scaleA})`);
assert(r1.scaleB === 50, `scaleB = weight - scaleA = 50 (got ${r1?.scaleB})`);

// Different weight in first field — second/third fields must not interfere
const r2 = parser.parseGiropes('$    640       0 830');
assert(r2 !== null, 'parses frame with weight 640');
assert(r2.weight === 640, `first numeric field extracted as 640 (got ${r2?.weight})`);
assert(r2.scaleA === 320, `scaleA = 320 (got ${r2?.scaleA})`);
assert(r2.scaleB === 320, `scaleB = 320 (got ${r2?.scaleB})`);

// Odd weight — scaleA/scaleB must sum exactly to weight
const r3 = parser.parseGiropes('$    101       0 830');
assert(r3 !== null, 'parses odd weight');
assert(r3.weight === 101, `weight is 101 (got ${r3?.weight})`);
assert(r3.scaleA + r3.scaleB === 101, `scaleA + scaleB === weight (got ${r3?.scaleA} + ${r3?.scaleB})`);

// Zero weight (unloaded scale) — valid reading
const r4 = parser.parseGiropes('$      0       0 830');
assert(r4 !== null, 'parses zero weight frame');
assert(r4.weight === 0, `zero weight passes through (got ${r4?.weight})`);

// ── Streaming-mode: axle counter must NOT auto-increment ───────────────────────
// Giropes is a continuous-stream device; the frontend/user triggers axle capture.
// Weight readings must never auto-push into the axles array.

const streamParser = new MobileScaleParser({ mode: 'giropes' });
streamParser.parseGiropes('$    200       0 830');
streamParser.parseGiropes('$    400       0 830');
streamParser.parseGiropes('$    600       0 830');
assert(streamParser.axles.length === 0,
  `streaming mode: axles array stays empty after 3 different readings (got ${streamParser.axles.length})`);
assert(streamParser.currentAxle === 0,
  `streaming mode: currentAxle stays 0 (got ${streamParser.currentAxle})`);

// ── Rejection of invalid / wrong-format data ──────────────────────────────────

assert(parser.parseGiropes('ST,GS, 0000270kg') === null, 'rejects PAW format');
assert(parser.parseGiropes('=SG+0000123kR') === null, 'rejects MCGS format');
assert(parser.parseGiropes('') === null, 'rejects empty string');
assert(parser.parseGiropes(null) === null, 'rejects null');
assert(parser.parseGiropes('some random text') === null, 'rejects unrelated text');

// Out-of-range weight (> 100000 kg)
assert(parser.parseGiropes('$ 999999       0 830') === null, 'rejects weight > 100000');

// ── Route through parse() ─────────────────────────────────────────────────────

const routeParser = new MobileScaleParser({ mode: 'giropes' });
const r5 = routeParser.parse('$    100       0 830');
assert(r5 !== null, 'parse() routes to parseGiropes()');
assert(r5.weight === 100, `parse() returns correct weight (got ${r5?.weight})`);

// ── validate() ───────────────────────────────────────────────────────────────

assert(parser.validate('$    100       0 830'), 'validate() accepts valid Giropes frame');
assert(!parser.validate('garbage'), 'validate() rejects garbage');
assert(!parser.validate('=SG+0000123kR'), 'validate() rejects MCGS frame');

// ── getTerminator() ──────────────────────────────────────────────────────────

assert(parser.getTerminator() === '\n\r', 'getTerminator() returns LF+CR (Giropes Sipi 2 sends reversed terminator)');

// ── getInfo() ────────────────────────────────────────────────────────────────

const info = parser.getInfo();
assert(info.protocol === 'Giropes Sipi 2', `getInfo().protocol = "Giropes Sipi 2" (got "${info.protocol}")`);
assert(info.mode === 'giropes', `getInfo().mode = "giropes" (got "${info.mode}")`);

// ── ParserFactory integration ─────────────────────────────────────────────────

const ParserFactory = require('../src/parsers/ParserFactory');
setTimeout(() => {
  try {
    const fp = ParserFactory.create('GIROPES', {});
    assert(fp !== null, 'ParserFactory.create("GIROPES") returns a parser');
    assert(fp.mode === 'giropes', `factory-created parser has mode "giropes" (got "${fp.mode}")`);
    const fr = fp.parse('$    100       0 830');
    assert(fr !== null && fr.weight === 100, `factory parser correctly parses weight 100 (got ${fr?.weight})`);
  } catch (e) {
    assert(false, `ParserFactory.create("GIROPES") threw: ${e.message}`);
  }

  console.log('\nAll Giropes parser tests complete.');
}, 100); // wait for ParserFactory deferred registration (setImmediate)
