# Auto-Weigh Flow Documentation

## Overview

This document describes the complete auto-weigh flow across all TruLoad components:
- **TruConnect Middleware** (Electron app on local machine)
- **TruLoad Backend** (.NET 10 API on cloud)
- **TruLoad Frontend** (Next.js PWA in browser)

---

## Architecture Modes

### Local Mode
```
┌─────────────────────────────────────────────────────────────────────┐
│                         LOCAL ENVIRONMENT                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐     WebSocket      ┌──────────────────┐           │
│  │   TruLoad    │◄──────────────────►│   TruConnect     │           │
│  │   Frontend   │     :3030          │   Middleware     │           │
│  │   (Browser)  │                    │   (Electron)     │           │
│  └──────┬───────┘                    └────────┬─────────┘           │
│         │                                      │                     │
│         │ REST API                             │ Serial/TCP/API      │
│         │ /api/v1                              │                     │
│         ▼                                      ▼                     │
│  ┌──────────────┐                    ┌──────────────────┐           │
│  │   TruLoad    │◄───────────────────│   Weighing       │           │
│  │   Backend    │    Auto-Weigh      │   Hardware       │           │
│  │   (Local)    │    POST /autoweigh │   (PAW/Haenni)   │           │
│  └──────────────┘                    └──────────────────┘           │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Cloud Mode (Updated Sprint 22.1)
```
┌─────────────────────────────────────────────────────────────────────┐
│                    CLOUD + LOCAL ENVIRONMENT                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐    REST API        ┌──────────────────┐           │
│  │   TruLoad    │──────────────────►│   TruLoad        │           │
│  │   Frontend   │    /api/v1         │   Backend        │           │
│  │   (Browser)  │                    │   (Cloud API)    │           │
│  └──────┬───────┘                    └──────────────────┘           │
│         │                                                            │
│         │ WebSocket (always local)                                   │
│         │ ws://localhost:3030                                        │
│         ▼                                                            │
│  ┌──────────────────┐               ┌──────────────────┐           │
│  │   TruConnect     │◄──────────────│   Weighing       │           │
│  │   Middleware     │  Serial/TCP   │   Hardware       │           │
│  │   (Local PC)     │               │   (PAW/Haenni)   │           │
│  └──────────────────┘               └──────────────────┘           │
│                                                                      │
│  NOTE: Backend WS relay removed in Sprint 22.1.                     │
│  Frontend ALWAYS connects directly to local TruConnect.             │
│  Backend is only used for REST API (transactions, compliance).      │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Scale Weight Handling (Mobile Mode)

### PAW vs Haenni vs MCGS Scale Behavior

Mobile weighing uses portable axle weighers that consist of two wheel pads (Scale A and Scale B) that measure weight from each wheel of an axle.

| Device | Weight Output | Individual Scales | Notes |
|--------|---------------|-------------------|-------|
| **PAW** | Combined (A+B) | Derived: total ÷ 2 | Returns total axle weight |
| **Haenni** | May be separate | Direct from API | May return scaleA/scaleB separately |
| **MCGS** | Combined (A+B) | Derived: total ÷ 2 | Serial frames `=SG+0000123kR`, one frame = one axle |

### Weight Data Structure

```javascript
// WebSocket weight event (mobile mode)
{
  event: "weight",
  mode: "mobile",

  // Total axle weight (always provided)
  weight: 6500,              // Combined Scale A + Scale B
  currentWeight: 6500,       // Alias for API compatibility

  // Individual scale weights
  scaleA: 3250,              // PAW: derived (weight/2), Haenni: may be direct
  scaleB: 3250,              // PAW: derived (weight - scaleA), Haenni: may be direct
  scaleWeightMode: "combined", // "combined" (PAW) or "separate" (Haenni)

  // Session data
  axleNumber: 1,
  stable: true,
  simulation: false
}
```

### Implementation Details

**MobileScaleParser.js:**
- PAW mode: Parses `ST,GS, 0000270kg` format, weight is already combined
- Haenni mode: Parses JSON, may include `scaleA`/`scaleB` fields
- MCGS mode: Parses `=SG+0000123kR` serial frames, each frame is one combined axle weight
- All modes return `scaleA`, `scaleB`, and `scaleWeightMode` in result

