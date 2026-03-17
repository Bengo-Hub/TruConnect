# Sprint 10: TruLoad Frontend Integration

**Duration**: 2-3 days
**Goal**: Define and implement communication protocol between TruConnect middleware and TruLoad frontend for real-time weight capture, plate notifications, and scale status monitoring.

---

## Objectives

1. Define WebSocket communication protocol for frontend integration
2. Implement scale-status broadcasting in WebSocketOutput
3. Create useMiddleware hook for TruLoad frontend
4. Update documentation with integration guide
5. Support both mobile and multideck weighing workflows

---

## Background: Frontend-Middleware Communication

### Previous State
- WebSocket server existed but lacked comprehensive event documentation
- Frontend (TruLoad) had no dedicated hook for middleware communication
- Scale connection status not broadcasted to clients
- Mobile mode axle capture workflow incomplete

### New Architecture
- Comprehensive WebSocket event specification
- `useMiddleware` React hook for frontend integration
- Scale status events for connection monitoring
- Complete mobile/multideck workflow support
- Simulation mode awareness

---

## Tasks

### 10.1 WebSocket Event Specification

- [x] Define server → client events:
  - `connected` - Connection established
  - `weights` - Multideck weight update
  - `weight` - Mobile weight update (single axle)
  - `scale-status` - Scale connection status
  - `register-ack` - Registration acknowledgement
  - `plate-ack` - Plate capture acknowledgement
  - `axle-captured-ack` - Axle capture acknowledgement
  - `vehicle-complete-ack` - Vehicle complete acknowledgement
  - `session-reset-ack` - Session reset acknowledgement
  - `error` - Error notification

- [x] Define client → server events:
  - `register` - Register with station, bound, mode
  - `plate` - Notify plate capture with ANPR image path
  - `axle-captured` - Confirm axle weight capture
  - `vehicle-complete` - Complete vehicle weighing
  - `query-weight` - Request current weight
  - `status-request` - Request system status
  - `bound-switch` - Switch weighing direction
  - `reset-session` - Reset current session

### 10.2 WebSocketOutput Enhancements

- [x] Add `broadcastScaleStatus()` method for scale connection status
- [x] Add `broadcastWeight()` method with mode-aware formatting
- [x] Update event documentation header
- [x] Support simulation flag in broadcasts

### 10.3 Frontend useMiddleware Hook

- [x] Create `src/hooks/useMiddleware.ts` for TruLoad frontend:
  - WebSocket connection management
  - Auto-reconnect with configurable interval
  - State management (connected, registered, weights, scaleStatus)
  - Actions: sendPlate, captureAxle, completeVehicle, queryWeight, resetSession
  - Callbacks for weight updates and status changes

### 10.4 Integration Documentation

- [x] Create `docs/frontend-integration.md`:
  - Complete event reference
  - Message format examples
  - Workflow diagrams
  - Hook usage examples
  - Testing instructions

---

## Code Changes

### Files Created

1. **docs/frontend-integration.md**
   - Comprehensive integration guide
   - WebSocket message reference
   - Hook implementation example
   - Workflow diagrams

2. **truload-frontend/src/hooks/useMiddleware.ts**
   - React hook for middleware communication
   - TypeScript types for all events
   - Connection management
   - Action methods

### Files Modified

1. **src/output/WebSocketOutput.js**
   - Updated event documentation header
   - Added `broadcastScaleStatus()` method
   - Added `broadcastWeight()` method

---

## Event Reference

### Server → Client Events

| Event | Description | Key Fields |
|-------|-------------|------------|
| `weights` | Multideck weight update | mode, deck1-4, gvw, stable, simulation |
| `weight` | Mobile weight update | mode, weight, axleNumber, axleWeights, runningTotal |
| `scale-status` | Scale connection status | mode, connected, simulation, protocol, scaleA, scaleB |
| `register-ack` | Registration confirmed | success, stationCode, bound, mode |
| `plate-ack` | Plate captured | success, plateNumber, vehicleId |

### Client → Server Events

| Event | Description | Key Fields |
|-------|-------------|------------|
| `register` | Register client | stationCode, bound, mode |
| `plate` | Capture plate | plateNumber, vehicleType, anprImagePath |
| `axle-captured` | Capture axle weight | axleNumber, weight, axleConfigurationId |
| `vehicle-complete` | Complete weighing | totalAxles, axleWeights, gvw |
| `query-weight` | Request weight | type (current/next-axle) |
| `reset-session` | Reset session | (none) |

---

## Weighing Workflows

### Mobile Mode (Axle-by-Axle)

```
Frontend                          TruConnect
   │                                  │
   ├──── register ────────────────────▶│
   │◀───── register-ack ──────────────┤
   │                                  │
   ├──── plate ───────────────────────▶│
   │◀───── plate-ack ─────────────────┤
   │                                  │
   │◀───── weight (axle 1) ───────────┤ (scale reading)
   ├──── axle-captured ───────────────▶│
   │◀───── axle-captured-ack ─────────┤
   │                                  │
   │◀───── weight (axle 2) ───────────┤
   ├──── axle-captured ───────────────▶│
   │◀───── axle-captured-ack ─────────┤
   │                                  │
   │       ... repeat for all axles   │
   │                                  │
   ├──── vehicle-complete ────────────▶│
   │◀───── vehicle-complete-ack ──────┤
   │                                  │
```

### Multideck Mode (Simultaneous)

```
Frontend                          TruConnect
   │                                  │
   ├──── register ────────────────────▶│
   │◀───── register-ack ──────────────┤
   │                                  │
   │◀───── weights (continuous) ──────┤ (all decks)
   │                                  │
   ├──── plate ───────────────────────▶│
   │◀───── plate-ack ─────────────────┤
   │                                  │
   │◀───── weights (vehicle detected) ┤
   │                                  │
   ├──── vehicle-complete ────────────▶│
   │◀───── vehicle-complete-ack ──────┤
   │                                  │
```

---

## Deliverables

1. [x] WebSocket event specification document
2. [x] WebSocketOutput scale-status broadcasting
3. [x] Frontend useMiddleware hook
4. [x] Integration guide documentation
5. [x] Sprint documentation

---

## Verification

### WebSocket Integration Test

1. Start TruConnect middleware
2. Open browser console and connect:
```javascript
const ws = new WebSocket('ws://localhost:3030');
ws.onmessage = (e) => console.log(JSON.parse(e.data));
ws.send(JSON.stringify({
  event: 'register',
  data: { stationCode: 'ROMIA', bound: 'A', mode: 'mobile' }
}));
```
3. Verify `register-ack` received with `success: true`

### Scale Status Test

1. Enable simulation mode in TruConnect
2. Connect via WebSocket
3. Verify `scale-status` event shows `simulation: true`
4. Verify `weight` events include `simulation: true`

