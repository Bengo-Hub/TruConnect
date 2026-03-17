# TruConnect - System Architecture

## Overview

TruConnect follows a modular, event-driven architecture designed for flexibility, reliability, and performance. The system is built on Electron with a clear separation between main process services and renderer UI.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              INPUT LAYER                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐   │
│  │ Serial Port   │ │  TCP Client   │ │  UDP Server   │ │  HTTP Client  │   │
│  │ (Indicators)  │ │ (Network Dev) │ │ (Load Cells)  │ │ (API Polling) │   │
│  └───────┬───────┘ └───────┬───────┘ └───────┬───────┘ └───────┬───────┘   │
│          │                 │                 │                 │            │
│          └─────────────────┴─────────┬───────┴─────────────────┘            │
│                                      ▼                                       │
│                        ┌──────────────────────────┐                         │
│                        │   INPUT MANAGER          │                         │
│                        │   - Protocol Detection   │                         │
│                        │   - Data Normalization   │                         │
│                        └────────────┬─────────────┘                         │
│                                     │                                        │
└─────────────────────────────────────┼────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CORE ENGINE                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         WEIGHT PROCESSOR                              │  │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐     │  │
│  │  │ ZM Parser   │ │  Cardinal   │ │   1310      │ │ MobileScale │     │  │
│  │  │             │ │  Parser     │ │   Parser    │ │   Parser    │     │  │
│  │  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘     │  │
│  │                              ▼                                        │  │
│  │  ┌───────────────────────────────────────────────────────────────┐   │  │
│  │  │                    WEIGHT STATE MANAGER                        │   │  │
│  │  │  - Current weights [deck1, deck2, deck3, deck4]               │   │  │
│  │  │  - GVW calculation                                             │   │  │
│  │  │  - Vehicle detection                                           │   │  │
│  │  │  - Change detection                                            │   │  │
│  │  └───────────────────────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                     │                                        │
│                                     │ Events                                 │
│                                     ▼                                        │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         EVENT BUS                                     │  │
│  │  Events: weights-updated, vehicle-detected, connection-status-changed │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────┼────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            OUTPUT LAYER                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐   │
│  │  WebSocket    │ │  REST API     │ │  RDU Output   │ │  Network Port │   │
│  │  :3030        │ │  (Polling)    │ │  Multi-Panel  │ │  Mapping      │   │
│  └───────────────┘ └───────────────┘ └───────────────┘ └───────────────┘   │
│                                                                              │
│          ▼                 ▼                 ▼                 ▼            │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐   │
│  │ WS Clients    │ │ HTTP Clients  │ │ Single RDU    │ │ ETH Devices   │   │
│  │ (TruLoad)     │ │ (Truload)   │ │ (1-5 Panels)  │ │ (USR-TCP232)  │   │
│  └───────────────┘ └───────────────┘ └───────────────┘ └───────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                            ELECTRON UI                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐   │
│  │    Main Window      │ │  Settings Window    │ │   System Tray       │   │
│  │    - Dashboard      │ │  - General          │ │   - Show/Hide       │   │
│  │    - Weight Display │ │  - Indicators       │ │   - Settings        │   │
│  │    - Status Bar     │ │  - Outputs          │ │   - Quit            │   │
│  └─────────────────────┘ │  - Authentication   │ └─────────────────────┘   │
│                          └─────────────────────┘                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         PERSISTENCE LAYER                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                     SQLite Database (truconnect.db)                  │   │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐        │   │
│  │  │  settings  │ │   users    │ │weight_logs │ │ auth_tokens│        │   │
│  │  └────────────┘ └────────────┘ └────────────┘ └────────────┘        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Module Structure

