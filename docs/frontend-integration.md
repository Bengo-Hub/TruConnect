# TruConnect ↔ TruLoad Frontend Integration Guide

## Overview

This document defines the communication protocol between TruConnect (middleware) and TruLoad (frontend). Communication occurs via WebSocket on port 3030 (realtime mode) or REST API polling on port 3031 (polling mode).

**Key Insight**: The `useMiddleware` hook implements a **hybrid connection strategy** that works in all deployment scenarios - online, offline (PWA), development, and production cloud hosting.

---

## Connection Strategy (Updated Sprint 22.1)

The frontend always connects directly to the local TruConnect middleware. There is **no backend WebSocket relay** — this was removed in Sprint 22.1 to eliminate failed `wss://` connection attempts in production.

### Connection Priority Chain

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     useMiddleware Hook - Connection Manager                  │
│                                                                             │
│   Priority 1: Local WebSocket (always)                                      │
│   └─► ws://localhost:3030                                                   │
│       ├─ Used in: All environments (dev, production, PWA offline)           │
│       └─ Direct connection to local TruConnect middleware                   │
│                                                                             │
│   Priority 2: Local API Polling (WebSocket unavailable)                     │
│   └─► http://localhost:3031/weights                                         │
│       ├─ Used in: WebSocket blocked, fallback scenarios                     │
│       └─ Polls every 500ms                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Why This Works (Critical Insight)

**When a PWA is installed and running offline:**
1. The service worker serves cached app assets **locally**
2. The browser runs **locally on the user's machine**
3. Therefore, the browser **CAN connect to localhost:3030** even without internet!

This means offline weighing works seamlessly - the PWA connects directly to the local TruConnect middleware.

### Scenario Matrix

| Scenario | Internet | Local WS | Connection Used |
|----------|----------|----------|-----------------|
| Production Online | Yes | Available | Local WS direct |
| Production Offline (PWA) | No | Available | Local WS direct |
| Development | Maybe | Available | Local WS direct |
| Network Issues | Intermittent | Available | Local WS direct |

### Environment Configuration

```env
# .env.local (Development)
NEXT_PUBLIC_API_URL=http://localhost:4000

# .env.production (Cloud)
NEXT_PUBLIC_API_URL=https://kuraweighapitest.masterspace.co.ke
# No NEXT_PUBLIC_BACKEND_WS_URL needed — always local
```

---

## Connection Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          TruLoad Frontend                                   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐            │
│  │ CaptureScreen   │  │ WeightCapture   │  │ Compliance      │            │
│  │ (Plate, ANPR)   │  │ (Mobile/Multi)  │  │ (Decision)      │            │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘            │
│           │                    │                    │                      │
│           └────────────────────┼────────────────────┘                      │
│                               │                                            │
│                     ┌─────────▼─────────┐                                 │
│                     │  WebSocket Client  │                                 │
│                     │  (useMiddleware)   │                                 │
│                     └─────────┬─────────┘                                 │
└───────────────────────────────┼────────────────────────────────────────────┘
                                │ ws://localhost:3030
                                ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                          TruConnect Middleware                              │
│                     ┌─────────────────────┐                                │
│                     │  WebSocket Server   │                                │
│                     │  :3030              │                                │
│                     └─────────┬───────────┘                                │
│                               │                                            │
│  ┌────────────────────────────┼────────────────────────────────────────┐  │
│  │                    EventBus (Internal)                               │  │
│  │  Events: weight:updated, axle:captured, vehicle:complete, etc.      │  │
│  └─────────────────────────────┬───────────────────────────────────────┘  │
│                                │                                           │
│  ┌──────────────┐  ┌───────────┴───────────┐  ┌──────────────┐           │
│  │ InputManager │  │    StateManager       │  │ OutputManager│           │
│  │ (Parsers)    │  │ (Weights, Mode, etc.) │  │ (RDU, API)   │           │
│  └──────────────┘  └───────────────────────┘  └──────────────┘           │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## WebSocket Message Format

All messages follow this structure:

```typescript
interface WebSocketMessage {
  event: string;
  data: Record<string, unknown>;
  timestamp: string; // ISO 8601
}
```

---

## Server → Client Events (TruConnect → TruLoad)

### 1. `connected`
Sent immediately after WebSocket connection established.

