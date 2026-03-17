# TruConnect - Integration Guide

## Indicator Protocols

### 1. ZM (Avery Weigh-Tronix)

**Communication**: RS-232 Serial, 9600 baud, 8N1

**Command**: ENQ (0x05) sent periodically to request weight

**Response Format**:
```
[weight1] kg,[weight2] kg,[weight3] kg,[weight4] kg,
```

**Example**:
```
  5200 kg, 12440 kg, 0 kg,  0 kg,
```

**Parsing Logic**:
```javascript
function parseZM(data) {
  const deckW = data.split(',');
  const weights = [];
  for (let i = 0; i < 4; i++) {
    const weight = deckW[i]?.trim().replace(/[^\d.-]/g, '') || '0';
    weights.push(parseInt(weight, 10) || 0);
  }
  return { deck1: weights[0], deck2: weights[1], deck3: weights[2], deck4: weights[3] };
}
```

---

### 2. Cardinal

**Communication**: RS-232 Serial, 9600 baud, 8N1

**Response Format**: Fixed-width 90-character string with comma-separated values

**Example**:
```
    5000    5500    6200    4800    ... (continues to 90 chars)
```

**Parsing Logic**:
```javascript
function parseCardinal(data) {
  if (data.length <= 89) return null;
  const deckW = data.substring(0, 90).split(',');
  const weights = [];
  for (let i = 0; i < 4; i++) {
    const weight = deckW[i]?.substring(0, 8).trim() || '0';
    weights.push(parseInt(weight, 10) || 0);
  }
  return { deck1: weights[0], deck2: weights[1], deck3: weights[2], deck4: weights[3] };
}
```

---

### 3. Cardinal2

**Communication**: RS-232 Serial, 9600 baud, 8N1

**Response Format**: Per-deck messages with deck identifier

**Format**: `Z[status]G [deck]        [weight]kg\r`

**Example**:
```
Z1G 2        5500kg
```
- Position 4-5: Deck number (1-4)
- Position 6 to end-2: Weight value

**Parsing Logic**:
```javascript
let deckWeights = [0, 0, 0, 0];

function parseCardinal2(data) {
  const deck = data.substring(4, 5);
  if (['1', '2', '3', '4'].includes(deck)) {
    const weight = parseInt(data.substring(6, data.length - 2).trim(), 10) || 0;
    deckWeights[parseInt(deck) - 1] = weight;
  }
  return { deck1: deckWeights[0], deck2: deckWeights[1], deck3: deckWeights[2], deck4: deckWeights[3] };
}
```

---

### 4. 1310 Indicator

**Communication**: RS-232 Serial, 9600 baud, 8N1

**Response Format**: Multi-line per scale

**Scale Header**: `Scale No: [n]`
**Weight Line**: `G [weight]kg` (Gross) or `N [weight]kg` (Net)

**Alternative Format**: Comma-separated single line

**Parsing Logic**:
```javascript
let scaleWeights = { scale1: 0, scale2: 0, scale3: 0, scale4: 0 };
let currentScale = null;

function parse1310(data) {
  const scaleMatch = data.match(/Scale No:\s+(\d+)/);
  if (scaleMatch) {
    currentScale = `scale${parseInt(scaleMatch[1], 10)}`;
  }
  
  const grossMatch = data.match(/^G\s+(-?\d+)\s*kg/);
  if (grossMatch && currentScale) {
    scaleWeights[currentScale] = parseInt(grossMatch[1], 10);
    currentScale = null;
  }
  
  return {
    deck1: scaleWeights.scale1,
    deck2: scaleWeights.scale2,
    deck3: scaleWeights.scale3,
    deck4: scaleWeights.scale4
  };
}
```

---

### 5. PAW (Portable Axle Weigher) Protocol

**Communication**: RS-232/USB Serial via Weight Console

**Connection Defaults**:
- **Port**: COM7 (configurable)
- **Baud Rate**: 9600
- **Data Bits**: 8
- **Parity**: None
- **Stop Bits**: 1

**Serial Commands**:
| Command | Description |
|---------|-------------|
| `W` | Request weight reading (query command) |
| `Q` | Request weight reading (like pressing print key) |
| `Z` | Zero/tare the scale |
| `U` | Toggle units (lb/kg) |
| `D` | Toggle gross/net mode |
| `T` | Tare |

**Response Format**:
```
ST,GS, 0000270kg
ST,GS, 0000270kg
ST,GS, 0000270kg
```

**Format Breakdown**:
| Field | Meaning | Values |
|-------|---------|--------|
| `ST` | Stability | ST = Stable, US = Unstable |
| `GS` | Weight Mode | GS = Gross, NT = Net |
| `0000270kg` | Weight | Combined Scale A+B (wheel pair = axle total) |

**Important Notes**:
- PAW wheel weighers have two scales (A and B) for left/right wheels
- The weight console reports the **combined weight** (A+B) as the axle weight
- Each response is one axle weight reading
- Continuous streaming mode sends readings at regular intervals

**Parsing Logic**:
```javascript
function parsePAWWeight(data) {
  // Format: ST,GS, 0000270kg
  const match = data.match(/^(ST|US)?,?\s*(GS|NT)?,?\s*(\d+)\s*kg/i);
  if (match) {
    const stable = match[1]?.toUpperCase() === 'ST';
    const weight = parseInt(match[3], 10);
    return { weight, stable, isGross: match[2]?.toUpperCase() === 'GS' };
  }
  return null;
}
```