### useMiddleware Hook Test

1. Import hook in TruLoad frontend:
```tsx
import { useMiddleware } from '@/hooks/useMiddleware';

function WeighingPage() {
  const {
    connected,
    weights,
    scaleStatus,
    simulation,
    sendPlate,
    captureAxle,
  } = useMiddleware({
    stationCode: 'ROMIA',
    mode: 'mobile',
  });

  // Use in component...
}
```
2. Verify connection status displays correctly
3. Verify weight updates received
4. Verify plate capture works

---

## Cloud Architecture Integration (Extended)

### 10.5 Cloud Architecture Gap Analysis

Analyzed the production deployment scenario where:
- Frontend: Cloud-hosted at `https://kuraweightest.masterspace.co.ke`
- Backend: Cloud-hosted at `https://kuraweighapitest.masterspace.co.ke`
- Middleware: Local desktop app (TruConnect)

**Critical Finding**: Cloud-hosted frontend cannot directly connect to local middleware via WebSocket.

**Solutions Implemented**:

1. **Auto-Weigh Mode** - TruConnect posts weights directly to cloud backend
2. **Backend Relay Mode** - TruConnect connects to backend WebSocket, backend relays to frontend
3. **Direct Mode** - For local development where frontend runs locally

- [x] Create `docs/cloud-architecture-gap-analysis.md`
- [x] Document all deployment scenarios
- [x] Define migration path for cloud deployment

### 10.6 Middleware Configuration Updates

Added auto-weigh and cloud connection configuration to `defaults.js`:

```javascript
// Auto-weigh configuration (post weights to cloud backend)
autoWeigh: {
  enabled: false,
  backendUrl: '',                          // e.g., https://kuraweighapitest.masterspace.co.ke
  endpoint: '/api/v1/autoweigh',
  stationCode: '',
  retryAttempts: 3,
  sendOnCapture: true,
  sendOnVehicleComplete: true
},

// Cloud connection (backend relay mode)
cloudConnection: {
  enabled: false,
  backendWsUrl: '',                        // e.g., wss://kuraweighapitest.masterspace.co.ke/ws/middleware
  reconnectInterval: 5000,
  heartbeatInterval: 30000
}
```

- [x] Add `autoWeigh` configuration section
- [x] Add `cloudConnection` configuration section
- [x] Document configuration options

### 10.7 Backend ERD Updates

Added new tables to TruLoad Backend ERD:

1. **station_middleware_settings** - Per-station middleware configuration
   - connection_mode (websocket/polling/backend_relay)
   - middleware URLs
   - scale protocol/port settings
   - simulation mode toggle

2. **system_configurations** - Global key-value configuration store
   - Middleware defaults
   - Auto-weigh settings
   - Backend relay configuration

- [x] Add `station_middleware_settings` table definition
- [x] Add `system_configurations` table definition
- [x] Define seed data for default configurations

---

## iConnect Auto-Weigh Pattern Reference

Analyzed legacy iConnect → KenloadV2 integration:

**Pattern** (from `kenloadv2.js`):
```javascript
// iConnect authenticates with backend
axios.post(server + ':' + serverport + '/api/AuthManagement/Login', credentials);

// Posts auto-weigh data
axios.post(server + ':' + serverport + '/api/AutoWeigh', {
  anpr: plateNumber,
  nplate: plateNumber,
  gvw: totalWeight,
  autodatetime: new Date(),
  stationcode: stationCode,
  autostatus: 'W' // Weighed
});
```

**TruConnect Implementation**:
- Same pattern but with modern authentication (JWT)
- Enhanced payload with axle-by-axle data
- Retry logic and batch mode support

---

## Production Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CLOUD (K8s)                                       │
│  ┌───────────────────────┐    ┌───────────────────────────────────┐    │
│  │ kuraweightest.        │◄──►│ kuraweighapitest.masterspace.co.ke│    │
│  │ masterspace.co.ke     │    │                                    │    │
│  │ (TruLoad Frontend)    │    │ (TruLoad Backend)                  │    │
│  │                       │    │ - /api/v1/autoweigh               │    │
│  │                       │    │ - /ws/middleware (relay)          │    │
│  └───────────────────────┘    └─────────────────┬─────────────────┘    │
└─────────────────────────────────────────────────┼───────────────────────┘
                                                  │ HTTPS/WSS
                                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        LOCAL (Field Station)                             │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ TruConnect Middleware (Electron Desktop App)                       │  │
│  │ - Connects to cloud backend                                        │  │
│  │ - Posts auto-weigh data                                           │  │
│  │ - Receives commands from backend                                  │  │
│  └───────────────────────┬───────────────────────────────────────────┘  │
│                          │                                               │
│  ┌───────────────────────▼───────────────────────────────────────────┐  │
│  │ Scales (PAW Serial COM7 / Haenni HTTP :8888)                      │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Next Steps

1. Integrate useMiddleware hook with CaptureScreen component
2. Add scale connection status cards to weighing UI
3. Implement ANPR image capture and path notification
4. Add simulation mode indicator to frontend
5. Complete backend → middleware → frontend data flow
6. **Implement backend `/api/v1/autoweigh` endpoint**
7. **Implement backend WebSocket relay endpoint (`/ws/middleware`)**
8. **Create frontend Settings → Middleware Configuration page**
9. **Test cloud deployment scenario end-to-end**

---

## Documentation Updates

- [x] docs/frontend-integration.md - New integration guide
- [x] docs/sprints/sprint-10.md - This document
- [x] docs/cloud-architecture-gap-analysis.md - Cloud deployment analysis
- [x] src/output/WebSocketOutput.js - Event documentation
- [x] src/config/defaults.js - Auto-weigh and cloud connection config
- [x] truload-backend/docs/erd.md - Middleware settings tables

---

## PWA Offline Mode - Hybrid Connection Strategy (10.8)

### Critical Insight

**When a PWA is installed and running offline:**
1. Service worker serves cached app assets locally
2. Browser runs locally on user's machine
3. Browser CAN connect to localhost WebSocket even without internet!

### Implementation

Updated `useMiddleware` hook with:
- [x] Connection priority chain (Backend WS → Local WS → API Polling)
- [x] Network state detection (`navigator.onLine`)
- [x] Automatic fallback on connection failure
- [x] `forceLocalConnection()` and `forceBackendConnection()` methods
- [x] `connectionMode` state for UI display

### Connection Flow

```
Online + Backend Available:
  Frontend ←→ Backend WS ←→ Middleware ←→ Scales

Offline (PWA Mode):
  Frontend ←→ Local WS (localhost:3030) ←→ Middleware ←→ Scales
  [Weighings stored in IndexedDB, synced when online]

Development:
  Frontend ←→ Local WS (localhost:3030) ←→ Middleware ←→ Scales
```

