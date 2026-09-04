# TruLoad Cloud Architecture Gap Analysis

## Executive Summary

This document analyzes the communication architecture between cloud-hosted TruLoad (frontend/backend) and locally-installed TruConnect middleware, identifying gaps and providing solutions for production deployment.

**Critical Finding**: The current architecture assumes frontend and middleware run on the same machine (localhost). When frontend is cloud-hosted, direct WebSocket/HTTP connections to `localhost` middleware are impossible from the browser.

---

## Production Environment Architecture

### Current Deployment (K8s Values.yaml)

```
Production URLs:
├── Frontend: https://kuraweightest.masterspace.co.ke
├── Backend:  https://kuraweighapitest.masterspace.co.ke
└── Middleware: localhost:3030 (Local Desktop App)
```

### Component Locations

| Component | Location | URL |
|-----------|----------|-----|
| TruLoad Frontend | Cloud (K8s) | https://kuraweightest.masterspace.co.ke |
| TruLoad Backend | Cloud (K8s) | https://kuraweighapitest.masterspace.co.ke |
| TruConnect Middleware | Local Desktop | ws://localhost:3030 |
| Scales (PAW/Haenni) | Local Hardware | COM7/localhost:8888 |

---

## Critical Gaps Identified

### Gap 1: Browser-to-Local WebSocket Connection (CRITICAL)

**Problem**: A cloud-hosted PWA cannot directly connect to `ws://localhost:3030` from the browser due to:
1. **CORS restrictions**: Browser blocks cross-origin WebSocket to localhost
2. **Network boundary**: Cloud browser has no route to client's localhost
3. **Security**: Modern browsers block mixed content (HTTPS→WS)

**Impact**: Frontend cannot receive real-time weight updates from middleware.

### Gap 2: Auto-Weigh Backend Integration Missing

**Status (2026-09-04): CLOSED.** TruConnect posts weight data directly to the cloud backend
today, exactly what this gap called for. `BackendClient.js` (`sendAutoweigh`/`completeSession`)
posts to `POST /api/v1/weighing-transactions/autoweigh` with `ClientLocalId`-based idempotency,
and every call is durably queued in SQLite before the network attempt so a submission is never
lost if the backend is unreachable at capture time (see the "TruConnect SQLite offline queue"
note under Gap 4, and `docs/AUTO_WEIGH_FLOW.md`'s "Offline Support" section for the full
mechanism). Original problem statement kept below for history.

**Original problem**: TruConnect has no configuration for posting weight data directly to the cloud backend (auto-weigh mode).

**Legacy Pattern (iConnect → KenloadV2)**:
```javascript
// iConnect kenloadv2.js
axios.post(server + ':' + serverport + '/api/AutoWeigh', autoWeighPayload);
```

**Impact**: Weight data cannot flow to backend for compliance calculation and ticket generation.

### Gap 3: Middleware Settings Not Persisted in Database

**Problem**: Frontend/Backend have no mechanism to:
1. Store middleware connection settings (WebSocket URL, API URL)
2. Configure auto-weigh mode and backend endpoint
3. Persist station-specific middleware configurations

### Gap 4: PWA Offline Mode Architecture Unclear

**Status (2026-09-04): CLOSED for the frontend-less TruConnect deployment shape.** Point 2 below
("syncing offline weights to cloud backend is not implemented") is no longer true for that shape -
see the "TruConnect SQLite offline queue vs. browser/PWA offline mode" note further down, right
before the PWA solution architecture, for which path applies to which deployment. Original
problem statement kept below for history.

**Original problem**: FRD mentions PWA with offline capability, but:
1. Offline weighing requires local middleware connection
2. Syncing offline weights to cloud backend is not implemented
3. Service worker configuration for middleware interaction missing

---

## Solution Architecture

### Architecture Option A: Backend as WebSocket Proxy (Recommended)

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    CLOUD ENVIRONMENT                                      │
│  ┌─────────────────┐      ┌─────────────────────────────┐               │
│  │  TruLoad        │◄────►│  TruLoad Backend            │               │
│  │  Frontend (PWA) │ WS   │  - /ws/weights (proxy)      │               │
│  │                 │      │  - /api/v1/autoweigh        │               │
│  └─────────────────┘      └──────────────┬──────────────┘               │
└───────────────────────────────────────────┼──────────────────────────────┘
                                            │
                          HTTPS/WS (Internet)
                                            │