```json
{
  "event": "connected",
  "data": {
    "clientId": 1,
    "serverTime": "2026-01-29T10:00:00.000Z"
  },
  "timestamp": "2026-01-29T10:00:00.000Z"
}
```

### 2. `weights` / `weight`
Real-time weight update broadcast.

**Multideck Mode:**
```json
{
  "event": "weights",
  "data": {
    "mode": "multideck",
    "deck1": 6500,
    "deck2": 8200,
    "deck3": 9100,
    "deck4": 7800,
    "gvw": 31600,
    "vehicleOnDeck": true,
    "stable": true,
    "simulation": false,
    "source": "ZM"
  },
  "timestamp": "2026-01-29T10:00:00.000Z"
}
```

**Mobile Mode:**
```json
{
  "event": "weight",
  "data": {
    "mode": "mobile",
    "weight": 6500,
    "axleNumber": 2,
    "axleWeights": [6500, 8200],
    "runningTotal": 14700,
    "stable": true,
    "unit": "kg",
    "simulation": false,
    "source": "PAW"
  },
  "timestamp": "2026-01-29T10:00:00.000Z"
}
```

### 3. `scale-status`
Scale connection status update.

```json
{
  "event": "scale-status",
  "data": {
    "mode": "mobile",
    "connected": true,
    "scaleA": { "status": "connected", "weight": 3200, "temp": 25, "battery": 85 },
    "scaleB": { "status": "connected", "weight": 3300, "temp": 24, "battery": 90 },
    "simulation": false,
    "protocol": "PAW",
    "port": "COM7"
  },
  "timestamp": "2026-01-29T10:00:00.000Z"
}
```

### 4. `register-ack`
Acknowledgement of client registration.

```json
{
  "event": "register-ack",
  "data": {
    "success": true,
    "stationCode": "ROMIA",
    "bound": "A",
    "mode": "mobile"
  },
  "timestamp": "2026-01-29T10:00:00.000Z"
}
```

### 5. `plate-ack`
Acknowledgement of plate capture.

```json
{
  "event": "plate-ack",
  "data": {
    "success": true,
    "plateNumber": "KAA 123A",
    "vehicleId": "uuid-string"
  },
  "timestamp": "2026-01-29T10:00:00.000Z"
}
```

### 6. `axle-captured-ack`
Acknowledgement of axle weight capture.

```json
{
  "event": "axle-captured-ack",
  "data": {
    "success": true,
    "axleNumber": 2,
    "weight": 8200
  },
  "timestamp": "2026-01-29T10:00:00.000Z"
}
```

### 7. `vehicle-complete-ack`
Acknowledgement of vehicle weighing completion.

```json
{
  "event": "vehicle-complete-ack",
  "data": {
    "success": true,
    "gvw": 45200,
    "ticketNumber": "MOB20260129000001"
  },
  "timestamp": "2026-01-29T10:00:00.000Z"
}
```

### 8. `session-reset-ack`
Acknowledgement of session reset.

```json
{
  "event": "session-reset-ack",
  "data": {
    "success": true
  },
  "timestamp": "2026-01-29T10:00:00.000Z"
}
```

### 9. `error`
Error notification.

```json
{
  "event": "error",
  "data": {
    "message": "Not registered",
    "code": "NOT_REGISTERED"
  },
  "timestamp": "2026-01-29T10:00:00.000Z"
}
```

---

## Client → Server Events (TruLoad → TruConnect)

### 1. `register`
Register client with station and mode.

```json
{
  "event": "register",
  "data": {
    "stationCode": "ROMIA",
    "bound": "A",
    "mode": "mobile"
  }
}
```

### 2. `plate`
Notify middleware of captured plate number and optional ANPR image.

```json
{
  "event": "plate",
  "data": {
    "plateNumber": "KAA 123A",
    "vehicleType": "6C",
    "anprImagePath": "C:/anpr/images/20260129_100000_KAA123A.jpg",
    "overviewImagePath": "C:/anpr/images/20260129_100000_overview.jpg",
    "confidence": 0.95
  }
}
```

### 3. `axle-captured`
Notify middleware when user confirms axle weight capture (mobile mode).

```json
{
  "event": "axle-captured",
  "data": {
    "axleNumber": 2,
    "weight": 8200,
    "axleConfigurationId": "uuid-string"
  }
}
```

