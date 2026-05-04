/**
 * zedem510-serial-read-test.js  — SELF-CONTAINED (no project dependencies)
 *
 * Live test: reads weight data from a Zedem 510 indicator via serial port,
 * parses multi-deck strings, and logs the formatted RDU output for each deck.
 *
 * Indicator baud rate : 9600 (indicators always run at 9600)
 * RDU display baud    : 1200 (RDU panels run at 1200 — separate from indicator)
 * Query command       : ENQ 0x05 (same as working sample code)
 *
 * Usage:
 *   node zedem510-serial-read-test.js                    # live on COM1 @ 9600 baud
 *   node zedem510-serial-read-test.js COM3 9600          # live on COM3 @ 9600 baud
 *   PORT=COM4 BAUD=9600 node zedem510-serial-read-test.js
 *   node zedem510-serial-read-test.js --parser-only      # no hardware needed
 *
 * External dependencies: serialport (npm install serialport)
 * Built-ins only otherwise — no project files required.
 */

'use strict';

// ─── CLI args & env ──────────────────────────────────────────────────────────
const args        = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags       = process.argv.slice(2).filter(a => a.startsWith('--'));
const PARSER_ONLY = flags.includes('--parser-only');
const SERIAL_PORT = args[0] || process.env.PORT  || 'COM1';
const BAUD_RATE   = parseInt(args[1] || process.env.BAUD || '9600', 10);  // indicators run at 9600
const QUERY_MS    = parseInt(process.env.QUERY_MS || '1000', 10);
const QUERY_CMD   = Buffer.from([0x05]);  // ENQ byte — triggers weight output (matches working sample)

