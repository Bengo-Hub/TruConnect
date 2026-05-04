/**
 * indicator-live-test.js
 *
 * Full end-to-end live test:
 *   1. Read weight data from a real indicator (serial or TCP)
 *   2. Parse the multi-deck weight string
 *   3. Send each deck weight to its dedicated RDU via the USR IOT device (TCP)
 *
 * Supports all TruConnect indicator protocols:
 *   ZM (Zedem 510, Avery), CARDINAL, CARDINAL2, 1310, CUSTOM
 *
 * ─── Usage ──────────────────────────────────────────────────────────────────
 *
 *   node tests/indicator-live-test.js [options]
 *
 * Options (all have defaults, override with env vars or flags):
 *
 *   --protocol=ZM          ZM | CARDINAL | CARDINAL2 | 1310 | CUSTOM  (default: ZM)
 *   --input=serial         serial | tcp  (default: serial)
 *   --port=COM1            Serial COM port  (default: COM1, env: INDICATOR_PORT)
 *   --baud=1200            Baud rate        (default: 1200, env: INDICATOR_BAUD)
 *   --tcp-host=192.168.x   Indicator TCP host (for --input=tcp, env: INDICATOR_HOST)
 *   --tcp-port=4001        Indicator TCP port (default: 4001, env: INDICATOR_TCP_PORT)
 *   --usr-ip=192.168.42.200  USR device IP  (env: USR_IP)
 *   --usr-ports=20,21,22,23,24  Comma list of USR ports for deck1-4,GVW
 *   --no-rdu               Read and parse only, do not send to RDU
 *   --duration=0           Test duration in seconds (0 = run forever, Ctrl+C to stop)
 *
 * Examples:
 *   # Zedem 510 on COM1 → USR RDUs
 *   node tests/indicator-live-test.js --protocol=ZM --port=COM1 --baud=1200
 *
 *   # Zedem 510 via TCP → USR RDUs
 *   node tests/indicator-live-test.js --protocol=ZM --input=tcp --tcp-host=192.168.1.50 --tcp-port=4001
 *
 *   # Cardinal via TCP, read only (no RDU output)
 *   node tests/indicator-live-test.js --protocol=CARDINAL --input=tcp --tcp-host=192.168.1.60 --no-rdu
 *
 *   # Custom USR IP and ports
 *   node tests/indicator-live-test.js --usr-ip=192.168.42.200 --usr-ports=20,21,22,23,24
 */

'use strict';

const path = require('path');
const net  = require('net');

// ─── Parse CLI arguments ─────────────────────────────────────────────────────
function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {
    protocol:   'ZM',
    input:      'serial',
    port:       process.env.INDICATOR_PORT     || 'COM1',
    baud:       parseInt(process.env.INDICATOR_BAUD || '1200', 10),
    tcpHost:    process.env.INDICATOR_HOST     || '192.168.1.100',
    tcpPort:    parseInt(process.env.INDICATOR_TCP_PORT || '4001', 10),
    usrIp:      process.env.USR_IP             || '192.168.42.200',
    usrPorts:   [20, 21, 22, 23, 24],
    noRdu:      false,
    duration:   0
  };

  for (const arg of argv) {
    if (arg.startsWith('--protocol='))  opts.protocol  = arg.split('=')[1].toUpperCase();
    if (arg.startsWith('--input='))     opts.input     = arg.split('=')[1].toLowerCase();
    if (arg.startsWith('--port='))      opts.port      = arg.split('=')[1];
    if (arg.startsWith('--baud='))      opts.baud      = parseInt(arg.split('=')[1], 10);
    if (arg.startsWith('--tcp-host='))  opts.tcpHost   = arg.split('=')[1];
    if (arg.startsWith('--tcp-port='))  opts.tcpPort   = parseInt(arg.split('=')[1], 10);
    if (arg.startsWith('--usr-ip='))    opts.usrIp     = arg.split('=')[1];
    if (arg.startsWith('--usr-ports=')) opts.usrPorts  = arg.split('=')[1].split(',').map(Number);
    if (arg === '--no-rdu')             opts.noRdu     = true;
    if (arg.startsWith('--duration='))  opts.duration  = parseInt(arg.split('=')[1], 10);
  }

  return opts;
}

const opts = parseArgs();

// ─── Load parser ─────────────────────────────────────────────────────────────
function loadParser(protocol) {
  const map = {
    ZM:        '../src/parsers/ZmParser',
    CARDINAL:  '../src/parsers/CardinalParser',
    CARDINAL2: '../src/parsers/Cardinal2Parser',
    '1310':    '../src/parsers/I1310Parser',
    CUSTOM:    '../src/parsers/CustomParser'
  };
  const mod = map[protocol];
  if (!mod) {
    console.error(`❌ Unknown protocol: ${protocol}. Use: ZM | CARDINAL | CARDINAL2 | 1310 | CUSTOM`);
    process.exit(1);
  }
  return new (require(path.join(__dirname, mod)))();
}

