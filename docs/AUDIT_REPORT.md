# TruConnect Comprehensive Audit Report

**Date**: 2026-01-28
**Auditor**: Systems Architecture Engineer
**Scope**: BengoBox/iConnect, BengoBox/TruLoad/TruConnect, Industry Research

---

## Executive Summary

This audit analyzed all iConnect implementations across the BengoBox project, the current TruConnect middleware, and conducted industry research on weighing scale protocols, RDU integration, and serial communication standards. The goal is to inform the revamped TruConnect architecture.

---

## 1. Codebase Analysis

### 1.1 iConnect Implementations Analyzed

| Location | Version | Lines of Code | Primary Indicator | Key Features |
|----------|---------|---------------|-------------------|--------------|
| iConnect-Juja | V1 | ~800 | Cardinal | Basic RDU, API |
| IConnect-Kanyonyo | V1 | ~900 | ZM | UDP listener, 5 RDUs |
| IConnect-Maimahiu | V1 | ~700 | ZM/Cardinal | TCP client |
| iConnect-Rongo | V2 | ~900 | 1310, ZM | Bidirectional, UDP/TCP |
| iConnect-Webuye | V2 | ~800 | 1310 | Best structured, CONFIG object |
| TruConnect | V2 | ~1200 | API polling | Electron, SQLite, modern UI |

### 1.2 Common Patterns Identified

**Input Sources**:
- Serial COM ports (9600 baud default)
- TCP socket connections (port 13805 typical)
- UDP listeners (port 13805 for Haenni/load cells)
- HTTP API polling (GET /weights)

**Output Methods**:
- Serial RDU (1200 baud, `$=XXXXXXXX=` format)
- TCP socket to USR-TCP232 devices
- HTTP API endpoints (/weights, /anpr, /scan)
- Express.js server on port 3031

**Weight Processing**:
- 4-deck weighbridge support standard
- GVW (Gross Vehicle Weight) calculation
- Vehicle detection threshold (~100 kg)
- Bidirectional weighing support

### 1.3 Indicator Protocol Support

| Protocol | Stations Using | Implementation Quality |
|----------|---------------|------------------------|
| ZM (Avery) | Kanyonyo, Maimahiu, Rongo | Good - CSV parsing |
| Cardinal | Juja, Kanyonyo | Good - Fixed-width |
| Cardinal2 | Kanyonyo, Rongo | Good - Per-deck |
| 1310 | Rongo, Webuye | Good - Scale-numbered |
| UDP/Binary | Rongo, Kanyonyo | Complex - IEEE 754 |

### 1.4 Files Analyzed

**serialout.js variations**:
- `iConnect-Rongo/serialout.js` - 179 lines, multi-RDU with TCP fallback
- `iConnect-Rongo/serialout1.js` - 230 lines, polling + processing
- `IConnect-Kanyonyo/serialout.js` - 150 lines, basic serial
- `TruConnect/serialout.js` - 189 lines, class-based RDUCommunicator

**getData.js variations**:
- `iConnect-Rongo/getData.js` - 885 lines, full autoweigh integration
- `IConnect-Kanyonyo/getData.js` - 883 lines, ZM parsing focus
- `iConnect-Webuye/readdata.js` - 767 lines, best structured with CONFIG

---

## 2. Protocol Deep Dive

### 2.1 Indicator Input Protocols

#### ZM (Avery Weigh-Tronix)
```
Input: ENQ (0x05) every 1000ms
Output: "  5200 kg, 12440 kg, 0 kg,  0 kg,\r"
Parsing: Split by comma, extract numeric, strip "kg"
```

#### Cardinal (Fixed-width)
```
Input: ENQ (0x05) every 1000ms
Output: 90-character fixed-width string
Parsing: Split by comma, take first 8 chars per field
```

#### Cardinal2 (Per-deck)
```
Output: "Z1G 2        5500kg\r"
Format: [Status][Deck][Padding][Weight][Unit]
Position 4-5: Deck number (1-4)
Position 6 to end-2: Weight value
```

