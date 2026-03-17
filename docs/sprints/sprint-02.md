# Sprint 02: Indicator Protocol Implementations

**Duration**: 4-5 days  
**Goal**: Implement all indicator protocol parsers with unified input management

---

## Objectives

1. Create parser architecture with plugin-style design
2. Implement all identified indicator protocols
3. Build unified input manager for serial/TCP/UDP sources
4. Add custom parser support for future indicators

---

## Tasks

### 2.1 Parser Architecture
- [x] Create `src/parsers/ParserInterface.js`:
  - Base interface/abstract class
  - Common methods: `parse()`, `validate()`, `getTerminator()`, `getInfo()`
  - Helper methods: `extractWeight()`, `createResult()`
- [x] Create `src/parsers/ParserFactory.js`:
  - Registry for parser types
  - Factory method for instantiation
  - Dynamic loading support

### 2.2 ZM Parser
- [x] Create `src/parsers/ZmParser.js`:
  - Parse comma-separated weight format
  - Handle `XXX kg` format with numeric extraction
  - Support 3-4 decks
  - Unit normalization (always kg)
  - Header codes: GS, GU, NS, NT, TR, OL, UL

### 2.3 Cardinal Parser
- [x] Create `src/parsers/CardinalParser.js`:
  - Fixed-width 90-character parsing
  - Configurable field positions
  - Handle partial/incomplete data

### 2.4 Cardinal2 Parser
- [x] Create `src/parsers/Cardinal2Parser.js`:
  - Per-deck message parsing (D1:, D2:, GVW:)
  - Deck number extraction
  - Weight extraction with status codes

### 2.5 1310 Indicator Parser
- [x] Create `src/parsers/I1310Parser.js`:
  - Multi-line scale parsing
  - `Scale No: X` header detection
  - `G XXXXkg` gross weight extraction
  - Alternative short format support

### 2.6 Mobile Scale Parser (PAW & Haenni-style)
- [x] Create `src/parsers/MobileScaleParser.js`:
  - Implement **PAW Protocol** (UDP binary IEEE 754 float)
  - Implement **Haenni Mode** (REST API JSON parsing)
  - Axle tracking and accumulation
  - GVW calculation from axles
  - Stability indicator handling

### 2.7 Custom Parser Support (User-Defined Protocols)

Enable users to configure their own indicator/mobile scale protocols without code changes.

- [x] Create `src/parsers/CustomParser.js`:
  - Support multiple parsing strategies:
    - **Regex**: Pattern with capture groups
    - **Delimiter**: CSV/TSV style parsing
    - **Fixed-width**: Position-based extraction
    - **JSON**: JSONPath-style field extraction
  - Field mapping to deck1-4, gvw, stable
  - Strip non-numeric characters option
  - Multiplier/decimal support
  - Unit conversion (lb → kg)

- [x] Create custom protocol configuration schema (defined in integrations.md, implemented in CustomParser.js):
  ```typescript
  interface CustomProtocolConfig {
    id: string;
    name: string;
    category: 'indicator' | 'mobile';
    connection: {
      type: 'serial' | 'tcp' | 'udp' | 'http';
      port?: string;
      baudRate?: number;
      host?: string;
      networkPort?: number;
      apiUrl?: string;
    };
    query: {
      mode: 'poll' | 'stream';
      command?: string;
      commandHex?: string;
      interval?: number;
    };
    parsing: {
      type: 'regex' | 'delimiter' | 'fixed' | 'json';
      pattern?: string;
      delimiter?: string;
      jsonPath?: Record<string, string>;
      stripNonNumeric?: boolean;
    };
    fieldMapping: {
      deck1?: string;
      deck2?: string;
      deck3?: string;
      deck4?: string;
      stable?: string;
    };
    output: {
      mode: 'multideck' | 'mobile';
      deckCount?: number;
      calculateGvw?: boolean;
    };
  }
  ```

- [x] Add custom protocol to database schema:
  ```sql
  CREATE TABLE custom_protocols (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    config TEXT NOT NULL,  -- JSON configuration
    created_at DATETIME,
    updated_at DATETIME
  );
  ```

- [ ] Settings UI for custom protocol configuration:
  - Add/Edit/Delete custom protocols
  - Connection type selector
  - Query command input
  - Parsing type selector with type-specific fields
  - Field mapping inputs
  - Test connection button
  - Preview parsed output

- [ ] Add tests for custom parser with various configurations

### 2.8 Input Manager & Normalization
- [x] Create `src/input/InputManager.js`:
  - Source registration and management
  - **Normalization Layer**: Convert all inputs to standard Mobile/Multideck JSON
  - Event emission for processed weights
- [x] Create `src/input/SerialInput.js`:
  - Serial port connection management
  - Auto-reconnect with exponential backoff
- [x] Create `src/input/TcpInput.js`:
  - TCP client connection management
  - Auto-reconnect support
- [x] Create `src/input/UdpInput.js`:
  - UDP server (binding to port 13805)
  - Multicast support
- [x] Create `src/input/ApiInput.js`:
  - HTTP client for weight query APIs (Haenni WebServer)
  - Support for actual Haenni endpoints: `/api/devices/measurements`
  - Configurable polling interval

---

## Deliverables

1. Parser interface and factory
2. 7 implemented parsers:
   - **Indicators**: ZM, Cardinal, Cardinal2, 1310
   - **Mobile Scales**: PAW, Haenni
   - **Custom**: User-defined protocol (supports regex, delimiter, fixed, JSON parsing)
3. Custom protocol configuration schema and database storage
4. Input manager with 4 input sources (Serial, TCP, UDP, HTTP)
5. Unit tests for all parsers including custom configurations

---

## Verification

### Unit Tests
```bash
# Run parser tests
npm test -- --grep "Parser"

# Run input manager tests
npm test -- --grep "InputManager"
```

### Integration Test
1. Configure serial port in settings
2. Connect test indicator
3. Verify weight data is parsed correctly
4. Check logs for parsed weights
5. Test reconnection by disconnecting cable

### Test Data Samples
```javascript
// ZM
"  5200 kg, 12440 kg, 0 kg,  0 kg,"

// Cardinal2
"Z1G 2        5500kg"

// 1310
"Scale No: 1\r\nG 5200kg"

// Mobile Scale
"ST,GS, 0000270kg"
```