// ─── Query command per protocol ───────────────────────────────────────────────
function getQueryCommand(protocol) {
  switch (protocol) {
    case 'ZM':       return Buffer.from('W');
    case 'CARDINAL': return null;                    // continuous output
    case 'CARDINAL2':
    case '1310':     return Buffer.from([0x05]);     // ENQ
    default:         return null;
  }
}

// ─── RDU formatter (reversed digits, no ×10) ─────────────────────────────────
function formatRdu(weightKg) {
  const str      = Math.abs(Math.round(weightKg)).toString();
  const reversed = str.split('').reverse().join('');
  return `=${reversed.padEnd(8, '0')}=`;
}

// ─── Per-deck weight state ────────────────────────────────────────────────────
const deckWeights = { 1: 0, 2: 0, 3: 0, 4: 0, gvw: 0 };

function updateDeckWeights(results) {
  let changed = false;
  for (const r of results) {
    if (r.deck > 0 && r.deck <= 4) {
      if (deckWeights[r.deck] !== r.weight) changed = true;
      deckWeights[r.deck] = r.weight;
    } else if (r.deck === 0) {
      if (deckWeights.gvw !== r.weight) changed = true;
      deckWeights.gvw = r.weight;   // explicit GVW from indicator
    }
  }
  // recalculate GVW if not provided explicitly
  const calcGvw = deckWeights[1] + deckWeights[2] + deckWeights[3] + deckWeights[4];
  if (deckWeights.gvw === 0 && calcGvw > 0) deckWeights.gvw = calcGvw;
  return changed;
}

// ─── Live display ─────────────────────────────────────────────────────────────
let parseCount = 0;
let sendCount  = 0;

function printStatus(rawLine) {
  parseCount++;
  const ts = new Date().toISOString().slice(11, 23);
  const gvwRdu = formatRdu(deckWeights.gvw);

  process.stdout.write('\x1B[2J\x1B[0;0H'); // clear screen
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  TruConnect — Indicator Live Test');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Protocol : ${opts.protocol}   Input: ${opts.input}   ${opts.input === 'serial' ? opts.port + ' @ ' + opts.baud + ' bps' : opts.tcpHost + ':' + opts.tcpPort}`);
  console.log(`  USR RDU  : ${opts.noRdu ? 'DISABLED (--no-rdu)' : opts.usrIp}   Parses: ${parseCount}   Sends: ${sendCount}`);
  console.log(`  Time     : ${ts}`);
  console.log(`  Raw      : "${rawLine}"`);
  console.log('──────────────────────────────────────────────────────────────');
  console.log('  Deck  │ Weight (kg) │ RDU String  │ USR Port │ Status');
  console.log('────────┼─────────────┼─────────────┼──────────┼──────────');

  const rows = [
    { label: 'Deck 1', weight: deckWeights[1], port: opts.usrPorts[0] },
    { label: 'Deck 2', weight: deckWeights[2], port: opts.usrPorts[1] },
    { label: 'Deck 3', weight: deckWeights[3], port: opts.usrPorts[2] },
    { label: 'Deck 4', weight: deckWeights[4], port: opts.usrPorts[3] },
    { label: 'GVW   ', weight: deckWeights.gvw, port: opts.usrPorts[4] }
  ];

  rows.forEach((row, i) => {
    const conn = rduConns[i];
    const st   = opts.noRdu ? '—' : (conn?.connected ? '✅ sent' : '⚠ no conn');
    console.log(`  ${row.label}│ ${String(row.weight).padStart(11)} │ ${formatRdu(row.weight)} │ ${String(row.port).padStart(8)} │ ${st}`);
  });

  console.log('══════════════════════════════════════════════════════════════');
  console.log('  Press Ctrl+C to stop');
}

// ─── USR RDU TCP connections (one per deck + GVW) ─────────────────────────────
const rduConns = [];

function setupRduConnections() {
  if (opts.noRdu) return;

  opts.usrPorts.forEach((port, i) => {
    const conn = { port, connected: false, socket: null };
    rduConns.push(conn);

    const connect = () => {
      conn.socket = new net.Socket();

      conn.socket.connect(port, opts.usrIp, () => {
        conn.connected = true;
        console.log(`  ✅ RDU ${i + 1} connected → ${opts.usrIp}:${port}`);
      });

      conn.socket.on('error', err => {
        conn.connected = false;
        console.warn(`  ⚠ RDU ${i + 1} (port ${port}) error: ${err.message} — retry in 5s`);
        setTimeout(connect, 5000);
      });

      conn.socket.on('close', () => {
        conn.connected = false;
        setTimeout(connect, 5000);
      });
    };

    connect();
  });
}

function sendToRdus() {
  if (opts.noRdu) return;

  const weights = [
    deckWeights[1], deckWeights[2], deckWeights[3], deckWeights[4], deckWeights.gvw
  ];

  weights.forEach((w, i) => {
    const conn = rduConns[i];
    if (!conn || !conn.connected || !conn.socket?.writable) return;
    const msg = formatRdu(w);
    conn.socket.write(msg, err => {
      if (!err) sendCount++;
    });
  });
}