**StateManager.js:**
```javascript
// setCurrentMobileWeight updates both combined and individual weights
StateManager.setCurrentMobileWeight(6500, true, { scaleA: 3250, scaleB: 3250 });
```

**WebSocketOutput.js:**
- Broadcasts `scaleA`, `scaleB`, `scaleWeightMode` to frontend
- Frontend can use these for scale test verification

### Scale Test Considerations

For scale calibration tests:
- **PAW**: Individual scale weights are **estimated** (total ÷ 2)
- **Haenni**: Individual scale weights may be **exact** (if API provides them)
- Scale test should verify **combined weight** matches expected value
- Balance check (scaleA ≈ scaleB) is only meaningful for Haenni separate mode

---

## Auto-Weigh Flow - Step by Step

### 1. Vehicle Detection

```
[Hardware] → [Middleware] → [Frontend] → [Backend]

1.1 Scale detects vehicle/weight
    └─► TruConnect receives weight via Serial/TCP/API
        └─► InputManager parses data using protocol parser
            └─► StateManager updates weight state
                └─► EventBus emits 'input:weight'
                    └─► OutputManager broadcasts to WebSocket clients

1.2 Frontend receives weight update
    └─► useMiddleware hook receives 'weight' event
        └─► Updates UI with current weight
        └─► Checks if vehicle threshold exceeded (> 200kg)
```

### 2. Plate Submission

**Frontend → Middleware → Backend**

```javascript
// Frontend: User enters plate number
const submitPlate = (plateNumber) => {
  middleware.sendPlate(plateNumber);  // WebSocket message
};

// Middleware: WebSocketOutput receives plate
handlePlate(ws, data) {
  StateManager.setCurrentPlate(data.plateNumber, data.vehicleType);
  EventBus.emit('plate:received', {
    plateNumber: data.plateNumber,
    vehicleType: data.vehicleType,
    source: 'websocket'
  });
  ws.send(JSON.stringify({ event: 'plate-ack', data: { accepted: true } }));
}

// In LIVE mode, CloudConnectionManager relays to backend
_onPlateReceived(data) {
  if (this.operationMode === 'live') {
    this._sendToBackend('plate-received', {
      ...data,
      stationId: this.config.stationIdentifier
    });
  }
}
```

### 3. Axle Capture (Mobile Mode)

**Per-Axle Capture Flow:**

```
┌─────────┐     ┌─────────────┐     ┌────────────┐     ┌──────────┐
│ Scale   │────►│ TruConnect  │────►│  Frontend  │────►│ Backend  │
│ Reading │     │ Middleware  │     │  (TruLoad) │     │  (API)   │
└─────────┘     └─────────────┘     └────────────┘     └──────────┘
     │                │                    │                 │
     │  Weight: 6500kg│                    │                 │
     └───────────────►│                    │                 │
                      │  WebSocket:        │                 │
                      │  {event:"weight",  │                 │
                      │   weight:6500}     │                 │
                      └───────────────────►│                 │
                                           │  User clicks    │
                                           │  "Capture Axle" │
                                           │                 │
                      ┌────────────────────│                 │
                      │  {event:"axle-     │                 │
                      │   captured",       │                 │
                      │   axle:1,          │                 │
                      │   weight:6500}     │                 │
                      ▼                    │                 │
               StateManager:               │                 │
               addCapturedAxle(1, 6500)    │                 │
               gvw += 6500                 │                 │
                      │                    │                 │
                      │  WebSocket:        │                 │
                      │  {event:"axle-ack"}│                 │
                      └───────────────────►│                 │
```

### 4. Auto-Weigh Submission (Preliminary)

When all axles are captured or weight is ready:

```javascript
// Frontend: All axles captured, send vehicle complete
middleware.completeVehicle({
  totalAxles: 5,
  axleWeights: [6500, 7200, 8100, 9300, 8900],
  gvw: 40000,
  plateNumber: 'KCZ 015N'
});

// Middleware: WebSocketOutput handles vehicle complete
handleVehicleComplete(ws, data) {
  EventBus.emit('vehicle:complete', {
    ...data,
    plateNumber: StateManager.getCurrentPlate()
  });
  ws.send(JSON.stringify({ event: 'vehicle-complete-ack' }));
}

// BackendClient: Sends auto-weigh to backend
async sendAutoweigh(weighingData) {
  const payload = {
    stationId: this.config.stationId,
    bound: this.config.bound,
    vehicleRegNumber: weighingData.plateNumber,
    axles: weighingData.axleWeights.map((w, i) => ({
      axleNumber: i + 1,
      measuredWeightKg: w
    })),
    weighingMode: 'mobile',
    capturedAt: new Date().toISOString(),
    source: 'TruConnect',
    captureSource: 'auto',
    isFinalCapture: false  // PRELIMINARY
  };

  const response = await fetch(`${this.config.baseUrl}/api/v1/weighing-transactions/autoweigh`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  return response.json();
}
```