#### 1310 Indicator
```
Output (multi-line):
  "Scale No: 1\r\n"
  "G 5200kg\r\n"
Parsing: Match "Scale No:" for deck, "G" prefix for gross
```

#### UDP Binary (Haenni/Load Cells)
```
Port: 13805
Format: Binary packet, IEEE 754 floats
Offset 120: Start of weight data
Each deck: 5 bytes (1 stability + 4 weight bytes)
Weight: Little-endian hex, reversed byte order
```

### 2.2 RDU Output Protocol

**Format**: `$=XXXXXXXX=`

**Encoding**:
1. Convert weight to string: `5200` -> `"5200"`
2. Reverse digits: `"5200"` -> `"0025"`
3. Pad to 8 chars: `"0025"` -> `"00250000"`
4. Wrap: `"$=00250000="`

**Connection Options**:
- Direct Serial: COM1-COM16, 1200 baud
- USR-TCP232: TCP to IP:port (default 4196)

### 2.3 API Endpoints

| Endpoint | Method | Purpose | Response Format |
|----------|--------|---------|-----------------|
| `/weights` | GET | Current weights | `STATION*taken*readings*status*scan` |
| `/weights` | POST | Weight confirmation | JSON with ticket data |
| `/scan` | POST | ANPR scan notification | `{ scanned: 1 }` |
| `/anpr` | GET | Get plate number | `{ plate: "KAA 123X" }` |
| `/NotificationInfo/KeepAlive` | POST | Device heartbeat | `{ Active, DeviceID }` |
| `/NotificationInfo/TollgateInfo` | POST | ANPR camera data | Plate from Picture object |

---

## 3. Industry Research Findings

### 3.1 USR-TCP232 Devices

