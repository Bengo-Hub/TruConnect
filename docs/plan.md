# TruConnect - Comprehensive System Plan

## Executive Summary

TruConnect is designed to be the ultimate, all-in-one weight monitoring and data distribution platform for weighbridge operations. This comprehensive revamp combines the best features and patterns from all existing iConnect implementations (Kanyonyo, Maimahiu, Rongo, Webuye) while introducing new capabilities for mobile scales, simulation mode, and enhanced configurability.

---

## Audit Findings Summary

### Analyzed iConnect Versions

| Version | Indicator(s) | Input Protocol | Output | Notable Features |
|---------|-------------|----------------|--------|------------------|
| **Kanyonyo** | ZM, Cardinal, Cardinal2 | Serial (COM), TCP, UDP | Serial RDU (5 ports), HTTP API | ANPR integration, bidirectional support |
| **Maimahiu** | ZM, Cardinal, Cardinal2 | Serial (COM), TCP | Serial RDU (4 ports) | UDP listener, TCP client |
| **Rongo** | 1310, ZM, Cardinal, Cardinal2 | Serial (COM), TCP, UDP | Serial RDU (5 ports), HTTP API | Bidirectional, 1310 indicator parsing |
| **Webuye** | 1310, ZM, Cardinal, Cardinal2 | Serial (COM) | Serial RDU (6 modules), HTTP API | Best structured, state management, CONFIG-based |
| **TruConnect (current)** | API-based | HTTP polling | Serial/TCP RDU | Electron app, SQLite, modern UI |

### Common Patterns Identified

1. **Weight Data Sources**:
   - Serial COM port communication (9600 baud typical)
   - TCP socket connections
   - UDP listeners (port 13805 common)
   - HTTP API polling

2. **Indicator Protocols**:
   - **ZM (Avery Weigh-Tronix)**: CSV comma-separated weights
   - **Cardinal**: Fixed-width 90-char strings
   - **Cardinal2**: Per-deck responses with deck identifier
   - **1310**: Scale-numbered responses with gross weight

3. **Data Output Methods**:
   - Serial port to RDU displays (1200 baud, format: `$=XXXXXXXX=`)
   - HTTP API endpoints (/weights GET/POST)
   - TCP socket connections

4. **Integration Features**:
   - ANPR camera integration (Hikvision)
   - Autoweigh endpoint communication
   - Alarm triggering via API (integrated with `notifications-service` for multi-channel alerts)

---

## New TruConnect Architecture Goals

### Core Principles

1. **Highly Configurable**: All settings stored in SQLite, UI-configurable
2. **Protocol Agnostic**: Support any indicator through protocol plugins
3. **Multi-Output**: Simultaneous real-time, polling, serial, and network output
4. **Simulation Ready**: Built-in simulation mode with configurable weights
5. **Production Grade**: Robust error handling, logging, authentication
6. **Modern Stack**: Updated Electron, latest Node.js libraries

### Feature Matrix

| Feature | Status | Priority |
|---------|--------|----------|
| Multi-deck indicator support | New | P0 |
| Mobile scale support (Haenni, MCGS) | New | P0 |
| Cumulative weight logic (MCGS) | New | P0 |
| Simulation mode | New | P0 |
| Real-time WebSocket output | New | P0 |
| API polling endpoint | Existing | P0 |
| Serial RDU output | Existing | P0 |
| Auto-submission session reset | New | P0 |
| Network/Port mapping output | New | P1 |
| SQLite configuration storage | Existing | P0 |
| Authentication (admin) | New | P1 |
| ANPR integration | Port | P2 |
| Autoweigh API integration | Port | P2 |

---

## Configuration Schema

### General Settings
```typescript
interface GeneralSettings {
  stationName: string;        // e.g., "Rongo Weighbridge"
  stationCode: string;        // e.g., "ROMIA"
  stationCode2?: string;      // For bidirectional
  mode: 'mobile' | 'multideck'; // Capture behavior
  theme: 'light' | 'dark' | 'system';
  bidirectional: boolean;
  vehicleThreshold: number;   // kg, weight to detect vehicle
}
```

