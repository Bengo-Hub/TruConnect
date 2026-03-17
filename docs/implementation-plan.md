# TruConnect Revamp - Implementation Plan

## Overview

Revamp TruConnect middleware to support all indicator protocols, two-way communication with TruLoad, custom user-defined protocols, and proper station/bound configuration.

---

## Directory Structure

```
TruConnect/
├── main.js                    # Electron entry (slimmed down)
├── preload.js                 # Secure IPC bridge
├── src/
│   ├── core/
│   │   ├── EventBus.js        # Central event emitter
│   │   ├── StateManager.js    # Weights, connections, plate state
│   │   └── ConnectionPool.js  # WebSocket client tracking
│   ├── auth/
│   │   ├── AuthManager.js     # Login/logout, session management
│   │   ├── AuthMiddleware.js  # Route protection, RBAC
│   │   └── PasswordUtils.js   # Hashing with bcryptjs
│   ├── input/
│   │   ├── InputManager.js    # Orchestrates all inputs
│   │   ├── SerialInput.js     # COM port connections
│   │   ├── TcpInput.js        # TCP client
│   │   ├── UdpInput.js        # UDP server (13805)
│   │   └── ApiInput.js        # HTTP polling (Haenni)
│   ├── parsers/
│   │   ├── ParserFactory.js   # Factory pattern
│   │   ├── ZmParser.js        # Avery Weigh-Tronix
│   │   ├── CardinalParser.js  # Fixed 90-char
│   │   ├── Cardinal2Parser.js # Per-deck messages
│   │   ├── I1310Parser.js     # Scale No: X format
│   │   ├── MobileScaleParser.js # PAW & Haenni
│   │   └── CustomParser.js    # User-defined protocols
│   ├── output/
│   │   ├── OutputManager.js   # Orchestrates outputs
│   │   ├── WebSocketOutput.js # WS server (8080)
│   │   ├── ApiOutput.js       # Express REST (3031)
│   │   ├── SerialRduOutput.js # Direct COM RDU
│   │   └── NetworkRduOutput.js # USR-TCP232
│   ├── simulation/
│   │   ├── SimulationEngine.js
│   │   └── WeightGenerator.js
│   ├── database/
│   │   ├── Database.js        # better-sqlite3
│   │   ├── Migrations.js      # Schema versions
│   │   └── Seed.js            # Default data
│   └── config/
│       ├── ConfigManager.js
│       └── defaults.js
└── pages/
    ├── index.html             # Dashboard (PUBLIC - read-only view)
    ├── login.html             # Login page
    └── settings.html          # Configuration (PROTECTED)
```

---

## Critical Files to Create/Modify

1. **src/parsers/ParserFactory.js** - Factory for all parser types
2. **src/parsers/CustomParser.js** - User-defined protocol support
3. **src/input/InputManager.js** - Unified input orchestration
4. **src/output/WebSocketOutput.js** - Two-way WS communication
5. **src/core/ConnectionPool.js** - TruLoad client tracking
6. **src/database/Database.js** - better-sqlite3 with migrations
7. **src/auth/AuthManager.js** - Authentication and session management
8. **src/auth/AuthMiddleware.js** - Route protection and RBAC
9. **pages/login.html** - Login page UI

---

## Database Schema (New Tables)