**TruConnect Configuration**:
```json
{
  "input": {
    "indicator": {
      "type": "serial",
      "protocol": "PAW",
      "serial": {
        "port": "COM7",
        "baudRate": 9600
      }
    }
  }
}
```

---

### 6. Haenni WebServer API

**Communication**: HTTP REST API (Mongoose Web Server for Windows)

**Default URL**: `http://localhost:8888/devices/measurements`

The Haenni WebServer runs locally on port 8888 and provides REST endpoints for weight data.

**API Root Response**:
```json
{
  "status": "/api/status",
  "devices": "/api/devices",
  "zero": "/api/devices/zero",
  "measurements": "/api/devices/measurements",
  "interface": "/api/devices/interface",
  "service": "/api/devices/service",
  "simulation": "/api/simulation"
}
```

**Endpoints**:
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Server status, version, HNP socket config |
| `/api/devices` | GET | Connected devices list |
| `/api/devices/measurements` | GET | **Current weight readings** |
| `/api/devices/zero` | POST | Zero/tare the scale |
| `/api/devices/interface` | GET | Interface configuration |
| `/api/devices/service` | GET | Service status |
| `/api/simulation` | GET/POST | Simulation mode control |

**Status Response Example**:
```json
{
  "isRunning": true,
  "consoleVisible": true,
  "version": "0.1.9",
  "autoOffTimeout": 60,
  "disableHnpSocket": false,
  "hnpSocketPort": 50505,
  "hnpSocketServer": true,
  "disableUsb": false,
  "hnpVersion": "1.5.0",
  "wl103LibraryVersion": null,
  "wl103DriverVersion": null
}
```

**HNP Socket**: Port 50505 (configurable) for real-time data streaming

**TruConnect Configuration**:
```json
{
  "input": {
    "indicator": {
      "type": "api",
      "protocol": "HAENNI",
      "api": {
        "url": "http://localhost:8888/devices/measurements",
        "interval": 500,
        "method": "GET"
      }
    }
  }
}
```

**Polling Implementation**:
```javascript
async function pollHaenniWeight() {
  const response = await axios.get('http://localhost:8888/devices/measurements');
  return normalizeWeight(response.data, 'haenni');
}

async function zeroHaenniScale() {
  await axios.post('http://localhost:8888/devices/zero');
}
```

---

### 7. MCGS Mobile Scale (Serial)

**Communication**: RS-232 Serial, 9600 baud, 8N1

**Frame Format**: Continuous stream of combined axle weights.
```
=SG+0000123kR
=SG+0000123kX
```
- `=SG+`: Header
- `0000123`: Weight value (Scale A + B combined)
- `kR` / `kX`: Unit (kg) and Status

**Cumulative Weight Logic**:
MCGS scales often operate in a cumulative mode where each subsequent reading includes the weight of all previously weighed axles. TruConnect handles this by:
1. Identifying if `useCumulativeWeight` is enabled for the source.
2. Subtracting the current session GVW (sum of previously captured axles) from the raw reading.
3. Reporting the result as the "True" current axle weight.

#### Example: 7-Axle Cumulative Weighing (MCGS)

In this scenario, the vehicle has 7 axles. The scale provides the cumulative total at each step. TruConnect automatically subtracts the weight of previously captured axles to derive the weight of the current axle on the scale.

| Step | Mobile Axle | Scale Reading (Raw GVW) | Session GVW (Captured) | Calculated Axle Weight | Action |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Axle 1 | 6,000 kg | 0 kg | 6,000 - 0 = **6,000 kg** | Capture |
| 2 | Axle 2 | 14,200 kg | 6,000 kg | 14,200 - 6,000 = **8,200 kg** | Capture |
| 3 | Axle 3 | 22,500 kg | 14,200 kg | 22,500 - 14,200 = **8,300 kg** | Capture |
| 4 | Axle 4 | 30,100 kg | 22,500 kg | 30,100 - 22,500 = **7,600 kg** | Capture |
| 5 | Axle 5 | 37,800 kg | 30,100 kg | 37,800 - 30,100 = **7,700 kg** | Capture |
| 6 | Axle 6 | 45,600 kg | 37,800 kg | 45,600 - 37,800 = **7,800 kg** | Capture |
| 7 | Axle 7 | 53,400 kg | 45,600 kg | 53,400 - 45,600 = **7,800 kg** | **Auto-Submit** |

**Note**: After the last axle (Step 7) is captured, TruConnect detects that the weighing is complete (7/7 axles) and automatically submits the data to the configured backend URL.

**Serial Commands (Binary)**:
| Command | Hex/Binary | Description |
|---------|------------|-------------|
| Weigh | `\x02A\x03` | STX 'A' ETX - Request current weight |
| Zero | `\x02D\x03` | STX 'D' ETX - Zero/Tare scale |
| Stop | `STOP\r\n` | Cancel current session |

**TruConnect Configuration**:
```json
{
  "input": {
    "mcgs": {
      "type": "serial",
      "protocol": "MCGS",
      "useCumulativeWeight": true,
      "serial": {
        "port": "COM3",
        "baudRate": 9600,
        "commands": {
          "weigh": "\\x02A\\x03",
          "zero": "\\x02D\\x03",
          "stop": "STOP\\r\\n"
        }
      }
    }
  }
}
```

---

**Port**: 13805 (typical)