### Connection Mode Configuration
```typescript
interface ConnectionConfig {
  defaultMode: 'realtime' | 'polling'; // Default: 'realtime'
  
  // Real-time WebSocket configuration
  realtime: {
    wsServerEnabled: boolean;     // TruConnect as WS server (port 8080)
    wsPool: {
      enabled: boolean;
      connections: { name: string; url: string; reconnectInterval: number; }[];
    };
  };
  
  // HTTP Polling configuration
  polling: {
    apiEnabled: boolean;          // Expose /api/weights endpoint
    apiPort: number;              // Default: 3031
  };
}
```

### Indicator Configuration
```typescript
interface IndicatorConfig {
  id: string;
  name: string;
  type: 'ZM' | 'Cardinal' | 'Cardinal2' | '1310' | 'PAW' | 'Haenni' | 'Custom';
  enabled: boolean;
  connection: {
    type: 'serial' | 'tcp' | 'udp' | 'http';
    // Serial options
    port?: string;           // e.g., "COM1"
    baudRate?: number;       // e.g., 9600
    dataBits?: number;       // e.g., 8
    stopBits?: number;       // e.g., 1
    parity?: 'none' | 'even' | 'odd';
    // Network/API options
    host?: string;           // For TCP/UDP
    networkPort?: number;    // For TCP/UDP
    apiBaseUrl?: string;     // For HTTP (e.g., Haenni Mongoose)
    pollInterval?: number;   // ms
  };
  parsing?: {
    delimiter?: string;
    weightFormat?: string;   // regex pattern
    deckCount?: number;
  };
  // For Custom type only
  customConfig?: CustomProtocolConfig;  // Reference to custom_protocols table
}
```

### Custom Protocol Configuration (User-Defined)
```typescript
interface CustomProtocolConfig {
  id: string;
  name: string;
  category: 'indicator' | 'mobile';

  connection: {
    type: 'serial' | 'tcp' | 'udp' | 'http';
    port?: string;
    baudRate?: number;
    dataBits?: 8 | 7;
    stopBits?: 1 | 2;
    parity?: 'none' | 'even' | 'odd';
    host?: string;
    networkPort?: number;
    apiUrl?: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
  };

  query: {
    mode: 'poll' | 'stream';
    command?: string;        // ASCII command (e.g., "Q")
    commandHex?: string;     // Hex command (e.g., "05" for ENQ)
    interval?: number;       // Poll interval in ms
    timeout?: number;        // Response timeout
  };

  parsing: {
    type: 'regex' | 'delimiter' | 'fixed' | 'json';
    pattern?: string;        // Regex with capture groups
    delimiter?: string;      // For delimiter type
    positions?: Array<{ start: number; end: number; field: string }>;
    jsonPath?: Record<string, string>;
    stripNonNumeric?: boolean;
    multiplier?: number;
  };

  fieldMapping: {
    deck1?: string;
    deck2?: string;
    deck3?: string;
    deck4?: string;
    gvw?: string;
    stable?: string;
  };

  output: {
    mode: 'multideck' | 'mobile';
    deckCount?: number;
    axleCount?: number;
    calculateGvw?: boolean;
  };
}
```

### Output Configuration
```typescript
interface OutputConfig {
  // RDU Output Mapping
  rdu: {
    directEnabled: boolean;       // Native COM ports (Default: true)
    usrnEnabled: boolean;         // Network serial via USR-TCP232
    devices: RduDeviceConfig[];
  };
  
  // Auto-Weigh Integration
  autoweigh: {
    enabled: boolean;
    serverHost: string;           // Backend IP/Host
    serverPort: number;
    protocol: 'http' | 'https';
    endpoints: {
      auth: string;               // Default: "/AuthManagement/Login"
      postWeight: string;         // Default: "/autoweigh"
    };
    dataFormat: 'kenloadv2' | 'truload' | 'custom';
    credentials: { email: string; password: string; };
  };
}

interface RduDeviceConfig {
  id: string;
  type: 'direct' | 'usrn';
  connection: {
    port?: string;                // For direct (COM1)
    baudRate?: number;            // Default: 1200
    host?: string;                // For USRN (192.168.1.100)
    networkPort?: number;         // For USRN (4196)
  };
  deckIndex: number;              // 0-3 for decks, 4 for GVW
}
```