### Files Updated

- [x] truload-frontend/src/hooks/useMiddleware.ts - Full hybrid connection implementation
- [x] docs/cloud-architecture-gap-analysis.md - PWA offline mode documentation
- [x] docs/frontend-integration.md - Updated hook documentation

---

## Input Source Configuration Restructure (10.9)

### Problem Statement

The previous input configuration had several issues:
1. Single `input.indicator` config couldn't distinguish between PAW (serial) and Haenni (API)
2. No way to configure multiple indicator models with different protocols
3. Only one input source should be active at a time
4. Settings not loading properly on startup (simulation not starting without fresh save)

### Solution: Separate Input Source Configurations

Restructured `defaults.js` input configuration to have:

```javascript
input: {
  // Currently active input source
  activeSource: 'none',  // 'none' | 'paw' | 'haenni' | 'indicator_zm' | etc.

  // Mobile Scales (axle-by-axle)
  paw: {          // PAW Portable Axle Weigher - Serial
    enabled: false,
    type: 'serial',
    protocol: 'PAW',
    serial: { port: 'COM7', baudRate: 9600, ... }
  },
  haenni: {       // Haenni WL Portable - API
    enabled: false,
    type: 'api',
    protocol: 'HAENNI',
    api: { url: 'http://localhost:8888/devices/measurements', interval: 500 }
  },

  // Multideck Indicators (platform/static weighbridge)
  indicator_zm: { ... },
  indicator_cardinal: { ... },
  indicator_cardinal2: { ... },
  indicator_1310: { ... },
  custom: { ... },

  decks: [ ... ]
}
```

### InputManager Updates

- [x] Rewritten to support new configuration structure
- [x] Implements exclusive source activation (only one active at a time)
- [x] `activateSource(sourceName)` - Activate a specific input source
- [x] `switchSource(newSource)` - Deactivate current and activate new
- [x] `getAvailableSources()` - List all configured sources with status
- [x] Backward compatibility with legacy `input.indicator` format

### Main.js Updates

- [x] Uses InputManager instead of direct API polling
- [x] `initializeInputSources()` - Initializes correct source on startup
- [x] Legacy config migration (converts old format to new)
- [x] IPC handlers for input source management:
  - `input:get-status` - Get current input status
  - `input:get-sources` - Get available sources
  - `input:switch-source` - Switch active source
  - `input:get-ports` - List available COM ports
  - `simulation:toggle` - Enable/disable simulation
  - `simulation:get-status` - Get simulation status

### Settings Loading Fix

- [x] Bumped seed version to `2.1.0` for new settings structure
- [x] Added debugging logs to ConfigManager for settings loading
- [x] Settings load from database on startup (no login required)
- [x] Simulation and input sources initialize from saved settings

### Key Files Modified

| File | Changes |
|------|---------|
| `src/config/defaults.js` | Restructured input configuration |
| `src/input/InputManager.js` | Complete rewrite for exclusive activation |
| `main.js` | InputManager integration, startup fixes |
| `src/config/ConfigManager.js` | Added debugging logs |
| `src/database/Seed.js` | Bumped version to 2.1.0 |

### Usage Example

```javascript
// Activate PAW scale
await InputManager.switchSource('paw');

// Switch to Haenni
await InputManager.switchSource('haenni');

// Disable all input (use simulation)
await InputManager.switchSource('none');
SimulationEngine.start();

// Get current status
const status = InputManager.getStatus();
// { running: true, activeSource: 'paw', type: 'serial', protocol: 'PAW', ... }
```

---

## Settings UI Input Source Separation (10.10)

### Problem

The settings UI combined PAW and Haenni as "Mobile Scale (PAW/Haenni)" but they are fundamentally different:
- **PAW**: Serial connection to weight console (COM7, 9600 baud)
- **Haenni**: HTTP API to local webserver (localhost:8888)

Also, legacy "Mobile" protocol was not being migrated correctly.

### Solution

1. **Updated Settings UI** (`pages/settings.html`):
   - Separate dropdown options for PAW and Haenni
   - PAW config: COM port, baud rate, query command
   - Haenni config: API URL, poll interval
   - Multideck indicators: connection type (serial/TCP), query command
   - Custom protocol configuration

2. **Fixed Legacy Migration** (`main.js`):
   - "Mobile" protocol now maps to PAW (serial) or Haenni (API) based on connection type
   - Added protocol mapping for all indicator types

3. **Implemented Serial Query Commands** (`InputManager.js`):
   - Added `_startQueryPolling()` for periodic weight queries
   - Added `_sendQuery()` to send query commands to serial devices
   - Supports ENQ (0x05) and text commands
   - Configurable query interval (default 500ms)

### Query Commands Reference

| Device/Protocol | Query Command | Response Format |
|-----------------|---------------|-----------------|
| PAW Weight Console | 'W' | `ST,GS, 0000270kg` |
| ZM Protocol | 'W' | `G:+00001234` |
| Cardinal 190/210 | (continuous) | 90-char frames |
| Cardinal 225/738 | ENQ (0x05) | Per-deck response |
| Rice Lake 1310 | ENQ (0x05) | STX...ETX frame |

### Key Files Modified

| File | Changes |
|------|---------|
| `pages/settings.html` | Separate PAW/Haenni config sections |
| `main.js` | Fixed legacy "Mobile" protocol migration |
| `src/input/InputManager.js` | Added serial query polling |

---

## Serial Port Connection Fixes (10.11)

### Problem

Serial port connections were failing with **Error Code 31** (ERROR_GEN_FAILURE) when using CH340/CH341 USB-serial adapters on Windows.

```
Failed to open COM7: Open (SetCommState): Unknown error code 31
```

### Root Cause

This is a known issue with newer CH340 driver versions (3.8+). The driver doesn't properly implement all required IOCTL codes for SetCommState operations.

### Solution

1. **Driver Downgrade**: Install CH340 driver version 3.5 (3.5.2019.1)
   - Download from: https://github.com/wemos/ch340_driver
   - Uninstall current CH340 driver from Device Manager
   - Install v3.5 driver
   - Restart computer

2. **Enhanced SerialInput.js**: Added better error handling and diagnostics
   - `listPorts()` - Lists available ports with USB-serial identification
   - `checkPort()` - Verifies port availability before connecting
   - `getDetailedError()` - Provides specific guidance for common errors
   - Exponential backoff for reconnection attempts
   - Max reconnect attempts limit (10)

3. **Serial Test Utility**: Created `tests/serial_test.js`
   - Lists all available COM ports with device info
   - Tests connection to specified port
   - Sends test commands and displays responses
   - Provides troubleshooting guidance for errors

### Key Files Modified

