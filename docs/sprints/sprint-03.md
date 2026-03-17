# Sprint 03: Data Output Protocols

**Duration**: 4-5 days  
**Goal**: Implement all data output methods (WebSocket, API, Serial RDU, Network Port)

---

## Objectives

1. Create unified output manager
2. Implement WebSocket real-time output
3. Implement REST API polling server
4. Refactor Serial RDU output
5. Implement Network/Port mapping output
6. Add output enable/disable configuration

---

## Tasks

### 3.1 Output Manager
- [x] Create `src/output/OutputManager.js`:
  - Output source registration
  - Broadcasting to all enabled outputs
  - Independent failure handling (one failure doesn't affect others)
  - **Only ONE primary mode active** (WebSocket OR API)
  - RDU output can run alongside either mode

### 3.2 WebSocket Output
- [x] Create `src/output/WebSocketOutput.js`:
  - Server mode (local WebSocket server on port 8080)
  - Two-way communication with TruLoad clients
  - Message handlers: register, plate, bound-switch, status-request
  - Mobile mode: axle-captured, vehicle-complete, reset-session, query-weight
  - JSON message format (Standardized)
  - Connection status tracking & ping/pong keepalive
- [x] Add configuration in defaults.js

### 3.3 REST API Server
- [x] Create `src/output/ApiOutput.js`:
  - Express server setup
  - Configurable port (default 3031)
  - CORS support
  - Endpoints:
    - `GET /weights` - Current weights with status
    - `GET /weights/:deck` - Specific deck weight
    - `GET /gvw` - GVW total
    - `GET /status` - System status
    - `POST /plate` - Submit plate number
    - `POST /capture` - Request weight capture
    - `POST /register` - Station registration
    - `GET /health` - Server health check
- [x] Add configuration in defaults.js

### 3.4 Serial RDU Output
- [x] Create `src/output/SerialRduOutput.js`:
  - Message format: `$=XXXXXXXX=` (reversed, zero-padded)
  - 1200 baud default for displays
  - Auto-reconnect support
  - Periodic weight sending (5Hz update rate)
- [x] Add configuration in defaults.js

### 3.5 Network RDU Integration (USRN)
- [x] Create `src/output/NetworkRduOutput.js`:
  - **Serial-to-Ethernet** transparent transmission
  - TCP Client mode for USR-TCP232 series devices
  - Default port: 4196
  - Auto-reconnect with exponential backoff
  - Same message format as SerialRduOutput
- [x] Add configuration in defaults.js

### 3.6 Default Output Behavior
- [x] Implement default enable logic:
  - Real-time (WebSocket): DEFAULT mode
  - API Polling: FALLBACK mode (only one active at a time)
  - Serial RDU: Enable if port configured
  - Network RDU: Enable if host configured
- [x] Mode switching via OutputManager.switchMode()

---

## Deliverables

1. Unified OutputManager
2. WebSocket output (server & client modes)
3. REST API server with endpoints
4. Refactored Serial RDU output
5. Network port mapping output
6. Configuration integration

---

## Verification

### Unit Tests
```bash
# Run output tests
npm test -- --grep "Output"
```

### Integration Tests

#### WebSocket Test
1. Enable WebSocket server mode on port 8080
2. Connect with WS client (e.g., wscat)
3. Trigger weight update
4. Verify JSON message received

#### API Test
1. Enable API polling on port 3031
2. Request `GET http://localhost:3031/weights`
3. Verify response format matches legacy
4. Test POST endpoints

#### Serial RDU Test
1. Configure RDU device on COM port
2. Connect RDU display or serial monitor
3. Trigger weight update
4. Verify `$=XXXXXXXX=` message format

#### Network Port Test
1. Configure network mapping (host, port)
2. Set up TCP server on target port
3. Trigger weight update
4. Verify data received on network port