┌───────────────────────────────────────────┼──────────────────────────────┐
│                    LOCAL ENVIRONMENT       │                              │
│  ┌─────────────────────────────────────────▼─────────────┐              │
│  │  TruConnect Middleware (Electron)                      │              │
│  │  - Connects to Cloud Backend WebSocket                 │              │
│  │  - Posts weights to Cloud /api/v1/autoweigh           │              │
│  │  - Receives commands from Backend (query weight, etc.) │              │
│  └───────────┬───────────────────────────────┬───────────┘              │
│              │                               │                            │
│  ┌───────────▼───────────┐    ┌──────────────▼──────────────┐           │
│  │  PAW Scales (Serial)  │    │  Haenni Scales (HTTP)       │           │
│  │  COM7 @ 9600 baud     │    │  localhost:8888             │           │
│  └───────────────────────┘    └─────────────────────────────┘           │
└──────────────────────────────────────────────────────────────────────────┘
```

**How It Works**:
1. TruConnect connects outbound to cloud backend WebSocket
2. Backend relays weight events to frontend via its own WebSocket
3. Auto-weigh posts go directly to backend API
4. Frontend never directly connects to localhost

### Architecture Option B: Direct Mode (Development/Testing)

For local development where frontend runs locally:

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    LOCAL ENVIRONMENT (Development)                        │
│                                                                           │
│  ┌─────────────────┐      ┌───────────────────────────────────────────┐ │
│  │  TruLoad        │◄────►│  TruConnect Middleware                     │ │
│  │  Frontend       │ WS   │  ws://localhost:3030                       │ │
│  │  localhost:3000 │      │  http://localhost:3031/weights             │ │
│  └─────────────────┘      └───────────────────────────────────────────┘ │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Requirements

### 1. TruConnect Configuration Updates

Add new configuration options to `defaults.js`:

```javascript
// Auto-weigh configuration (post weights to cloud backend)
autoWeigh: {
  enabled: false,                          // Enable/disable auto-weigh
  backendUrl: '',                          // Cloud backend URL (e.g., https://kuraweighapitest.masterspace.co.ke)
  endpoint: '/api/v1/autoweigh',           // Auto-weigh endpoint
  authToken: '',                           // JWT token for authentication
  stationCode: '',                         // Station identifier
  retryAttempts: 3,                        // Retry on failure
  retryDelayMs: 5000,                      // Delay between retries
  batchMode: false,                        // Batch multiple weights
  batchIntervalMs: 10000                   // Batch interval
},

// Cloud connection (for backend relay mode)
cloudConnection: {
  enabled: false,                          // Enable cloud relay mode
  backendWsUrl: '',                        // Backend WebSocket URL (wss://...)
  reconnectInterval: 5000,                 // Reconnect delay
  heartbeatInterval: 30000                 // Heartbeat interval
}
```

### 2. Backend Database Schema Updates

Add to ERD (`erd.md`):

```sql
-- Station middleware settings
CREATE TABLE station_middleware_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID NOT NULL REFERENCES stations(id),
  connection_mode VARCHAR(20) NOT NULL DEFAULT 'websocket', -- 'websocket' | 'polling' | 'backend_relay'
  middleware_ws_url VARCHAR(500) DEFAULT 'ws://localhost:3030',
  middleware_api_url VARCHAR(500) DEFAULT 'http://localhost:3031',
  auto_weigh_enabled BOOLEAN DEFAULT FALSE,
  polling_interval_ms INTEGER DEFAULT 500,
  is_simulation BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(station_id)
);

-- System configuration (global settings)
CREATE TABLE system_configurations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_key VARCHAR(100) UNIQUE NOT NULL,
  config_value TEXT NOT NULL,
  config_type VARCHAR(20) DEFAULT 'string', -- 'string' | 'number' | 'boolean' | 'json'
  description TEXT,
  is_sensitive BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Seed Data**:
```sql
INSERT INTO system_configurations (config_key, config_value, config_type, description) VALUES
('middleware.default_ws_url', 'ws://localhost:3030', 'string', 'Default middleware WebSocket URL'),
('middleware.default_api_url', 'http://localhost:3031', 'string', 'Default middleware API URL'),
('middleware.default_polling_interval', '500', 'number', 'Default polling interval in ms'),
('autoweigh.default_endpoint', '/api/v1/autoweigh', 'string', 'Auto-weigh backend endpoint'),
('backend.ws_relay_enabled', 'false', 'boolean', 'Enable backend WebSocket relay for cloud mode');
```