// ════════════════════════════════════════════════════════════════════════════
//  Inlined parser base class
// ════════════════════════════════════════════════════════════════════════════
class ParserInterface {
  constructor(config = {}) {
    this.config = config;
    this.name = this.constructor.name;
  }
  validate(data) { return data && data.length > 0; }
  getTerminator() { return '\r\n'; }
  extractWeight(str) {
    if (!str) return 0;
    const value = parseFloat(str.replace(/[^\d.-]/g, ''));
    return isNaN(value) ? 0 : value;
  }
  createResult(overrides = {}) {
    return {
      deck: 1, weight: 0, unit: 'kg', stable: true,
      motion: false, overload: false, underload: false,
      tare: 0, net: null, gross: null, raw: '',
      timestamp: new Date(), ...overrides
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Inlined ZmParser
// ════════════════════════════════════════════════════════════════════════════
class ZmParser extends ParserInterface {
  constructor(config = {}) {
    super(config);
    this.deckNumber = config.deck || 1;
  }

  parse(data) {
    if (!this.validate(data)) return null;
    const str = data.toString().trim();

    // Zedem 510 multi-deck: "00,    00,  1100,  1000, 2100"
    const parts = str.split(',').map(p => p.trim());
    const isMultiDeck = parts.length >= 4 && parts.every(p => /^\d+$/.test(p));
    if (isMultiDeck) return this._parseMultiDeck(parts);

    const result = this.createResult({ raw: str, deck: this.deckNumber });

    if (str.includes('OL')) { result.overload = true; result.weight = 0; return result; }
    if (str.includes('UL')) { result.underload = true; result.weight = 0; return result; }

    if (parts.length < 2) return null;
    const header = parts[0].toUpperCase();
    const value  = this.extractWeight(parts[1]);
    const unit   = parts[2] || 'kg';

    switch (header) {
      case 'GS': result.weight = value; result.gross = value; result.stable = true; break;
      case 'GU': result.weight = value; result.gross = value; result.stable = false; result.motion = true; break;
      case 'NS':
      case 'NT': result.weight = value; result.net = value; result.stable = true; break;
      case 'NU': result.weight = value; result.net = value; result.stable = false; result.motion = true; break;
      case 'TR': result.tare = value; result.weight = 0; break;
      default:   result.weight = value;
    }
    result.unit = unit.toLowerCase();
    return result;
  }

  _parseMultiDeck(parts) {
    const decks = [];
    for (let i = 0; i < 4 && i < parts.length; i++) {
      const w = parseInt(parts[i], 10);
      decks.push(this.createResult({
        deck: i + 1, weight: isNaN(w) ? 0 : w, gross: isNaN(w) ? 0 : w,
        stable: true, unit: 'kg', raw: parts[i]
      }));
    }
    return decks;
  }

  validate(data) {
    return super.validate(data) && data.toString().trim().length >= 2;
  }
}

// ─── RDU formatter ───────────────────────────────────────────────────────────
function formatRdu(weightKg) {
  // Use 8888 as default test value if weight is zero
  const displayWeight = weightKg === 0 ? 8888 : weightKg;
  const reversed = Math.abs(Math.round(displayWeight)).toString().split('').reverse().join('');
  const result = `=${reversed.padEnd(8, '0')}=`;
  const testNote = weightKg === 0 ? ' [TEST DEFAULT: 8888]' : '';
  console.log(`  → RDU format: ${weightKg} kg → ${displayWeight} kg → ${result}${testNote}`);
  return result;
}

// ─── Pretty-print deck table ──────────────────────────────────────────────────
function printDeckTable(results, rawLine) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`\n[${ts}] Raw: "${rawLine}"`);
  console.log('  ┌────────┬────────────┬────────────┬──────────┐');
  console.log('  │ Deck   │ Weight(kg) │ RDU String │ Stable   │');
  console.log('  ├────────┼────────────┼────────────┼──────────┤');
  results.forEach(r => {
    const deck   = (r.deck > 0 ? `Deck ${r.deck}` : 'GVW').padEnd(6);
    const wt     = String(r.weight).padStart(10);
    const stable = r.stable !== false ? 'yes' : 'no (motion)';
    console.log(`  │ ${deck} │ ${wt} │ ${formatRdu(r.weight)} │ ${stable.padEnd(8)} │`);
  });
  console.log('  └────────┴────────────┴────────────┴──────────┘');
}

// ─── Parser-only validation ───────────────────────────────────────────────────
function runParserOnly() {
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

// ─── Live serial mode ─────────────────────────────────────────────────────────
async function runLiveSerial() {
  let SerialPort;
  try {
    SerialPort = require('serialport').SerialPort;
  } catch (e) {
    console.error('❌ serialport package not found. Run: npm install serialport');
    process.exit(1);
  }

  const parser = new ZmParser();

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Zedem 510 — Live Serial Weight Reader');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  Port       : ${SERIAL_PORT}`);
  console.log(`  Baud       : ${BAUD_RATE} bps  (indicator serial baud — NOT the RDU baud)`);
  console.log(`  Protocol   : ZM (Zedem 510)`);
  console.log(`  Query Cmd  : ENQ 0x05 every ${QUERY_MS}ms`);
  console.log(`  RDU baud   : 1200 bps  (separate — on USR device serial port to RDU display)`);
  console.log('  Press Ctrl+C to stop\n');

  const port = new SerialPort({
    path: SERIAL_PORT, baudRate: BAUD_RATE,
    dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false
  });

  port.open(err => {
    if (err) {
      console.error(`❌ Cannot open ${SERIAL_PORT}: ${err.message}`);
      console.error('   Check: port name, USB-serial driver, indicator power, cable');
      process.exit(1);
    }
    console.log(`✅ ${SERIAL_PORT} opened @ ${BAUD_RATE} bps — waiting for indicator data...\n`);

    const queryTimer = setInterval(() => {
      port.write(QUERY_CMD, writeErr => {
        if (writeErr) console.warn(`⚠ Query write error: ${writeErr.message}`);
      });
    }, QUERY_MS);

    let buffer = '';
    let lastRaw = '';

    port.on('data', data => {
      const ts = new Date().toISOString().slice(11, 23);

      buffer += data.toString();
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop();

      for (const line of lines) {
        // Strip non-printable control chars (STX 0x02, etc.) that some indicators prepend
        const trimmed = line.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
        if (!trimmed) continue;
        if (trimmed === lastRaw) {
          console.log(`[${ts}] ↩ Duplicate line skipped: "${trimmed}"`);
          continue;
        }
        lastRaw = trimmed;

        console.log(`[${ts}] 📥 Weight string from indicator: "${trimmed}"`);

        const result  = parser.parse(trimmed);
        const results = Array.isArray(result) ? result : (result ? [result] : []);
        if (results.length === 0) {
          console.log(`[${ts}] ⚠ Parser: no match for "${trimmed}" — not a recognised ZM weight string`);
          continue;
        }

        results.forEach(r => {
          const label = r.deck > 0 ? `Deck ${r.deck}` : 'GVW';
          const rduStr = formatRdu(r.weight);
          console.log(`[${ts}] ✅ ${label}: ${r.weight} kg  →  RDU string: "${rduStr}"`);
        });

        printDeckTable(results, trimmed);
      }
    });

    port.on('error', err => console.error(`❌ Serial error: ${err.message}`));

    process.on('SIGINT', () => {
      clearInterval(queryTimer);
      console.log('\n  Closing serial port...');
      port.close(() => { console.log('  Done.\n'); process.exit(0); });
    });
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────
if (PARSER_ONLY) {
  runParserOnly();
} else {
  runLiveSerial();
}
