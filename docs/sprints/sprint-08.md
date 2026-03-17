# Sprint 08: Two-Way Communication & Station/Bound Management

**Duration**: 3-4 days
**Goal**: Implement two-way WebSocket communication between TruLoad and TruConnect with comprehensive station code and bound management

---

## Objectives

1. Implement two-way WebSocket communication protocol
2. Add comprehensive station code and bound configuration
3. Handle bidirectional weighbridge stations
4. Support multi-deck per bound configurations (Athi River style)
5. Integrate vehicle plate data for auto-weigh

---

## Background: Station Code Architecture

### Station Code Patterns

TruLoad supports complex weighbridge configurations:

**1. Simple Bidirectional (Single deck per bound)**
```
Station: Rongo Weighbridge
Base Code: ROMI
Bound A: ROMIA (Nairobi bound)
Bound B: ROKSA (Kisumu bound)
```

**2. Multi-Deck Per Bound (Athi River style)**
```
Station: Athi River Mombasa Bound
Station Code: ATMB
Deck A: ATMBA (First deck on Mombasa bound)
Deck B: ATMBB (Second deck on Mombasa bound)
```

**3. Non-Directional (Single bound)**
```
Station: Webuye Weighbridge
Station Code: WBMLA
```

---

## Tasks

### 8.1 Two-Way WebSocket Protocol

- [x] Define bidirectional message types (implemented in WebSocketOutput.js):

**TruLoad → TruConnect Messages:**
```typescript
// Connection registration (sent immediately on connect)
interface RegisterMessage {
  type: 'register';
  stationCode: string;        // Full station code (e.g., "ROMIA")
  bound: 'A' | 'B';           // Current active bound
  deckId?: string;            // For multi-deck: "A" or "B"
  clientType: 'truload' | 'kenloadv2';
}

// Vehicle plate update (ANPR or manual entry)
interface PlateMessage {
  type: 'plate';
  plate: string;              // Vehicle number plate (e.g., "KAA 123X")
  source: 'anpr' | 'manual';  // How plate was captured
  confidence?: number;        // ANPR confidence (0-1)
  timestamp: string;
}

// Bound switch notification (bidirectional stations)
interface BoundSwitchMessage {
  type: 'bound-switch';
  newBound: 'A' | 'B';
  newStationCode: string;     // New full station code
}

// Request connection status
interface StatusRequestMessage {
  type: 'status-request';
}
```

**TruConnect → TruLoad Messages:**
```typescript
// Weight update (continuous stream)
interface WeightMessage {
  type: 'weights';
  mode: 'multideck' | 'mobile';
  stationCode: string;
  bound: 'A' | 'B';
  decks: Array<{
    index: number;
    weight: number;
    stable: boolean;
  }>;
  gvw: number;
  status: 'stable' | 'unstable';
  vehicleOnDeck: boolean;
  timestamp: string;
}

// Connection status response
interface StatusMessage {
  type: 'status';
  connected: boolean;
  simulation: boolean;
  indicators: Array<{
    id: string;
    type: string;
    connected: boolean;
    lastSeen: string;
  }>;
  rdus: Array<{
    id: string;
    connected: boolean;
  }>;
}

// Registration acknowledgment
interface AckMessage {
  type: 'ack';
  registered: boolean;
  stationCode: string;
  bound: 'A' | 'B';
}

// Auto-weigh data ready notification
interface AutoweighReadyMessage {
  type: 'autoweigh-ready';
  data: {
    stationCode: string;
    bound: 'A' | 'B';
    plate: string;
    deck1: number;
    deck2: number;
    deck3: number;
    deck4: number;
    gvw: number;
    timestamp: string;
  };
}
```

### 8.2 Connection Pool Manager

- [x] Create `src/core/ConnectionPool.js`:

```javascript
class ConnectionPool {
  constructor() {
    this.clients = new Map(); // ws -> metadata
  }

  register(ws, metadata) {
    this.clients.set(ws, {
      stationCode: metadata.stationCode,
      bound: metadata.bound,
      deckId: metadata.deckId,
      clientType: metadata.clientType,
      currentPlate: null,
      plateSource: null,
      registeredAt: new Date().toISOString()
    });
    return { registered: true };
  }

  updateBound(ws, newBound, newStationCode) {
    const client = this.clients.get(ws);
    if (client) {
      client.bound = newBound;
      client.stationCode = newStationCode;
      return true;
    }
    return false;
  }

  updatePlate(ws, plate, source) {
    const client = this.clients.get(ws);
    if (client) {
      client.currentPlate = plate;
      client.plateSource = source;
      client.plateUpdatedAt = new Date().toISOString();
      return true;
    }
    return false;
  }

  getClientForStation(stationCode) {
    for (const [ws, meta] of this.clients.entries()) {
      if (meta.stationCode === stationCode) {
        return { ws, meta };
      }
    }
    return null;
  }

  getCurrentPlate(ws) {
    const client = this.clients.get(ws);
    return client ? client.currentPlate : null;
  }

  broadcast(message, filter = null) {
    const msgString = JSON.stringify(message);
    this.clients.forEach((meta, ws) => {
      if (ws.readyState === 1) { // WebSocket.OPEN
        if (!filter || filter(meta)) {
          ws.send(msgString);
        }
      }
    });
  }

  remove(ws) {
    this.clients.delete(ws);
  }
}
```

### 8.3 WebSocket Server Enhancement

- [x] Update `src/output/WebSocketOutput.js` (implemented with two-way communication):