```
TruConnect/
├── main.js                    # Electron main process entry
├── preload.js                 # Context bridge for renderer
├── renderer.js                # Renderer process utilities
│
├── src/
│   ├── core/
│   │   ├── WeightProcessor.js      # Weight parsing & processing
│   │   ├── StateManager.js         # Application state management
│   │   └── EventBus.js             # Internal event system
│   │
│   ├── input/
│   │   ├── InputManager.js         # Input source orchestration
│   │   ├── SerialInput.js          # Serial port communication
│   │   ├── TcpInput.js             # TCP client input
│   │   ├── UdpInput.js             # UDP server input
│   │   └── ApiInput.js             # HTTP API polling input
│   │
│   ├── parsers/
│   │   ├── ParserFactory.js        # Parser instantiation
│   │   ├── ZmParser.js             # ZM indicator protocol
│   │   ├── CardinalParser.js       # Cardinal indicator protocol
│   │   ├── Cardinal2Parser.js      # Cardinal2 indicator protocol
│   │   ├── I1310Parser.js          # 1310 indicator protocol
│   │   ├── MobileScaleParser.js    # Mobile scales (PAW, Haenni, MCGS)
│   │   └── CustomParser.js         # User-defined parsing
│   │
│   ├── output/
│   │   ├── OutputManager.js        # Output orchestration
│   │   ├── WebSocketOutput.js      # Real-time WebSocket server/client
│   │   ├── ApiOutput.js            # REST API server (Express)
│   │   ├── SerialRduOutput.js      # Serial port RDU output
│   │   └── NetworkPortOutput.js    # TCP port mapping output
│   │
│   ├── simulation/
│   │   ├── SimulationEngine.js     # Simulation mode controller
│   │   └── WeightGenerator.js      # Simulated weight generation
│   │
│   ├── auth/
│   │   ├── AuthManager.js          # Authentication management
│   │   └── AuthMiddleware.js       # Express middleware
│   │
│   ├── database/
│   │   ├── Database.js             # SQLite connection manager
│   │   ├── Migrations.js           # Schema migrations
│   │   └── Seed.js                 # Default data seeding
│   │
│   └── config/
│       ├── ConfigManager.js        # Configuration CRUD
│       └── defaults.js             # Default values
│
├── pages/
│   ├── index.html                  # Main dashboard
│   ├── settings.html               # Settings management
│   └── login.html                  # Authentication
│
├── assets/
│   ├── css/                        # Stylesheets
│   ├── js/                         # Browser scripts
│   ├── icons/                      # Application icons
│   └── images/                     # UI images
│
└── docs/
    ├── plan.md                     # This document
    ├── architecture.md             # Architecture guide
    ├── integrations.md             # Integration protocols
    └── sprints/                    # Sprint planning
        ├── sprint-01.md
        ├── sprint-02.md
        └── ...
```

---

## Data Flow

### Weight Data Processing Flow

```
1. Input Received (Serial/TCP/UDP/API)
   │
2. InputManager.receive(rawData, source)
   │
3. ParserFactory.getParser(indicatorType)
   │
4. parser.parse(rawData) → WeightData { deck1, deck2, deck3, deck4, raw }
   │
5. StateManager.setCurrentMobileWeight(weight, stable)
   │ - If useCumulativeWeight is enabled: trueWeight = weight - sessionGVW
   │ - skips cumulative logic in simulation mode
   │
6. StateManager.updateWeights(weightData)
   │
7. if (hasSignificantChange) → EventBus.emit('weights-updated', weightData)
   │
8. OutputManager.broadcast(weightData)
   │
9. Each output module sends to its destinations
```

### Weight Data Structure

```typescript
interface WeightData {
  deck1: number;   // kg
  deck2: number;   // kg
  deck3: number;   // kg
  deck4: number;   // kg
  gvw: number;     // calculated total
  vehicleOnDeck: boolean;
  timestamp: string;
  source: string;  // indicator ID
  raw?: string;    // original data
}
```

### Input Source Configuration

TruConnect supports multiple input source types, but only **ONE source can be active at a time**.
Activating a new source automatically deactivates any currently active source.