| File | Changes |
|------|---------|
| `src/input/SerialInput.js` | Enhanced error handling, port detection |
| `src/input/InputManager.js` | Updated `getAvailablePorts()` with filtering |
| `tests/serial_test.js` | New serial port test utility |

### Usage: Serial Test Utility

```bash
# List all ports and test first available
node tests/serial_test.js

# Test specific port
node tests/serial_test.js COM7 9600
```

### Error Code Reference

| Error Code | Windows Error | Likely Cause | Fix |
|------------|---------------|--------------|-----|
| 31 | ERROR_GEN_FAILURE | CH340 driver issue | Downgrade to v3.5 |
| 87 | ERROR_INVALID_PARAMETER | Invalid serial settings | Check baud rate, data bits |
| 2 | ERROR_FILE_NOT_FOUND | Port doesn't exist | Check Device Manager |
| 5 | ERROR_ACCESS_DENIED | Port in use | Close other applications |

---

## API Response Format Updates (10.12)

### Problem

The API endpoint `/api/v1/weights` was returning multideck format regardless of capture mode:
```json
{
  "success": true,
  "data": { "deck1": 0, "deck2": 0, "deck3": 0, "deck4": 0, "gvw": 0 },
  "timestamp": "..."
}
```

Mobile mode requires different data (current weight, axles, battery, temp).

### Solution

1. **Mode-Specific API Response** (`ApiOutput.js`):
   - Detects capture mode from StateManager
   - Returns mode-appropriate data structure
   - Includes connection info (protocol, type, status)

2. **Mobile Mode Response**:
```json
{
  "success": true,
  "mode": "mobile",
  "data": {
    "currentWeight": 270,
    "stable": true,
    "session": { "currentAxle": 2, "totalAxles": 2, "axles": [...], "gvw": 540 },
    "scaleInfo": { "battery": 100, "temperature": 25, "signalStrength": 100 }
  },
  "connection": { "source": "paw", "protocol": "PAW", "type": "serial", "connected": true },
  "timestamp": "..."
}
```

3. **Multideck Mode Response**:
```json
{
  "success": true,
  "mode": "multideck",
  "data": {
    "decks": [
      { "index": 1, "weight": 5200, "stable": true },
      { "index": 2, "weight": 6300, "stable": true },
      ...
    ],
    "gvw": 23500,
    "vehicleOnDeck": true
  },
  "connection": { "source": "indicator_zm", "protocol": "ZM", "type": "serial", "connected": true },
  "timestamp": "..."
}
```

4. **StateManager Enhancements**:
   - Added `inputSource` state (name, protocol, connectionType, connected)
   - Added `mobileScaleInfo` state (battery, temperature, signalStrength)
   - Added getter/setter methods for both

5. **Dashboard Updates** (`pages/index.html`):
   - Added connection info display in header (protocol/type)
   - Added scale info bar for mobile mode (battery, temp, protocol, type)
   - Connection status includes protocol info

6. **useMiddleware Hook Updates** (`truload-frontend/src/hooks/useMiddleware.ts`):
   - Updated `handlePollingResponse()` to parse new API format
   - Extracts mode-specific weight data
   - Updates scale status with connection and scale info

### Key Files Modified

| File | Changes |
|------|---------|
| `src/output/ApiOutput.js` | Mode-specific response format |
| `src/core/StateManager.js` | Input source and scale info state |
| `main.js` | Connection status events with protocol info |
| `pages/index.html` | Scale info bar, connection info display |
| `truload-frontend/src/hooks/useMiddleware.ts` | Parse new API response format |

---

## Mobile Mode Weight Separation (10.13)

### Problem

Mobile mode was incorrectly displaying deck values instead of the live scale weight:
- PAW parser returned `deck: 1` causing weight to be stored as `deck1`
- UI displayed `deck1` value even in mobile mode
- Reset button didn't properly reset mobile session
- Weight updates weren't broadcasting in mobile mode

### Solution

1. **StateManager Updates**:
   - Added `currentMobileWeight` and `mobileWeightStable` properties
   - Updated `getMobileWeightData()` to use `currentMobileWeight` instead of `deck1`
   - Updated `reset()` to clear mobile weight state

2. **InputManager Updates**:
   - Modified `_parseAndEmit()` to detect mobile mode/source
   - Mobile sources (paw, haenni) store weight as `currentMobileWeight`
   - Does NOT update deck weights in mobile mode
   - Emits `isMobile: true` flag in weight events

3. **Main.js Updates**:
   - Updated `get-initial-data` IPC handler for mode-specific response
   - Updated `broadcastWeights()` to send mode-appropriate data
   - Updated `input:weight` event handler for mobile mode
   - Fixed `mobile:capture-axle` IPC handler to use StateManager.addAxleWeight()
   - Fixed `mobile:reset-session` IPC handler to call StateManager.resetMobileSession()
   - Fixed `mobile:vehicle-complete` IPC handler to return session data

4. **UI Updates** (`pages/index.html`):
   - Updated `updateWeights()` to handle mode-specific data
   - Mobile mode uses `data.currentWeight`, multideck uses `data.deck1-4`
   - Fixed `handleWeightsUpdated()` to detect mobile weight data

### Data Flow

**Mobile Mode:**
```
Scale → Parser → InputManager → StateManager.currentMobileWeight
                            → EventBus 'input:weight' (isMobile: true)
                            → main.js → broadcastWeights()
                            → IPC 'weights-updated' {currentWeight, session, scaleInfo}
                            → index.html → updateWeights() → currentAxleWeight display
```

**Multideck Mode:**
```
Scale → Parser → InputManager → StateManager.weights.deck1-4
                            → EventBus 'input:weight' (isMobile: false)
                            → main.js → broadcastWeights()
                            → IPC 'weights-updated' {deck1-4, gvw, vehicleOnDeck}
                            → index.html → updateWeights() → deck displays
```

### Key Files Modified

| File | Changes |
|------|---------|
| `src/core/StateManager.js` | Added currentMobileWeight, updated getMobileWeightData |
| `src/input/InputManager.js` | Mobile mode detection in _parseAndEmit |
| `main.js` | Mode-specific IPC handlers and broadcasts |
| `pages/index.html` | Mode-specific updateWeights function |

---

## Backend Autoweigh Endpoint (10.14)

### New Endpoint

Implemented `POST /api/v1/weighing-transactions/autoweigh` for TruConnect middleware to send weight captures directly to the backend.

**Features:**
- Single-operation weighing: create transaction, capture weights, calculate compliance
- Vehicle lookup by registration number
- Idempotency via `ClientLocalId`
- Scale test validation
- Full compliance calculation with fees and prohibition generation
- Automatic ticket number generation