**Data Format**: Binary packet with IEEE 754 float weights

**Packet Structure**:
- Bytes 0-23: Header/metadata
- Bytes 24+: Weight data (5 bytes per deck: 1 stability + 4 weight)

**Weight Extraction** (bytes 120+):
```javascript
function parseUdpWeights(buffer) {
  const weights = [];
  let offset = 120;
  
  for (let i = 0; i < 4; i++) {
    const stability = buffer[offset];
    const hexWeight = '0x' + 
      buffer[offset+4].toString(16).padStart(2,'0') +
      buffer[offset+3].toString(16).padStart(2,'0') +
      buffer[offset+2].toString(16).padStart(2,'0') +
      buffer[offset+1].toString(16).padStart(2,'0');
    
    weights.push(ieee754ToWeight(hexWeight));
    offset += 5;
  }
  
  return { deck1: weights[0], deck2: weights[1], deck3: weights[2], deck4: weights[3] };
}

function ieee754ToWeight(hexStr) {
  const int = parseInt(hexStr, 16);
  const sign = (int >>> 31) ? -1 : 1;
  const exp = ((int >>> 23) & 0xff) - 127;
  const mantissa = ((int & 0x7fffff) + 0x800000);
  
  let float = 0;
  let e = exp;
  for (let i = 0; i < 24; i++) {
    if ((mantissa >> (23 - i)) & 1) {
      float += Math.pow(2, e);
    }
    e--;
  }
  
  return Math.round((float * sign) / 10) * 10;
}
```

---

### 8. Custom Protocol (User-Defined)

TruConnect supports fully configurable custom protocols for indicators and mobile scales not covered by built-in parsers. This allows integration with any scale/indicator by defining:

1. **Connection parameters** (serial/TCP/UDP/HTTP)
2. **Query command** (what to send to request weight)
3. **Response parsing** (regex or structured extraction)
4. **Weight field mapping** (which fields map to which decks)

**Custom Protocol Configuration Schema:**

```typescript
interface CustomProtocolConfig {
  id: string;                    // Unique identifier
  name: string;                  // Display name
  category: 'indicator' | 'mobile';  // Type of scale

  // Connection settings
  connection: {
    type: 'serial' | 'tcp' | 'udp' | 'http';

    // Serial options
    port?: string;               // e.g., "COM1"
    baudRate?: number;           // e.g., 9600
    dataBits?: 8 | 7;
    stopBits?: 1 | 2;
    parity?: 'none' | 'even' | 'odd';

    // Network options
    host?: string;               // IP address
    networkPort?: number;        // Port number

    // HTTP options
    apiUrl?: string;             // Full URL for HTTP
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
  };

  // Query configuration
  query: {
    mode: 'poll' | 'stream';     // Poll = send command; Stream = continuous
    command?: string;            // Command to send (e.g., "Q", "\x05")
    commandHex?: string;         // Hex command (e.g., "05" for ENQ)
    interval?: number;           // Poll interval in ms
    timeout?: number;            // Response timeout in ms
  };

  // Response parsing
  parsing: {
    type: 'regex' | 'delimiter' | 'fixed' | 'json';

    // Regex parsing
    pattern?: string;            // Regex pattern with capture groups

    // Delimiter parsing
    delimiter?: string;          // e.g., "," or "\t"

    // Fixed-width parsing
    positions?: Array<{
      start: number;
      end: number;
      field: string;
    }>;

    // JSON path parsing
    jsonPath?: Record<string, string>;  // field -> JSON path

    // Common options
    stripNonNumeric?: boolean;   // Remove non-numeric chars from weight
    multiplier?: number;         // Multiply weight (e.g., 0.1 for decimals)
    decimalPlaces?: number;      // Round to decimal places
  };

  // Field mapping (which parsed fields map to weights)
  fieldMapping: {
    deck1?: string;              // Field name for deck 1
    deck2?: string;              // Field name for deck 2
    deck3?: string;              // Field name for deck 3
    deck4?: string;              // Field name for deck 4
    gvw?: string;                // Field name for GVW (or calculated)
    stable?: string;             // Field name for stability indicator
    unit?: string;               // Field name for unit
  };

  // Output format
  output: {
    mode: 'multideck' | 'mobile';
    deckCount?: number;          // Number of decks (1-4)
    axleCount?: number;          // For mobile: max axles
    calculateGvw?: boolean;      // Auto-calculate GVW from decks
  };
}
```

**Example 1: Custom Serial Indicator (CSV format)**

```json
{
  "id": "custom-csv-indicator",
  "name": "Generic CSV Indicator",
  "category": "indicator",
  "connection": {
    "type": "serial",
    "port": "COM3",
    "baudRate": 9600,
    "dataBits": 8,
    "stopBits": 1,
    "parity": "none"
  },
  "query": {
    "mode": "poll",
    "commandHex": "05",
    "interval": 1000,
    "timeout": 500
  },
  "parsing": {
    "type": "delimiter",
    "delimiter": ",",
    "stripNonNumeric": true
  },
  "fieldMapping": {
    "deck1": "0",
    "deck2": "1",
    "deck3": "2",
    "deck4": "3"
  },
  "output": {
    "mode": "multideck",
    "deckCount": 4,
    "calculateGvw": true
  }
}
```

**Example 2: Custom HTTP API Scale**