### 3. Frontend Configuration Page

Add Settings → Middleware Configuration page with:

1. **Connection Mode** dropdown:
   - WebSocket (Real-time) - default
   - API Polling (Fallback)
   - Backend Relay (Cloud Mode)

2. **WebSocket Settings**:
   - Middleware WS URL: `ws://localhost:3030`
   - Reconnect Interval: 5000ms

3. **API Polling Settings**:
   - Middleware API URL: `http://localhost:3031`
   - Polling Interval: 500ms

4. **Auto-Weigh Settings**:
   - Enable Auto-Weigh: toggle
   - Backend URL: auto-filled from environment
   - Station Code: dropdown from assigned stations

5. **Simulation Mode**:
   - Enable Simulation: toggle
   - Simulation Pattern: mobile/multideck

### 4. Auto-Weigh Flow (TruConnect → Backend)

```
TruConnect                          Cloud Backend
    │                                    │
    │  1. POST /api/v1/autoweigh         │
    │  {                                 │
    │    stationCode: "ROMIA",           │
    │    plateNumber: "KAA 123A",        │
    │    weights: {...},                 │
    │    gvw: 45000,                     │
    │    capturedAt: ISO timestamp,      │
    │    operatorId: "uuid",             │
    │    source: "truconnect"            │
    │  }                                 │
    ├───────────────────────────────────►│
    │                                    │ 2. Validate & process
    │                                    │ 3. Compute compliance
    │                                    │ 4. Generate ticket
    │  5. Response                       │
    │  {                                 │
    │    success: true,                  │
    │    ticketNumber: "WBT202601290001",│
    │    complianceStatus: "legal",      │
    │    gvwLimit: 50000                 │
    │  }                                 │
    │◄───────────────────────────────────┤
    │                                    │
```

---

## Migration Path

### Phase 1: Configuration Infrastructure (Sprint 11)

1. Add `station_middleware_settings` table to backend
2. Add `system_configurations` table to backend
3. Create backend API endpoints:
   - `GET/PUT /api/v1/settings/middleware` - Get/update middleware settings
   - `GET/PUT /api/v1/settings/system` - Get/update system configuration
4. Create frontend Settings → Middleware Configuration page

### Phase 2: Auto-Weigh Mode (Sprint 12)

1. Add auto-weigh configuration to TruConnect `defaults.js`
2. Implement auto-weigh service in TruConnect
3. Create backend `/api/v1/autoweigh` endpoint
4. Test end-to-end auto-weigh flow

### Phase 3: Backend Relay Mode (Sprint 13)

1. Add WebSocket relay endpoint to backend
2. Add cloud connection client to TruConnect
3. Implement bidirectional communication
4. Test cloud deployment scenario

---

## Environment-Specific Configuration

### Development Environment

```env
# truload-frontend/.env.local
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_MIDDLEWARE_WS_URL=ws://localhost:3030
NEXT_PUBLIC_MIDDLEWARE_API_URL=http://localhost:3031
NEXT_PUBLIC_MIDDLEWARE_MODE=websocket
```

### Production Environment

```env
# truload-frontend/.env.production
NEXT_PUBLIC_API_URL=https://kuraweighapitest.masterspace.co.ke
NEXT_PUBLIC_MIDDLEWARE_WS_URL=  # Not used - cloud mode
NEXT_PUBLIC_MIDDLEWARE_API_URL= # Not used - cloud mode
NEXT_PUBLIC_MIDDLEWARE_MODE=backend_relay
```

### TruConnect Production Config

```json
{
  "autoWeigh": {
    "enabled": true,
    "backendUrl": "https://kuraweighapitest.masterspace.co.ke",
    "endpoint": "/api/v1/autoweigh",
    "stationCode": "ROMIA"
  },
  "cloudConnection": {
    "enabled": true,
    "backendWsUrl": "wss://kuraweighapitest.masterspace.co.ke/ws/middleware"
  }
}
```

---

## PWA Offline Mode - Critical Architecture Insight