**Request DTO:**
```csharp
public class AutoweighCaptureRequest
{
    public Guid StationId { get; set; }
    public string? Bound { get; set; }
    public string VehicleRegNumber { get; set; }
    public Guid? VehicleId { get; set; }
    public List<WeighingAxleCaptureDto> Axles { get; set; }
    public string WeighingMode { get; set; } = "static";
    public DateTime? CapturedAt { get; set; }
    public string? Source { get; set; }
    public Guid? SourceDeviceId { get; set; }
    public string? ClientLocalId { get; set; }
}
```

**Response DTO:**
```csharp
public class AutoweighResultDto
{
    public Guid WeighingId { get; set; }
    public string TicketNumber { get; set; }
    public string VehicleRegNumber { get; set; }
    public int GvwMeasuredKg { get; set; }
    public int GvwPermissibleKg { get; set; }
    public int GvwOverloadKg { get; set; }
    public bool IsCompliant { get; set; }
    public string ControlStatus { get; set; }
    public decimal TotalFeeUsd { get; set; }
    public List<AxleComplianceDto> AxleCompliance { get; set; }
}
```

**Authorization:** Requires `weighing.webhook` permission.

### Key Files Modified

| File | Changes |
|------|---------|
| `DTOs/Weighing/WeighingTransactionDto.cs` | Added AutoweighCaptureRequest, AutoweighResultDto |
| `Services/Interfaces/Weighing/IWeighingService.cs` | Added ProcessAutoweighAsync method |
| `Services/Implementations/Weighing/WeighingService.cs` | Implemented ProcessAutoweighAsync |
| `Controllers/WeighingOperations/WeighingController.cs` | Added Autoweigh endpoint |
| `Repositories/Weighing/Interfaces/IWeighingRepository.cs` | Added GetByClientLocalIdAsync |
| `Repositories/Weighing/WeighingRepository.cs` | Implemented GetByClientLocalIdAsync |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-29 | Initial frontend integration |
| 1.1 | 2026-01-29 | Cloud architecture gap analysis and configuration |
| 1.2 | 2026-01-29 | PWA offline mode - Hybrid connection strategy |
| 1.3 | 2026-01-29 | Input source configuration restructure |
| 1.4 | 2026-01-29 | Settings UI PAW/Haenni separation, serial query commands |
| 1.5 | 2026-01-29 | Serial port connection fixes, CH340 driver documentation |
| 1.6 | 2026-01-29 | API response format updates, mode-specific data, scale info |
| 1.7 | 2026-01-29 | Mobile mode weight separation, fixed reset/capture IPC handlers |
| 1.8 | 2026-01-29 | Backend autoweigh endpoint implementation |
| 1.9 | 2026-01-29 | Fixed API /weights endpoint, running GVW calculation, axle capture sync |
| 2.0 | 2026-01-29 | Fixed backend Swagger route (/v1/docs), axios version pin, connection architecture analysis |
| 2.1 | 2026-01-29 | Added runningGvw for real-time GVW calculation during axle capture |
| 2.2 | 2026-01-29 | Full axle capture workflow: auto-detection, config sync, backend tracking |

---

## API and UI Sync Fixes (10.15)

### Problems Fixed

1. **API returning currentWeight: 0** - The API endpoint `/api/v1/weights` was reading from `weights.deck1` instead of `currentMobileWeight`
2. **GVW not updating** - The Total GVW display wasn't showing the running total (captured axles + current weight)
3. **Axle capture sync** - Axle captures weren't being properly synced between UI and StateManager

### Solutions

1. **ApiOutput.js** - Updated to use `StateManager.getCurrentMobileWeight()` static method
2. **StateManager** - Added static methods:
   - `getCurrentMobileWeight()` - Get current mobile weight
   - `getMobileWeightStable()` - Get stability status
   - `setCurrentMobileWeight(weight, stable)` - Set mobile weight with stability
3. **InputManager** - Updated to use static method for consistency with debug logging
4. **index.html** - Updated `updateMobileGvw()` to calculate: `capturedGvw + currentWeight`
5. **Backend build fixes** - Fixed WeighingRepository and WeighingService compilation errors

### Key Changes

| File | Changes |
|------|---------|
| `src/output/ApiOutput.js` | Use static getter for currentMobileWeight |
| `src/core/StateManager.js` | Added static getter/setter methods |
| `src/input/InputManager.js` | Use static setter, added debug logging |
| `pages/index.html` | Running GVW calculation, async captureAxle |
| `truload-backend/Repositories/Weighing/WeighingRepository.cs` | Fixed Guid parsing |
| `truload-backend/Services/Implementations/Weighing/WeighingService.cs` | Fixed null assignment |
| `truload-backend/Tests/Unit/Services/WeighingServiceTests.cs` | Added missing mock dependencies |

---

## Connection Architecture Analysis (10.16)

### Overview

Analyzed the fallback and priority mechanism for connections between truload-frontend, TruConnect, and truload-backend across scenarios: PWA offline, local dev, cloud online (API polling and WebSocket).

### Connection Priority Chain (useMiddleware Hook)

```
Frontend Connection Strategy:
1. Backend WebSocket (wss://backend/ws/weights)
   └─ When online & preferBackend=true & backendWsUrl configured
   └─ 5-second timeout

2. Local WebSocket (ws://localhost:3030)
   └─ Offline OR backend unavailable OR forceLocal=true
   └─ 5-second timeout

3. Local API Polling (http://localhost:3031/api/v1/weights)
   └─ Both WebSockets unavailable AND enablePollingFallback=true
   └─ Configurable interval (default 500ms)
```

### Automatic Fallback Mechanisms

| Trigger | Action |
|---------|--------|
| `navigator.onLine = false` | Switch to local WebSocket/API |
| `navigator.onLine = true` | Attempt backend reconnection |
| WebSocket connection timeout | Try next in priority chain |
| WebSocket close event | Schedule reconnect with exponential backoff |
| API poll failure | Retry on next interval |

### Environment Matrix

| Environment | Mode | Primary | Fallback 1 | Fallback 2 |
|-------------|------|---------|------------|------------|
| **Local Dev** | Online | Local WS (:3030) | Local API (:3031) | - |
| **PWA Offline** | Offline | Local WS (:3030) | Local API (:3031) | - |
| **Cloud Staging** | Online | Backend WS (❌) | Local WS | Local API |
| **Cloud Production** | Online | Backend WS (❌) | Local WS | Local API |

### Gap: Backend WebSocket Relay

**Problem:** The frontend's `useMiddleware` hook expects `wss://backend/ws/weights` but the backend doesn't implement this endpoint.

**Current Workaround:** Falls back to local TruConnect connection.