```json
{
  "id": "custom-api-scale",
  "name": "Custom REST API Scale",
  "category": "indicator",
  "connection": {
    "type": "http",
    "apiUrl": "http://192.168.1.100:8080/api/weight",
    "method": "GET",
    "headers": {
      "Authorization": "Bearer token123"
    }
  },
  "query": {
    "mode": "poll",
    "interval": 500,
    "timeout": 3000
  },
  "parsing": {
    "type": "json",
    "jsonPath": {
      "deck1": "$.scales[0].weight",
      "deck2": "$.scales[1].weight",
      "deck3": "$.scales[2].weight",
      "deck4": "$.scales[3].weight",
      "stable": "$.status.stable"
    }
  },
  "fieldMapping": {
    "deck1": "deck1",
    "deck2": "deck2",
    "deck3": "deck3",
    "deck4": "deck4",
    "stable": "stable"
  },
  "output": {
    "mode": "multideck",
    "deckCount": 4,
    "calculateGvw": true
  }
}
```

**Example 3: Custom Mobile Scale (Regex parsing)**

```json
{
  "id": "custom-mobile-scale",
  "name": "Generic Mobile Weigher",
  "category": "mobile",
  "connection": {
    "type": "serial",
    "port": "COM5",
    "baudRate": 9600
  },
  "query": {
    "mode": "poll",
    "command": "W",
    "interval": 500
  },
  "parsing": {
    "type": "regex",
    "pattern": "^(ST|US),([A-Z]+),\\s*(\\d+)\\s*(kg|lb)$",
    "stripNonNumeric": false
  },
  "fieldMapping": {
    "stable": "1",
    "deck1": "3",
    "unit": "4"
  },
  "output": {
    "mode": "mobile",
    "axleCount": 7,
    "calculateGvw": true
  }
}
```

**Custom Parser Implementation:**

```javascript
class CustomParser {
  constructor(config) {
    this.config = config;
    this.deckWeights = [0, 0, 0, 0];
  }

  parse(data) {
    let fields = {};

    switch (this.config.parsing.type) {
      case 'regex':
        fields = this.parseRegex(data);
        break;
      case 'delimiter':
        fields = this.parseDelimiter(data);
        break;
      case 'fixed':
        fields = this.parseFixed(data);
        break;
      case 'json':
        fields = this.parseJson(data);
        break;
    }

    return this.mapFields(fields);
  }

  parseRegex(data) {
    const match = data.match(new RegExp(this.config.parsing.pattern));
    if (!match) return {};

    const fields = {};
    match.forEach((val, idx) => {
      if (idx > 0) fields[String(idx)] = val;
    });
    return fields;
  }

  parseDelimiter(data) {
    const parts = data.split(this.config.parsing.delimiter);
    const fields = {};
    parts.forEach((val, idx) => {
      fields[String(idx)] = this.config.parsing.stripNonNumeric
        ? val.replace(/[^\d.-]/g, '')
        : val.trim();
    });
    return fields;
  }

  parseJson(data) {
    try {
      const obj = JSON.parse(data);
      const fields = {};
      for (const [field, path] of Object.entries(this.config.parsing.jsonPath)) {
        fields[field] = this.getJsonPath(obj, path);
      }
      return fields;
    } catch {
      return {};
    }
  }

  mapFields(fields) {
    const mapping = this.config.fieldMapping;
    const weights = {
      deck1: parseInt(fields[mapping.deck1] || '0', 10) || 0,
      deck2: parseInt(fields[mapping.deck2] || '0', 10) || 0,
      deck3: parseInt(fields[mapping.deck3] || '0', 10) || 0,
      deck4: parseInt(fields[mapping.deck4] || '0', 10) || 0,
      stable: fields[mapping.stable] === 'ST' || fields[mapping.stable] === 'true'
    };

    if (this.config.output.calculateGvw) {
      weights.gvw = weights.deck1 + weights.deck2 + weights.deck3 + weights.deck4;
    }

    return weights;
  }
}
```

---

## Output Protocols

### 1. RDU (Remote Display Unit) Output

TruConnect supports a single RDU device with up to 5 panels for displaying weight data. Each panel can be assigned to a specific deck (1-4) or GVW.

#### RDU Configuration

**IMPORTANT**: Only ONE RDU device can be configured per system. The RDU can have multiple panels (1-5) that display weights for different decks.

##### Configuration Data Structure

```typescript
interface RduConfig {
  enabled: boolean;              // Enable/disable RDU output
  name: string;                  // Display name (e.g., "Main RDU")
  model: 'KELI' | 'Yaohua' | 'Generic';  // RDU model type
  connectionType: 'serial' | 'usr';       // Connection method
  format: string;                // Message format template

  // For USR-TCP232 network connection
  usr?: {
    ip: string;                  // USR device IP (e.g., "192.168.1.100")
    port: number;                // USR device port (default: 4196)
  };

  // Panel configurations (1-5 panels)
  panels: Array<{
    deckIndex: number;           // 0=deck1, 1=deck2, 2=deck3, 3=deck4, 4=GVW
    baudRate: number;            // Typically 1200

    // For serial connection
    port?: string;               // COM port (e.g., "COM3")

    // For USR connection
    channel?: number;            // USR channel index
  }>;
}
```

##### Supported RDU Models