> **Note (2026-09-04) - TruConnect SQLite offline queue vs. browser/PWA offline mode.** The
> design in this section (IndexedDB + Background Sync in the browser) is real and shipped, but as
> a separate, earlier initiative (2026-06) covering the case where an operator uses
> `truload-frontend` directly in a browser at a connected site - offline capture there lives in
> the browser's own storage and syncs via the Background Sync API.
>
> It does not apply to a frontend-less TruConnect deployment - a remote quarry or waste-site
> install with no browser in the loop, which is what an offline site actually runs. That shape is
> solved by a completely different implementation built in a later (2026-09) initiative: a
> durable SQLite queue inside TruConnect itself (`weighing_queue` table, driven by
> `src/backend/SyncQueue.js` and `src/backend/BackendClient.js`). See `docs/AUTO_WEIGH_FLOW.md`'s
> "Offline Support" section for that mechanism, and `docs/architecture.md`'s "Database Schema"
> section for the table itself.
>
> The two are complementary, not competing - which one applies depends on whether a browser
> frontend is actually present and reachable at the site.

### The Key Realization

**When a PWA is installed and running offline:**
1. The service worker serves cached app assets **locally**
2. The browser runs **locally on the user's machine**
3. Therefore, the browser **CAN connect to localhost WebSocket** even without internet!

This enables a **Hybrid Connection Strategy** that works in all scenarios.

### Hybrid Connection Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    FRONTEND (PWA) - Connection Priority Chain               │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │  useMiddleware Hook - Smart Connection Manager                       │  │
│   │                                                                      │  │
│   │  Priority 1: Backend WebSocket (when online)                        │  │
│   │  └─► wss://kuraweighapitest.masterspace.co.ke/ws/weights            │  │
│   │      ├─ Best for: Production, cloud deployment                      │  │
│   │      └─ Backend relays weights from connected middleware             │  │
│   │                                                                      │  │
│   │  Priority 2: Local WebSocket (when offline OR backend unavailable)  │  │
│   │  └─► ws://localhost:3030                                            │  │
│   │      ├─ Best for: Offline PWA mode, development                     │  │
│   │      └─ Direct connection to local TruConnect                        │  │
│   │                                                                      │  │
│   │  Priority 3: Local API Polling (fallback)                           │  │
│   │  └─► http://localhost:3031/weights                                  │  │
│   │      ├─ Best for: WebSocket not supported, debugging                │  │
│   │      └─ Polls every 500ms                                           │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Connection Flow Logic

```typescript
// Pseudo-code for connection manager
function connectToMiddleware() {
  const isOnline = navigator.onLine;
  const backendWsUrl = process.env.NEXT_PUBLIC_BACKEND_WS_URL;
  const localWsUrl = 'ws://localhost:3030';
  const localApiUrl = 'http://localhost:3031/weights';

  if (isOnline && backendWsUrl) {
    // Try backend WebSocket first (production/online mode)
    try {
      return connectWebSocket(backendWsUrl, {
        onFail: () => connectWebSocket(localWsUrl) // Fallback to local
      });
    } catch {
      return connectWebSocket(localWsUrl);
    }
  } else {
    // Offline or no backend configured - connect directly to local middleware
    try {
      return connectWebSocket(localWsUrl);
    } catch {
      // Final fallback: API polling
      return startApiPolling(localApiUrl);
    }
  }
}
```

### Scenario Analysis

| Scenario | Internet | Backend WS | Local WS | Strategy |
|----------|----------|------------|----------|----------|
| **Production Online** | Yes | Available | Available | Backend WS (relay) |
| **Production Offline (PWA)** | No | N/A | Available | Local WS direct |
| **Development** | Maybe | Optional | Available | Local WS direct |
| **Network Issues** | Intermittent | Unstable | Available | Auto-fallback to Local WS |

### Why This Works

1. **PWA Caching**: Service worker caches the app shell, so frontend loads even offline
2. **Local Browser**: When running offline, the browser is on the user's machine
3. **Localhost Access**: Browser can always reach localhost (same machine)
4. **TruConnect Local**: Middleware always runs locally, serving `ws://localhost:3030`

