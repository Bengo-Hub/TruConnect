/**
 * zedem510-serial-read-test.js
 *
 * Live test: reads weight data from a Zedem 510 indicator via serial port,
 * parses multi-deck strings, and logs the formatted RDU output for each deck.
 *
 * By default this opens a REAL serial port and reads REAL indicator data.
 * Use --parser-only to skip hardware and validate the parser against example data.
 *
 * Usage:
 *   node tests/zedem510-serial-read-test.js                    # live on COM1 @ 1200 baud
 *   node tests/zedem510-serial-read-test.js COM3 9600          # live on COM3 @ 9600 baud
 *   PORT=COM4 BAUD=1200 node tests/zedem510-serial-read-test.js
 *   node tests/zedem510-serial-read-test.js --parser-only      # no hardware needed
 *
 * The script:
 *  1. Opens the serial port
 *  2. Sends 'W' query every second to prompt weight output (ZM protocol)
 *  3. Parses every response line through ZmParser
 *  4. Prints a live table of deck weights and their RDU-formatted strings
 *
 * Press Ctrl+C to stop.
 */

'use strict';

const path = require('path');

// ─── CLI args & env ─────────────────────────────────────────────────────────
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = process.argv.slice(2).filter(a => a.startsWith('--'));

const PARSER_ONLY  = flags.includes('--parser-only');
const SERIAL_PORT  = args[0] || process.env.PORT  || 'COM1';
const BAUD_RATE    = parseInt(args[1] || process.env.BAUD || '1200', 10);
const QUERY_MS     = parseInt(process.env.QUERY_MS || '1000', 10);   // query interval

// ─── RDU formatter (matches serialout.js KELI reversed format) ──────────────
function formatRdu(weightKg) {
  const str      = Math.abs(Math.round(weightKg)).toString();
  const reversed = str.split('').reverse().join('');
  const padded   = reversed.padEnd(8, '0');
  return `=${padded}=`;
}

// ─── Pretty-print deck table ─────────────────────────────────────────────────
function printDeckTable(results, rawLine) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`\n[${ts}] Raw: "${rawLine}"`);
  console.log('  ┌────────┬────────────┬────────────┬──────────┐');
  console.log('  │ Deck   │ Weight(kg) │ RDU String │ Stable   │');
  console.log('  ├────────┼────────────┼────────────┼──────────┤');
  results.forEach(r => {
    const deck   = (r.deck > 0 ? `Deck ${r.deck}` : 'GVW').padEnd(6);
    const wt     = String(r.weight).padStart(10);
    const rduStr = formatRdu(r.weight);
    const stable = r.stable !== false ? 'yes' : 'no (motion)';
    console.log(`  │ ${deck} │ ${wt} │ ${rduStr} │ ${stable.padEnd(8)} │`);
  });
  console.log('  └────────┴────────────┴────────────┴──────────┘');
}

// ─── Parser-only validation ──────────────────────────────────────────────────
function runParserOnly() {
  const ZmParser = require(path.join(__dirname, '..', 'src', 'parsers', 'ZmParser'));
  const parser = new ZmParser();

  const TEST_CASES = [
    { label: 'Zedem 510 example weights',  input: '00,    00,  1100,  1000, 2100' },
    { label: 'All-zero decks',             input: '00, 00, 00, 00, 00' },
    { label: 'Heavy loaded vehicle',       input: '5200, 4800, 3100, 2900, 16000' },
    { label: 'Single-deck ZM (GS)',        input: 'GS,     2540,kg' }
  ];

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  ZmParser — parser-only validation (no hardware)');
  console.log('══════════════════════════════════════════════════════════');

  let passed = 0, failed = 0;

  for (const tc of TEST_CASES) {
    console.log(`\n▶ ${tc.label}: "${tc.input}"`);
    const result  = parser.parse(tc.input);
    const results = Array.isArray(result) ? result : (result ? [result] : []);

    if (results.length === 0) {
      console.log('  ❌ parse returned null/empty');
      failed++;
      continue;
    }

    printDeckTable(results, tc.input);
    passed++;
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed  ${failed} failed`);
  console.log('══════════════════════════════════════════════════════════\n');
}

// ─── Live serial mode ────────────────────────────────────────────────────────
async function runLiveSerial() {
  let SerialPort;
  try {
    SerialPort = require('serialport').SerialPort;
  } catch (e) {
    console.error('❌ serialport package not found. Run: npm install serialport');
    process.exit(1);
  }

  const ZmParser = require(path.join(__dirname, '..', 'src', 'parsers', 'ZmParser'));
  const parser = new ZmParser();

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Zedem 510 — Live Serial Weight Reader');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  Port     : ${SERIAL_PORT}`);
  console.log(`  Baud     : ${BAUD_RATE} bps`);
  console.log(`  Query    : 'W' every ${QUERY_MS}ms`);
  console.log('  Press Ctrl+C to stop\n');

  const port = new SerialPort({
    path:     SERIAL_PORT,
    baudRate: BAUD_RATE,
    dataBits: 8,
    parity:   'none',
    stopBits: 1,
    autoOpen: false
  });

  port.open(err => {
    if (err) {
      console.error(`❌ Cannot open ${SERIAL_PORT}: ${err.message}`);
      console.error('   Check: port name, USB-serial driver, indicator power, cable');
      process.exit(1);
    }
    console.log(`✅ ${SERIAL_PORT} opened — waiting for indicator data...\n`);

    // Periodic weight query ('W' command for ZM protocol)
    const queryTimer = setInterval(() => {
      port.write('W', writeErr => {
        if (writeErr) console.warn(`  ⚠ Query write error: ${writeErr.message}`);
      });
    }, QUERY_MS);

    let buffer = '';
    let lastRaw = '';

    port.on('data', data => {
      buffer += data.toString();

      // Split on CR/LF — Zedem 510 terminates each line with \r\n
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop(); // keep partial last line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === lastRaw) continue; // skip duplicates / empty
        lastRaw = trimmed;

        const result  = parser.parse(trimmed);
        const results = Array.isArray(result) ? result : (result ? [result] : []);

        if (results.length === 0) {
          console.log(`  [raw] "${trimmed}" — no parse match`);
          continue;
        }

        printDeckTable(results, trimmed);
      }
    });

    port.on('error', err => {
      console.error(`❌ Serial error: ${err.message}`);
    });

    process.on('SIGINT', () => {
      clearInterval(queryTimer);
      console.log('\n  Closing serial port...');
      port.close(() => {
        console.log('  Done.\n');
        process.exit(0);
      });
    });
  });
}

// ─── Entry point ─────────────────────────────────────────────────────────────
if (PARSER_ONLY) {
  runParserOnly();
} else {
  runLiveSerial();
}