### Simulation Configuration
```typescript
interface SimulationConfig {
  enabled: boolean;
  mode: 'static' | 'dynamic' | 'pattern';
  weights: {
    deck1: { min: number; max: number; current: number; };
    deck2: { min: number; max: number; current: number; };
    deck3: { min: number; max: number; current: number; };
    deck4: { min: number; max: number; current: number; };
  };
  vehicleCycleDuration?: number;  // ms for dynamic mode
}
```

---

## Developer Information

**Developer**: Titus Owuor  
**Company**: Covertext IT Solutions  
**Address**: Oginga Street, Kisumu  
**Tel**: +254743793901

---

## Default Settings

### Enabled by Default
- Real-time output (if wsBaseUrl configured)
- Serial RDU output (if ports configured)
- Network/Port mapping output (if configured)

### Disabled by Default
- API polling mode (must be explicitly enabled)
- Simulation mode

### Reset Behavior
When user resets settings, all values return to factory defaults:
- `stationName`: "Weighbridge Station"
- `theme`: "dark"
- `pollInterval`: 1000
- All outputs disabled except serial RDU
- Simulation disabled with zero weights

---

## Security & Authentication

### Default Admin Credentials (seeded on first run)
- **Email**: admin@truconnect.local
- **Password**: Admin@123!

### Public Pages
- Dashboard/Main view (read-only weight display)
- Status page

### Protected Pages (require authentication)
- Settings/Configuration
- Device management
- User management
- Logs/Diagnostics

---

## Technology Upgrades

| Package | Current | Target | Notes |
|---------|---------|--------|-------|
| Electron | 21.x | 35.x | Latest stable (updated Jan 2026) |
| Node.js | 18.x | 22.x | LTS |
| better-sqlite3 | 9.x | 11.x | Sync SQLite |
| serialport | ^10 | ^12 | Latest API |
| ws | ^8 | ^8.18 | WebSocket |
| axios | ^1 | ^1.7 | HTTP client |

---

## Station Code & Bound Configuration

### Overview

TruConnect supports complex weighbridge configurations with multiple naming conventions for station codes and bounds. This is critical for proper integration with TruLoad and KenloadV2 systems.

### Station Code Patterns

**1. Simple Bidirectional (Single deck per bound)**
```
Station: Rongo Weighbridge
Base Code: ROMI
Bound A: ROMIA (Nairobi bound - vehicles heading to Nairobi)
Bound B: ROKSA (Kisumu bound - vehicles heading to Kisumu)

Pattern: [BASE_CODE][BOUND_LETTER]
```

**2. Multi-Deck Per Bound (Athi River style)**
```
Station: Athi River
Mombasa Bound Station Code: ATMB

Deck A on Mombasa Bound: ATMBA
Deck B on Mombasa Bound: ATMBB

Nairobi Bound Station Code: ATNA
Deck A on Nairobi Bound: ATNAA
Deck B on Nairobi Bound: ATNAB

Pattern: [STATION_CODE][DECK_LETTER]
```

**3. Non-Directional Stations (Single bound)**
```
Station: Webuye Weighbridge
Station Code: WBMLA
No bound switching needed - single direction only
```

### Configuration Schema

```typescript
interface StationConfig {
  // Primary station identification
  stationCode: string;           // e.g., "ROMI" (base code without bound)
  stationName: string;           // e.g., "Rongo Weighbridge"

  // Bound configuration
  bidirectional: boolean;        // Does station support two directions?
  currentBound: 'A' | 'B';       // Active bound (received from TruLoad)

  // Bound details (if bidirectional)
  bounds?: {
    A: {
      code: string;              // e.g., "ROMIA"
      name: string;              // e.g., "Nairobi Bound"
      deckCount: number;         // 1-4 decks per platform
    };
    B: {
      code: string;              // e.g., "ROKSA"
      name: string;              // e.g., "Kisumu Bound"
      deckCount: number;
    };
  };

  // Multi-deck per bound (Athi River style)
  multiDeckPerBound: boolean;
  decks?: {
    A: string;                   // e.g., "ATMBA"
    B: string;                   // e.g., "ATMBB"
  };
}
```

