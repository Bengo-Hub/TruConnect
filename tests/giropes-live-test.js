/**
 * giropes-live-test.js
 *
 * Self-contained live test for the Giropes GI620 T8 on a real serial port.
 * Logs raw bytes, parsed weight, and any parser rejections.
 *
 * Usage:
 *   node tests/giropes-live-test.js [PORT] [BAUD]
 *
 * Defaults: COM3, 9600
 *
 * Press Ctrl+C to stop.
 */

const { SerialPort } = require('serialport');
const MobileScaleParser = require('../src/parsers/MobileScaleParser');

const PORT  = process.argv[2] || 'COM3';
const BAUD  = parseInt(process.argv[3], 10) || 9600;

const parser = new MobileScaleParser({ mode: 'giropes' });

console.log('='.repeat(60));
console.log(`Giropes GI620 T8 - Live Serial Test`);
console.log(`Port: ${PORT}  Baud: ${BAUD}  8N1  Continuous`);
console.log('='.repeat(60));
console.log('Waiting for data... (Ctrl+C to stop)\n');

const port = new SerialPort({
  path: PORT,
  baudRate: BAUD,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  autoOpen: false
});

let chunkCount = 0;
let buffer = '';
let frameCount = 0;
let parsedCount = 0;
let rejectedCount = 0;

port.open((err) => {
  if (err) {
    console.error(`[ERROR] Cannot open ${PORT}: ${err.message}`);
    console.error('  - Check the port name (e.g. COM2, COM3, COM4)');
    console.error('  - Make sure no other program (PuTTY, TruConnect) is using the port');
    process.exit(1);
  }
  console.log(`[OK] Port ${PORT} opened at ${BAUD} baud\n`);
});

port.on('data', (chunk) => {
  chunkCount++;
  buffer += chunk.toString('latin1');

  // Giropes Sipi 2 terminator: LF then CR (\n\r = 0x0a 0x0d)
  const TERM = '\n\r';
  let idx;
  while ((idx = buffer.indexOf(TERM)) !== -1) {
    const frame = buffer.substring(0, idx);
    buffer = buffer.substring(idx + TERM.length);
    frameCount++;

    if (!frame.trim()) continue;

    const result = parser.parseGiropes(frame);
    if (result) {
      parsedCount++;
      console.log(`[FRAME #${frameCount}] "${frame.trim()}"  =>  weight: ${result.weight} kg  scaleA: ${result.scaleA} kg  scaleB: ${result.scaleB} kg`);
    } else {
      rejectedCount++;
      const nums = frame.match(/\d+/g);
      console.log(`[FRAME #${frameCount}] "${frame.trim()}"  =>  REJECTED (nums: [${nums ? nums.join(', ') : 'none'}])`);
    }
  }
});

port.on('error', (err) => {
  console.error(`[PORT ERROR] ${err.message}`);
});

port.on('close', () => {
  console.log(`\nPort closed.`);
  printSummary();
});

process.on('SIGINT', () => {
  console.log('\nStopping...');
  port.close(() => {
    printSummary();
    process.exit(0);
  });
});

function printSummary() {
  console.log('='.repeat(60));
  console.log(`Total chunks received: ${chunkCount}`);
  console.log('='.repeat(60));
}