**IMPORTANT - Cumulative Weight Logic (MCGS Scales)**:

For MCGS mobile scales and other cumulative-weight sources:

> The `weight` field should contain the **individual axle weight** (already cumulative-adjusted by the middleware). 
> The middleware provides this as `currentMobileWeight` which is calculated by subtracting the session GVW from the raw scale reading.

**Example for 2-Axle Vehicle**:
- **Axle 1**: Scale reads 940 kg
  - Middleware calculates: 940 - 0 = 940 kg
  - Frontend receives `currentMobileWeight: 940`
  - Frontend sends `axle-captured(weight: 940)` ✓

- **Axle 2**: Scale reads 1580 kg (cumulative: 940+640)
  - Middleware calculates: 1580 - 940 = 640 kg
  - Frontend receives `currentMobileWeight: 640`
  - Frontend sends `axle-captured(weight: 640)` ✓

**Note**: The middleware applies cumulative weight logic again at capture time as a safety net. 
So even if the frontend sends the raw scale reading (1580), the middleware will correct it to 640.

### 4. `vehicle-complete`
Notify middleware when vehicle weighing is complete.

```json
{
  "event": "vehicle-complete",
  "data": {
    "totalAxles": 5,
    "axleWeights": [6500, 8200, 9100, 8500, 7200],
    "gvw": 39500,
    "axleConfigurationCode": "5C",
    "vehicleId": "uuid-string",
    "driverId": "uuid-string",
    "transporterId": "uuid-string"
  }
}
```

### 5. `query-weight`
Request current weight reading from middleware.

```json
{
  "event": "query-weight",
  "data": {
    "type": "current"
  }
}
```

**Types:**
- `current` - Get current scale reading
- `next-axle` - Request next axle weight (triggers scale query)

### 6. `status-request`
Request current system status.

```json
{
  "event": "status-request",
  "data": {}
}
```

### 7. `bound-switch`
Switch weighing bound/direction.

```json
{
  "event": "bound-switch",
  "data": {
    "bound": "B"
  }
}
```

### 8. `reset-session`
Reset current weighing session (clear axles, plate, etc.).

```json
{
  "event": "reset-session",
  "data": {}
}
```

### 9. `capture-request`
Request weight capture (trigger weight logging).

```json
{
  "event": "capture-request",
  "data": {
    "deck": 0,
    "type": "gvw"
  }
}
```

---

## Frontend Integration Hook (useMiddleware)

The `useMiddleware` hook is already implemented in the TruLoad frontend at `src/hooks/useMiddleware.ts`.

### Key Features

1. **Local-Only Connection**: Always connects to local TruConnect middleware (no backend relay)
2. **Connection Priority Chain**: Local WS → API Polling fallback
3. **Network State Detection**: Listens for online/offline events
4. **Auto-Reconnect**: Exponential backoff on connection failures

### Basic Usage

```typescript
import { useMiddleware } from '@/hooks/useMiddleware';

function WeighingPage() {
  const {
    // Connection state
    connected,
    registered,
    connectionMode,  // 'local_ws' | 'local_api' | 'disconnected'
    isOnline,
    isLocalFallback,

    // Data
    weights,
    scaleStatus,
    simulation,
    error,

    // Actions
    sendPlate,
    captureAxle,
    completeVehicle,
    queryWeight,
    resetSession,

    // Connection control
    forceLocalConnection,
    forceBackendConnection,
  } = useMiddleware({
    stationCode: 'ROMIA',
    mode: 'mobile',
    bound: 'A',
    // Optional callbacks
    onWeightUpdate: (weight) => console.log('Weight:', weight),
    onConnectionModeChange: (mode, url) => console.log(`Connected via ${mode}: ${url}`),
  });

  return (
    <div>
      <StatusIndicator
        connected={connected}
        mode={connectionMode}
        isOffline={!isOnline}
      />
      {weights && <WeightDisplay data={weights} />}
    </div>
  );
}
```

### Configuration Options