**Future Implementation (Sprint 11+):**
```
Backend WebSocket Relay Architecture:
┌──────────────────┐    SignalR/WS    ┌──────────────────┐
│ truload-frontend │ ◄──────────────► │  truload-backend │
│     (Browser)    │                   │   /ws/weights    │
└──────────────────┘                   └────────┬─────────┘
                                               │
                                    gRPC stream or polling
                                               │
                                       ┌───────▼─────────┐
                                       │   TruConnect    │
                                       │   (Station)     │
                                       └─────────────────┘
```

### Connection Status Indicators

The backend logs confirm activity:
```
[INF] HTTP GET /v1/docs/ responded 404 in 26.6197 ms
```
- HTTP 404 (not connection refused) = Server is running
- Serilog `[INF]` prefix = Backend request pipeline active
- Audit middleware logging = Request reached application

### Recommendation Summary

1. **Local Dev:** Works seamlessly - no changes needed
2. **PWA Offline:** Works seamlessly - fallback chain operational
3. **Cloud Mode:** Partial - needs backend WS relay or alternative:
   - Option A: Implement SignalR hub in backend
   - Option B: Use SSE (Server-Sent Events) from backend
   - Option C: Backend-initiated polling of TruConnect

### Key Files

| File | Role |
|------|------|
| `truload-frontend/src/hooks/useMiddleware.ts` | Hybrid connection hook with fallback |
| `TruConnect/src/output/WebSocketOutput.js` | Local WebSocket server (port 3030) |
| `TruConnect/src/output/ApiOutput.js` | Local REST API (port 3031) |
| `truload-backend/Program.cs` | Backend configuration (no WS relay yet) |

---

## Real-time Running GVW Fix (10.17)

### Problem

GVW was not updating in real-time during mobile axle capturing:
- API response showed `gvw: 0` (captured axles only) even when scale showed `currentWeight: 60`
- No real-time running total provided to frontend

### Solution

Added `runningGvw` field to all outputs:
- `runningGvw = capturedAxlesGvw + currentWeight` (real-time total)
- `session.gvw` = captured axles only (for reference)

### API Response Update

```json
{
  "success": true,
  "mode": "mobile",
  "data": {
    "currentWeight": 60,
    "runningGvw": 60,      // NEW: real-time total
    "stable": true,
    "session": {
      "currentAxle": 0,
      "totalAxles": 0,
      "axles": [],
      "gvw": 0             // Captured axles only
    }
  }
}
```

### Files Modified

| File | Changes |
|------|---------|
| `src/output/ApiOutput.js` | Added `runningGvw` to mobile response |
| `main.js` | Added `runningGvw` to IPC broadcast |
| `truload-frontend/src/hooks/useMiddleware.ts` | Parse `runningGvw`, use for `gvw` and `runningTotal` |

---

## Axle Capture Workflow Implementation (10.18)

### Overview

Implemented full axle capture workflow with frontend-middleware sync, automatic next axle detection, and backend status tracking.

### Requirements Addressed

1. **AXLE UNDEFINED label fix** - Axle list now correctly shows axle numbers
2. **Frontend-Middleware sync** - Bidirectional communication for capture acknowledgment
3. **Auto next axle detection** - Middleware monitors weight changes to detect next axle
4. **Axle configuration sync** - Frontend sends expected axle count to middleware
5. **Backend GVW status tracking** - Track auto-weigh vs final captured status

### Workflow Diagram

```
Frontend (TruLoad)                    Middleware (TruConnect)                    Backend
       │                                      │                                     │
       │ 1. Set axle config                   │                                     │
       ├─────────────────────────────────────►│                                     │
       │    {expectedAxles, axleConfigCode}   │                                     │
       │                                      │                                     │
       │ 2. Vehicle arrives on scale          │                                     │
       │                                      │◄─── Weight from scale               │
       │                                      │     (currentWeight: 5000kg)         │
       │◄─────────────────────────────────────┤                                     │
       │    weights-updated {currentWeight}   │                                     │
       │                                      │                                     │
       │ 3. Capture Axle 1                    │                                     │
       ├─────────────────────────────────────►│                                     │
       │    mobile:capture-axle               │                                     │
       │◄─────────────────────────────────────┤                                     │
       │    {success, axleNumber, gvw,        │                                     │
       │     remainingAxles, isComplete}      │                                     │
       │                                      │                                     │
       │ 4. Auto-detection starts             │                                     │
       │                                      │ state: waiting_zero                 │
       │                                      │                                     │
       │ 5. Vehicle moves to next axle        │                                     │
       │◄─────────────────────────────────────┤ weight drops < 50kg                 │
       │    axle:vehicle-moving               │ state: waiting_stable               │
       │                                      │                                     │
       │ 6. Next axle on scale (stable)       │                                     │
       │◄─────────────────────────────────────┤ weight > 100kg & stable             │
       │    axle:next-ready {axleNumber,      │                                     │
       │     weight, remainingAxles}          │                                     │
       │                                      │                                     │
       │ 7. Capture remaining axles...        │                                     │
       │    (repeat 3-6)                      │                                     │
       │                                      │                                     │
       │ 8. All axles captured                │                                     │
       │    isComplete: true                  │                                     │
       │                                      │                                     │
       │ 9. Submit final weights              │                                     │
       ├───────────────────────────────────────────────────────────────────────────►│
       │    POST /weighing-transactions       │                                     │
       │    {axles, CaptureSource: "frontend",│                                     │
       │     IsFinalCapture: true}            │                                     │
       │                                      │                                     │
       │◄──────────────────────────────────────────────────────────────────────────┤
       │    {CaptureStatus: "captured"}       │                                     │
```

### StateManager Updates

Added axle configuration and auto-detection capabilities:

```javascript
// Axle configuration from frontend
this.axleConfig = {
  expectedAxles: 0,
  axleConfigurationId: null,
  axleConfigurationCode: null,
  vehicleId: null,
  plateNumber: null
};

// Auto-detection state machine
this.autoDetection = {
  enabled: false,
  state: 'idle' | 'waiting_zero' | 'waiting_stable',
  lastWeight: 0,
  zeroThreshold: 50,      // Weight below this = off scale
  stableThreshold: 100,   // Minimum for valid reading
  stabilityCount: 0,
  requiredStableReadings: 3
};
```

### New Methods

**StateManager:**
- `setAxleConfiguration(config)` - Set expected axles from frontend
- `getAxleConfiguration()` - Get current axle config
- `isWeighingComplete()` - Check if all axles captured
- `getRemainingAxles()` - Get count of remaining axles
- `setAutoDetection(enabled, options)` - Enable/disable auto-detection
- `processAutoDetection(weight, stable)` - Process weight for auto-detection
- `startNextAxleDetection()` - Start monitoring after capture

**IPC Handlers (main.js):**
- `mobile:set-axle-config` - Set axle configuration
- `mobile:get-axle-config` - Get axle configuration
- `mobile:is-complete` - Check completion status

