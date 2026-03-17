# Sprint 09: RDU Configuration Revamp & UI Enhancements

**Duration**: 2-3 days
**Goal**: Revamp RDU configuration to support single device with multi-panel architecture, add connection status indicators, and improve mobile responsiveness

---

## Objectives

1. Implement single-RDU, multi-panel configuration architecture
2. Add RDU model support with auto-format templates
3. Support both Serial (COM) and USR-TCP232 network connections
4. Add WebSocket/API connection status indicators
5. Fix mobile dashboard responsiveness
6. Update output configuration with dynamic URLs

---

## Background: RDU Architecture Changes

### Previous Architecture (Multiple RDU Devices)
- Multiple independent RDU devices could be configured
- Each device had separate connection settings
- Duplicated configuration across devices.html and settings.html

### New Architecture (Single RDU, Multi-Panel)
- **One RDU device** per system with up to **5 panels**
- Each panel assigned to a specific deck (1-4) or GVW
- Centralized configuration in settings.html only
- Model-specific message format templates

---

## Tasks

### 9.1 RDU Configuration Data Structure

- [x] Define new RDU configuration schema:

```typescript
interface RduConfig {
  enabled: boolean;
  name: string;                          // Display name
  model: 'KELI' | 'Yaohua' | 'Generic';  // RDU model
  connectionType: 'serial' | 'usr';       // Connection method
  format: string;                         // Message format template

  usr?: {
    ip: string;                           // USR device IP
    port: number;                         // USR device port (default: 4196)
  };

  panels: Array<{
    deckIndex: number;                    // 0-4 (deck1-4, GVW)
    baudRate: number;                     // Typically 1200
    port?: string;                        // COM port (serial)
    channel?: number;                     // USR channel (network)
  }>;
}
```

### 9.2 RDU Model Support

- [x] Implement model-specific message formats:

| Model | Format Template | Type | Example Output (200 kg) |
|-------|-----------------|------|-------------------------|
| KELI | `$={WEIGHT}=` | Reversed | `$=00200000=` |
| Yaohua YHL | `$={WEIGHT}=` | Reversed | `$=00200000=` |
| XK3190 | `={WEIGHT}=` | Reversed | `=00200000=` |
| Cardinal | `{WEIGHT}` | Leading | `00000200` |
| Avery WT | `W{WEIGHT}` | Leading | `W00000200` |
| Generic | `{WEIGHT}` | Leading | `00000200` |

**Format Types:**
- Reversed: KELI/Yaohua/XK3190 - digits reversed, trailing zeros (200 → 002 → 00200000)
- Leading: Cardinal/Avery/Generic - leading zeros only (200 → 00000200)

- [x] Auto-populate format when model is selected
- [x] Allow custom format override
- [x] Database trigger ensures only one RDU model is active at a time

### 9.3 Settings UI Updates

- [x] Revamp RDU section in settings.html:
  - Single RDU enable/disable toggle
  - RDU name input field
  - Model selector dropdown (KELI, Yaohua, Generic)
  - Connection type selector (Serial, USR-TCP232)
  - Message format input (auto-populated, editable)
  - Panel count selector (1-5)
  - Dynamic panel configuration fields

- [x] Panel configuration fields:
  - Deck assignment dropdown (Deck 1-4, GVW)
  - Baud rate input
  - COM port (for serial)
  - Channel (for USR)

- [x] USR device configuration:
  - IP address input
  - Port input (default: 4196)

### 9.4 RDUCommunicator Rewrite

- [x] Update serialout.js with new architecture:
  - Single RDU with multiple panel connections
  - Model-specific message formatting
  - Serial and USR connection types
  - Auto-reconnect with 5-second delay
  - Weight threshold filtering (>10 kg)

### 9.5 Connection Status Indicators

- [x] Add status bubbles to output configuration:
  - Green: Connected/healthy
  - Gold/Yellow: Connecting/initializing
  - Red: Disconnected/failed

- [x] WebSocket status indicator:
  - Show connection status next to WebSocket section
  - Display full WebSocket URL with port

- [x] API status indicator:
  - Show connection status next to API section
  - Display full API endpoint URL

### 9.6 Dynamic URL Display

- [x] Update output section to show actual configured ports:
  - WebSocket URL: `ws://localhost:{wsPort}`
  - API URL: `http://localhost:{apiPort}/weights`
  - Read ports from database settings

### 9.7 Mobile Dashboard Responsiveness

- [x] Fix responsive layout for mobile view:
  - Stack axle header vertically on small screens
  - Reduce font sizes for mobile
  - Full-width action buttons
  - Proper spacing and padding

---

## Code Changes

### Files Modified

1. **pages/settings.html**
   - Complete RDU section rewrite
   - Added status bubble CSS
   - Added dynamic URL display
   - Added panel generation JavaScript

2. **serialout.js**
   - Rewritten RDUCommunicator class
   - New config format support
   - Serial and USR connection handling
   - Model-specific message formatting

3. **main.js**
   - Updated RDU initialization for new config format
   - Updated save-settings handler

4. **pages/index.html**
   - Added responsive CSS for mobile view

### Files Deprecated

1. **pages/devices.html**
   - Functionality consolidated into settings.html
   - RDU configuration no longer uses separate devices page

---

## Configuration Example

### Serial Connection (Direct COM Ports)

```json
{
  "enabled": true,
  "name": "Main Display",
  "model": "KELI",
  "connectionType": "serial",
  "format": "$={WEIGHT}=",
  "panels": [
    { "deckIndex": 0, "baudRate": 1200, "port": "COM3" },
    { "deckIndex": 1, "baudRate": 1200, "port": "COM4" },
    { "deckIndex": 4, "baudRate": 1200, "port": "COM5" }
  ]
}
```

### USR-TCP232 Network Connection

```json
{
  "enabled": true,
  "name": "Network Display",
  "model": "KELI",
  "connectionType": "usr",
  "format": "$={WEIGHT}=",
  "usr": {
    "ip": "192.168.1.100",
    "port": 4196
  },
  "panels": [
    { "deckIndex": 0, "baudRate": 1200, "channel": 0 },
    { "deckIndex": 1, "baudRate": 1200, "channel": 1 },
    { "deckIndex": 4, "baudRate": 1200, "channel": 2 }
  ]
}
```

---

## Deliverables

1. [x] Revamped RDU configuration in settings UI
2. [x] Updated RDUCommunicator class
3. [x] Connection status indicators
4. [x] Dynamic URL display
5. [x] Mobile responsive dashboard
6. [x] Updated documentation

---

## Verification

### RDU Configuration Test

1. Open settings page
2. Enable RDU and select model "KELI"
3. Verify format auto-populates to `$={WEIGHT}=`
4. Select 3 panels
5. Verify 3 panel configuration fields appear
6. Configure panels for Deck 1, Deck 2, and GVW
7. Save settings
8. Verify RDU sends weights correctly

### Connection Status Test

1. Enable WebSocket output
2. Verify green status bubble when connected
3. Stop WebSocket server
4. Verify red status bubble appears
5. Restart server
6. Verify returns to green

### Mobile Responsiveness Test

1. Open dashboard on mobile device (or resize browser)
2. Verify axle header stacks vertically
3. Verify buttons are full width
4. Verify text is readable
5. Verify no horizontal scrolling required

---

## Documentation Updates

- [x] docs/integrations.md - RDU output section rewritten
- [x] docs/architecture.md - Added RDU config structure
- [x] README.md - Updated RDU configuration description
- [x] docs/sprints/sprint-09.md - This document