```typescript
interface UseMiddlewareOptions {
  stationCode: string;           // Required: Station identifier
  bound?: 'A' | 'B';             // Weighing direction (default: 'A')
  mode?: 'mobile' | 'multideck'; // Weighing mode (default: 'mobile')
  autoConnect?: boolean;         // Auto-connect on mount (default: true)

  // Connection URLs (auto-configured from environment)
  localWsUrl?: string;           // Local middleware WebSocket (default: ws://localhost:3030)
  localApiUrl?: string;          // Local middleware API (default: http://localhost:3031/weights)
  enablePollingFallback?: boolean; // Fall back to API polling (default: true)
  pollingInterval?: number;      // API polling interval in ms (default: 500)
  reconnectInterval?: number;    // Base reconnect delay (default: 5000)

  // Callbacks
  onWeightUpdate?: (weight: WeightData) => void;
  onScaleStatusChange?: (status: ScaleStatus) => void;
  onConnectionModeChange?: (mode: ConnectionMode, url: string) => void;
  onError?: (error: string) => void;
}
```

### Connection State

```typescript
interface MiddlewareState {
  connected: boolean;           // WebSocket/polling connected
  registered: boolean;          // Registered with middleware
  connectionMode: ConnectionMode; // Current connection type
  isOnline: boolean;            // navigator.onLine
  isLocalFallback: boolean;     // Using local connection (not backend)
  weights: WeightData | null;   // Latest weight data
  scaleStatus: ScaleStatus | null; // Scale connection status
  simulation: boolean;          // Simulation mode active
  error: string | null;         // Last error message
  clientId: number | null;      // Assigned client ID
}

type ConnectionMode = 'local_ws' | 'local_api' | 'disconnected';
```

### Connection Status UI Example

```tsx
function ConnectionStatusBadge({ connectionMode, isOnline }: {
  connectionMode: ConnectionMode;
  isOnline: boolean;
}) {
  const statusConfig = {
    local_ws: { color: 'green', label: 'Local WebSocket' },
    local_api: { color: 'orange', label: 'API Polling' },
    disconnected: { color: 'red', label: 'Disconnected' },
  };

  const { color, label } = statusConfig[connectionMode];

  return (
    <Badge color={color}>
      {label}
      {!isOnline && ' (Offline)'}
    </Badge>
  );
}
```

### Legacy Reference (Simple Implementation)

For reference, here's a minimal implementation without hybrid connection:

```typescript
export function useMiddlewareSimple(options: {
  stationCode: string;
  bound?: string;
  mode?: 'mobile' | 'multideck';
  autoConnect?: boolean;
    };

    ws.onerror = (error) => {
      setState(s => ({ ...s, error: 'Connection error' }));
    };

    wsRef.current = ws;
  }, [options.stationCode, options.bound, options.mode]);

  const handleMessage = useCallback((message: any) => {
    switch (message.event) {
      case 'register-ack':
        setState(s => ({ ...s, registered: message.data.success }));
        break;
      case 'weights':
      case 'weight':
        setState(s => ({
          ...s,
          weights: message.data,
          simulation: message.data.simulation || false,
        }));
        break;
      case 'scale-status':
        setState(s => ({
          ...s,
          scaleStatus: message.data,
          simulation: message.data.simulation || false,
        }));
        break;
      case 'error':
        setState(s => ({ ...s, error: message.data.message }));
        break;
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimer.current) return;
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null;
      connect();
    }, 5000);
  }, [connect]);

  // Actions
  const sendPlate = useCallback((plateNumber: string, data?: {
    vehicleType?: string;
    anprImagePath?: string;
    overviewImagePath?: string;
  }) => {
    wsRef.current?.send(JSON.stringify({
      event: 'plate',
      data: { plateNumber, ...data },
    }));
  }, []);

  const captureAxle = useCallback((axleNumber: number, weight: number, axleConfigurationId?: string) => {
    wsRef.current?.send(JSON.stringify({
      event: 'axle-captured',
      data: { axleNumber, weight, axleConfigurationId },
    }));
  }, []);

  const completeVehicle = useCallback((data: {
    totalAxles: number;
    axleWeights: number[];
    gvw: number;
    axleConfigurationCode?: string;
  }) => {
    wsRef.current?.send(JSON.stringify({
      event: 'vehicle-complete',
      data,
    }));
  }, []);

  const queryWeight = useCallback((type: 'current' | 'next-axle' = 'current') => {
    wsRef.current?.send(JSON.stringify({
      event: 'query-weight',
      data: { type },
    }));
  }, []);

  const resetSession = useCallback(() => {
    wsRef.current?.send(JSON.stringify({
      event: 'reset-session',
      data: {},
    }));
  }, []);

  useEffect(() => {
    if (options.autoConnect !== false) {
      connect();
    }
    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
    };
  }, [connect, options.autoConnect]);

  return {
    ...state,
    connect,
    sendPlate,
    captureAxle,
    completeVehicle,
    queryWeight,
    resetSession,
  };
}
```