### Bound Auto-Detection Logic

For bidirectional stations, TruConnect can auto-detect vehicle entry direction:

```javascript
// Vehicle entering from Deck 1 side → Bound A (forward)
// Vehicle entering from Deck 4 side → Bound B (reverse)

function detectBound(weights, threshold = 100) {
  const deck1Active = weights[0] > threshold;
  const deck4Active = weights[3] > threshold;

  if (deck1Active && !deck4Active) {
    return { bound: 'A', direction: 'forward' };
  } else if (deck4Active && !deck1Active) {
    return { bound: 'B', direction: 'reverse' };
  }
  return null; // Cannot determine
}
```

---

## Two-Way Communication Protocol

### Overview

TruConnect implements bidirectional WebSocket communication with TruLoad clients. This enables:
- Weight data streaming (TruConnect → TruLoad)
- Station/bound registration (TruLoad → TruConnect)
- Vehicle plate updates for auto-weigh (TruLoad → TruConnect)
- Connection status queries (Both directions)

### Connection Modes

**IMPORTANT**: Only ONE mode should be active at a time:

1. **Real-time (WebSocket) - DEFAULT**
   - TruConnect runs as WebSocket server (port 8080)
   - TruLoad connects as client
   - Weights pushed in real-time
   - Two-way messaging supported

2. **API Polling - FALLBACK**
   - Enabled explicitly in TruLoad configuration
   - TruConnect exposes HTTP API on port 3031
   - TruLoad polls GET /weights endpoint
   - TruConnect backend proxies weights from middleware

When API polling is enabled in TruLoad, the middleware must also enable its API server to serve weights. The mode should be synchronized.

### Message Types

**TruLoad → TruConnect**
```typescript
// Registration on connect
{ type: 'register', stationCode: 'ROMIA', bound: 'A', clientType: 'truload' }

// Vehicle plate from ANPR or manual entry
{ type: 'plate', plate: 'KAA 123X', source: 'anpr' | 'manual' }

// Bound switch notification
{ type: 'bound-switch', newBound: 'B', newStationCode: 'ROKSA' }

// Request status
{ type: 'status-request' }
```

**TruConnect → TruLoad**
```typescript
// Weight update
{
  type: 'weights',
  mode: 'multideck' | 'mobile',
  stationCode: 'ROMIA',
  bound: 'A',
  decks: [{ index: 1, weight: 6500, stable: true }, ...],
  gvw: 26000,
  status: 'stable',
  vehicleOnDeck: true,
  timestamp: '2026-01-28T10:00:00Z'
}

// Connection status
{
  type: 'status',
  connected: true,
  simulation: false,
  indicators: [{ id: 'ZM1', type: 'ZM', connected: true }],
  rdus: [{ id: 'Deck1', connected: true }]
}

// Registration acknowledgment
{ type: 'ack', registered: true, stationCode: 'ROMIA', bound: 'A' }
```

### Auto-Weigh Data Flow

1. TruLoad connects and sends `register` message with station code and bound
2. When vehicle plate is captured (ANPR/manual), TruLoad sends `plate` message
3. TruConnect stores plate for current session
4. When vehicle weighing completes, TruConnect submits auto-weigh record:
   - Station code (with bound)
   - All deck weights
   - GVW
   - Vehicle plate (from TruLoad)
   - Timestamp

---

## Sprint Overview

| Sprint | Focus | Duration |
|--------|-------|----------|
| Sprint 01 | Core Infrastructure & Database | 3-4 days |
| Sprint 02 | Indicator Protocol Implementations | 4-5 days |
| Sprint 03 | Data Output Protocols | 4-5 days |
| Sprint 04 | Mobile Scale & Advanced Input | 3-4 days |
| Sprint 05 | Simulation Mode & Testing | 3-4 days |
| Sprint 06 | Authentication & UI Refinement | 3-4 days |
| Sprint 07 | Production Optimization & Packaging | 2-3 days |
| Sprint 08 | Two-Way Communication & Station Config | 3-4 days |