**Preload API:**
- `setAxleConfig(config)` - Set axle configuration
- `getAxleConfig()` - Get axle configuration
- `isWeighingComplete()` - Check completion
- `onNextAxleReady(callback)` - Event: next axle ready
- `onVehicleMoving(callback)` - Event: vehicle moving to next axle

### Auto-Detection State Machine

```
                    axle captured
                         │
                         ▼
         ┌─────────────────────────────┐
         │           IDLE              │
         │   (waiting for capture)     │
         └─────────────┬───────────────┘
                       │ startNextAxleDetection()
                       ▼
         ┌─────────────────────────────┐
         │      WAITING_ZERO           │
         │  (weight > zeroThreshold)   │
         └─────────────┬───────────────┘
                       │ weight < zeroThreshold
                       ▼
         ┌─────────────────────────────┐
         │     WAITING_STABLE          │
         │  (counting stable readings) │
         └─────────────┬───────────────┘
                       │ weight >= stableThreshold
                       │ && stable
                       │ && stabilityCount >= required
                       ▼
         ┌─────────────────────────────┐
         │     READY (emit event)      │
         │  axle:next-ready            │
         └─────────────┬───────────────┘
                       │ reset to IDLE
                       ▼
              (wait for next capture)
```

### Backend Changes

Added capture tracking fields to `WeighingTransaction`:

```csharp
// Capture source: auto, manual, frontend
public string CaptureSource { get; set; } = "manual";

// Capture status: auto, captured, not_weighed
public string CaptureStatus { get; set; } = "captured";

// Auto-weigh GVW before final capture
public int? AutoweighGvwKg { get; set; }

// Timestamp of auto-weigh
public DateTime? AutoweighAt { get; set; }
```

**AutoweighCaptureRequest updates:**
- `CaptureSource` - Where capture originated (auto/manual/frontend)
- `IsFinalCapture` - Whether this is final submission or preliminary data

### Files Modified

| File | Changes |
|------|---------|
| `pages/index.html` | Fixed AXLE UNDEFINED, normalize axle data |
| `src/core/StateManager.js` | Added axle config, auto-detection |
| `main.js` | IPC handlers, auto-detection processing |
| `preload.js` | New API methods and events |
| `truload-backend/.../WeighingTransaction.cs` | Capture tracking fields |
| `truload-backend/.../WeighingTransactionDto.cs` | DTO updates |

---

## Auto-Weigh Submission Workflow (10.19)

### Overview

Implemented complete auto-weigh submission workflow where:
1. **Auto-weigh data is sent when all axles are captured** (before frontend submits final)
2. **Frontend submission updates existing record** (changes status to "captured")
3. **Incomplete sessions are flagged** when new session starts without completion
4. **Cancel weighing** properly resets session and marks as not_weighed

### Workflow Diagram

```
┌─────────────────┐                ┌──────────────────┐                ┌──────────────────┐
│   TruLoad       │                │    TruConnect    │                │   TruLoad        │
│   Frontend      │                │    Middleware    │                │   Backend        │
└────────┬────────┘                └────────┬─────────┘                └────────┬─────────┘
         │                                  │                                    │
         │ 1. Set axle config               │                                    │
         ├─────────────────────────────────►│                                    │
         │    {expectedAxles: 5,            │                                    │
         │     plateNumber: "KAA 123A"}     │ BackendClient.startSession()       │
         │                                  │                                    │
         │ 2. Capture axles 1-4             │                                    │
         ├─────────────────────────────────►│                                    │
         │    mobile:capture-axle           │                                    │
         │                                  │                                    │
         │ 3. Capture axle 5 (final)        │                                    │
         ├─────────────────────────────────►│                                    │
         │                                  │ isWeighingComplete() = true        │
         │                                  │                                    │
         │                                  │ 4. Auto-weigh submission           │
         │                                  ├───────────────────────────────────►│
         │                                  │    POST /autoweigh                 │
         │                                  │    {IsFinalCapture: false,         │
         │                                  │     CaptureSource: "auto"}         │
         │                                  │                                    │
         │                                  │◄───────────────────────────────────┤
         │                                  │    {CaptureStatus: "auto",         │
         │ 5. autoweigh:sent event          │     AutoweighGvwKg: 45000}         │
         │◄─────────────────────────────────┤                                    │
         │                                  │                                    │
         │ 6. Frontend submits final        │                                    │
         ├─────────────────────────────────►│                                    │
         │    mobile:vehicle-complete       │                                    │
         │                                  │ 7. Session completion              │
         │                                  ├───────────────────────────────────►│
         │                                  │    POST /autoweigh                 │
         │                                  │    {IsFinalCapture: true,          │
         │                                  │     CaptureSource: "frontend"}     │
         │                                  │                                    │
         │                                  │◄───────────────────────────────────┤
         │ 8. weighing:complete event       │    {CaptureStatus: "captured"}     │
         │◄─────────────────────────────────┤                                    │
         │                                  │                                    │
```

### Backend Changes

**IWeighingRepository - New Methods:**
```csharp
// Find existing auto-weigh record for final capture
Task<WeighingTransaction?> GetLatestAutoweighByVehicleAsync(
    string vehicleRegNumber, Guid stationId, string? bound = null);

// Mark incomplete sessions as not_weighed
Task<int> MarkPendingAsNotWeighedAsync(
    string? vehicleRegNumber, Guid stationId, Guid? excludeTransactionId = null);
```

**WeighingService.ProcessAutoweighAsync - Updated Logic:**
```csharp
// 1. For final capture: look for existing auto-weigh record
if (request.IsFinalCapture)
{
    transaction = await _weighingRepository.GetLatestAutoweighByVehicleAsync(
        vehicleRegNumber, request.StationId, request.Bound);
}

// 2. For auto-weigh: mark previous incomplete sessions
else
{
    await _weighingRepository.MarkPendingAsNotWeighedAsync(
        vehicleRegNumber, request.StationId);
}

// 3. Create or update transaction
if (transaction == null)
{
    transaction = new WeighingTransaction
    {
        CaptureSource = request.IsFinalCapture ? "frontend" : "auto",
        CaptureStatus = request.IsFinalCapture ? "captured" : "auto",
        AutoweighAt = request.IsFinalCapture ? null : DateTime.UtcNow,
        // ... other properties
    };
}
else
{
    // Update existing record
    transaction.CaptureStatus = "captured";
    transaction.CaptureSource = "frontend";
}

// 4. Store AutoweighGvwKg for preliminary capture
if (!request.IsFinalCapture)
{
    transaction.AutoweighGvwKg = calculatedGvw;
}
```

### Middleware Changes

**New Module - BackendClient.js:**

Location: `src/backend/BackendClient.js`