```typescript
// Available input sources
type InputSource =
  | 'none'              // No input (use simulation)
  | 'paw'               // PAW Portable Axle Weigher (Serial)
  | 'haenni'            // Haenni WL Portable (API)
  | 'mcgs'              // MCGS Mobile Scale (Serial)
  | 'indicator_zm'      // ZM Protocol Indicator
  | 'indicator_cardinal'     // Cardinal Scale
  | 'indicator_cardinal2'    // Cardinal Model 225/738
  | 'indicator_1310'    // Rice Lake 1310
  | 'custom';           // Custom Configuration

interface InputConfig {
  activeSource: InputSource;  // Currently active source

  // Mobile Scales
  paw: {
    enabled: boolean;
    type: 'serial';
    protocol: 'PAW';
    serial: SerialConfig;
  };
  haenni: {
    enabled: boolean;
    type: 'api';
    protocol: 'HAENNI';
    api: ApiConfig;
  };
  mcgs: {
    enabled: boolean;
    type: 'serial';
    protocol: 'MCGS';
    serial: SerialConfig;
  };

  // Multideck Indicators
  indicator_zm: IndicatorConfig;
  indicator_cardinal: IndicatorConfig;
  indicator_cardinal2: IndicatorConfig;
  indicator_1310: IndicatorConfig;
  custom: IndicatorConfig;

  decks: DeckConfig[];
}

interface IndicatorConfig {
  enabled: boolean;
  type: 'serial' | 'tcp' | 'udp' | 'api';
  protocol: string;
  serial?: SerialConfig;
  tcp?: TcpConfig;
  connectionType: 'serial' | 'tcp';
}
```

**Key Points:**
- PAW uses serial (COM7 default) for weight console queries
- Haenni uses HTTP API (localhost:8888 default) for measurements
- Multideck indicators can use serial or TCP connection
- Each indicator protocol has specific parsing requirements
- Switching sources triggers `input:source-switched` event

### Serial Query Commands Reference

For serial-connected devices, TruConnect sends periodic query commands to request weight data.

| Device/Protocol | Query Command | Baud Rate | Response Format |
|-----------------|---------------|-----------|-----------------|
| **PAW Weight Console** | `W` (ASCII) | 9600 | `ST,GS, 0000270kg` (Scale A+B combined) |
| **ZM Protocol** | `W` (ASCII) | 9600 | `G:+00001234` (Gross weight) |
| **Cardinal 190/210** | *(continuous)* | 9600, 7-O-1 | 90-character frames |
| **Cardinal 225/738** | `ENQ` (0x05) | 9600 | Per-deck response |
| **Rice Lake 1310** | `ENQ` (0x05) | 9600 | STX...ETX framed |
| **Avery Weigh-Tronix** | `W` (ASCII) | 9600 | Protocol-dependent |

**Query Polling:**
- Default interval: 500ms
- Configurable per source
- Continuous output indicators (Cardinal 190/210) don't need queries

### RDU Configuration Structure

TruConnect supports a **single RDU device** with up to 5 panels for displaying weights on different decks.

```typescript
interface RduConfig {
  enabled: boolean;              // Enable/disable RDU output
  name: string;                  // Display name (e.g., "Main RDU")
  model: 'KELI' | 'Yaohua' | 'Generic';  // RDU model determines message format
  connectionType: 'serial' | 'usr';       // Direct serial or USR-TCP232 network

  // Message format template (model-specific)
  // KELI: '$={WEIGHT}=', Yaohua: 'W{WEIGHT}', Generic: '{WEIGHT}'
  format: string;

  // USR-TCP232 network device (when connectionType = 'usr')
  usr?: {
    ip: string;    // USR device IP address
    port: number;  // USR device port (default: 4196)
  };

  // Panel configurations (up to 5)
  panels: Array<{
    deckIndex: number;   // 0=deck1, 1=deck2, 2=deck3, 3=deck4, 4=GVW
    baudRate: number;    // Typically 1200
    port?: string;       // COM port (serial connection)
    channel?: number;    // USR channel (usr connection)
  }>;
}
```

**Panel Assignment**:
- Index 0-3: Deck weights (Deck 1-4)
- Index 4: GVW (Gross Vehicle Weight)

---

## IPC Communication

### Main ↔ Renderer Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `weights-updated` | Main → Renderer | Real-time weight updates |
| `connection-status` | Main → Renderer | Device connection changes |
| `get-settings` | Renderer → Main | Request current settings |
| `save-settings` | Renderer → Main | Persist settings changes |
| `get-initial-data` | Renderer → Main | Initial dashboard data |
| `open-settings` | Renderer → Main | Open settings window |
| `restart-app` | Renderer → Main | Restart application |
| `test-connection` | Renderer → Main | Test device connection |

---

## Weight Data Flow