| Model | Format String | Format Type | Example Output |
|-------|---------------|-------------|----------------|
| KELI | `$={WEIGHT}=` | Reversed | `$=00200000=` (200 kg) |
| Yaohua YHL | `$={WEIGHT}=` | Reversed | `$=00200000=` (200 kg) |
| XK3190 | `={WEIGHT}=` | Reversed | `=00200000=` (200 kg) |
| Cardinal | `{WEIGHT}` | Leading | `00000200` (200 kg) |
| Avery WT | `W{WEIGHT}` | Leading | `W00000200` (200 kg) |
| Generic | `{WEIGHT}` | Leading | `00000200` (200 kg) |

**Format Types:**
- **Reversed**: Digits are reversed, then padded with trailing zeros to 8 chars (KELI/Yaohua/XK3190)
- **Leading**: Weight padded with leading zeros to 8 chars (Cardinal/Avery/Generic)

##### Weight Formatting Logic

```javascript
// Models that use reversed digit format
const REVERSED_FORMAT_MODELS = ['KELI', 'YAOHUA', 'YAOHUA_YHL', 'XK3190'];

function formatRduMessage(weight, formatTemplate, model) {
  const str = Math.abs(Math.round(weight)).toString();
  let padded;

  if (REVERSED_FORMAT_MODELS.includes(model.toUpperCase())) {
    // KELI/Yaohua format: reverse digits, trailing zeros
    const reversed = str.split('').reverse().join('');
    padded = reversed.padEnd(8, '0');
  } else {
    // Generic format: leading zeros
    padded = str.padStart(8, '0');
  }

  return formatTemplate.replace('{WEIGHT}', padded);
}

// Examples:
// KELI/Yaohua (reversed):
// Weight 200 → "002" reversed → "00200000" padded → '$=00200000='
// Weight 5200 → "0025" reversed → "00250000" padded → '$=00250000='

// Cardinal/Generic (leading):
// Weight 200 → "00000200" leading zeros → '00000200'
// Weight 5200 → "00005200" leading zeros → '00005200'
```

#### Connection Types

##### Serial Connection (Direct COM Port)

Each panel connects to a separate COM port. Used when RDU displays are directly connected to the PC.

```javascript
// Serial panel configuration
{
  deckIndex: 0,      // deck1
  port: "COM3",      // Direct serial port
  baudRate: 1200
}
```

##### USR-TCP232 Network Connection

All panels share a single USR-TCP232 serial-to-ethernet device. The USR device is configured to route data to multiple connected RDU displays.

```javascript
// USR configuration
{
  connectionType: 'usr',
  usr: {
    ip: '192.168.1.100',
    port: 4196
  },
  panels: [
    { deckIndex: 0, channel: 0, baudRate: 1200 },  // deck1
    { deckIndex: 1, channel: 1, baudRate: 1200 },  // deck2
    { deckIndex: 4, channel: 2, baudRate: 1200 }   // GVW
  ]
}
```

#### Panel Assignment

| Panel Index | Assignment | Description |
|-------------|------------|-------------|
| 0 | Deck 1 | First axle/deck weight |
| 1 | Deck 2 | Second axle/deck weight |
| 2 | Deck 3 | Third axle/deck weight |
| 3 | Deck 4 | Fourth axle/deck weight |
| 4 | GVW | Gross Vehicle Weight (sum of all decks) |

#### RDUCommunicator Class

```javascript
class RDUCommunicator {
  constructor(config) {
    this.config = config;
    this.connections = [];              // Panel connections
    this.currentWeights = [0,0,0,0,0];  // deck1-4 + GVW
    this.enabled = config.enabled || false;
    this.messageFormat = config.format || '$={WEIGHT}=';
  }

  // Initialize all panel connections
  initializeConnections() {
    if (this.config.connectionType === 'serial') {
      this.initializeSerialConnections();
    } else if (this.config.connectionType === 'usr') {
      this.initializeUsrConnection();
    }
  }

  // Update weights and send to all panels
  updateWeights(newWeights) {
    this.currentWeights = newWeights;
    this.sendToAllRdus();
  }

  // Send formatted weight to each panel based on its deck assignment
  sendToAllRdus() {
    this.connections.forEach(conn => {
      const weight = this.currentWeights[conn.deckIndex] || 0;
      const message = weight > 10
        ? this.formatMessage(weight)
        : this.formatMessage(0);

      if (conn.type === 'SERIAL') {
        this.sendSerial(conn, message);
      } else if (conn.type === 'USR') {
        this.sendUsr(conn, message);
      }
    });
  }
}
```

---

### 2. WebSocket Real-time Output

**Default Port**: 3030 (configurable in settings)

**Server Mode** (for local clients):
```javascript
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 3030 });

wss.on('connection', (ws) => {
  eventBus.on('weights-updated', (data) => {
    ws.send(JSON.stringify({
      type: 'weights',
      data: {
        deck1: data.deck1,
        deck2: data.deck2,
        deck3: data.deck3,
        deck4: data.deck4,
        gvw: data.gvw,
        timestamp: data.timestamp
      }
    }));
  });
});
```

**Client Mode** (connect to external):
```javascript
const ws = new WebSocket(config.wsBaseUrl);

ws.on('open', () => {
  console.log('Connected to weight server');
});

eventBus.on('weights-updated', (data) => {
  ws.send(JSON.stringify(data));
});
```

---

### 3. REST API Polling Output

**Endpoints**:

**GET /weights**
```json
{
  "stationCode": "ROMIA",
  "weightTaken": 0,
  "readings": "5200 kg, 12440 kg, 0 kg, 0 kg,",
  "status": "Vehicle on Deck",
  "scan": 1
}
```

