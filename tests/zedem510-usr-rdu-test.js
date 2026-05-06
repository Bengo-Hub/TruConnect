/**
 * zedem510-usr-rdu-test.js
 *
 * Sends Zedem 510 deck weights to RDU displays via the USR IOT device
 * (TCP Server mode). Opens one TCP connection per deck/GVW and continuously
 * sends the formatted weight string.
 *
 * USR device: 192.168.42.200
 *   Port1 (RDU1 – deck1) → TCP port 20
 *   Port2 (RDU2 – deck2) → TCP port 21
 *   Port3 (RDU3 – deck3) → TCP port 22
 *   Port4 (RDU4 – deck4) → TCP port 23
 *   Port5 (RDU5 – GVW)   → TCP port 24
 *
 * Example input: "00,    00,  1100,  1000, 2100"
 *   deck1=0  → =00000000= → port 20
 *   deck2=0  → =00000000= → port 21
 *   deck3=1100 → =00110000= → port 22
 *   deck4=1000 → =00010000= → port 23
 *   GVW =2100 → =00120000= → port 24
 *
 * Usage:
 *   node tests/zedem510-usr-rdu-test.js
 *
 * Override USR IP or ports via env:
 *   USR_IP=192.168.42.200 node tests/zedem510-usr-rdu-test.js
 */

'use strict';

const net = require('net');

// ─── Config ────────────────────────────────────────────────────────────────
const USR_IP      = process.env.USR_IP || '192.168.42.200';
const SEND_INTERVAL_MS = 500;  // send weight every 500ms (matches sample code)
const TEST_DURATION_MS = 30000; // run for 30 seconds then exit

// Example Zedem 510 weight string: "00,    00,  1100,  1000, 2100"
const EXAMPLE_WEIGHTS = {
  deck1: 0,
  deck2: 0,
  deck3: 1100,
  deck4: 1000,
  gvw:   2100
};

const PANELS = [
  { label: 'deck1', deckKey: 'deck1', usrPort: 20 },
  { label: 'deck2', deckKey: 'deck2', usrPort: 21 },
  { label: 'deck3', deckKey: 'deck3', usrPort: 22 },
  { label: 'deck4', deckKey: 'deck4', usrPort: 23 },
  { label: 'GVW',   deckKey: 'gvw',   usrPort: 24 }
];

// ─── Format (matches mygetinverse / serialout.js formatMessage with KELI) ──
function formatRdu(weightKg) {
  // Use 8888 as default test value if weight is zero
  const displayWeight = weightKg === 0 ? 8888 : weightKg;
  const str      = Math.abs(Math.round(displayWeight)).toString();
  const reversed = str.split('').reverse().join('');
  const padded   = reversed.padEnd(8, '0');
  const result = `=${padded}=`;
  const testNote = weightKg === 0 ? ' [TEST DEFAULT: 8888]' : '';
  return result;
}

// ─── Connection state ───────────────────────────────────────────────────────
const connections = PANELS.map(p => ({
  ...p,
  socket: null,
  connected: false,
  sendCount: 0,
  errorCount: 0
}));

function connectPanel(conn) {
  conn.socket = new net.Socket();

  conn.socket.connect(conn.usrPort, USR_IP, () => {
    conn.connected = true;
    console.log(`  ✅ [${conn.label}] connected to ${USR_IP}:${conn.usrPort}`);
  });

  conn.socket.on('error', err => {
    conn.connected = false;
    conn.errorCount++;
    console.warn(`  ⚠ [${conn.label}] error (${USR_IP}:${conn.usrPort}): ${err.message}`);
    // Reconnect after 5s
    setTimeout(() => connectPanel(conn), 5000);
  });

  conn.socket.on('close', () => {
    if (conn.connected) {
      console.warn(`  ⚠ [${conn.label}] disconnected from ${USR_IP}:${conn.usrPort}`);
    }
    conn.connected = false;
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  Zedem 510 → USR RDU Output Test');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  USR Device : ${USR_IP}`);
console.log(`  Send rate  : every ${SEND_INTERVAL_MS}ms`);
console.log(`  Duration   : ${TEST_DURATION_MS / 1000}s`);
console.log('\n  Input weights (from Zedem 510 example):');
console.log('  "00,    00,  1100,  1000, 2100"');
console.log('\n  Formatted RDU strings (with test defaults):');
PANELS.forEach(p => {
  const w = EXAMPLE_WEIGHTS[p.deckKey];
  const displayW = w === 0 ? 8888 : w;
  const testNote = w === 0 ? ' [TEST DEFAULT: 8888]' : '';
  console.log(`    ${p.label.padEnd(6)} (port ${p.usrPort})  weight=${String(w).padStart(5)}kg → ${String(displayW).padStart(5)}kg  →  ${formatRdu(w)}${testNote}`);
});
console.log('\n  Connecting to USR device...');

// Open all connections
connections.forEach(connectPanel);

// Start sending loop
const sendTimer = setInterval(() => {
  connections.forEach(conn => {
    if (!conn.connected || !conn.socket?.writable) return;

    const weight  = EXAMPLE_WEIGHTS[conn.deckKey];
    const displayWeight = weight === 0 ? 8888 : weight;
    const message = formatRdu(weight);
    const ts = new Date().toISOString().slice(11, 23);

    conn.socket.write(message, err => {
      if (err) {
        console.error(`  ✗ [${conn.label}] write error: ${err.message}`);
        conn.errorCount++;
      } else {
        conn.sendCount++;
        if (conn.sendCount === 1 || conn.sendCount % 20 === 0) {
          // Log first send and then every 10 seconds
          const testNote = weight === 0 ? ' [TEST DEFAULT: 8888]' : '';
          console.log(`[${ts}] 📤 [${conn.label}] port ${conn.usrPort}  weight: ${weight} kg → ${displayWeight} kg  →  "${message}"${testNote}  (count: ${conn.sendCount})`);
        }
      }
    });
  });
}, SEND_INTERVAL_MS);

// Status report every 5 seconds
const statusTimer = setInterval(() => {
  console.log('\n  ── Status ───────────────────────────────────────');
  connections.forEach(conn => {
    const state = conn.connected ? '✅ connected' : '❌ disconnected';
    console.log(`    [${conn.label.padEnd(6)}] port ${conn.usrPort}  ${state}  sends=${conn.sendCount}  errors=${conn.errorCount}`);
  });
  console.log('');
}, 5000);

// Graceful shutdown
function shutdown() {
  console.log('\n  Shutting down...');
  clearInterval(sendTimer);
  clearInterval(statusTimer);
  connections.forEach(conn => {
    if (conn.socket) {
      conn.socket.destroy();
    }
  });
  console.log('  Done.\n');
  process.exit(0);
}

setTimeout(shutdown, TEST_DURATION_MS);
process.on('SIGINT', shutdown);
