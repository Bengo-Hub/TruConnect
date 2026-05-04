/**
 * defaults.js - Default configuration values for TruConnect
 *
 * All configurable options with sensible defaults.
 * These can be overridden via database settings or environment variables.
 */

module.exports = {
  // Application settings
  app: {
    name: 'TruConnect',
    version: '2.0.0',
    theme: 'dark',                    // 'light' | 'dark'
    captureMode: 'mobile',            // 'mobile' | 'multideck' - default is mobile
    language: 'en'
  },

  // Station configuration
  station: {
    code: '',                         // Station code (e.g., 'ROMIA')
    name: 'TruConnect Station',
    bidirectional: false,             // Has A/B bounds
    multiDeckPerBound: false          // Multiple decks per bound
  },

  // Output configuration
  output: {
    mode: 'realtime',                 // 'realtime' (WebSocket) | 'polling' (API)

    // WebSocket server (realtime mode)
    websocket: {
      enabled: true,
      port: 3030,
      pingInterval: 30000,            // 30 seconds
      pingTimeout: 5000
    },

    // REST API server (polling mode)
    api: {
      enabled: false,                 // Only enabled if mode='polling'
      port: 3031,
      basePath: '/weights' // Dev url http://localhost:3031/api/v1/weights
    },

    // RDU output (serial display or network, single-channel — used by OutputManager for mobile GVW)
    rdu: {
      enabled: false,
      type: 'serial',                 // 'serial' | 'network'
      port: '',                       // COM port (e.g., 'COM3')
      baudRate: 1200,
      host: '',
      networkPort: 4196
    }
  },

  // =====================================================
  // RDU COMMUNICATOR (serialout.js / RDUCommunicator)
  // Multi-deck mode: one panel per deck, each routed to
  // its own COM port or USR TCP port.
  //
  // connectionType: 'serial' | 'usr'
  //
  // Serial panel shape:   { deckIndex, port, baudRate }
  // USR panel shape:      { deckIndex, usrPort, baudRate }
  //   deckIndex 0–3 → deck1–deck4 weights
  //   deckIndex 4   → GVW
  //
  // model controls digit format:
  //   'KELI' | 'YAOHUA' | 'XK3190' → reversed digits, padded to 8, no ×10
  //   'CARDINAL' | 'AVERY'         → leading zeros, no ×10
  //
  // format: '={WEIGHT}=' for Zedem/KELI RDUs (no $ prefix)
  //
  // Zedem 510 + USR IOT default (192.168.42.200, ports 20–24):
  //   set enabled:true and captureMode:'multideck' to activate
  // =====================================================
  rdu: {
    enabled: false,
    connectionType: 'usr',            // 'serial' | 'usr'
    model: 'KELI',                    // reversed digits, no ×10
    format: '={WEIGHT}=',             // no $ prefix for Zedem/KELI RDUs
    usr: {
      ip: '192.168.42.200'            // USR IOT device IP
    },
    panels: [
      { deckIndex: 0, usrPort: 20, baudRate: 1200 },  // deck1 → RDU1
      { deckIndex: 1, usrPort: 21, baudRate: 1200 },  // deck2 → RDU2
      { deckIndex: 2, usrPort: 22, baudRate: 1200 },  // deck3 → RDU3
      { deckIndex: 3, usrPort: 23, baudRate: 1200 },  // deck4 → RDU4
      { deckIndex: 4, usrPort: 24, baudRate: 1200 }   // GVW   → RDU5
    ]
  },

  // Input configuration
  // NOTE: Only ONE input source can be active at a time
  // Activating a new source automatically deactivates the current one
  input: {
    // Currently active input source
    // Values: 'none' | 'paw' | 'haenni' | 'mcgs' | 'indicator_zm' | 'indicator_cardinal' |
    //         'indicator_cardinal2' | 'indicator_1310' | 'custom' | 'udp_legacy'
    activeSource: 'none',

    // =====================================================
    // MOBILE SCALES (axle-by-axle weighing)
    // =====================================================

    // PAW Portable Axle Weigher (Serial)
    // Uses serial weight console to query combined axle weight
    // Response format: "ST,GS, 0000270kg" (Scale A+B combined)
    paw: {
      enabled: false,
      type: 'serial',
      protocol: 'PAW',
      useCumulativeWeight: false,     // PAW serves fresh axle weights
      metadata: {
        make: 'Intercomp',            // Scale manufacturer
        model: 'LP600',               // Scale model
        capacity: 15000               // Max weight capacity in kg
      },
      serial: {
        port: 'COM7',                 // Default COM7 for PAW weight console
        baudRate: 9600,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        queryCommand: 'W'             // Weight query command
      }
    },

    // Haenni WL Portable Scale (API)
    // Uses local HTTP webserver for weight data
    haenni: {
      enabled: false,
      type: 'api',
      protocol: 'HAENNI',
      useCumulativeWeight: false,     // Haenni serves fresh axle weights
      metadata: {
        make: 'Haenni',               // Scale manufacturer
        model: 'WL103',               // Scale model
        capacity: 20000               // Max weight capacity in kg
      },
      api: {
        url: 'http://localhost:8888/devices/measurements',  // Haenni WebServer default
        interval: 500,                // Polling interval in ms
        method: 'GET',
        headers: {}
      }
    },

    // MCGS Mobile Scale (Serial)
    // Uses serial console streaming combined axle weight frames
    // Frame format: "=SG+0000123kR" or "=SG+0000060kX" (A+B combined; kR/kX = unit/status)
    // Commands (STX=0x02, ETX=0x03): Weigh=STX+'A'+ETX, Zero=STX+'D'+ETX, Start/Stop per console manual
    mcgs: {
      enabled: true,
      type: 'serial',
      protocol: 'MCGS',
      useCumulativeWeight: true,      // MCGS accumulates gvw, so we subtract previous axles
      metadata: {
        make: 'MCGS',                // Scale manufacturer
        model: 'Console',            // Scale/console model
        capacity: 20000              // Max weight capacity in kg
      },
      serial: {
        port: 'COM3',                // Default COM3 for MCGS console
        baudRate: 9600,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        // Optional: send this to request weight (empty = continuous stream only)
        queryCommand: '',
        // MCGS console commands (binary STX+char+ETX). Used when middleware triggers weigh/zero/stop
        commands: {
          weigh: '\\x02A\\x03',      // STX 'A' ETX - trigger weigh / send current axle GVW
          zero: '\\x02D\\x03',       // STX 'D' ETX - zero/tare
          stop: 'STOP\\r\\n'         // Stop/cancel current session (if supported)
        }
      }
    },

    // =====================================================
    // MULTIDECK INDICATORS (platform/static weighbridge)
    // All indicators below are multi-deck by design.
    // Only mobile sources (paw, haenni, mcgs) support
    // axle-by-axle capture. Indicators always produce
    // deck-indexed weight results routed to per-deck RDUs.
    // =====================================================

    // ZM Protocol Indicators (e.g., Zedem ZM-510, Avery Weigh-Tronix, Ohaus)
    // Query-response via serial/TCP.
    // Multi-deck output: "00,    00,  1100,  1000, 2100" (deck1–4, GVW)
    indicator_zm: {
      enabled: false,
      type: 'serial',
      protocol: 'ZM',
      multiDeck: true,                  // Always multi-deck — do not change
      metadata: {
        make: 'Zedem',
        model: 'ZM-510',
        capacity: 80000
      },
      serial: {
        port: 'COM1',
        baudRate: 1200,                 // Zedem 510 baud rate
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        queryCommand: 'W'               // ASCII 'W' triggers weight output
      },
      tcp: {
        host: '192.168.1.100',          // Indicator IP or USR input port host
        port: 4001
      },
      connectionType: 'serial'          // 'serial' | 'tcp'
    },

    // Cardinal Scale Indicators (Model 190, 210, etc.)
    // Continuous output, fixed 90-char message with all deck weights.
    indicator_cardinal: {
      enabled: false,
      type: 'serial',
      protocol: 'CARDINAL',
      multiDeck: true,
      metadata: {
        make: 'Cardinal',
        model: '190',
        capacity: 80000
      },
      serial: {
        port: 'COM1',
        baudRate: 9600,
        dataBits: 7,
        parity: 'odd',
        stopBits: 1,
        queryCommand: ''                // Continuous output — no query needed
      },
      tcp: {
        host: '192.168.1.100',
        port: 4001
      },
      connectionType: 'serial'
    },

    // Cardinal Scale Model 225/738
    // Per-deck streaming: D1: 1250 kg S  D2: 1340 kg S  GVW: 5190 kg S
    indicator_cardinal2: {
      enabled: false,
      type: 'serial',
      protocol: 'CARDINAL2',
      multiDeck: true,
      metadata: {
        make: 'Cardinal',
        model: '225',
        capacity: 80000
      },
      serial: {
        port: 'COM1',
        baudRate: 9600,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        queryCommand: '\x05'            // ENQ triggers deck output
      },
      tcp: {
        host: '192.168.1.100',
        port: 4001
      },
      connectionType: 'serial'
    },

    // Rice Lake 1310 Indicator
    // Per-deck: "Scale No: 1  Weight: 1250 kg Stable"
    indicator_1310: {
      enabled: false,
      type: 'serial',
      protocol: '1310',
      multiDeck: true,
      metadata: {
        make: 'Rice Lake',
        model: '1310',
        capacity: 80000
      },
      serial: {
        port: 'COM1',
        baudRate: 9600,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        queryCommand: '\x05'            // ENQ (0x05) triggers output
      },
      tcp: {
        host: '192.168.1.100',
        port: 4001
      },
      connectionType: 'serial'
    },

    // Custom/Generic Indicator
    // For indicators not in the predefined list.
    // Configure parserConfig.multiDeck for multi-deck CSV indicators.
    custom: {
      enabled: false,
      type: 'serial',                   // 'serial' | 'tcp' | 'udp' | 'api'
      protocol: 'CUSTOM',
      multiDeck: false,                 // Set true for multi-deck custom indicators
      metadata: {
        make: 'Custom',
        model: 'Custom',
        capacity: 80000
      },
      serial: {
        port: 'COM1',
        baudRate: 9600,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        queryCommand: 'W'
      },
      tcp: {
        host: '192.168.1.100',
        port: 4001
      },
      udp: {
        port: 13805,
        multicast: false
      },
      api: {
        url: '',
        interval: 500,
        method: 'GET',
        headers: {}
      },
      connectionType: 'serial',
      // Custom parser configuration
      parserConfig: {
        terminator: '\r\n',
        weightRegex: '(\\d+)',
        deckRegex: null,
        multiplier: 1
      }
    },

    // Legacy UDP input (PAW binary mode - IEEE 754 float)
    udp_legacy: {
      enabled: false,
      type: 'udp',
      protocol: 'PAW_BINARY',
      metadata: {
        make: 'Intercomp',            // Default for PAW legacy
        model: 'LP600',
        capacity: 15000
      },
      udp: {
        port: 13805,
        multicast: false,
        multicastAddress: ''
      }
    },

    // Deck configuration — all 4 enabled by default for multi-deck indicators.
    // Disable unused decks in the UI for single- or 2-deck weighbridges.
    decks: [
      { id: 1, name: 'Deck 1', enabled: true },
      { id: 2, name: 'Deck 2', enabled: true },
      { id: 3, name: 'Deck 3', enabled: true },
      { id: 4, name: 'Deck 4', enabled: true }
    ]
  },

  // Weight thresholds (configurable validation)
  thresholds: {
    // Multideck mode thresholds
    multideck: {
      minWeight: 200,                 // Minimum valid deck weight (kg)
      maxWeight: 100000,              // Maximum valid weight (kg)
      vehicleDetection: 500,          // Weight to detect vehicle presence (kg)
      stableTolerance: 50,            // Weight change tolerance for stability (kg)
      motionTimeout: 5000             // Time to wait for stable reading (ms)
    },
    // Mobile mode thresholds (axle-by-axle)
    mobile: {
      minAxleWeight: 200,             // Minimum valid axle weight (kg)
      maxAxleWeight: 20000,           // Maximum single axle weight (kg)
      maxGvw: 100000,                 // Maximum total GVW (kg)
      stableTolerance: 20,            // Stability tolerance for axle capture (kg)
      motionTimeout: 3000             // Time to wait for stable axle reading (ms)
    }
  },

  // Mobile mode workflow settings
  mobileMode: {
    maxAxles: 12,                     // Maximum axles per vehicle
    axlePromptTimeout: 5000,          // UI prompt timeout before next axle (ms)
    autoQueryOnCapture: true,         // Auto-query for next weight after capture
    queryDelayMs: 500,                // Delay before querying next axle (ms)
    requireStableReading: true,       // Require stable reading before capture
    stableReadingsRequired: 3,        // Number of stable readings before capture
    allowManualCapture: true          // Allow manual capture button
  },

  // Simulation settings
  simulation: {
    enabled: false,
    mode: 'static',                   // 'static' | 'dynamic' | 'pattern'
    staticWeight: 5000,               // Weight for static mode (kg)
    minWeight: 1000,                  // Min for dynamic mode
    maxWeight: 50000,                 // Max for dynamic mode
    updateInterval: 1000,             // Update interval (ms)
    pattern: 'mobile',                // 'mobile' | 'multideck' for pattern mode
    defaultMultideckVehicleType: 'lorry2axle',  // 2A weights by default for multideck simulation
    staticDeckCount: 2                // 2A: only decks 1-2 for static multideck (decks 3-4 zero)
  },

  // Logging settings
  logging: {
    level: 'info',                    // 'debug' | 'info' | 'warn' | 'error'
    file: {
      enabled: true,
      maxSize: '10m',
      maxFiles: 5,
      path: ''                        // Auto-set to %APPDATA%/TruConnect/logs
    },
    console: {
      enabled: true
    }
  },

  // Authentication settings
  auth: {
    sessionTimeout: 86400000,         // 24 hours in ms
    rememberMeTimeout: 604800000,     // 7 days in ms
    maxLoginAttempts: 5,
    lockoutDuration: 300000           // 5 minutes
  },

  // Performance settings
  performance: {
    weightDebounceMs: 50,             // Debounce weight updates
    maxClientConnections: 100,
    eventQueueSize: 1000
  },

  // TruLoad Backend Configuration
  // Connection settings for TruLoad backend API
  backend: {
    enabled: false,                          // Enable backend integration
    baseUrl: 'http://localhost:4000',        // Backend API URL (dev default)
    authEndpoint: '/api/v1/auth/login',      // Authentication endpoint
    autoweighEndpoint: '/api/v1/weighing-transactions/autoweigh', // Autoweigh submission endpoint
    email: 'middleware@truconnect.local',     // Service account email (seeded in backend)
    password: 'ChangeMe123!',                // Service account password (CHANGE IN PRODUCTION)
    timeout: 30000,                          // Request timeout in ms
    retryCount: 3,                           // Number of retries on failure
    retryDelay: 1000                         // Delay between retries in ms
  },

  // Auto-weigh configuration
  // Enable to automatically send weight data to TruLoad backend on capture
  autoWeigh: {
    enabled: false,                          // Enable/disable auto-weigh mode
    sendOnCapture: true,                     // Send immediately on axle capture (mobile)
    sendOnVehicleComplete: true,             // Send when vehicle weighing completes (multideck)
    retryAttempts: 3,                        // Number of retry attempts on failure
    retryDelayMs: 5000,                      // Delay between retries (ms)
    batchMode: false,                        // Batch multiple weights before sending
    batchIntervalMs: 10000                   // Batch interval (ms)
  },

  // Cloud connection configuration (for backend relay mode)
  // When enabled, TruConnect connects to cloud backend and relays weight data
  // Use this when frontend is hosted in cloud and cannot directly connect to local middleware
  cloudConnection: {
    enabled: false,                          // Enable cloud relay mode
    backendWsUrl: '',                        // Backend WebSocket URL (wss://kuraweighapitest.masterspace.co.ke/ws/middleware)
    reconnectInterval: 5000,                 // Reconnect delay on disconnect (ms)
    heartbeatInterval: 30000,                // Heartbeat interval to keep connection alive (ms)
    maxReconnectAttempts: 10,                // Max reconnect attempts before giving up
    authOnConnect: true,                     // Authenticate immediately on connect
    registerOnConnect: true                  // Register station on connect
  },

  // Middleware operation mode configuration
  // Controls how TruConnect operates: locally or connected to cloud
  operationMode: {
    mode: 'local',                           // 'local' | 'live' - Current operation mode
    // Local mode: TruConnect serves weights via local WebSocket/API only
    // Live mode: TruConnect also relays to backend WebSocket and syncs with cloud
    autoSwitchToLive: false,                 // Auto-switch to live when backend available
    syncToBackendInLive: true,               // In live mode, sync all weight data to backend WS
    primaryWsInLive: 'backend',              // In live mode, which WS is primary: 'local' | 'backend'
    fallbackToLocalInLive: true,             // Fall back to local if backend WS fails in live mode
    localWsPort: 3030,                       // Local WebSocket server port
    localApiPort: 3031,                      // Local API server port
    backendWsUrl: '',                        // Backend WebSocket URL (for live mode)
    backendApiUrl: '',                       // Backend REST API URL (for live mode)
    // Connection pool settings
    poolName: 'truconnect-middleware',       // Pool identifier for backend WS
    stationIdentifier: '',                   // Station ID for backend registration
    connectionTimeout: 10000,                // Connection timeout (ms)
    keepAliveInterval: 25000                 // Keep-alive ping interval (ms)
  },

  // Developer info
  developer: {
    name: 'Titus Owuor',
    company: 'Covertext IT Solutions',
    address: 'Oginga Street, Kisumu',
    tel: '+254743793901',
    email: 'support@covertextisolutions.com'
  }
};