**GET /anpr**
```json
{
  "plate": "KAA 123X"
}
```

**POST /weights** (receive weight taken notification)
```json
{
  "wbrg_ticket_no": "ROMIA202401000001",
  "nplate": "KAA 123X",
  "weightaken": 1,
  "wbrg_ticket_dateout": "2024-01-15T14:30:00"
}
```

---

---

### 4. Network RDU Integration (USR-TCP232)

USR-TCP232 devices enable transparent bidirectional data transmission between RS232/RS485 and TCP/IP networks. TruConnect uses these devices when the RDU connectionType is set to `usr`.

**Supported USR Models**:
- USR-TCP232-302 (single RS232)
- USR-TCP232-306 (RS232/RS485/RS422)
- USR-TCP232-410S (dual port)

**Default Configuration**:
- Port: 4196 (configurable via USR web interface)
- Mode: TCP Client (TruConnect connects to USR device)

**Integration with RDU**:

When `connectionType: 'usr'` is selected, TruConnect:
1. Establishes a single TCP connection to the USR device
2. Sends formatted weight messages for all configured panels
3. The USR device routes data to connected RDU displays based on its internal configuration

```javascript
// USR connection initialization
initializeUsrConnection() {
  if (!this.config.usr || !this.config.usr.ip) {
    console.warn('USR device IP not configured');
    return;
  }

  const connectUsr = () => {
    this.usrClient = new net.Socket();

    this.usrClient.connect(this.config.usr.port || 4196, this.config.usr.ip, () => {
      console.log(`USR device connected: ${this.config.usr.ip}:${this.config.usr.port}`);
      this.usrConnected = true;
    });

    this.usrClient.on('error', err => {
      console.error('USR connection error:', err.message);
      this.usrConnected = false;
      setTimeout(connectUsr, 5000);  // Auto-reconnect
    });

    this.usrClient.on('close', () => {
      this.usrConnected = false;
      setTimeout(connectUsr, 5000);  // Auto-reconnect
    });
  };

  connectUsr();
}

// Send weight to USR device
sendUsr(conn, message) {
  if (!this.usrConnected || !this.usrClient?.writable) return;

  this.usrClient.write(message, err => {
    if (err) {
      console.error(`${conn.id} USR send error:`, err.message);
    }
  });
}
```

**USR Device Setup**:
1. Configure USR device via web interface (typically http://192.168.0.7)
2. Set work mode to "TCP Server"
3. Configure serial parameters to match RDU (typically 1200 baud, 8N1)
4. Note the configured port (default: 4196)
5. Enter USR IP and port in TruConnect settings

---

## Standardized Weight Output Formats

Regardless of the underlying indicator type (ZM, Cardinal, Haenni, PAW), TruConnect normalizes weight data into a consistent JSON structure for clients (TruLoad Frontend, Backend Proxies).

### 1. Multideck Mode (Static Weighbridge)
Used for multi-deck platforms where all weights are read simultaneously.

```json
{
  "mode": "multideck",
  "status": "stable",
  "decks": [
    { "index": 1, "weight": 6500, "stable": true },
    { "index": 2, "weight": 8200, "stable": true },
    { "index": 3, "weight": 9100, "stable": true },
    { "index": 4, "weight": 7800, "stable": true }
  ],
  "gvw": 31600,
  "timestamp": "2026-01-28T10:00:00Z"
}
```

### 2. Mobile Mode (Axle-by-Axle)
Used for portable wheel/axle weighers (Haenni, PAW) where weights are captured sequentially.

```json
{
  "mode": "mobile",
  "currentAxle": 2,
  "totalAxles": 5,
  "axles": [
    { "axle": 1, "weight": 6500, "captured": true },
    { "axle": 2, "weight": 8200, "captured": false, "live": true },
    { "axle": 3, "weight": 0, "captured": false },
    { "axle": 4, "weight": 0, "captured": false },
    { "axle": 5, "weight": 0, "captured": false }
  ],
  "gvw": 14700,
  "timestamp": "2026-01-28T10:00:00Z"
}
```

---

## External Integrations

### ANPR Camera (Hikvision)

**Snapshot API**:
```
GET http://{ip}:80/ISAPI/Streaming/channels/1/picture
Authorization: Basic {base64(username:password)}
```

**Integration Pattern**:
```javascript
async function captureAnpr(cameraConfig, recordId) {
  const url = `http://${cameraConfig.ip}/ISAPI/Streaming/channels/1/picture`;
  const auth = Buffer.from(`${cameraConfig.username}:${cameraConfig.password}`).toString('base64');
  
  const response = await axios.get(url, {
    headers: { Authorization: `Basic ${auth}` },
    responseType: 'arraybuffer'
  });
  
  // Save image and/or send to ANPR service
  return response.data;
}
```

### KenloadV2 Autoweigh API

**Base URL**: Configured per station (e.g., `http://192.168.4.22:4444/api`)

**Authentication**:
```javascript
const token = await axios.post(`${baseUrl}/AuthManagement/Login`, {
  email: 'admin@admin.com',
  password: '@Admin123'
});
```