---

## Scale Status Card Integration

The frontend should display scale connection status using the `scale-status` event data:

```typescript
// types/weighing.ts additions
export interface MiddlewareScaleStatus {
  mode: 'mobile' | 'multideck';
  connected: boolean;
  simulation: boolean;
  protocol: string;
  port?: string;
  scaleA?: ScaleInfo;
  scaleB?: ScaleInfo;
}

export interface ScaleInfo {
  status: 'connected' | 'disconnected' | 'error';
  weight: number;
  temp?: number;
  battery?: number;
}
```

**Status Display Requirements:**
1. Show connection status indicator (green=connected, red=disconnected, yellow=unstable)
2. Display mode (Mobile/Multideck)
3. Show simulation indicator when in simulation mode
4. For mobile mode: show Scale A and Scale B status separately
5. For multideck mode: show all 4 deck connection statuses

---

## Weighing Workflow Integration

### Mobile Mode Workflow

```
1. Frontend connects to middleware via WebSocket
2. Frontend sends 'register' with stationCode, bound, mode='mobile'
3. User captures plate (ANPR or manual)
4. Frontend sends 'plate' event with plateNumber, images
5. Middleware broadcasts 'weight' events as scale readings come in
6. User positions vehicle axle on scale
7. Middleware sends stable reading via 'weight' event
8. User clicks "Capture Axle" on frontend
9. Frontend sends 'axle-captured' with axleNumber and weight
10. Middleware acknowledges and triggers query for next axle
11. Repeat for all axles
12. Frontend sends 'vehicle-complete' with all data
13. Middleware forwards to backend/autoweigh
```

### Multideck Mode Workflow

```
1. Frontend connects to middleware via WebSocket
2. Frontend sends 'register' with stationCode, bound, mode='multideck'
3. Middleware continuously broadcasts 'weights' events
4. User captures plate (ANPR or manual)
5. Frontend sends 'plate' event with plateNumber, images
6. Vehicle drives onto deck
7. Middleware detects vehicle (GVW > threshold)
8. Middleware broadcasts stable 'weights' event
9. Frontend displays compliance calculation
10. User confirms capture
11. Frontend sends 'vehicle-complete'
12. Middleware forwards to backend/autoweigh
```

---

## Configuration

### TruConnect Settings

```json
{
  "output": {
    "websocket": {
      "enabled": true,
      "port": 3030
    }
  },
  "app": {
    "captureMode": "mobile"
  }
}
```

### Frontend Environment

```env
NEXT_PUBLIC_MIDDLEWARE_WS_URL=ws://localhost:3030
NEXT_PUBLIC_MIDDLEWARE_API_URL=http://localhost:3031
```

---

## Error Handling

| Error Code | Message | Recovery |
|------------|---------|----------|
| `NOT_REGISTERED` | Client not registered | Send 'register' event |
| `SCALE_DISCONNECTED` | Scale not connected | Check physical connection |
| `PARSE_ERROR` | Invalid weight data | Check indicator protocol |
| `SESSION_EXPIRED` | Session timed out | Re-register |

---

## Testing

### Using WebSocket Test Client

```bash
# Install wscat
npm install -g wscat

# Connect to TruConnect
wscat -c ws://localhost:3030

# Send register message
{"event":"register","data":{"stationCode":"ROMIA","bound":"A","mode":"mobile"}}

# Send plate capture
{"event":"plate","data":{"plateNumber":"KAA 123A"}}

# Query weight
{"event":"query-weight","data":{"type":"current"}}
```

### Simulation Mode Testing

Enable simulation in TruConnect settings:

```json
{
  "simulation": {
    "enabled": true,
    "mode": "dynamic",
    "pattern": "mobile",
    "minWeight": 1000,
    "maxWeight": 10000,
    "updateInterval": 1000
  }
}
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-29 | Initial specification |