### 5. Backend Processing

**WeighingController.cs - Autoweigh Endpoint:**

```csharp
[HttpPost("autoweigh")]
[Authorize(Policy = "Permission:weighing.webhook")]
public async Task<IActionResult> Autoweigh([FromBody] AutoweighCaptureRequest request)
{
    // 1. Validate scale test
    var scaleTest = await _scaleTestService.GetValidTestForStation(request.StationId, request.Bound);
    if (scaleTest == null)
        return BadRequest("No valid scale test for today. Complete scale test first.");

    // 2. Check idempotency
    if (request.ClientLocalId != null) {
        var existing = await _service.GetByClientLocalIdAsync(request.ClientLocalId);
        if (existing != null)
            return Ok(MapToAutoweighResult(existing));
    }

    // 3. Process auto-weigh
    var result = await _weighingService.ProcessAutoweighAsync(request);

    // 4. Return result with compliance info
    return Ok(new AutoweighResultDto {
        WeighingId = result.Id,
        TicketNumber = result.TicketNumber,
        VehicleRegNumber = result.VehicleRegNumber,
        GvwMeasuredKg = result.GvwMeasuredKg,
        GvwPermissibleKg = result.GvwPermissibleKg,
        GvwOverloadKg = result.GvwOverloadKg,
        IsCompliant = result.IsCompliant,
        ControlStatus = result.ControlStatus,
        CaptureStatus = result.CaptureStatus,  // "auto" for preliminary
        CaptureSource = result.CaptureSource
    });
}
```

### 6. Two-Stage Capture Model

The system supports two-stage capture for accuracy:

**Stage 1: Preliminary (Auto)**
- Triggered automatically when vehicle complete
- `CaptureSource = "auto"`, `CaptureStatus = "auto"`
- Stores `AutoweighGvwKg` and `AutoweighAt`

**Stage 2: Final (Manual Confirmation)**
- Operator reviews and confirms weights
- `CaptureSource = "frontend"`, `CaptureStatus = "captured"`
- Updates final weights and calculates compliance

```javascript
// Frontend: Confirm final weights
const confirmWeights = async (weighingId, axles) => {
  await api.post('/api/v1/weighing-transactions/autoweigh', {
    stationId,
    vehicleRegNumber: plateNumber,
    axles: axles,
    weighingMode: 'mobile',
    captureSource: 'frontend',
    isFinalCapture: true  // FINAL
  });
};
```

---

## Event Flow Summary

### Middleware Events (EventBus)

| Event | Trigger | Data |
|-------|---------|------|
| `input:weight` | Scale reading received | `{ weight, deck, stable, source }` |
| `plate:received` | Plate submitted | `{ plateNumber, vehicleType, source }` |
| `axle:captured` | Axle weight captured | `{ axle, weight, timestamp }` |
| `vehicle:complete` | All axles captured | `{ totalAxles, axleWeights, gvw, plateNumber }` |
| `cloud:weight-update` | Relay to backend (live mode) | `{ ...weightData, stationId }` |

### WebSocket Events (Client ↔ Middleware)

| Event | Direction | Purpose |
|-------|-----------|---------|
| `register` | Client → Middleware | Register client with station/bound |
| `weight` / `weights` | Middleware → Client | Real-time weight updates |
| `plate` | Client → Middleware | Submit plate number |
| `axle-captured` | Client → Middleware | Confirm axle capture |
| `vehicle-complete` | Client → Middleware | Complete weighing session |
| `query-weight` | Client → Middleware | Request current weight |

### Backend API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/weighing-transactions/autoweigh` | POST | Create/update auto-weigh |
| `/api/v1/weighing-transactions/{id}` | GET | Get transaction details |
| `/api/v1/weighing-transactions/{id}/capture-weights` | POST | Manual weight capture |