**Create Autoweigh Record**:
```javascript
await axios.post(`${baseUrl}/autoweigh`, {
  deck1: 5200,
  deck2: 12440,
  deck3: 0,
  deck4: 0,
  gvw: 17640,
  nplate: '',
  wbt_no: '',
  autodatetime: '2024-01-15T14:30:00',
  autoweighbridge: 'ROMIA',
  weighdate: '2024-01-15T14:30:00',
  autouser: 'KenloadV2',
  ipaddress: '192.168.4.100',
  anpr: 'KAA 123X',
  anprb: '',
  autostatus: 'N'
}, { headers: { Authorization: `Bearer ${token}` }});
```

---

## Serial Port Configuration Reference

| Parameter | Common Values | Notes |
|-----------|---------------|-------|
| Baud Rate | 9600 (indicator), 1200 (RDU) | Match device spec |
| Data Bits | 8 | Standard |
| Stop Bits | 1 | Standard |
| Parity | None | Standard |
| Flow Control | None | Typically disabled |

---

## Troubleshooting

### No Data from Indicator
1. Verify COM port assignment in Device Manager
2. Check baud rate matches indicator setting
3. Ensure cable is correct type (straight vs crossover)
4. Test with terminal emulator (PuTTY)

### RDU Not Displaying
1. Verify RDU power and cable connection
2. Check baud rate is 1200
3. Confirm message format `$=XXXXXXXX=`
4. Test weight formatting logic

### Connection Drops
1. Enable auto-reconnect with exponential backoff
2. Check for cable issues or EMI interference
3. Verify network stability for TCP/UDP
4. Monitor system resources

### Parse Errors
1. Log raw data for analysis
2. Verify indicator type configuration
3. Check for firmware differences
4. Test with known good data samples

---

## USR-TCP232 Serial-to-Ethernet Devices

Based on research, USR-TCP232 devices provide transparent bidirectional data transmission between RS232/RS485 and TCP/IP networks. These are critical for network-based RDU integration.

### Common Models

| Model | Ports | Features |
|-------|-------|----------|
| USR-TCP232-302 | 1x RS232 | Basic serial to Ethernet |
| USR-TCP232-306 | 1x RS232/RS485/RS422 | Multi-protocol support |
| USR-TCP232-410S | 2x (1 RS232, 1 RS485) | Dual port, Modbus gateway |

### Operating Modes

1. **TCP Server Mode**: USR device listens on configured port, TruConnect connects as client
2. **TCP Client Mode**: TruConnect listens, USR device connects to TruConnect IP
3. **UDP Mode**: Stateless broadcast to device IP

### Default Configuration

- **Port**: 4196 (configurable via web interface)
- **Baud Rate**: Match indicator/RDU setting (typically 1200 for RDU, 9600 for indicators)
- **Configuration**: Via web interface at device IP (default: 192.168.0.7)

### Integration Pattern

```javascript
const net = require('net');

class UsrnConnection {
  constructor(config) {
    this.host = config.host;
    this.port = config.port || 4196;
    this.reconnectInterval = config.reconnectInterval || 5000;
    this.socket = null;
  }

  connect() {
    this.socket = new net.Socket();

    this.socket.connect(this.port, this.host, () => {
      console.log(`Connected to USR device at ${this.host}:${this.port}`);
    });

    this.socket.on('error', (err) => {
      console.error(`USR connection error: ${err.message}`);
      this.scheduleReconnect();
    });

    this.socket.on('close', () => {
      this.scheduleReconnect();
    });
  }

  send(data) {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(data);
    }
  }

  scheduleReconnect() {
    setTimeout(() => this.connect(), this.reconnectInterval);
  }
}
```

