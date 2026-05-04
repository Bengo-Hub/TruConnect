/**
 * indicator-live-test.js  — SELF-CONTAINED (no project dependencies)
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
 *   node indicator-live-test.js [options]
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
 *   node indicator-live-test.js --protocol=ZM --port=COM1 --baud=1200
 *   node indicator-live-test.js --protocol=ZM --input=tcp --tcp-host=192.168.1.50 --tcp-port=4001
 *   node indicator-live-test.js --protocol=CARDINAL --input=tcp --tcp-host=192.168.1.60 --no-rdu
 *
 * External dependencies: serialport (npm install serialport) — only for serial input.
 * Built-ins only otherwise — no project files required.
 */

'use strict';

const net = require('net');

// ─── CLI arguments ────────────────────────────────────────────────────────────
function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {
    protocol: 'ZM',
    input:    'serial',
    port:     process.env.INDICATOR_PORT     || 'COM1',
    baud:     parseInt(process.env.INDICATOR_BAUD || '1200', 10),
    tcpHost:  process.env.INDICATOR_HOST     || '192.168.1.100',
    tcpPort:  parseInt(process.env.INDICATOR_TCP_PORT || '4001', 10),
    usrIp:    process.env.USR_IP             || '192.168.42.200',
    usrPorts: [20, 21, 22, 23, 24],
    noRdu:    false,
    duration: 0
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
//  Inlined ZmParser  (Avery Weigh-Tronix ZM / Zedem 510)
// ════════════════════════════════════════════════════════════════════════════
class ZmParser extends ParserInterface {
  constructor(config = {}) {
    super(config);
    this.deckNumber = config.deck || 1;
  }

  parse(data) {
    if (!this.validate(data)) return null;
    const str = data.toString().trim();

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

// ════════════════════════════════════════════════════════════════════════════
//  Inlined CardinalParser  (fixed 90-char protocol)
// ════════════════════════════════════════════════════════════════════════════
class CardinalParser extends ParserInterface {
  constructor(config = {}) {
    super(config);
    this.fields = config.fields || {
      deck1:  { start: 10, length: 10 },
      deck2:  { start: 20, length: 10 },
      deck3:  { start: 30, length: 10 },
      deck4:  { start: 40, length: 10 },
      total:  { start: 50, length: 10 },
      status: { start: 60, length: 10 },
      unit:   { start: 70, length: 5  }
    };
    this.messageLength = config.messageLength || 90;
  }

  extractField(str, field) {
    if (!field || str.length < field.start + field.length) return '';
    return str.substring(field.start, field.start + field.length).trim();
  }

  parse(data) {
    if (!this.validate(data)) return null;
    const str = data.toString();
    const raw = str.trim();
    const results = [];

    const deckWeights = [
      this.extractField(str, this.fields.deck1),
      this.extractField(str, this.fields.deck2),
      this.extractField(str, this.fields.deck3),
      this.extractField(str, this.fields.deck4)
    ];
    const totalWeight = this.extractField(str, this.fields.total);
    const status = this.extractField(str, this.fields.status);
    const unit = this.extractField(str, this.fields.unit) || 'kg';

    const motion    = status.includes('M') || status.includes('U');
    const overload  = status.includes('O');
    const underload = status.includes('-') && !motion;

    for (let i = 0; i < 4; i++) {
      const weight = this.extractWeight(deckWeights[i]);
      if (weight !== 0 || i === 0) {
        results.push(this.createResult({
          deck: i + 1, weight, gross: weight,
          unit: unit.toLowerCase().trim(),
          stable: !motion, motion, overload, underload, raw
        }));
      }
    }

    const gvw = this.extractWeight(totalWeight);
    if (gvw > 0) {
      results.push(this.createResult({
        deck: 0, weight: gvw, gross: gvw,
        unit: unit.toLowerCase().trim(),
        stable: !motion, motion, raw
      }));
    }

    return results.length === 1 ? results[0] : results;
  }

  validate(data) {
    return super.validate(data) && data.toString().length >= this.messageLength * 0.8;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Inlined Cardinal2Parser  (per-deck message: D1: YYYY kg S)
// ════════════════════════════════════════════════════════════════════════════
class Cardinal2Parser extends ParserInterface {
  constructor(config = {}) {
    super(config);
    this.patterns = {
      deck:  /D(\d):\s*([\d.]+)\s*(\w+)?\s*([SMOU])?/i,
      gvw:   /GVW:\s*([\d.]+)\s*(\w+)?\s*([SMOU])?/i,
      total: /TOTAL:\s*([\d.]+)\s*(\w+)?\s*([SMOU])?/i
    };
  }

  parse(data) {
    if (!this.validate(data)) return null;
    const str = data.toString().trim();

    let match = str.match(this.patterns.deck);
    if (match) {
      const status = (match[4] || 'S').toUpperCase();
      return this.createResult({
        deck: parseInt(match[1], 10),
        weight: this.extractWeight(match[2]),
        gross:  this.extractWeight(match[2]),
        unit:   (match[3] || 'kg').toLowerCase(),
        stable: status === 'S', motion: status === 'M',
        overload: status === 'O', underload: status === 'U',
        raw: str
      });
    }

    match = str.match(this.patterns.gvw) || str.match(this.patterns.total);
    if (match) {
      const status = (match[3] || 'S').toUpperCase();
      return this.createResult({
        deck: 0, weight: this.extractWeight(match[1]),
        gross: this.extractWeight(match[1]),
        unit:  (match[2] || 'kg').toLowerCase(),
        stable: status === 'S', motion: status === 'M', raw: str
      });
    }

    return null;
  }

  validate(data) {
    return super.validate(data) && /D\d:|GVW:|TOTAL:/i.test(data.toString().trim());
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Inlined I1310Parser  (Scale No: X  Weight: YYYY kg)
// ════════════════════════════════════════════════════════════════════════════
class I1310Parser extends ParserInterface {
  constructor(config = {}) {
    super(config);
    this.patterns = {
      full:  /Scale\s*No[:\s]*(\d+)\s*Weight[:\s]*([\d.]+)\s*(\w+)?\s*(Stable|Motion|OL|UL)?/i,
      short: /^(\d+)[:\s]+([\d.]+)\s*(\w+)?/,
      total: /Total\s*Weight[:\s]*([\d.]+)\s*(\w+)?/i
    };
  }

  parse(data) {
    if (!this.validate(data)) return null;
    const str = data.toString().trim();

    let match = str.match(this.patterns.full);
    if (match) {
      const status = (match[4] || 'Stable').toLowerCase();
      return this.createResult({
        deck: parseInt(match[1], 10),
        weight: this.extractWeight(match[2]),
        gross:  this.extractWeight(match[2]),
        unit:   (match[3] || 'kg').toLowerCase(),
        stable: status === 'stable', motion: status === 'motion',
        overload: status === 'ol', underload: status === 'ul',
        raw: str
      });
    }

    match = str.match(this.patterns.short);
    if (match) {
      return this.createResult({
        deck: parseInt(match[1], 10),
        weight: this.extractWeight(match[2]),
        gross:  this.extractWeight(match[2]),
        unit:   (match[3] || 'kg').toLowerCase(),
        stable: true, raw: str
      });
    }

    match = str.match(this.patterns.total);
    if (match) {
      return this.createResult({
        deck: 0, weight: this.extractWeight(match[1]),
        gross: this.extractWeight(match[1]),
        unit:  (match[2] || 'kg').toLowerCase(),
        stable: true, raw: str
      });
    }

    return null;
  }

  validate(data) {
    return super.validate(data) &&
      /Scale\s*No|^\d+[:\s]+[\d.]+|Total\s*Weight/i.test(data.toString().trim());
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Inlined CustomParser  (delimiter / regex / fixed / json)
// ════════════════════════════════════════════════════════════════════════════
class CustomParser extends ParserInterface {
  constructor(config = {}) {
    super(config);
    this.mode            = config.mode || 'delimiter';
    this.protocolName    = config.name || 'Custom Protocol';
    this.regexConfig     = config.regex     || {};
    this.delimiterConfig = config.delimiter || { separator: ',', fields: { weight: 0 } };
    this.fixedConfig     = config.fixed     || {};
    this.jsonConfig      = config.json      || { paths: { weight: 'weight' } };
    this.multiDeckConfig = config.multiDeck || { enabled: false };
    this.defaults        = config.defaults  || { deck: 1, unit: 'kg' };
    this.statusMap = config.statusMap || {
      'S': 'stable', 'M': 'motion', 'O': 'overload', 'U': 'underload',
      'stable': 'stable', 'motion': 'motion'
    };
    this.terminator = config.terminator || '\r\n';
    if (this.mode === 'regex' && this.regexConfig.pattern) {
      this.compiledRegex = new RegExp(this.regexConfig.pattern, 'i');
    }
  }

  parse(data) {
    if (!this.validate(data)) return null;
    const str = data.toString().trim();
    if (this.multiDeckConfig.enabled && this.mode === 'delimiter') return this.parseMultiDeck(str);
    switch (this.mode) {
      case 'regex':     return this.parseRegex(str);
      case 'delimiter': return this.parseDelimiter(str);
      case 'fixed':     return this.parseFixed(str);
      case 'json':      return this.parseJson(str);
      default:          return null;
    }
  }

  parseMultiDeck(str) {
    const sep       = this.multiDeckConfig.separator || this.delimiterConfig.separator || ',';
    const deckCount = this.multiDeckConfig.deckCount || 4;
    const start     = this.multiDeckConfig.startIndex || 0;
    const unit      = this.multiDeckConfig.unit || this.defaults.unit || 'kg';
    const parts     = str.split(sep).map(p => p.trim());
    const results   = [];
    for (let i = 0; i < deckCount; i++) {
      const idx = start + i;
      if (idx >= parts.length) break;
      const w = this.extractWeight(parts[idx]);
      results.push(this.createResult({ deck: i + 1, weight: w, gross: w, stable: true, unit, raw: str }));
    }
    return results.length > 0 ? results : null;
  }

  parseRegex(str) {
    if (!this.compiledRegex) return null;
    const match = str.match(this.compiledRegex);
    if (!match) return null;
    const groups = this.regexConfig.groups || { weight: 1 };
    return this.buildResult({
      weight: groups.weight ? this.extractWeight(match[groups.weight]) : 0,
      unit:   groups.unit   ? match[groups.unit]               : this.defaults.unit,
      deck:   groups.deck   ? parseInt(match[groups.deck], 10) : this.defaults.deck,
      status: groups.status ? match[groups.status]             : 'stable'
    }, str);
  }

  parseDelimiter(str) {
    const { separator, fields, skipLines } = this.delimiterConfig;
    let line = str;
    if (skipLines > 0) { const lines = str.split(/\r?\n/); line = lines[skipLines] || lines[0]; }
    const parts = line.split(separator).map(p => p.trim());
    return this.buildResult({
      weight: fields.weight !== undefined ? this.extractWeight(parts[fields.weight]) : 0,
      unit:   fields.unit   !== undefined ? parts[fields.unit]                       : this.defaults.unit,
      deck:   fields.deck   !== undefined ? parseInt(parts[fields.deck], 10)         : this.defaults.deck,
      status: fields.status !== undefined ? parts[fields.status]                     : 'stable'
    }, str);
  }

  parseFixed(str) {
    const ex = { weight: 0, unit: this.defaults.unit, deck: this.defaults.deck, status: 'stable' };
    for (const [field, pos] of Object.entries(this.fixedConfig)) {
      if (pos && pos.start !== undefined && pos.length) {
        const value = str.substring(pos.start, pos.start + pos.length).trim();
        if (field === 'weight') ex.weight = this.extractWeight(value);
        else if (field === 'unit')   ex.unit   = value || this.defaults.unit;
        else if (field === 'deck')   ex.deck   = parseInt(value, 10) || this.defaults.deck;
        else if (field === 'status') ex.status = value || 'stable';
      }
    }
    return this.buildResult(ex, str);
  }

  parseJson(str) {
    try {
      const json = JSON.parse(str);
      const paths = this.jsonConfig.paths || { weight: 'weight' };
      const getPath = (obj, path) => path ? path.split('.').reduce((o, k) => (o || {})[k], obj) : undefined;
      const ex = {
        weight: this.extractWeight(String(getPath(json, paths.weight) || 0)),
        unit:   getPath(json, paths.unit)   || this.defaults.unit,
        deck:   parseInt(getPath(json, paths.deck) || this.defaults.deck, 10) || 1,
        status: getPath(json, paths.status) || 'stable'
      };
      return this.buildResult(ex, str);
    } catch (e) { return null; }
  }

  buildResult(extracted, raw) {
    const status = this.normalizeStatus(extracted.status);
    return this.createResult({
      deck: extracted.deck || 1,
      weight: extracted.weight, gross: extracted.weight,
      unit: (extracted.unit || 'kg').toLowerCase(),
      stable: status === 'stable', motion: status === 'motion',
      overload: status === 'overload', underload: status === 'underload',
      raw
    });
  }

  normalizeStatus(status) {
    if (!status) return 'stable';
    const norm = String(status).trim().toUpperCase();
    return this.statusMap[norm] || this.statusMap[status.toLowerCase()] || 'stable';
  }

  validate(data) {
    if (!super.validate(data)) return false;
    const str = data.toString().trim();
    if (this.mode === 'regex') return this.compiledRegex ? this.compiledRegex.test(str) : false;
    if (this.mode === 'json') { try { JSON.parse(str); return true; } catch { return false; } }
    return str.length > 0;
  }
}

// ─── Parser factory ───────────────────────────────────────────────────────────
function loadParser(protocol) {
  switch (protocol) {
    case 'ZM':        return new ZmParser();
    case 'CARDINAL':  return new CardinalParser();
    case 'CARDINAL2': return new Cardinal2Parser();
    case '1310':      return new I1310Parser();
    case 'CUSTOM':    return new CustomParser();
    default:
      console.error(`❌ Unknown protocol: ${protocol}. Use: ZM | CARDINAL | CARDINAL2 | 1310 | CUSTOM`);
      process.exit(1);
  }
}

// ─── Query command per protocol ───────────────────────────────────────────────
function getQueryCommand(protocol) {
  switch (protocol) {
    case 'ZM':        return Buffer.from('W');
    case 'CARDINAL':  return null;
    case 'CARDINAL2':
    case '1310':      return Buffer.from([0x05]);
    default:          return null;
  }
}

// ─── RDU formatter ───────────────────────────────────────────────────────────
function formatRdu(weightKg) {
  const reversed = Math.abs(Math.round(weightKg)).toString().split('').reverse().join('');
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
      deckWeights.gvw = r.weight;
    }
  }
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

  process.stdout.write('\x1B[2J\x1B[0;0H');
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
    { label: 'Deck 1', weight: deckWeights[1],   port: opts.usrPorts[0] },
    { label: 'Deck 2', weight: deckWeights[2],   port: opts.usrPorts[1] },
    { label: 'Deck 3', weight: deckWeights[3],   port: opts.usrPorts[2] },
    { label: 'Deck 4', weight: deckWeights[4],   port: opts.usrPorts[3] },
    { label: 'GVW   ', weight: deckWeights.gvw,  port: opts.usrPorts[4] }
  ];

  rows.forEach((row, i) => {
    const conn = rduConns[i];
    const st   = opts.noRdu ? '—' : (conn?.connected ? '✅ sent' : '⚠ no conn');
    console.log(`  ${row.label}│ ${String(row.weight).padStart(11)} │ ${formatRdu(row.weight)} │ ${String(row.port).padStart(8)} │ ${st}`);
  });

  console.log('══════════════════════════════════════════════════════════════');
  console.log('  Press Ctrl+C to stop');
}

// ─── USR RDU TCP connections ──────────────────────────────────────────────────
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
      conn.socket.on('close', () => { conn.connected = false; setTimeout(connect, 5000); });
    };

    connect();
  });
}

function sendToRdus() {
  if (opts.noRdu) return;
  const weights = [deckWeights[1], deckWeights[2], deckWeights[3], deckWeights[4], deckWeights.gvw];
  weights.forEach((w, i) => {
    const conn = rduConns[i];
    if (!conn || !conn.connected || !conn.socket?.writable) return;
    conn.socket.write(formatRdu(w), err => { if (!err) sendCount++; });
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
    path: opts.port, baudRate: opts.baud,
    dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false
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

      port.on('data',  data => handleData(data, parser));
      port.on('error', err  => console.error(`❌ Serial error: ${err.message}`));

      process.on('SIGINT', () => {
        if (queryTimer) clearInterval(queryTimer);
        console.log('\n  Closing serial port...');
        port.close(() => { shutdownRdus(); process.exit(0); });
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
      if (queryCmd) {
        const queryTimer = setInterval(() => socket.write(queryCmd), 1000);
        socket.once('close', () => clearInterval(queryTimer));
      }
    });
  };

  socket.on('data',  data => handleData(data, parser));
  socket.on('error', err  => { console.warn(`  ⚠ Indicator TCP error: ${err.message} — retry in 5s`); setTimeout(connect, 5000); });
  socket.on('close', ()   => { console.warn('  ⚠ Indicator TCP closed — reconnecting in 5s...'); setTimeout(connect, 5000); });

  process.on('SIGINT', () => {
    console.log('\n  Disconnecting...');
    socket.destroy();
    shutdownRdus();
    process.exit(0);
  });

  connect();
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────
function shutdownRdus() {
  rduConns.forEach(conn => { if (conn.socket) conn.socket.destroy(); });
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

  setupRduConnections();
  if (!opts.noRdu) await new Promise(r => setTimeout(r, 1000));

  if (opts.input === 'tcp') {
    await startTcp(parser);
  } else {
    await startSerial(parser);
  }

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