---

## Connection Modes

### Local Mode (Default — All Environments)

1. Frontend connects directly to middleware WebSocket (ws://localhost:3030)
2. Middleware sends auto-weigh to backend REST API
3. All weight streaming is local — no backend WebSocket relay

> **Note (Sprint 22.1):** The "Live Mode" backend WebSocket relay was removed from the frontend. The frontend always connects directly to the local TruConnect middleware. TruConnect's `CloudConnectionManager` still supports LIVE mode for backend auto-weigh submissions via REST API, but the WebSocket relay for weight streaming to the frontend is no longer used.

---

## Offline Support

TruConnect's weighing capture is offline-first. Every backend call for a weighing (`autoweigh`
and `complete`) is written to a durable SQLite queue BEFORE any network attempt. A weighing
captured while a site has no connectivity is never lost, even across an app restart or a machine
reboot - it sits in the queue as `pending` until it can sync.

### The queue table

`weighing_queue` (`src/database/Database.js`, migration `014_create_weighing_queue`) holds one
row per queued network call:

| Column | Purpose |
|---|---|
| `local_session_id` | Groups the `autoweigh` + `complete` pair for one physical weighing |
| `client_local_id` | A fresh UUID per row - sent as the backend's `ClientLocalId` idempotency key |
| `request_type` | `autoweigh` or `complete` |
| `status` | `pending` -> `sending` -> `synced`, or `dead_letter` on a non-retryable failure |
| `attempts` / `max_attempts` | Retry counter, capped at 10 attempts by default |
| `next_attempt_at` | When backoff allows the next send attempt |
| `backend_transaction_id` | The backend's `WeighingId`, filled in once the row is `synced` |

`BackendClient.sendAutoweigh()` and `completeSession()` (`src/backend/BackendClient.js`) both
call `_queueForSync()`, which delegates straight to `SyncQueue.enqueue()`
(`src/backend/SyncQueue.js`). The write to SQLite happens first; only then does
`SyncQueue.attempt()` try the network call. If that immediate attempt fails, the row stays
`pending` and the queue's own retry machinery takes over - the caller never has to handle the
failure itself.

### Two calls, two distinct idempotency keys

Each physical weighing produces two queue rows: an `autoweigh` row (sent as soon as all axles are
captured) and a `complete` row (sent when the operator confirms). They share a
`local_session_id`, generated once in `BackendClient.startSession()` and stable across an app
restart between the two calls, purely to group them - but each gets its own `client_local_id`,
never reused between the pair. Reusing one id across both calls would make the second call land
on the backend's idempotent-return path and hand back the first call's result instead of actually
completing the transaction, stranding the weighing at `CaptureStatus="auto"` forever.

### Dependency chaining

A `complete` row cannot send before its sibling `autoweigh` row has synced. `SyncQueue.attempt()`
checks this on every attempt (`_findAutoweighRow`): if the sibling isn't `synced` yet, the
`complete` row is left untouched - this is not counted as a failed attempt, so it doesn't consume
a retry or advance the row's backoff schedule. Once the `autoweigh` row syncs, its
`backend_transaction_id` is patched into the `complete` row's payload as `weighingTransactionId`
(`_patchWeighingTransactionId`), so the backend can match the completion to the record it already
created.

### Backoff and dead-lettering

Retry backoff is ported verbatim from `CloudConnectionManager._scheduleReconnect`, not a new
formula: `delay = min(5000ms * 1.5^(attempts-1), 30000ms)`. A row that fails past `max_attempts`
(10 by default) moves to `dead_letter` and stops retrying automatically; an operator can requeue
every dead-lettered row for another attempt via `SyncQueue.retryDeadLetters()`.

Failures are classified by HTTP status:
- `401` - the cached token is cleared and the row is retried (a token can be rejected
  server-side even before its recorded expiry)
- `429` or `5xx` - transient, retried with backoff
- Any other `4xx` - treated as a permanent client error (bad payload, validation failure) and
  dead-lettered immediately rather than retried forever

### Draining the queue

`SyncQueue.drain()` processes all due `pending` rows in creation order, which naturally sends an
`autoweigh` row before its `complete` sibling since the sibling is always enqueued later. It runs:
- On a periodic timer (`startPeriodicDrain`, every 20s by default)
- Immediately when `BackendClient`'s connectivity poll (`startConnectivityPoll`, every 30s by
  default) detects the backend has come back online (the `backend:online` edge event)