```javascript
// Start new weighing session
BackendClient.startSession({ regNumber, vehicleId, axleConfigurationId });

// Send auto-weigh when all axles captured (IsFinalCapture: false)
BackendClient.sendAutoweigh({ axles, gvw, plateNumber });

// Complete session when frontend submits (IsFinalCapture: true)
BackendClient.completeSession({ axles, gvw, plateNumber });

// Cancel session (marks as not_weighed)
BackendClient.cancelSession();

// Check if auto-weigh was sent
BackendClient.isAutoweighSent();
```

**Updated IPC Handlers (main.js):**

1. **mobile:capture-axle** - Now checks `isWeighingComplete()` and calls `BackendClient.sendAutoweigh()`
2. **mobile:set-axle-config** - Now calls `BackendClient.startSession()` for new vehicle
3. **mobile:vehicle-complete** - Now calls `BackendClient.completeSession()` for final submission
4. **mobile:cancel-weighing** (NEW) - Calls `BackendClient.cancelSession()` and resets state
5. **mobile:reset-session** - Now calls `BackendClient.cancelSession()` before reset

**New Preload API Methods:**

```javascript
// Cancel weighing session
electronAPI.cancelWeighing(reason);

// Backend event listeners
electronAPI.onAutoweighSent(callback);      // Auto-weigh sent to backend
electronAPI.onWeighingComplete(callback);   // Weighing complete confirmation
electronAPI.onWeighingCancelled(callback);  // Session cancelled
```

### Configuration

**defaults.js - New backend section:**

```javascript
backend: {
  baseUrl: '',           // Backend API URL
  apiKey: '',            // API key for authentication
  timeout: 30000,        // Request timeout
  retryCount: 3,         // Retry attempts
  retryDelay: 1000       // Delay between retries
}
```

### Session Lifecycle

| Event | Backend Status | Description |
|-------|----------------|-------------|
| Start Session | - | New weighing session begins |
| All Axles Captured | `CaptureStatus: "auto"` | Preliminary data sent |
| Frontend Submits | `CaptureStatus: "captured"` | Final weights confirmed |
| New Session (no complete) | Previous: `"not_weighed"` | Previous session flagged |
| Cancel Weighing | `CaptureStatus: "not_weighed"` | Session explicitly cancelled |

### Files Modified

| File | Changes |
|------|---------|
| `src/backend/BackendClient.js` | NEW: Backend communication module |
| `src/config/defaults.js` | Added backend configuration section |
| `main.js` | BackendClient integration, IPC handlers |
| `preload.js` | New IPC channels and API methods |
| `truload-backend/.../IWeighingRepository.cs` | New repository methods |
| `truload-backend/.../WeighingRepository.cs` | Implementation |
| `truload-backend/.../WeighingService.cs` | Updated ProcessAutoweighAsync |

### Testing Scenarios

1. **Happy Path**: All axles captured → auto-weigh sent → frontend submits → captured
2. **Cancel During Capture**: Some axles captured → cancel → session marked not_weighed
3. **New Vehicle Without Complete**: Vehicle A auto-weigh sent → Vehicle B starts → A marked not_weighed
4. **Backend Offline**: Weights captured locally, queued for sync when online

---

## Version History (Updated)

| Version | Date | Changes |
|---------|------|---------|
| ... | ... | ... |
| 2.3 | 2026-01-29 | Auto-weigh submission workflow, BackendClient module, session tracking |
| 2.4 | 2026-01-29 | Endpoint fixes, TransporterController, BoundSelector, Station sync |

---

## Endpoint Fixes and Station Sync (10.20)

### Overview

Fixed 404 errors on multiple endpoints and implemented station sync between frontend, backend, and middleware.

### Fixed Endpoints

| Frontend URL | Backend Route | Issue |
|--------------|---------------|-------|
| `/CargoTypes` | `/cargo-types` | Case mismatch - fixed frontend URL |
| `/OriginsDestinations` | `/origins-destinations` | Case mismatch - fixed frontend URL |
| `/WeighingTransaction` | `/weighing-transactions` | Case mismatch - fixed frontend URL |
| `/Transporter/search` | N/A | Controller didn't exist - created TransporterController |

### New TransporterController

Created `TransporterController.cs` at `/api/v1/transporters` with endpoints:
- `GET /` - Get all transporters
- `GET /active` - Get active transporters
- `GET /search?query=` - Search by name, code, registration, phone, email, NTAC
- `GET /{id}` - Get by ID
- `GET /code/{code}` - Get by code
- `POST /` - Create transporter
- `PUT /{id}` - Update transporter
- `DELETE /{id}` - Soft delete

### Station Code Fix

Fixed confusion between `Code` and `StationCode` fields:
- Updated `StationDto` to properly map both fields
- Added `BoundACode` and `BoundBCode` to the DTO
- `MapToDto` now syncs both fields for compatibility

### BoundSelector Component

Created `BoundSelector.tsx` for weighing screens:
- Shows only for bidirectional stations (`supportsBidirectional: true`)
- Compact mode for inline display
- Full mode with description
- Integrated into both mobile and multideck weighing pages

### Station Sync to Middleware

Implemented station configuration sync from frontend to TruConnect middleware:

**New IPC Handlers:**
- `station:sync` - Sync station data from frontend
- `station:get` - Get current station config
- `station:set-bound` - Change current bound

**New Preload API:**
```javascript
electronAPI.syncStation(stationData);
electronAPI.getStation();
electronAPI.setStationBound(bound);
electronAPI.onStationUpdated(callback);
electronAPI.onBoundChanged(callback);
```

### Files Modified

| File | Changes |
|------|---------|
| `truload-frontend/src/lib/api/weighing.ts` | Fixed API URLs to kebab-case |
| `truload-backend/Controllers/WeighingOperations/TransporterController.cs` | NEW |
| `truload-backend/Repositories/Weighing/TransporterRepository.cs` | NEW |
| `truload-backend/Repositories/Weighing/Interfaces/ITransporterRepository.cs` | NEW |
| `truload-backend/Program.cs` | Added TransporterRepository DI registration |
| `truload-backend/DTOs/User/StationDto.cs` | Added BoundACode, BoundBCode |
| `truload-backend/Controllers/UserManagement/StationsController.cs` | Fixed MapToDto |
| `truload-frontend/src/components/weighing/BoundSelector.tsx` | NEW |
| `truload-frontend/src/app/weighing/mobile/page.tsx` | Added BoundSelector |
| `truload-frontend/src/app/weighing/multideck/page.tsx` | Added BoundSelector |
| `TruConnect/src/core/StateManager.js` | Station config, setStationConfig, getStationConfig |
| `TruConnect/main.js` | Station sync IPC handlers |
| `TruConnect/preload.js` | Station sync API methods |
