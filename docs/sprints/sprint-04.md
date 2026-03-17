# Sprint 04: Mobile Scale & Advanced Input Support

**Duration**: 3-4 days
**Goal**: Full mobile scale support and advanced input configurations

---

## Objectives

1. Complete mobile scale integration (Haenni and similar)
2. Add API endpoint input support
3. Implement bidirectional weighing logic
4. Add vehicle detection and status management
5. Port autoweigh API integration

---

## Tasks

### 4.1 Mobile Scale Integration (Haenni Focus)
- [x] Enhance `MobileScaleParser.js`:
  - Implement full parsing for **Haenni WL Wheel Weigher**.
  - Support for **PAW (Portable Axle Weigher)** serial commands.
  - Multi-axle state management (Current Axle, Total Axles).
  - Configurable weight division (÷2 for dual-scale, ÷1 for single).
- [x] Create mobile scale configuration:
  ```typescript
  interface MobileScaleConfig {
    id: string;
    type: 'haenni' | 'paw';
    connection: {
      type: 'http' | 'serial';
      apiBaseUrl?: string; // For Haenni Mongoose
      port?: string;       // For PAW
    };
    axleCount: number;
    pollInterval: number;
  }
  ```

### 4.2 Haenni & API Input Support
- [x] Enhance `ApiInput.js` for Haenni:
  - Implement GET `/api/devices/measurements` for live weights.
  - Implement POST `/api/devices/zero` for resetting scales.
  - Implement GET `/api/status` for device health tracking.
  - Configurable polling interval (Default: 500ms).
  - Handle Mongoose Web Server JSON response structure.

### 4.3 State Manager
- [x] Create `src/core/StateManager.js`:
  - Centralized weight state management
  - Vehicle detection logic (threshold-based)
  - Deck status tracking (No Vehicle, Weighing, Complete)
  - Bidirectional deck detection
  - State machine for weighing workflow
- [x] State events:
  - `vehicle-arrived`
  - `vehicle-weighing`
  - `vehicle-departed`
  - `weights-stable`

### 4.4 Bidirectional Weighing
- [x] Implement bidirectional detection:
  - Entry direction detection (deck 1 vs deck 4 first)
  - Direction-aware deck reordering
  - Station code switching based on direction
  - Configurable bidirectional mode

### 4.5 Autoweigh & External Integration
- [x] Port autoweigh API logic:
  - Support for **KenloadV2** (legacy) and **TruLoad** (modern) data formats.
  - Background submission with retry logic.
  - State-triggered weighing sessions (Vehicle Arrival -> Capture -> Departure).
- [x] Add configuration (database table: autoweigh_config):
  ```typescript
  interface AutoweighConfig {
    enabled: boolean;
    serverHost: string;
    protocol: 'http' | 'https';
    dataFormat: 'kenloadv2' | 'truload';
    credentials: { email: string; password: string; };
  }
  ```

### 4.6 ANPR Integration (Optional)
- [ ] Create `src/integrations/AnprService.js`:
  - Camera snapshot capture
  - OpenALPR integration (optional)
  - Plate data storage
  - Tollgate notification endpoint

---

## Deliverables

1. Enhanced mobile scale support
2. API endpoint input capability
3. State manager for weighing workflow
4. Bidirectional weighing logic
5. Autoweigh API integration

---

## Verification

### Mobile Scale Test
1. Configure mobile scale connection
2. Send sample data: `ST,GS, 0000270kg`
3. Verify weights parsed (135kg per scale)
4. Check GVW calculation

### Bidirectional Test
1. Enable bidirectional mode
2. Simulate vehicle entering from deck 4
3. Verify direction detected as "D"
4. Check deck reordering in output

### Autoweigh Test
1. Configure autoweigh endpoint
2. Simulate vehicle on deck
3. Verify autoweigh record created
4. Simulate vehicle departure
5. Verify record updated