### What this replaces

Earlier versions of this document described an in-memory `syncQueue` array kept on
`BackendClient` (`this.syncQueue.push(...)`), lost on any app restart. That code no longer
exists - it was replaced entirely by the durable SQLite queue described above, built as part of
the TruConnect offline-capability initiative (`TruConnect` commits `1270b61`/`1fa49ff`). Anyone
still going by the old description would wrongly conclude an offline weighing is lost if the app
restarts before reconnecting; the opposite is true - the queue row survives on disk independent of
the app process, and durability across a real two-process restart is covered by a regression test
(`tests/sync-queue-and-config-sync-test.js`, section (e)).

### Idempotency

Backend uses `ClientLocalId` for idempotency:

```csharp
// Check for duplicate submissions
var existing = await _context.WeighingTransactions
    .FirstOrDefaultAsync(t => t.ClientLocalId == request.ClientLocalId);

if (existing != null) {
    return existing;  // Return existing instead of creating duplicate
}
```

---

## Compliance Calculation

After weight capture, backend calculates:

1. **GVW Compliance**: Total weight vs permissible limit
2. **Axle Group Compliance**: Per-axle vs configuration limits
3. **Permit Validation**: Check for valid overload permits
4. **Fee Calculation**: Based on Kenya Traffic Act Cap 403
5. **Control Status**: Compliant / Warning / Overloaded

```csharp
public async Task<ComplianceResult> CalculateComplianceAsync(WeighingTransaction transaction)
{
    // Get axle configuration for vehicle type
    var config = await GetAxleConfiguration(transaction.AxleConfigurationId);

    // Calculate GVW compliance
    var gvwOverload = transaction.GvwMeasuredKg - config.MaxGvwKg;

    // Calculate axle group compliance
    foreach (var group in config.AxleGroups) {
        var groupWeight = transaction.Axles
            .Where(a => group.AxleNumbers.Contains(a.AxleNumber))
            .Sum(a => a.MeasuredWeightKg);

        var tolerance = group.AxleCount > 1 ? 0 : config.MaxGvwKg * 0.05;
        var groupOverload = groupWeight - group.MaxWeightKg - tolerance;
        // ...
    }

    return new ComplianceResult {
        IsCompliant = gvwOverload <= 0 && !hasAxleOverload,
        ControlStatus = DetermineControlStatus(gvwOverload),
        OverloadKg = Math.Max(0, gvwOverload)
    };
}
```

---

## Troubleshooting

### Common Issues

1. **Auto-weigh not reaching backend**
   - Check `operationMode` in middleware config
   - Verify backend URL in `backend.baseUrl` config
   - Check network connectivity

2. **Duplicate transactions**
   - Ensure `ClientLocalId` is being sent
   - Check idempotency logic in backend

3. **Scale test validation failing**
   - Complete daily scale test before weighing
   - Check station/bound match in scale test

4. **WebSocket connection dropping**
   - Check firewall settings for port 3030
   - Verify middleware is running
   - Check for network instability

### Debug Logging

Enable debug logging in middleware:

```javascript
ConfigManager.set('logging.level', 'debug');
ConfigManager.set('logging.console', true);
```

Check browser console for frontend WebSocket events.

---

## Files Reference

| Component | File | Purpose |
|-----------|------|---------|
| Middleware | `src/output/WebSocketOutput.js` | WebSocket server, event handling |
| Middleware | `src/backend/BackendClient.js` | Backend API communication |
| Middleware | `src/backend/SyncQueue.js` | Durable offline sync queue (see "Offline Support" above) |
| Middleware | `src/backend/ConfigSyncService.js` | Station/AxleConfiguration mirror + drift detection |
| Middleware | `src/cloud/CloudConnectionManager.js` | Cloud relay management |
| Middleware | `src/core/StateManager.js` | Weight state management |
| Backend | `Controllers/WeighingController.cs` | Auto-weigh API endpoint |
| Backend | `Services/WeighingService.cs` | Auto-weigh processing logic |
| Frontend | `hooks/useMiddleware.ts` | WebSocket connection hook |
| Frontend | `app/weighing/mobile/page.tsx` | Mobile weighing UI |

---

*Last Updated: February 2026 (Sprint 22.1)*