```sql
-- Users table for authentication
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',  -- 'admin' | 'operator' | 'viewer'
  is_active BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sessions for token management
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Custom user-defined protocols
CREATE TABLE custom_protocols (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,     -- 'indicator' | 'mobile'
  config TEXT NOT NULL,       -- JSON configuration
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Station configuration
CREATE TABLE stations (
  id INTEGER PRIMARY KEY,
  base_code TEXT UNIQUE NOT NULL,
  station_name TEXT NOT NULL,
  bidirectional BOOLEAN DEFAULT FALSE,
  multi_deck_per_bound BOOLEAN DEFAULT FALSE
);

-- Bound configuration
CREATE TABLE station_bounds (
  id INTEGER PRIMARY KEY,
  station_id INTEGER NOT NULL,
  bound_letter TEXT NOT NULL,
  full_code TEXT NOT NULL,
  bound_name TEXT NOT NULL,
  FOREIGN KEY (station_id) REFERENCES stations(id)
);

-- Settings key-value store
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Device configuration (indicators)
CREATE TABLE devices (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  protocol TEXT NOT NULL,
  connection_type TEXT NOT NULL,
  config TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE
);

-- Weight thresholds configuration (no weight logging - middleware only stores config)
CREATE TABLE thresholds (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  mode TEXT NOT NULL,              -- 'multideck' | 'mobile'
  min_weight INTEGER DEFAULT 200,  -- Minimum valid axle/deck weight (kg)
  max_weight INTEGER DEFAULT 100000,
  vehicle_detection INTEGER DEFAULT 500,
  stable_tolerance INTEGER DEFAULT 50,
  motion_timeout INTEGER DEFAULT 5000,
  is_active BOOLEAN DEFAULT TRUE
);

-- RDU device configuration
CREATE TABLE rdu_devices (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  connection_type TEXT NOT NULL,
  port TEXT,
  host TEXT,
  network_port INTEGER,
  baud_rate INTEGER DEFAULT 1200,
  deck_index INTEGER NOT NULL,
  is_active BOOLEAN DEFAULT TRUE
);

-- Autoweigh API configuration
CREATE TABLE autoweigh_config (
  id INTEGER PRIMARY KEY,
  enabled BOOLEAN DEFAULT FALSE,
  server_host TEXT,
  server_port INTEGER DEFAULT 4444,
  protocol TEXT DEFAULT 'http',
  auth_endpoint TEXT,
  post_endpoint TEXT,
  data_format TEXT DEFAULT 'truload',
  email TEXT,
  password TEXT
);
```

---

## Implementation Order

### Phase 1: Core Infrastructure
- Upgrade deps (Electron 35.x, better-sqlite3 11.x, serialport 12.x)
- Create src/ structure
- Implement Database.js with migrations
- Implement ConfigManager with validation

### Phase 2: Parser System
- ParserFactory with registry
- ZmParser, CardinalParser, Cardinal2Parser, I1310Parser
- MobileScaleParser (PAW + Haenni)
- **CustomParser** with regex/delimiter/fixed/json parsing

### Phase 3: Input/Output
- InputManager with 4 source types
- WebSocketOutput (port 8080) - DEFAULT
- ApiOutput (port 3031) - FALLBACK
- SerialRduOutput with $=XXXXXXXX= format
- **Only ONE mode active** (realtime OR polling)

### Phase 4: Two-Way Communication
- ConnectionPool for client tracking
- Message handlers: register, plate, bound-switch, status-request
- Station/bound configuration UI
- Auto-weigh integration with plate data

### Phase 5: Authentication & Security
- AuthManager with login/logout and session tokens
- Password hashing with bcryptjs
- AuthMiddleware for route protection
- Role-Based Access Control (RBAC):
  - **admin**: Full access (settings, users, protocols)
  - **operator**: Can view dashboard, trigger captures
  - **viewer**: Read-only dashboard access
- Login page UI with remember-me option
- Protected pages: Settings, Device Management
- Public pages: Dashboard (read-only view)
- Seed default admin user on first run

### Phase 6: Simulation & Polish
- SimulationEngine with static/dynamic/pattern modes
- Production build and packaging
- Performance optimization (memory, CPU, latency)

---

## Key Design Decisions

1. **Exclusive Output Modes**: Only realtime (WebSocket) OR polling (API) active, never both
2. **Custom Protocol Support**: User can define regex/delimiter/fixed/JSON parsing rules
3. **Two-Way WebSocket**: TruLoad sends station code, bound, plate; TruConnect sends weights
4. **Station/Bound Patterns**: Support ROMIA/ROKSA (bidirectional), ATMBA/ATMBB (multi-deck)
5. **Authentication & RBAC**: Dashboard public (read-only), settings protected, role-based permissions
6. **Performance**: Efficient event-driven architecture, minimal memory footprint, <50ms weight latency

---

## Verification

1. **Parser Tests**: Test each parser with sample data from iConnect
2. **WebSocket Test**: Connect with wscat, send register/plate messages
3. **RDU Test**: Verify $=00250000= format for weight 5200
4. **Custom Protocol Test**: Configure delimiter parser, verify parsing
5. **Mode Switch Test**: Verify only one output mode active at a time
6. **Auth Test**: Login with admin@truconnect.local / Admin@123!, verify protected pages
7. **RBAC Test**: Verify operator cannot access user management, viewer is read-only
8. **Performance Test**: Memory <150MB, CPU <2% idle, weight latency <50ms