### Data Sync Strategy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          DATA FLOW & SYNC                                    │
│                                                                             │
│  ONLINE MODE:                                                               │
│  ┌─────────┐    ┌─────────┐    ┌─────────────┐    ┌────────────┐          │
│  │ Scales  │───►│TruConnect│───►│ Backend WS  │───►│  Frontend  │          │
│  └─────────┘    │(local)   │    │ (cloud)     │    │  (cloud)   │          │
│                 │          │───►│ /autoweigh  │    │            │          │
│                 └──────────┘    └─────────────┘    └────────────┘          │
│                                         │                                   │
│                                         ▼                                   │
│                                  ┌─────────────┐                           │
│                                  │  Database   │                           │
│                                  │ (real-time) │                           │
│                                  └─────────────┘                           │
│                                                                             │
│  OFFLINE MODE:                                                              │
│  ┌─────────┐    ┌─────────┐    ┌─────────────┐                             │
│  │ Scales  │───►│TruConnect│───►│  Frontend   │                             │
│  └─────────┘    │(local)   │    │  (PWA)      │                             │
│                 └──────────┘    │             │                             │
│                                 │ ┌─────────┐ │                             │
│                                 │ │IndexedDB│ │  ← Weighings stored locally │
│                                 │ │ synced: │ │                             │
│                                 │ │  false  │ │                             │
│                                 │ └─────────┘ │                             │
│                                 └─────────────┘                             │
│                                         │                                   │
│                              When online ▼                                  │
│                                 ┌─────────────┐    ┌─────────────┐          │
│                                 │ Background  │───►│  Database   │          │
│                                 │    Sync     │    │ (batch sync)│          │
│                                 └─────────────┘    └─────────────┘          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Implementation Requirements

#### 1. useMiddleware Hook Updates

The `useMiddleware` hook must implement the connection priority chain:

```typescript
// Connection state
interface ConnectionState {
  mode: 'backend_ws' | 'local_ws' | 'local_api' | 'disconnected';
  url: string;
  connected: boolean;
  isOnline: boolean;  // navigator.onLine
  isLocalFallback: boolean;
}

// Connection priority
const CONNECTION_PRIORITY = [
  { mode: 'backend_ws', url: process.env.NEXT_PUBLIC_BACKEND_WS_URL },
  { mode: 'local_ws', url: 'ws://localhost:3030' },
  { mode: 'local_api', url: 'http://localhost:3031/weights' }
];
```

#### 2. Service Worker Configuration

```javascript
// service-worker.js
self.addEventListener('fetch', (event) => {
  // Allow localhost connections even when offline
  if (event.request.url.includes('localhost:3030') ||
      event.request.url.includes('localhost:3031')) {
    // Don't cache, pass through directly
    return;
  }
  // ... normal caching logic
});
```

#### 3. IndexedDB Offline Storage

```typescript
// Schema for offline weighings
interface OfflineWeighing {
  clientId: string;           // UUID generated client-side
  stationCode: string;
  plateNumber: string;
  weights: WeightData;
  gvw: number;
  capturedAt: Date;
  synced: boolean;            // false until synced
  syncedAt?: Date;
  syncError?: string;
  retryCount: number;
}
```

#### 4. Background Sync

```typescript
// Register sync when weighing captured offline
if (!navigator.onLine) {
  // Store in IndexedDB
  await db.weighings.add({ ...weighingData, synced: false });

  // Register for background sync
  if ('serviceWorker' in navigator && 'sync' in registration) {
    await registration.sync.register('sync-weighings');
  }
}
```

### Network State Detection

```typescript
// useNetworkState hook
function useNetworkState() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}
```

---

## Verification Checklist

### Local Development
- [ ] Frontend connects to `ws://localhost:3030`
- [ ] Weight updates display in real-time
- [ ] Plate capture sends to middleware
- [ ] Mobile mode axle capture works

### Cloud Production
- [ ] TruConnect auto-weigh posts to cloud backend
- [ ] Backend processes weights and generates tickets
- [ ] Frontend receives weight updates via backend relay
- [ ] Offline weights sync when online

### PWA Mode
- [ ] Service worker registered and active
- [ ] Weights captured offline stored in IndexedDB
- [ ] Sync completes when connectivity restored
- [ ] Conflict resolution handles duplicates

---

## References

- [TruConnect Frontend Integration Guide](frontend-integration.md)
- [TruLoad FRD](../../truload-backend/docs/Master-FRD-KURAWEIGH.md)
- [iConnect Auto-Weigh Pattern](../../../iConnect/iConnect-Juja/iConnect/kenloadv2.js)
- [KenloadV2 AutoWeighController](../../../Kenloadv2/KenloadV2APIUpgrade/Controllers/AutoWeighController.cs)
- [DevOps K8s Values](../../../devops-k8s/apps/truload-frontend/values.yaml)

---

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-01-29 | Claude | Initial gap analysis |
| 1.1 | 2026-09-04 | Claude | Gap 2 and Gap 4 point 2 marked closed (TruConnect's SQLite `SyncQueue`/`BackendClient` now post weight data to the cloud backend with durable offline retry); added a note distinguishing that path from this document's browser/PWA IndexedDB design, which shipped separately for the connected-frontend deployment shape |