### Input → Processing → Output Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              INPUT LAYER                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐          │
│  │ Serial Input     │  │ API Input        │  │ Simulation       │          │
│  │ (PAW, Multideck) │  │ (Haenni)         │  │ Engine           │          │
│  │ COM1/COM7        │  │ :8888/devices    │  │                  │          │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘          │
│           │                      │                      │                    │
│           └──────────────────────┼──────────────────────┘                    │
│                                  ▼                                           │
│                    ┌────────────────────────────┐                           │
│                    │      InputManager          │                           │
│                    │  (Parser + Event Emit)     │                           │
│                    └────────────┬───────────────┘                           │
│                                 │                                            │
└─────────────────────────────────┼────────────────────────────────────────────┘
                                  │ EventBus: 'input:weight'
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              STATE LAYER                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                    ┌────────────────────────────┐                           │
│                    │      StateManager          │                           │
│                    │  (Weights, Vehicle, Mode)  │                           │
│                    └────────────┬───────────────┘                           │
│                                 │                                            │
└─────────────────────────────────┼────────────────────────────────────────────┘
                                  │ EventBus: 'state:weights-updated'
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              OUTPUT LAYER                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐          │
│  │ WebSocket Server │  │ REST API Server  │  │ RDU Communicator │          │
│  │ :3030 (realtime) │  │ :3031/weights    │  │ (Serial/USR)     │          │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘          │
│           │                      │                      │                    │
│           ▼                      ▼                      ▼                    │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐          │
│  │ TruLoad Clients  │  │ HTTP Clients     │  │ LED Displays     │          │
│  │ (Connection Pool)│  │ (Polling Mode)   │  │ (Weight Panels)  │          │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Mobile Mode Flow (Step-by-Step Axle Capture)

1. **Weight Query**: TruLoad client sends `query-weight` via WebSocket
2. **Input Query**: TruConnect queries PAW/Haenni/MCGS scale for current weight
3. **Weight Response**: Scale returns axle weight
4. **Cumulative Logic**: If scale is cumulative (e.g., MCGS), previous GVW is subtracted. 
   - *Logic*: `Current Axle Weight = Raw Scale Reading - Session GVW`
   - *Example*: See `integrations.md` for a full 7-axle step-by-step weighing scenario.
5. **Broadcast**: Processed weight broadcast to all connected clients in pool
6. **Capture**: User confirms axle capture on TruLoad
7. **TruLoad → TruConnect**: `axle-captured` event with weight
8. **Accumulate**: StateManager adds axle to running session total
9. **Complete**: When all axles captured, `vehicle-complete` sent
10. **AutoWeigh**: Final GVW and plate sent to backend
11. **Session Reset**: After successful submission, `StateManager.resetMobileSession()` is called automatically

### Multideck Mode Flow (Simultaneous Deck Capture)

1. **Continuous Input**: Indicator streams all deck weights
2. **Parse**: InputManager parses multi-deck data
3. **State Update**: All 4 deck weights + GVW updated simultaneously
4. **Vehicle Detection**: GVW > threshold triggers vehicle presence
5. **Broadcast**: Weights pushed to all WebSocket clients
6. **RDU Output**: Formatted weights sent to display panels

---

## Database Schema

### Tables

```sql
-- Settings (key-value store)
CREATE TABLE settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Users (authentication)
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT DEFAULT 'user',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Weight Logs (optional logging)
CREATE TABLE weight_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deck1 REAL,
  deck2 REAL,
  deck3 REAL,
  deck4 REAL,
  gvw REAL,
  source TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Auth Tokens (session management)
CREATE TABLE auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  token TEXT UNIQUE,
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

---

## Error Handling Strategy

1. **Connection Errors**: Auto-reconnect with exponential backoff
2. **Parse Errors**: Log and skip, continue with last known values
3. **Output Errors**: Individual output failures don't affect others
4. **Database Errors**: Fallback to in-memory defaults
5. **Critical Errors**: Show user dialog, log to file

---

## Performance Targets

| Metric | Target |
|--------|--------|
| Weight update latency | < 50ms |
| UI update rate | 10 Hz |
| Memory usage | < 150MB |
| CPU usage (idle) | < 2% |
| Startup time | < 3s |