// ─── Data handler ─────────────────────────────────────────────────────────────
let buffer = '';

function handleData(data, parser) {
  buffer += data.toString();
  const lines = buffer.split(/\r\n|\r|\n/);
  buffer = lines.pop();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const result  = parser.parse(trimmed);
    const results = Array.isArray(result) ? result : (result ? [result] : []);
    if (results.length === 0) continue;

    updateDeckWeights(results);
    sendToRdus();
    printStatus(trimmed);
  }
}

// ─── Serial input ─────────────────────────────────────────────────────────────
async function startSerial(parser) {
  let SerialPort;
  try {
    SerialPort = require('serialport').SerialPort;
  } catch (e) {
    console.error('❌ serialport package not found. Run: npm install serialport');
    process.exit(1);
  }

  const port = new SerialPort({
    path:     opts.port,
    baudRate: opts.baud,
    dataBits: 8,
    parity:   'none',
    stopBits: 1,
    autoOpen: false
  });

  return new Promise((resolve, reject) => {
    port.open(err => {
      if (err) {
        console.error(`❌ Cannot open ${opts.port}: ${err.message}`);
        console.error('   Check: port name, USB-serial adapter, indicator power, cable connection');
        process.exit(1);
      }
      console.log(`✅ Serial port ${opts.port} opened @ ${opts.baud} bps`);

      const queryCmd = getQueryCommand(opts.protocol);
      let queryTimer = null;

      if (queryCmd) {
        queryTimer = setInterval(() => {
          port.write(queryCmd, writeErr => {
            if (writeErr) console.warn(`  ⚠ Query error: ${writeErr.message}`);
          });
        }, 1000);
      } else {
        console.log('  Continuous output mode — no query command needed');
      }

      port.on('data', data => handleData(data, parser));
      port.on('error', err => console.error(`❌ Serial error: ${err.message}`));

      process.on('SIGINT', () => {
        if (queryTimer) clearInterval(queryTimer);
        console.log('\n  Closing serial port...');
        port.close(() => {
          shutdownRdus();
          process.exit(0);
        });
      });

      resolve(port);
    });
  });
}

// ─── TCP input ────────────────────────────────────────────────────────────────
async function startTcp(parser) {
  const socket = new net.Socket();

  const connect = () => {
    socket.connect(opts.tcpPort, opts.tcpHost, () => {
      console.log(`✅ TCP connected to ${opts.tcpHost}:${opts.tcpPort}`);

      const queryCmd = getQueryCommand(opts.protocol);
      let queryTimer = null;
      if (queryCmd) {
        queryTimer = setInterval(() => socket.write(queryCmd), 1000);
        socket.once('close', () => clearInterval(queryTimer));
      }
    });
  };

  socket.on('data', data => handleData(data, parser));

  socket.on('error', err => {
    console.warn(`  ⚠ Indicator TCP error: ${err.message} — retry in 5s`);
    setTimeout(connect, 5000);
  });

  socket.on('close', () => {
    console.warn('  ⚠ Indicator TCP closed — reconnecting in 5s...');
    setTimeout(connect, 5000);
  });

  process.on('SIGINT', () => {
    console.log('\n  Disconnecting...');
    socket.destroy();
    shutdownRdus();
    process.exit(0);
  });

  connect();
}

// ─── Cleanup RDU connections ──────────────────────────────────────────────────
function shutdownRdus() {
  rduConns.forEach(conn => {
    if (conn.socket) conn.socket.destroy();
  });
  console.log('  Done.\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const parser = loadParser(opts.protocol);

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  TruConnect — Indicator Full Live Test');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Protocol    : ${opts.protocol}`);
  console.log(`  Input       : ${opts.input === 'serial' ? `Serial ${opts.port} @ ${opts.baud} bps` : `TCP ${opts.tcpHost}:${opts.tcpPort}`}`);
  console.log(`  RDU output  : ${opts.noRdu ? 'DISABLED' : `USR ${opts.usrIp} ports [${opts.usrPorts.join(', ')}]`}`);
  console.log(`  Duration    : ${opts.duration > 0 ? opts.duration + 's' : 'until Ctrl+C'}`);
  console.log('══════════════════════════════════════════════════════════════\n');

  // Connect RDU outputs first so sockets are ready when first weight arrives
  setupRduConnections();

  // Brief pause to let RDU TCP connections attempt
  if (!opts.noRdu) await new Promise(r => setTimeout(r, 1000));

  // Start indicator input
  if (opts.input === 'tcp') {
    await startTcp(parser);
  } else {
    await startSerial(parser);
  }

  // Auto-stop after duration
  if (opts.duration > 0) {
    setTimeout(() => {
      console.log(`\n  Duration ${opts.duration}s reached. Stopping...`);
      shutdownRdus();
      process.exit(0);
    }, opts.duration * 1000);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