### Sources
- [USR-TCP232-410S Product Page](https://www.pusr.com/products/modbus-serial-to-ethernet-converters-usr-tcp232-410s.html)
- [USR-TCP232-306 Product Page](https://www.pusr.com/products/ethernet-to-serial-converters-usr-tcp232-306.html)

---

## Additional Indicator Protocols (From Research)

### Avery Weigh-Tronix ZM Series Extended

Based on [Avery Weigh-Tronix documentation](https://averyweigh-tronix.com/zm400), the ZM series supports:

- **SMA Protocol**: Scale Manufacturers Association standard
- **Broadcast Mode**: Continuous output at configurable intervals
- **Enquire Mode**: Request/response polling
- **Ethernet**: Built-in on ZM400+ models
- **USB**: Host port for peripherals

**ZM510 Features**:
- 3x RS232 serial ports
- Ethernet with 10 independent device support
- DHCP client/server
- All serial protocols supported

### Modbus RTU Integration

For Modbus-enabled indicators (some Cardinal/ZM models):

```javascript
const ModbusRTU = require('modbus-serial');

async function readModbusWeight(port, slaveId, register) {
  const client = new ModbusRTU();
  await client.connectRTUBuffered(port, { baudRate: 9600 });
  client.setID(slaveId);

  const data = await client.readHoldingRegisters(register, 2);
  // Convert 2x 16-bit registers to 32-bit float
  return parseFloat(data.buffer);
}
```

---

## Mobile Scale Integration Details

### Haenni WL Series

Based on [Haenni Scales research](https://www.haenni-scales.com/):

**Connection Options**:
- Fieldbus interface with wireless option
- Up to 12 scales can be networked
- Software available for WL103 and WL104

**HNP Socket Protocol** (from existing codebase analysis):
- Port: 50505 (configurable)
- Real-time streaming when `hnpSocketServer: true`
- Binary data format for high-speed updates

### Intercomp Portable Scales

Based on [Intercomp research](https://www.intercompcompany.com/):

- ITS scales operate standalone or integrated with software
- Camera and traffic control integration
- Available in fixed, in-ground, and portable configurations

### MCGS Mobile Scale (Serial)

**Communication**: RS-232 Serial, 9600 baud, 8N1 (continuous streaming)

**Frame Format**:

```
=SG+0000123kR
```

**Semantics**:
- Each frame represents **one complete axle weight**
- Weight value is **already A+B combined** (left + right wheel pads)
- No pairing or accumulation of consecutive frames is required

**Parsing Logic (MobileScaleParser, `mode: 'mcgs'`)**:
- Detects frames containing `"SG"` and trailing `"kR"`
- Extracts the numeric portion between `SG+` and `kR`
- Validates weight in a safe range (0–100000 kg)
- Treats each frame as a **stable combined axle weight**
- Produces the standard mobile payload:
  - `weight` / `currentWeight` = combined axle weight
  - `axleNumber`, `axleWeights` and `runningTotal` for GVW accumulation
  - `scaleWeightMode = 'combined'`

**TruConnect Configuration** (from `src/config/defaults.js`):

```json
{
  "input": {
    "activeSource": "mcgs",
    "mcgs": {
      "enabled": true,
      "type": "serial",
      "protocol": "MCGS",
      "serial": {
        "port": "COM8",
        "baudRate": 9600,
        "dataBits": 8,
        "parity": "none",
        "stopBits": 1,
        "queryCommand": ""
      }
    }
  }
}
```

**Notes**:
- MCGS is treated as a **mobile** input source (like PAW/Haenni)
- WebSocket/API weight events are normalized to the same mobile structure used by existing portable scales

---

## WebSocket Best Practices

Based on current industry best practices for real-time weight streaming:

### Server Implementation

```javascript
const WebSocket = require('ws');
const wss = new WebSocket.Server({
  port: 3030,  // Default WebSocket port (configurable)
  perMessageDeflate: {
    zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
    zlibInflateOptions: { chunkSize: 10 * 1024 }
  }
});

// Connection pool management
const clients = new Set();

wss.on('connection', (ws, req) => {
  clients.add(ws);

  ws.on('close', () => clients.delete(ws));
  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    clients.delete(ws);
  });

  // Send initial state
  ws.send(JSON.stringify({ type: 'init', data: currentWeights }));
});

// Broadcast to all clients
function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}
```

### Client Implementation (for external pool connections)

```javascript
class WeightPoolClient {
  constructor(urls) {
    this.urls = urls;
    this.connections = new Map();
  }

  connectAll() {
    this.urls.forEach(url => this.connect(url));
  }

  connect(url) {
    const ws = new WebSocket(url);

    ws.on('open', () => {
      console.log(`Connected to pool: ${url}`);
      this.connections.set(url, ws);
    });

    ws.on('message', (data) => {
      const weight = JSON.parse(data);
      this.handleWeightUpdate(url, weight);
    });

    ws.on('close', () => {
      this.connections.delete(url);
      setTimeout(() => this.connect(url), 5000);
    });
  }

  sendToAll(data) {
    const message = JSON.stringify(data);
    this.connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }
}
```

### Sources
- [Node.js WebSocket](https://nodejs.org/en/learn/getting-started/websocket)
- [WebSocket Streaming Guide](https://www.videosdk.live/developer-hub/websocket/websocket-streaming)

---

## Serial Data Format Standards

### Common Weight Transmission Formats

| Format | Example | Notes |
|--------|---------|-------|
| CSV | `5200,12440,0,0` | Simple comma-separated |
| CSV with units | `5200 kg,12440 kg,0 kg,0 kg,` | Includes unit suffix |
| Fixed-width | `    5200    12440        0        0` | Padded to fixed columns |
| Scale-numbered | `Scale No: 1\r\nG 5200kg` | Multi-line per deck |
| RDU reverse | `$=00250000=` | Reversed digits, zero-padded |

### Enquiry Command (ENQ)

Most indicators respond to ENQ (0x05) command to request current weight:

```javascript
// Send ENQ periodically
setInterval(() => {
  if (serialPort.isOpen) {
    serialPort.write(Buffer.from([0x05]));  // ENQ
  }
}, 1000);
```

### Response Terminators

| Indicator | Terminator | Notes |
|-----------|------------|-------|
| ZM | `\r` or `\r\n` | Carriage return |
| Cardinal | `\r` | Carriage return |
| 1310 | `\r\n` | CRLF |
| PAW | `\r\n` | CRLF |

---

## Gap Analysis & Recommendations

### Current Implementation Gaps

1. **No Modbus RTU Support**: Some modern indicators support Modbus - should be added
2. **Limited HNP Socket**: Haenni HNP socket (port 50505) not fully implemented
3. **No Dynamic Indicator Detection**: Must manually configure indicator type
4. **Single Station Code**: Limited support for multi-station deployments
5. **No Weight Logging**: Local weight history not stored
6. **No Offline Mode**: Requires network for autoweigh integration

### Recommended Enhancements

1. **Auto-detection**: Probe indicator type on startup based on response patterns
2. **Weight Buffering**: Queue weights locally when backend unavailable
3. **Multi-tenant**: Support multiple station codes per instance
4. **Protocol Plugins**: Allow custom indicator protocol definitions
5. **Health Monitoring**: Track connection health metrics
6. **Diagnostic Mode**: Built-in terminal for raw data inspection