**Source**: [PUSR IOT](https://www.pusr.com/products/modbus-serial-to-ethernet-converters-usr-tcp232-410s.html)

- **USR-TCP232-410S**: 2 ports, Modbus gateway, -40 to +85C
- **USR-TCP232-306**: 1 port, RS232/RS485/RS422
- **USR-TCP232-302**: 1 port, basic RS232

**Configuration**: Web interface at device IP (default 192.168.0.7)
**Default Port**: 4196

### 3.2 Avery Weigh-Tronix ZM Series

**Source**: [Avery Weigh-Tronix](https://averyweigh-tronix.com/zm400)

- ZM201: 2x RS232, Ethernet, SMA/Broadcast/Enquire
- ZM303: 2x RS232 full duplex
- ZM405: 2x RS232, USB host
- ZM510: 3x RS232, Ethernet with 10 device support

**Protocols**: SMA, Broadcast, Enquire modes

### 3.3 Haenni Portable Scales

**Source**: [Haenni Scales](https://www.haenni-scales.com/)

- WL103/WL104 with software integration
- Fieldbus interface with wireless option
- Up to 12 scales networked
- HNP Socket: Port 50505 for real-time streaming

### 3.4 Mobile Scale Integration

**Intercomp**: Standalone or integrated with software, cameras, traffic control
**SmartBridge**: Weight indicator support via TCP/IP, PLC, or network PC

---

## 4. Current TruConnect Analysis

### 4.1 Architecture

```
API Polling (GET /weights)
    -> Main Process (Electron)
        -> Parse weights
        -> RDUCommunicator.updateWeights()
        -> RDUCommunicator.sendToAllRdus()
        -> IPC to Renderer
            -> Dashboard UI update
```

### 4.2 Key Components

| File | Purpose | Lines |
|------|---------|-------|
| main.js | Electron main, polling, IPC | 506 |
| serialout.js | RDUCommunicator class | 189 |
| src/config.js | ConfigManager singleton | 116 |
| src/database.js | SQLite manager | 200 |
| preload.js | Secure IPC bridge | 104 |
| renderer.js | UI updates | 75 |

### 4.3 Configuration Schema

```javascript
{
  stationName: 'Webuye Weighbridge',
  apiUrl: 'http://192.168.4.151:3031/weights',
  pollInterval: 1000,
  theme: 'dark',
  rduConfigs: [
    { id: 'Deck1', serialPort: 'COM1', tcpPort: 24, ip: '192.168.4.93' },
    // ... 4 more devices
  ]
}
```

---

## 5. Gap Analysis

### 5.1 Missing Features

| Feature | Priority | Complexity | Notes |
|---------|----------|------------|-------|
| Direct indicator connection | P0 | Medium | Currently API-only |
| WebSocket real-time output | P0 | Low | For TruLoad frontend |
| Multiple indicator protocols | P0 | Medium | ZM, Cardinal, 1310, etc. |
| Simulation mode | P0 | Low | For testing |
| Modbus RTU support | P1 | Medium | Some indicators support |
| HNP Socket (Haenni) | P1 | Medium | Port 50505 streaming |
| Auto-detection | P2 | High | Probe indicator type |
| Weight buffering | P2 | Low | Queue when offline |
| Multi-tenant support | P2 | Medium | Multiple stations |

### 5.2 Documentation Gaps (Now Filled)

- [x] USR-TCP232 device configuration
- [x] Avery ZM series protocols
- [x] Mobile scale integration patterns
- [x] WebSocket best practices
- [x] Gap analysis and recommendations

### 5.3 Code Quality Issues

| Issue | Location | Recommendation |
|-------|----------|----------------|
| Hardcoded credentials | getData.js | Move to config/env |
| No error boundaries | serialout.js | Add try-catch wrappers |
| Global state | All iConnect | Use class/module pattern |
| Mixed async patterns | getData.js | Standardize on async/await |
| No logging framework | All | Add structured logging |

---

## 6. Recommendations

### 6.1 Architecture Redesign

1. **Modular Protocol Handlers**: Plugin-based indicator support
2. **Event-Driven Core**: Central EventBus for weight updates
3. **Multi-Output Manager**: Simultaneous WS, API, Serial, Network
4. **Configuration UI**: Full settings management in Electron

### 6.2 Implementation Priority

**Phase 1 (P0)**: Core functionality
- Direct serial/TCP indicator input
- All existing protocol parsers
- WebSocket server output
- API polling endpoint
- Serial RDU output

**Phase 2 (P1)**: Enhanced features
- Network RDU (USR-TCP232)
- Simulation mode
- Authentication
- Autoweigh integration

**Phase 3 (P2)**: Advanced features
- Auto-detection
- Modbus RTU
- HNP Socket
- Weight buffering
- Diagnostics UI

### 6.3 Technology Stack

| Component | Current | Recommended |
|-----------|---------|-------------|
| Electron | 28.x | 33.x |
| Node.js | 18.x | 22.x LTS |
| serialport | 12.x | 12.x (latest) |
| SQLite | sqlite3 | better-sqlite3 |
| WebSocket | - | ws 8.x |
| HTTP Server | Express 4.x | Express 4.x or Fastify |

---

## 7. Data Structure Audit (January 2026)

### 7.1 Issue: WebSocket vs API Response Format Inconsistency

The WebSocket `broadcastWeight()` and API `/api/v1/weights` endpoints were returning different data structures, causing the frontend to maintain separate parsing logic for each connection mode.

**Before Fix - WebSocket (mobile mode):**
```json
{
  "event": "weight",
  "data": {
    "mode": "mobile",
    "weight": 5200,
    "axleNumber": 2,
    "axleWeights": [5200],
    "runningTotal": 5200,
    "stable": true,
    "source": "paw"
  }
}
```

**Before Fix - API (mobile mode):**
```json
{
  "success": true,
  "mode": "mobile",
  "data": {
    "currentWeight": 5200,
    "runningGvw": 10400,
    "stable": true,
    "session": { "currentAxle": 2, "totalAxles": 5, "axles": [...], "gvw": 5200 },
    "scaleInfo": { "battery": 85, "temperature": 25, "signalStrength": 100 }
  },
  "connection": { "source": "paw", "protocol": "PAW", "connected": true }
}
```

### 7.2 Fix Applied

Updated `WebSocketOutput.js:broadcastWeight()` to include:
- `connection` info (source, protocol, type, connected, device metadata)
- `session` state for mobile mode (matches API structure)
- `scaleInfo` for mobile mode (battery, temperature, signalStrength, make, model)
- `indicatorInfo` for multideck mode (make, model, signalStrength)
- `decks` array format (in addition to flat `deck1-4` for backward compatibility)
- `runningGvw` and `currentWeight` aliases (for API compatibility)

**After Fix - WebSocket (mobile mode):**
```json
{
  "event": "weight",
  "data": {
    "mode": "mobile",
    "weight": 5200,
    "currentWeight": 5200,
    "runningTotal": 10400,
    "runningGvw": 10400,
    "axleNumber": 2,
    "axleWeights": [5200],
    "session": { "currentAxle": 2, "totalAxles": 5, "axles": [...], "gvw": 5200 },
    "stable": true,
    "scaleInfo": { "battery": 85, "temperature": 25, "signalStrength": 100, "make": "PAW", "model": "LP600" },
    "connection": { "source": "paw", "protocol": "PAW", "connected": true, "outputMode": "websocket" }
  }
}
```

**After Fix - WebSocket (multideck mode):**
```json
{
  "event": "weights",
  "data": {
    "mode": "multideck",
    "deck1": 6500, "deck2": 8200, "deck3": 9100, "deck4": 7800,
    "decks": [
      { "index": 1, "weight": 6500, "stable": true },
      { "index": 2, "weight": 8200, "stable": true },
      { "index": 3, "weight": 9100, "stable": true },
      { "index": 4, "weight": 7800, "stable": true }
    ],
    "gvw": 31600,
    "vehicleOnDeck": true,
    "stable": true,
    "indicatorInfo": { "make": "Zedem", "model": "ZM-400", "signalStrength": 100 },
    "connection": { "source": "indicator_zm", "protocol": "ZM", "connected": true, "outputMode": "websocket" }
  }
}
```

### 7.3 Frontend Hook Update

Updated `useMiddleware.ts`:
- Extended `WeightData` interface to include new fields (connection, scaleInfo, session, etc.)
- Updated `handleMessage()` to extract scale status from enhanced weight events
- Frontend now receives consistent data structure from both WebSocket and API modes

### 7.4 Files Modified

| File | Change |
|------|--------|
| `TruConnect/src/output/WebSocketOutput.js` | Enhanced `broadcastWeight()` to include connection, scaleInfo, indicatorInfo, session data |
| `truload-frontend/src/hooks/useMiddleware.ts` | Extended `WeightData` interface, updated `handleMessage()` to extract scale status |

---

## 8. Conclusion

The audit reveals a mature ecosystem with well-established patterns for weighbridge integration. The data structure audit (Section 7) identified and fixed WebSocket vs API response format inconsistencies to ensure the frontend receives consistent data regardless of connection mode.

The key opportunity is consolidating the best practices from all iConnect implementations into a unified, highly configurable TruConnect middleware that:

1. **Supports all indicator protocols** from existing implementations
2. **Provides multiple output methods** (WS, API, Serial, Network)
3. **Is fully configurable** via UI and database
4. **Includes simulation mode** for development/testing
5. **Follows modern Node.js/Electron best practices**

The existing documentation is comprehensive and has been enhanced with research findings on USR devices, industry protocols, and recommended patterns.

---

## Appendix: Key File Locations

```
BengoBox/
├── iConnect/
│   ├── iConnect-Juja/iConnect/       # Juja station
│   ├── IConnect-Kanyonyo/            # Kanyonyo station
│   ├── IConnect-Maimahiu/            # Maimahiu station
│   ├── iConnect-Rongo/               # Rongo station (best patterns)
│   ├── iConnect-Webuye/              # Webuye station (best structure)
│   ├── IconnectV1/                   # Legacy V1
│   └── IconnectV12/                  # V1.2
│
└── TruLoad/
    ├── TruConnect/                   # Current middleware
    │   ├── main.js                   # Electron main
    │   ├── serialout.js              # RDU communicator
    │   ├── src/                      # Core modules
    │   ├── docs/                     # Documentation
    │   └── pages/                    # UI
    │
    ├── truload-backend/              # .NET 8 backend
    └── truload-frontend/             # Next.js frontend
```
