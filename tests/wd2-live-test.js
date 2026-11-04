/**
 * wd2-live-test.js
 *
 * Listen-only live test for the "Portable axle scale 255-D" (WD2-88888-5.0)
 * over a Bluetooth serial port. Never writes to the port.
 *
 * Decodes 12-byte Yaohua frames: STX, sign, 6 weight digits, decimal position,
 * 2 XOR checksum characters, ETX. Anything else is printed as raw bytes so the
 * Toledo and Yaohua Protocol 2 console settings can be examined as well.
 *
 * Usage:
 *   node tests/wd2-live-test.js [PORT] [BAUD] [--seconds=N] [--log=FILE]
 *
 * Defaults: COM5, 19200, runs until Ctrl+C. --log records every raw chunk with
 * its elapsed time. Console output only shows changes.
 */

const fs = require('fs');
const { SerialPort } = require('serialport');

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const option = (name) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
};

const PORT = positional[0] || 'COM5';
const BAUD = parseInt(positional[1], 10) || 19200;
const SECONDS = parseInt(option('seconds'), 10) || 0;
const LOG = option('log');
const MAX_RAW_PRINTS = 40;

const STX = 0x02;
const ETX = 0x03;

const port = new SerialPort({
  path: PORT,
  baudRate: BAUD,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  autoOpen: false
});

const startedAt = Date.now();
const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(1);

let buffer = Buffer.alloc(0);
let byteCount = 0;
let frameCount = 0;
let badChecksums = 0;
let rawPrints = 0;
let lastFrame = null;
const distinctFrames = new Map();
const seenRaw = new Set();

function decodeYaohua(body) {
  if (body.length !== 10) return null;
  const text = body.toString('latin1');
  const match = text.match(/^([+-])(\d{6})(\d)([0-9A-F]{2})$/);
  if (!match) return null;

  let xor = 0;
  for (const byte of body.subarray(0, 8)) xor ^= byte;
  const expected = xor.toString(16).toUpperCase().padStart(2, '0');

  return {
    text,
    digits: match[2],
    decimals: parseInt(match[3], 10),
    weight: (parseInt(`${match[1]}${match[2]}`, 10)) / 10 ** parseInt(match[3], 10),
    checksumOk: expected === match[4]
  };
}

function printRaw(label, bytes) {
  const key = bytes.toString('hex');
  if (seenRaw.has(key) || rawPrints >= MAX_RAW_PRINTS) return;
  seenRaw.add(key);
  rawPrints++;
  console.log(`[${elapsed()}s] ${label} hex=${key} ascii=${JSON.stringify(bytes.toString('latin1'))}`);
}

function printSummary() {
  console.log('='.repeat(60));
  console.log(`Bytes: ${byteCount}  Yaohua frames: ${frameCount}  Bad checksums: ${badChecksums}`);
  for (const [frame, count] of distinctFrames) {
    console.log(`  ${frame}  x${count}`);
  }
  console.log(`Distinct raw chunks: ${seenRaw.size}`);
  console.log('='.repeat(60));
}

function finish() {
  printSummary();
  if (port.isOpen) {
    port.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
}

console.log('='.repeat(60));
console.log('Portable axle scale 255-D (WD2) - Live Serial Test');
console.log(`Port: ${PORT}  Baud: ${BAUD}  8N1  Log: ${LOG || 'none'}`);
console.log('='.repeat(60));

port.on('data', (chunk) => {
  byteCount += chunk.length;
  if (LOG) fs.appendFileSync(LOG, `${elapsed()} ${chunk.toString('hex')}\n`);

  buffer = Buffer.concat([buffer, chunk]);
  let start;
  let end;
  while ((start = buffer.indexOf(STX)) !== -1 && (end = buffer.indexOf(ETX, start)) !== -1) {
    if (start > 0) printRaw('[OTHER]', buffer.subarray(0, start));
    const frame = buffer.subarray(start, end + 1);
    buffer = buffer.subarray(end + 1);

    const decoded = decodeYaohua(frame.subarray(1, frame.length - 1));
    if (!decoded) {
      printRaw('[OTHER FRAME]', frame);
      continue;
    }

    frameCount++;
    if (!decoded.checksumOk) badChecksums++;
    distinctFrames.set(decoded.text, (distinctFrames.get(decoded.text) || 0) + 1);
    if (decoded.text !== lastFrame) {
      lastFrame = decoded.text;
      console.log(`[${elapsed()}s] "${decoded.text}" digits=${decoded.digits} decimals=${decoded.decimals} weight=${decoded.weight} checksum=${decoded.checksumOk ? 'OK' : 'BAD'}`);
    }
  }

  // Protocols without STX framing never reach the loop above
  if (buffer.length > 0 && buffer.indexOf(STX) === -1) {
    printRaw('[RAW]', buffer);
    buffer = Buffer.alloc(0);
  } else if (buffer.length > 256) {
    printRaw('[RAW]', buffer);
    buffer = Buffer.alloc(0);
  }
});

port.on('error', (err) => {
  console.error(`[PORT ERROR] ${err.message}`);
});

process.on('SIGINT', finish);

port.open((err) => {
  if (err) {
    console.error(`[ERROR] Cannot open ${PORT}: ${err.message}`);
    console.error('  - Error 121 means the Bluetooth link timed out: check the scale is on and in range');
    console.error('  - Disconnect the tablet app and close Tera Term, as the link allows one client');
    process.exit(1);
  }
  console.log(`[OK] Port ${PORT} opened at ${BAUD} baud\n`);
  if (SECONDS > 0) setTimeout(finish, SECONDS * 1000);
});