```javascript
class WebSocketServer {
  constructor(port, connectionPool) {
    this.wss = new WebSocket.Server({ port });
    this.pool = connectionPool;

    this.wss.on('connection', (ws) => this.handleConnection(ws));
  }

  handleConnection(ws) {
    ws.on('message', (data) => this.handleMessage(ws, data));
    ws.on('close', () => this.pool.remove(ws));
    ws.on('error', (err) => console.error('WS error:', err));
  }

  handleMessage(ws, data) {
    try {
      const msg = JSON.parse(data);

      switch (msg.type) {
        case 'register':
          const result = this.pool.register(ws, msg);
          ws.send(JSON.stringify({
            type: 'ack',
            ...result,
            stationCode: msg.stationCode,
            bound: msg.bound
          }));
          break;

        case 'plate':
          this.pool.updatePlate(ws, msg.plate, msg.source);
          break;

        case 'bound-switch':
          this.pool.updateBound(ws, msg.newBound, msg.newStationCode);
          break;

        case 'status-request':
          ws.send(JSON.stringify(this.getStatus()));
          break;
      }
    } catch (err) {
      console.error('Message parse error:', err);
    }
  }

  broadcastWeights(weightsData) {
    this.pool.broadcast({
      type: 'weights',
      ...weightsData
    });
  }
}
```

### 8.4 Station Configuration Database Schema

- [x] Add database tables (implemented in Database.js migrations 004, 005):

```sql
-- Station configuration
CREATE TABLE stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_code TEXT UNIQUE NOT NULL,       -- e.g., "ROMI"
  station_name TEXT NOT NULL,           -- e.g., "Rongo Weighbridge"
  bidirectional BOOLEAN DEFAULT FALSE,
  multi_deck_per_bound BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Bound configuration
CREATE TABLE station_bounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL,
  bound_letter TEXT NOT NULL,           -- 'A' or 'B'
  full_code TEXT NOT NULL,              -- e.g., "ROMIA"
  bound_name TEXT NOT NULL,             -- e.g., "Nairobi Bound"
  deck_count INTEGER DEFAULT 4,
  FOREIGN KEY (station_id) REFERENCES stations(id),
  UNIQUE(station_id, bound_letter)
);

-- Multi-deck per bound configuration
CREATE TABLE bound_decks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bound_id INTEGER NOT NULL,
  deck_letter TEXT NOT NULL,            -- 'A' or 'B'
  deck_code TEXT NOT NULL,              -- e.g., "ATMBA"
  FOREIGN KEY (bound_id) REFERENCES station_bounds(id),
  UNIQUE(bound_id, deck_letter)
);
```

### 8.5 Auto-Weigh Integration with Plate Data

- [ ] Enhance auto-weigh submission:

```javascript
async function submitAutoweigh(clientMeta, weights) {
  const data = {
    deck1: weights[0],
    deck2: weights[1],
    deck3: weights[2],
    deck4: weights[3],
    gvw: weights.reduce((a, b) => a + b, 0),
    nplate: clientMeta.currentPlate || '',
    wbt_no: '',
    autodatetime: new Date().toISOString(),
    autoweighbridge: clientMeta.stationCode,  // Full station code with bound
    weighdate: new Date().toISOString(),
    autouser: 'TruConnect',
    ipaddress: getLocalIP(),
    anpr: clientMeta.currentPlate || '',
    anprb: '',
    autostatus: 'N'  // N = New
  };

  await axios.post(config.autoweigh.endpoint, data, {
    headers: { Authorization: `Bearer ${authToken}` }
  });
}
```

### 8.6 Bound Auto-Detection

- [x] Implement for bidirectional stations (in StateManager.js):

```javascript
function detectEntryDirection(weights, threshold = 100) {
  const deck1Active = weights[0] > threshold;
  const deck4Active = weights[3] > threshold;

  if (deck1Active && !deck4Active) {
    return { bound: 'A', direction: 'forward', confidence: 'high' };
  } else if (deck4Active && !deck1Active) {
    return { bound: 'B', direction: 'reverse', confidence: 'high' };
  }

  return null;
}
```

### 8.7 Settings UI for Station Configuration

- [ ] Add station configuration section to settings:
  - Base station code input
  - Station name input
  - Bidirectional toggle
  - Bound A/B configuration (full code, name)
  - Multi-deck per bound toggle
  - Deck A/B codes (if multi-deck enabled)

---

## Deliverables

1. Two-way WebSocket protocol implementation
2. Connection pool manager with client tracking
3. Station/bound database schema and migrations
4. Auto-weigh with plate integration
5. Settings UI for station configuration
6. Bound auto-detection logic

---

## Verification

### Two-Way Communication Test

1. Start TruConnect with WebSocket server enabled (port 8080)
2. Connect TruLoad client (or test with wscat)
3. Send: `{"type":"register","stationCode":"ROMIA","bound":"A","clientType":"truload"}`
4. Verify ACK received
5. Send: `{"type":"plate","plate":"KAA 123X","source":"manual"}`
6. Verify weights include station code
7. Send: `{"type":"bound-switch","newBound":"B","newStationCode":"ROKSA"}`
8. Verify subsequent weights tagged with ROKSA

### Station Configuration Test

1. Configure bidirectional station in settings
2. Set Bound A = ROMIA, Bound B = ROKSA
3. Connect TruLoad with Bound A
4. Verify weights tagged with ROMIA
5. Switch bound in TruLoad
6. Verify weights tagged with ROKSA

### Auto-Weigh with Plate Test

1. Enable autoweigh integration
2. Connect TruLoad and register
3. Send plate: "KAA 123X"
4. Simulate vehicle on deck
5. Verify autoweigh record includes plate
6. Verify station code includes correct bound
