/**
 * TruConnect - Main Process
 *
 * Weighbridge Middleware for TruLoad
 * Supports: Multideck and Mobile Scale modes
 */

const electron = require('electron');
// Handle case where require('electron') returns the path to the executable instead of the module object
// This occurs when running via Node.js instead of Electron.
if (typeof electron === 'string' || !process.versions.electron) {
  console.error('\x1b[31m%s\x1b[0m', 'ERROR: TruConnect must be run via Electron, not Node.');
  console.error('require("electron") returned a string instead of the API object.');
  if (typeof electron === 'string') console.error('Path: ' + electron);
  process.exit(1);
}
const { app, BrowserWindow, ipcMain, Tray, Menu, dialog } = electron;
const path = require('path');
let autoUpdater;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch (err) {
  console.error('Failed to load electron-updater:', err.message);
}
const log = require('electron-log');

// Configure logging
if (autoUpdater) {
  autoUpdater.logger = log;
  autoUpdater.logger.transports.file.level = 'info';
}
log.info('App starting...');

// Import new modular architecture
const Database = require('./src/database/Database');
const ConfigManager = require('./src/config/ConfigManager');
const Seed = require('./src/database/Seed');
const EventBus = require('./src/core/EventBus');
const StateManager = require('./src/core/StateManager');
const OutputManager = require('./src/output/OutputManager');
const InputManager = require('./src/input/InputManager');
const BackendClient = require('./src/backend/BackendClient');

// Keep serialout for RDU communication (legacy, will be replaced)
const RDUCommunicator = require('./serialout');

let mainWindow;
let tray;
let rduCommunicator;
let settingsWindow = null;
let loginWindow = null;
let appIsQuitting = false;
let isAuthenticated = false;
let currentUser = null;

/**
 * Create the main application window
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      enableRemoteModule: false,
      nodeIntegration: false
    },
    icon: path.join(__dirname, 'assets', 'icons', 'win', 'icon.ico'),
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'pages', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (!appIsQuitting) {
      event.preventDefault();
      console.log('Window close prevented - minimizing to tray');
      if (mainWindow) {
        mainWindow.hide();
        if (tray) {
          tray.displayBalloon({
            icon: path.join(__dirname, 'assets', 'icons', 'win', 'icon.ico'),
            title: 'TruConnect',
            content: 'Application minimized to tray. Right-click tray icon to access menu.'
          });
        }
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Create login window
 */
function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 450,
    height: 600,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, 'assets', 'icons', 'win', 'icon.ico'),
    show: false
  });

  loginWindow.loadFile(path.join(__dirname, 'pages', 'login.html'));

  loginWindow.once('ready-to-show', () => {
    loginWindow.show();
  });

  loginWindow.on('closed', () => {
    loginWindow = null;
  });
}

/**
 * Create settings window
 */
function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 950,
    height: 700,
    minWidth: 700,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    parent: mainWindow,
    modal: false,
    show: false,
    title: 'TruConnect Settings',
    icon: path.join(__dirname, 'assets', 'icons', 'win', 'icon.ico')
  });

  settingsWindow.loadFile(path.join(__dirname, 'pages', 'settings.html'));

  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
    settingsWindow.focus();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

/**
 * Create system tray
 */
function createTray() {
  try {
    const iconPath = path.join(__dirname, 'assets', 'icons', 'win', 'icon.ico');
    tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show App',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      {
        label: 'Settings',
        click: () => createSettingsWindow()
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          appIsQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setToolTip('TruConnect - Weighbridge Middleware');
    tray.setContextMenu(contextMenu);

    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });

    console.log('Tray created successfully');
  } catch (error) {
    console.error('Error creating tray:', error);
  }
}

/**
 * Initialize the application
 */
async function initializeApp() {
  try {
    console.log('Initializing TruConnect...');

    // Initialize database (runs migrations)
    console.log('Initializing database...');
    Database.initialize();
    console.log('Database initialized');

    // Run seeds (idempotent)
    console.log('Running seeds...');
    await Seed.seed();
    console.log('Seeds complete');

    // Initialize config with database
    console.log('Loading configuration...');
    const db = Database.getDb();
    ConfigManager.initialize(db);
    console.log('Configuration loaded');

    // Initialize AuthManager with database
    console.log('Initializing authentication...');
    const AuthManager = require('./src/auth/AuthManager');
    AuthManager.initialize(db);
    console.log('Authentication initialized');

    // Initialize OutputManager with WebSocket server
    console.log('Initializing output manager...');
    const outputConfig = ConfigManager.get('output') || {};
    await OutputManager.initialize(outputConfig);
    await OutputManager.start();
    console.log('Output manager started (WebSocket on port ' + (outputConfig.websocket?.port || 3030) + ')');

    // Initialize BackendClient for TruLoad backend communication
    console.log('Initializing backend client...');
    const backendConfig = ConfigManager.get('backend') || {};
    BackendClient.initialize({
      enabled: backendConfig.enabled || false,
      baseUrl: backendConfig.baseUrl || '',
      authEndpoint: backendConfig.authEndpoint || '/api/v1/auth/login',
      autoweighEndpoint: backendConfig.autoweighEndpoint || '/api/v1/weighing-transactions/autoweigh',
      email: backendConfig.email || '',
      password: backendConfig.password || '',
      stationId: ConfigManager.get('station.id'),
      bound: ConfigManager.get('station.bound') || 'A'
    });

    // Authenticate with backend if enabled
    if (backendConfig.enabled && backendConfig.baseUrl) {
      BackendClient.checkConnection().then(connected => {
        console.log(`Backend client: ${connected ? 'connected & authenticated' : 'not connected'}`);
      }).catch(err => {
        console.error('Backend client init error:', err.message);
      });
    }
    console.log('Backend client initialized');

    // Initialize CloudConnectionManager for local/live mode switching
    console.log('Initializing cloud connection manager...');
    const CloudConnectionManager = require('./src/cloud/CloudConnectionManager');
    const operationModeConfig = ConfigManager.get('operationMode') || {};
    await CloudConnectionManager.initialize({
      mode: operationModeConfig.mode || 'local',
      backendWsUrl: operationModeConfig.backendWsUrl || '',
      stationIdentifier: ConfigManager.get('station.id'),
      syncToBackend: operationModeConfig.syncToBackendInLive
    });
    console.log(`Cloud connection manager initialized (mode: ${operationModeConfig.mode || 'local'})`);

    // Get RDU config from new config system
    const rduConfig = ConfigManager.get('rdu') || { enabled: false };

    // Initialize RDU communicator with new config format
    rduCommunicator = new RDUCommunicator(rduConfig);

    // Create windows and tray
    createWindow();
    createTray();

    // Initialize RDU connections
    if (rduCommunicator && rduCommunicator.initializeConnections) {
      rduCommunicator.initializeConnections();
    }

    // Initialize input/simulation based on saved settings
    // IMPORTANT: Settings are loaded from database during ConfigManager.initialize()
    // No login required - settings apply immediately on startup
    await initializeInputSources();

    app.on('activate', () => {
      if (mainWindow === null) createWindow();
    });

    console.log('TruConnect initialized successfully');

  } catch (error) {
    console.error('Failed to initialize application:', error);
    dialog.showErrorBox(
      'Initialization Error',
      `Failed to start TruConnect:\n\n${error.message}\n\nCheck the logs for details.`
    );
    app.quit();
  }
}

// Start app when ready
app.whenReady().then(initializeApp);

// Weight monitoring state
let isVehicleOnDeck = false;

/**
 * Initialize input sources based on saved configuration
 * Called on startup - no login required
 *
 * Supports both new input config format (input.activeSource, input.paw, etc.)
 * and legacy format (input.indicator.type) for backwards compatibility.
 */
async function initializeInputSources() {
  const simulationConfig = ConfigManager.get('simulation') || { enabled: false };
  const inputConfig = ConfigManager.get('input') || {};
  const captureMode = ConfigManager.get('app.captureMode', 'mobile');

  // Support legacy input.indicator.type format
  const legacyIndicator = inputConfig.indicator || {};
  let activeSource = inputConfig.activeSource || 'none';

  // Migration: Convert legacy format to new format
  if (activeSource === 'none' && legacyIndicator.type && legacyIndicator.type !== 'none') {
    console.log(`Migrating legacy input config: type=${legacyIndicator.type}, protocol=${legacyIndicator.protocol}`);

    const protocol = (legacyIndicator.protocol || '').toUpperCase();

    // Map legacy type/protocol to new source name
    if (legacyIndicator.type === 'serial') {
      // Check for mobile scales (PAW or Mobile protocol)
      if (protocol === 'PAW' || protocol === 'MOBILE') {
        activeSource = 'paw';
        // Copy serial config to paw source
        if (!inputConfig.paw) inputConfig.paw = { enabled: false, type: 'serial', protocol: 'PAW' };
        inputConfig.paw.serial = legacyIndicator.serial || {};
        inputConfig.paw.enabled = true;
        console.log(`Mapped ${protocol} serial to PAW source`);
      } else {
        // Map indicator protocol to source name
        const protocolMap = {
          'ZM': 'indicator_zm',
          'CARDINAL': 'indicator_cardinal',
          'CARDINAL2': 'indicator_cardinal2',
          '1310': 'indicator_1310',
          'I1310': 'indicator_1310'
        };
        activeSource = protocolMap[protocol] || 'indicator_zm';
        console.log(`Mapped ${protocol} to ${activeSource}`);
      }
    } else if (legacyIndicator.type === 'api') {
      // API type - Haenni or Mobile protocol
      if (protocol === 'HAENNI' || protocol === 'MOBILE') {
        activeSource = 'haenni';
        if (!inputConfig.haenni) inputConfig.haenni = { enabled: false, type: 'api', protocol: 'HAENNI' };
        inputConfig.haenni.api = legacyIndicator.api || {};
        inputConfig.haenni.enabled = true;
        console.log(`Mapped ${protocol} API to Haenni source`);
      }
    } else if (legacyIndicator.type === 'tcp') {
      // TCP type - multideck indicator
      const protocolMap = {
        'ZM': 'indicator_zm',
        'CARDINAL': 'indicator_cardinal',
        'CARDINAL2': 'indicator_cardinal2',
        '1310': 'indicator_1310',
        'I1310': 'indicator_1310'
      };
      activeSource = protocolMap[protocol] || 'indicator_zm';
      console.log(`Mapped ${protocol} TCP to ${activeSource}`);
    }

    inputConfig.activeSource = activeSource;
    console.log(`Migrated to new format: activeSource=${activeSource}`);
  }

  console.log('=== Input Source Initialization ===');
  console.log(`Simulation config: ${JSON.stringify(simulationConfig)}`);
  console.log(`Active input source: ${activeSource}`);
  console.log(`Capture mode: ${captureMode}`);

  // Priority: Simulation > Input Source
  if (simulationConfig.enabled) {
    // Start simulation engine
    console.log('Starting simulation mode...');
    const SimulationEngine = require('./src/simulation/SimulationEngine');
    SimulationEngine.initialize({
      ...simulationConfig,
      pattern: captureMode // Use capture mode for simulation pattern
    });
    SimulationEngine.start();
    StateManager.setSimulation(true);
    console.log(`Simulation started (mode: ${simulationConfig.mode || 'static'})`);

  } else if (activeSource !== 'none') {
    // Initialize and start InputManager with the configured source
    console.log(`Starting input source: ${activeSource}`);
    try {
      await InputManager.initialize(inputConfig);
      await InputManager.start();
      StateManager.setSimulation(false);
      console.log(`Input source ${activeSource} started successfully`);
    } catch (error) {
      console.error(`Failed to start input source ${activeSource}:`, error.message);
      // Don't crash - continue with no input source
    }

  } else {
    console.log('No input source configured (simulation disabled, activeSource = none)');
    StateManager.setSimulation(false);
  }

  // Set capture mode in StateManager
  StateManager.setMode(captureMode);
  console.log(`Capture mode set to: ${captureMode}`);

  console.log('=== Input Source Initialization Complete ===');
}

/**
 * Broadcast weight updates to renderer and RDU
 * Sends mode-appropriate data based on capture mode (mobile vs multideck)
 */
function broadcastWeights(weights, error = null, weightData = null) {
  const captureMode = ConfigManager.get('app.captureMode', 'mobile');

  // Update RDU communicator (for multideck only)
  if (captureMode !== 'mobile') {
    const weightsArray = Array.isArray(weights) ? weights : [
      weights.deck1 || 0,
      weights.deck2 || 0,
      weights.deck3 || 0,
      weights.deck4 || 0
    ];

    if (rduCommunicator && typeof rduCommunicator.updateWeights === 'function') {
      rduCommunicator.updateWeights(weightsArray);
      if (typeof rduCommunicator.sendToAllRdus === 'function') {
        rduCommunicator.sendToAllRdus(true);
      }
    }
  }

  // Send to renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (captureMode === 'mobile') {
      // Mobile mode: send currentWeight and session data
      const sm = StateManager.getInstance();
      const mobileState = StateManager.getMobileState();
      const currentWeight = weightData?.currentWeight ?? sm.currentMobileWeight ?? 0;
      const capturedGvw = mobileState.gvw || 0;
      const runningGvw = capturedGvw + currentWeight;  // Real-time total

      mainWindow.webContents.send('weights-updated', {
        captureMode: 'mobile',
        currentWeight: currentWeight,
        runningGvw: runningGvw,  // Real-time total (captured + current on scale)
        stable: weightData?.stable ?? sm.mobileWeightStable ?? true,
        session: mobileState,
        gvw: capturedGvw,  // Sum of captured axles only
        scaleInfo: StateManager.getMobileScaleInfo(),
        error: error,
        timestamp: new Date().toISOString()
      });
    } else {
      // Multideck mode: send deck values
      const stateWeights = StateManager.getWeights();
      mainWindow.webContents.send('weights-updated', {
        captureMode: 'multideck',
        deck1: stateWeights.deck1,
        deck2: stateWeights.deck2,
        deck3: stateWeights.deck3,
        deck4: stateWeights.deck4,
        gvw: stateWeights.gvw,
        vehicleOnDeck: isVehicleOnDeck,
        error: error,
        timestamp: new Date().toISOString()
      });
    }
  }
}

/**
 * Switch input source (used when settings change)
 * @param {string} newSource - New source to activate
 */
async function switchInputSource(newSource) {
  const SimulationEngine = require('./src/simulation/SimulationEngine');

  // Stop simulation if running
  if (SimulationEngine.getStatus().enabled) {
    SimulationEngine.stop();
    StateManager.setSimulation(false);
    console.log('Simulation stopped');
  }

  // Switch to new input source
  if (newSource === 'none') {
    await InputManager.stop();
    console.log('Input source stopped');
  } else {
    try {
      await InputManager.switchSource(newSource);
      console.log(`Switched to input source: ${newSource}`);
    } catch (error) {
      console.error(`Failed to switch to ${newSource}:`, error.message);
    }
  }
}

/**
 * Enable simulation mode (disables any active input source)
 * @param {Object} simConfig - Simulation configuration
 */
async function enableSimulation(simConfig) {
  // Stop any active input source
  await InputManager.stop();

  // Start simulation
  const SimulationEngine = require('./src/simulation/SimulationEngine');
  const captureMode = ConfigManager.get('app.captureMode', 'mobile');

  SimulationEngine.initialize({
    ...simConfig,
    pattern: captureMode
  });
  SimulationEngine.start();
  StateManager.setSimulation(true);
  console.log(`Simulation enabled (mode: ${simConfig.mode || 'static'})`);
}

/**
 * Disable simulation mode
 */
async function disableSimulation() {
  const SimulationEngine = require('./src/simulation/SimulationEngine');

  if (SimulationEngine.getStatus().enabled) {
    SimulationEngine.stop();
    StateManager.setSimulation(false);
    console.log('Simulation disabled');
  }
}

// Subscribe to weight updates from simulation or other input sources
EventBus.on('input:weight', (data) => {
  const captureMode = ConfigManager.get('app.captureMode', 'mobile');

  if (data.isMobile || captureMode === 'mobile') {
    const currentWeight = data.currentWeight ?? data.weight ?? 0;
    const stable = data.stable !== false;

    // Process auto-detection for next axle
    const autoResult = StateManager.processAutoDetection(currentWeight, stable);

    // If next axle is ready, notify renderer
    if (autoResult.ready) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('axle:next-ready', {
          axleNumber: autoResult.axleNumber,
          weight: autoResult.weight,
          remainingAxles: autoResult.remainingAxles,
          isComplete: StateManager.isWeighingComplete()
        });
      }
    }

    // Mobile mode: broadcast the currentWeight to renderer
    broadcastWeights(null, null, {
      currentWeight: currentWeight,
      stable: stable,
      autoDetection: autoResult
    });
  } else if (data.source === 'simulation') {
    // Simulation mode for multideck
    const threshold = ConfigManager.get('thresholds.multideck.vehicleDetection', 500);
    const weights = data.decks ? data.decks.map(d => d.weight) : [0, 0, 0, 0];
    const newVehicleStatus = weights.some(w => w > threshold);

    if (newVehicleStatus !== isVehicleOnDeck) {
      isVehicleOnDeck = newVehicleStatus;
      EventBus.emit('vehicle:status-changed', { onDeck: isVehicleOnDeck });
    }

    // Broadcast to renderer and RDU
    broadcastWeights(weights);
  } else {
    // Multideck mode: update vehicle detection and broadcast
    const threshold = ConfigManager.get('thresholds.multideck.vehicleDetection', 500);
    const weights = StateManager.getWeights();
    const newVehicleStatus = weights.gvw > threshold;

    if (newVehicleStatus !== isVehicleOnDeck) {
      isVehicleOnDeck = newVehicleStatus;
      EventBus.emit('vehicle:status-changed', { onDeck: isVehicleOnDeck });
    }

    // Broadcast to renderer and RDU
    broadcastWeights(weights);
  }
});

// Subscribe to input source connection events
EventBus.on('input:source-activated', (data) => {
  console.log('Input source activated:', data);
  sendConnectionStatus(true, data.source, data.connectionType || data.type, null, data.protocol);

  // Update StateManager with input source info
  StateManager.setInputSource({
    name: data.source,
    protocol: data.protocol,
    connectionType: data.connectionType || data.type,
    connected: true
  });
});

EventBus.on('input:stopped', (data) => {
  console.log('Input source stopped:', data);
  sendConnectionStatus(false, data.source, null, null, null);

  // Clear input source in StateManager
  StateManager.setInputSource({
    name: null,
    protocol: null,
    connectionType: null,
    connected: false
  });
});

EventBus.on('input:error', (data) => {
  console.log('Input error:', data);
  // Only mark as disconnected for activation errors
  if (data.type === 'activation') {
    sendConnectionStatus(false, data.source, null, data.error);
  }
});

// Send connection status to renderer
function sendConnectionStatus(connected, source, type, error, protocol = null) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Get current scale info for mobile mode
    const scaleInfo = StateManager.getMobileScaleInfo();
    const captureMode = ConfigManager.get('app.captureMode', 'mobile');

    mainWindow.webContents.send('connection-status', {
      connected,
      source,
      type,
      protocol,
      error,
      scaleInfo: captureMode === 'mobile' ? scaleInfo : null,
      timestamp: new Date().toISOString()
    });
  }
}

// =============================================
// Connection Pool Event Forwarding
// =============================================

// Forward client connection events to Electron renderer
EventBus.on('client:connected', (data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pool:client-joined', data);
    // Also send pool update
    sendPoolUpdate();
  }
});

EventBus.on('client:disconnected', (data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pool:client-left', data);
    sendPoolUpdate();
  }
});

EventBus.on('client:registered', (data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pool:client-registered', data);
    sendPoolUpdate();
  }
});

// When client requests weight (e.g. query-weight), trigger scale query; for MCGS this sends weigh command
EventBus.on('weight:query-requested', () => {
  InputManager.queryWeight();
});

// Helper to send pool update to renderer
function sendPoolUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      const OutputManager = require('./src/output/OutputManager');
      const wsOutput = OutputManager.getInstance()?.outputs?.websocket;

      if (wsOutput) {
        const clientList = [];
        for (const [clientId, client] of wsOutput.clients) {
          clientList.push({
            clientId,
            clientName: client.clientName || `Client ${clientId}`,
            clientType: client.clientType || 'unknown',
            stationCode: client.stationCode,
            bound: client.bound,
            mode: client.mode,
            registered: client.registered || false,
            connectedAt: client.connectedAt,
            ip: client.ip
          });
        }

        mainWindow.webContents.send('pool:updated', {
          clients: clientList,
          totalClients: wsOutput.clients.size,
          registeredClients: wsOutput.getRegisteredClientCount ? wsOutput.getRegisteredClientCount() : 0
        });
      }
    } catch (error) {
      console.error('Error sending pool update:', error);
    }
  }
}

// IPC Handlers

ipcMain.handle('get-initial-data', async () => {
  try {
    const stationCode = ConfigManager.get('station.code', '');
    const stationName = ConfigManager.get('station.name', 'TruConnect Station');
    const captureMode = ConfigManager.get('app.captureMode', 'mobile');

    // Get input source connection status
    const inputStatus = InputManager.getStatus();
    const inputConnected = inputStatus.running && inputStatus.connected !== false;

    // Get RDU connection status (for deck status display)
    const rduConnections = rduCommunicator?.connections?.map(c => c?.active || false) || [false, false, false, false];

    // Get scale info for mobile mode
    const scaleInfo = StateManager.getMobileScaleInfo();

    // Build base response
    const response = {
      // Main connection status = input source connected
      connected: inputConnected,
      // Deck-level connections for RDU display
      deckConnections: rduConnections,
      vehicleOnDeck: isVehicleOnDeck,
      stationCode,
      stationName,
      captureMode,
      theme: ConfigManager.get('app.theme', 'dark'),
      // Additional input source info
      inputSource: inputStatus.activeSource,
      inputType: inputStatus.type || inputStatus.connectionType,
      inputProtocol: inputStatus.protocol,
      simulation: require('./src/simulation/SimulationEngine').getStatus().enabled
    };

    // Mode-specific data
    if (captureMode === 'mobile') {
      // Mobile mode: send currentWeight and session data, NOT deck values
      const mobileState = StateManager.getMobileState();
      const sm = StateManager.getInstance();
      response.currentWeight = sm.currentMobileWeight || 0;
      response.stable = sm.mobileWeightStable !== false;
      response.session = mobileState;
      response.gvw = mobileState.gvw || 0;
      response.scaleInfo = scaleInfo;
    } else {
      // Multideck mode: send deck values
      const weights = StateManager.getWeights();
      response.deck1 = weights.deck1 || 0;
      response.deck2 = weights.deck2 || 0;
      response.deck3 = weights.deck3 || 0;
      response.deck4 = weights.deck4 || 0;
      response.gvw = weights.gvw || 0;
    }

    return response;
  } catch (error) {
    console.error('Error getting initial data:', error);
    return {
      connected: false,
      deckConnections: [false, false, false, false],
      vehicleOnDeck: false,
      stationCode: '',
      stationName: 'TruConnect Station',
      captureMode: 'mobile',
      currentWeight: 0,
      gvw: 0,
      error: error.message
    };
  }
});

ipcMain.handle('open-settings', async () => {
  createSettingsWindow();
  return ConfigManager.getInstance().export();
});

ipcMain.handle('get-settings', async () => {
  return ConfigManager.getInstance().export();
});

ipcMain.handle('save-settings', async (event, settings) => {
  try {
    console.log('Saving settings:', settings);

    // Capture current state BEFORE importing (for comparison later)
    const previousSimEnabled = ConfigManager.get('simulation.enabled', false);
    const previousActiveSource = ConfigManager.get('input.activeSource', 'none');

    // Import settings into config manager (persists to database)
    ConfigManager.getInstance().import(settings);

    // Apply changes live without restart

    // 1. Update station configuration
    if (settings.station) {
      StateManager.getInstance().setStationConfig({
        stationCode: settings.station.code,
        stationName: settings.station.name,
        bidirectional: settings.station.bidirectional
      });
    }

    // 2. Update capture mode
    if (settings.app?.captureMode) {
      StateManager.getInstance().mode = settings.app.captureMode;
    }

    // 3. Update thresholds
    if (settings.thresholds) {
      const thresholds = settings.thresholds.multideck || settings.thresholds;
      StateManager.getInstance().vehicleThreshold = thresholds.vehicleDetection || 500;
      StateManager.getInstance().weightThreshold = thresholds.stableTolerance || 50;
    }

    // 4. Update output mode (WebSocket vs API)
    if (settings.output?.mode) {
      const currentMode = OutputManager.getInstance().mode;
      if (settings.output.mode !== currentMode) {
        console.log(`Switching output mode from ${currentMode} to ${settings.output.mode}`);
        await OutputManager.switchMode(settings.output.mode);
      }
    }

    // 5. Reinitialize RDU if config changed
    if (settings.rdu) {
      // Shutdown existing RDU connections
      if (rduCommunicator && rduCommunicator.shutdown) {
        rduCommunicator.shutdown();
      }
      // Create new RDU communicator with updated config
      rduCommunicator = new RDUCommunicator(settings.rdu);
      if (rduCommunicator.initializeConnections) {
        rduCommunicator.initializeConnections();
      }
    }

    // 6. Handle simulation and input source changes
    const newSimEnabled = settings.simulation?.enabled;
    const newActiveSource = settings.input?.activeSource;

    if (newSimEnabled !== undefined && newSimEnabled !== previousSimEnabled) {
      if (newSimEnabled) {
        // Enable simulation (stops any active input)
        console.log('Enabling simulation mode...');
        await enableSimulation(settings.simulation);
      } else {
        // Disable simulation
        console.log('Disabling simulation mode...');
        await disableSimulation();
        // Start input source if configured
        if (newActiveSource && newActiveSource !== 'none') {
          await switchInputSource(newActiveSource);
        }
      }
    } else if (newActiveSource !== undefined && !newSimEnabled) {
      // Input source changed (simulation not enabled)
      if (newActiveSource !== previousActiveSource) {
        await switchInputSource(newActiveSource);
      }
    }

    // 7. Update backend integration
    if (settings.backend) {
      const BackendClient = require('./src/backend/BackendClient');
      BackendClient.configure(settings.backend);

      // If enabled, check connection in background
      if (settings.backend.enabled && settings.backend.baseUrl) {
        BackendClient.checkConnection().then(connected => {
          console.log(`[Settings] Backend connection: ${connected ? 'OK' : 'Failed'}`);
        }).catch(err => {
          console.error('[Settings] Backend connection check error:', err.message);
        });
      }
    }

    // 8. Notify renderer of settings change
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('settings-updated', {
        stationName: settings.station?.name,
        captureMode: settings.app?.captureMode,
        theme: settings.app?.theme
      });
    }

    return { success: true };
  } catch (error) {
    console.error('Error saving settings:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('reset-settings', async () => {
  try {
    ConfigManager.getInstance().resetAll();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Test backend connection from settings UI
ipcMain.handle('test-backend-connection', async (event, config) => {
  try {
    const BackendClient = require('./src/backend/BackendClient');
    const client = BackendClient.getInstance();

    // Temporarily configure with test settings
    client.configure({
      enabled: true,
      baseUrl: config.baseUrl,
      authEndpoint: config.authEndpoint || '/api/v1/auth/login',
      email: config.email,
      password: config.password
    });

    // Try to authenticate
    const authenticated = await client.authenticate();
    if (authenticated) {
      return { success: true };
    } else {
      return { success: false, error: client.lastError || 'Authentication failed' };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Cloud/Operation Mode handlers
// Switch between local and live mode
ipcMain.handle('cloud:switch-mode', async (event, mode) => {
  try {
    const CloudConnectionManager = require('./src/cloud/CloudConnectionManager');
    await CloudConnectionManager.switchMode(mode);
    return { success: true, mode: CloudConnectionManager.getStatus().mode };
  } catch (error) {
    console.error('Error switching mode:', error);
    return { success: false, error: error.message };
  }
});

// Get current cloud/operation mode status
ipcMain.handle('cloud:get-status', async () => {
  try {
    const CloudConnectionManager = require('./src/cloud/CloudConnectionManager');
    return { success: true, status: CloudConnectionManager.getStatus() };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Set backend WebSocket URL for live mode
ipcMain.handle('cloud:set-backend-url', async (event, { url, autoConnect }) => {
  try {
    const CloudConnectionManager = require('./src/cloud/CloudConnectionManager');
    await CloudConnectionManager.setBackendUrl(url, autoConnect);
    return { success: true, url };
  } catch (error) {
    console.error('Error setting backend URL:', error);
    return { success: false, error: error.message };
  }
});

// Connect to backend (in live mode)
ipcMain.handle('cloud:connect', async () => {
  try {
    const CloudConnectionManager = require('./src/cloud/CloudConnectionManager');
    const connected = await CloudConnectionManager.connect();
    return { success: connected, status: CloudConnectionManager.getStatus() };
  } catch (error) {
    console.error('Error connecting to backend:', error);
    return { success: false, error: error.message };
  }
});

// Disconnect from backend
ipcMain.handle('cloud:disconnect', async () => {
  try {
    const CloudConnectionManager = require('./src/cloud/CloudConnectionManager');
    CloudConnectionManager.disconnect();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Authentication handlers
ipcMain.handle('auth:login', async (event, { email, password, rememberMe }) => {
  try {
    const AuthManager = require('./src/auth/AuthManager');
    const result = await AuthManager.login(email, password);

    if (result.success) {
      isAuthenticated = true;
      currentUser = result.user;
      // Close login window and show main window if needed
      if (loginWindow) {
        loginWindow.close();
      }
      if (!mainWindow) {
        createWindow();
      } else {
        mainWindow.show();
      }
    }

    return result;
  } catch (error) {
    console.error('Login error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('auth:logout', async () => {
  try {
    const AuthManager = require('./src/auth/AuthManager');
    await AuthManager.logout();
    isAuthenticated = false;
    currentUser = null;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('auth:check-session', async () => {
  return { 
    authenticated: isAuthenticated,
    user: currentUser
  };
});

// Get saved credentials (for "Remember Me" feature)
ipcMain.handle('auth:get-saved-credentials', async () => {
  // For now, return null - "Remember Me" could be implemented with electron-store
  // or by storing encrypted credentials in the database
  return null;
});

// Mobile scale handlers
ipcMain.handle('mobile:capture-axle', async (event, data) => {
  try {
    // Get current weight from StateManager
    const sm = StateManager.getInstance();
    const weight = data?.weight ?? sm.currentMobileWeight ?? 0;

    if (weight <= 0) {
      return { success: false, error: 'No weight to capture' };
    }

    // Add axle weight to session
    const axleResult = StateManager.addAxleWeight(weight);

    // Start auto-detection for next axle (monitors for weight drop then stable reading)
    StateManager.startNextAxleDetection();

    // Check if all axles are captured
    const isComplete = StateManager.isWeighingComplete();
    const remainingAxles = StateManager.getRemainingAxles();
    const axleConfig = StateManager.getAxleConfiguration();
    const mobileState = StateManager.getMobileState();

    // Broadcast updated session to renderer
    broadcastWeights(null, null, { currentWeight: weight });

    EventBus.emit('axle:captured', {
      ...axleResult,
      isComplete,
      remainingAxles,
      expectedAxles: axleConfig.expectedAxles
    });

    console.log(`Axle captured: ${weight}kg (Axle ${axleResult.axleNumber}/${axleConfig.expectedAxles || '?'}, GVW: ${axleResult.gvw}kg, Remaining: ${remainingAxles})`);

    // Send auto-weigh to backend when all axles are captured
    if (isComplete && !BackendClient.isAutoweighSent()) {
      console.log('[AutoWeigh] All axles captured - sending auto-weigh to backend...');

      const autoweighResult = await BackendClient.sendAutoweigh({
        plateNumber: axleConfig.plateNumber,
        vehicleId: axleConfig.vehicleId,
        axleConfigurationId: axleConfig.axleConfigurationId,
        axles: mobileState.axles,
        gvw: mobileState.gvw
      });

      if (autoweighResult) {
        console.log(`[AutoWeigh] Auto-weigh sent successfully: Ticket=${autoweighResult.ticketNumber}`);

        // Notify renderer that auto-weigh was sent
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('autoweigh:sent', {
            ticketNumber: autoweighResult.ticketNumber,
            transactionId: autoweighResult.weighingId,
            gvw: autoweighResult.gvwMeasuredKg
          });
        }
      }
    }

    return {
      success: true,
      ...axleResult,
      isComplete,
      remainingAxles,
      expectedAxles: axleConfig.expectedAxles,
      autoweighSent: isComplete && BackendClient.isAutoweighSent()
    };
  } catch (error) {
    console.error('Error capturing axle:', error);
    return { success: false, error: error.message };
  }
});

// Set axle configuration from frontend
ipcMain.handle('mobile:set-axle-config', async (event, config) => {
  try {
    const result = StateManager.setAxleConfiguration(config);

    // Enable auto-detection when axle config is set
    StateManager.setAutoDetection(true, {
      zeroThreshold: config.zeroThreshold || 50,
      stableThreshold: config.stableThreshold || 100,
      requiredStableReadings: config.requiredStableReadings || 3
    });

    // Start new backend session for this vehicle
    BackendClient.startSession({
      regNumber: config.plateNumber,
      vehicleId: config.vehicleId,
      axleConfigurationId: config.axleConfigurationId
    });

    console.log(`Axle config set from frontend: ${result.expectedAxles} axles (${result.axleConfigurationCode})`);

    return { success: true, config: result };
  } catch (error) {
    console.error('Error setting axle config:', error);
    return { success: false, error: error.message };
  }
});

// Get current axle configuration
ipcMain.handle('mobile:get-axle-config', async () => {
  return StateManager.getAxleConfiguration();
});

// Check if weighing is complete
ipcMain.handle('mobile:is-complete', async () => {
  return {
    isComplete: StateManager.isWeighingComplete(),
    remainingAxles: StateManager.getRemainingAxles(),
    capturedAxles: StateManager.getMobileState().axles.length,
    expectedAxles: StateManager.getAxleConfiguration().expectedAxles
  };
});

ipcMain.handle('mobile:reset-session', async () => {
  try {
    // Cancel any pending backend session
    await BackendClient.cancelSession();

    // Reset mobile session in StateManager
    StateManager.resetMobileSession();

    // Also reset the currentMobileWeight
    const sm = StateManager.getInstance();
    sm.currentMobileWeight = 0;
    sm.mobileWeightStable = true;

    // Broadcast reset state to renderer
    broadcastWeights(null, null, { currentWeight: 0 });

    EventBus.emit('session:reset');
    console.log('Mobile session reset');

    return { success: true };
  } catch (error) {
    console.error('Error resetting session:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('mobile:vehicle-complete', async (event, data) => {
  try {
    const mobileState = StateManager.getMobileState();
    const axleConfig = StateManager.getAxleConfiguration();

    // Prepare complete vehicle data
    const vehicleData = {
      ...data,
      session: mobileState,
      completedAt: new Date().toISOString()
    };

    // Send final capture to backend (updates existing auto-weigh record)
    console.log('[WeighingComplete] Sending final capture to backend...');
    const backendResult = await BackendClient.completeSession({
      plateNumber: data.plateNumber || axleConfig.plateNumber,
      vehicleId: data.vehicleId || axleConfig.vehicleId,
      axleConfigurationId: data.axleConfigurationId || axleConfig.axleConfigurationId,
      axles: mobileState.axles,
      gvw: mobileState.gvw
    });

    if (backendResult) {
      console.log(`[WeighingComplete] Backend updated: Ticket=${backendResult.ticketNumber}, Status=${backendResult.controlStatus}`);
      vehicleData.backendResult = backendResult;

      // Notify renderer of completion result
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('weighing:complete', {
          ticketNumber: backendResult.ticketNumber,
          transactionId: backendResult.weighingId,
          isCompliant: backendResult.isCompliant,
          controlStatus: backendResult.controlStatus,
          gvw: backendResult.gvwMeasuredKg,
          totalFee: backendResult.totalFeeUsd
        });
      }
    }

    EventBus.emit('vehicle:complete', vehicleData);
    console.log(`Vehicle complete: ${mobileState.totalAxles} axles, GVW: ${mobileState.gvw}kg`);

    // Reset session after successful completion
    StateManager.resetMobileSession();
    const sm = StateManager.getInstance();
    sm.currentMobileWeight = 0;
    sm.mobileWeightStable = true;

    return { success: true, ...vehicleData };
  } catch (error) {
    console.error('Error completing vehicle:', error);
    return { success: false, error: error.message };
  }
});

// Cancel current weighing session (explicitly cancel, different from reset)
ipcMain.handle('mobile:cancel-weighing', async (event, reason) => {
  try {
    const mobileState = StateManager.getMobileState();
    const axleConfig = StateManager.getAxleConfiguration();

    console.log(`[CancelWeighing] Cancelling session: ${mobileState.totalAxles} axles captured, reason: ${reason || 'user request'}`);

    // Cancel backend session (marks as not_weighed)
    await BackendClient.cancelSession();

    // Reset StateManager
    StateManager.resetMobileSession();
    const sm = StateManager.getInstance();
    sm.currentMobileWeight = 0;
    sm.mobileWeightStable = true;

    // Broadcast reset state to renderer
    broadcastWeights(null, null, { currentWeight: 0 });

    EventBus.emit('weighing:cancelled', {
      vehicleRegNumber: axleConfig.plateNumber,
      capturedAxles: mobileState.totalAxles,
      reason: reason || 'user request'
    });

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('weighing:cancelled', {
        message: 'Weighing session cancelled',
        reason: reason || 'user request'
      });
    }

    return { success: true, message: 'Session cancelled' };
  } catch (error) {
    console.error('Error cancelling weighing:', error);
    return { success: false, error: error.message };
  }
});

// =============================================
// Station Sync Handlers
// =============================================

// Sync station configuration from frontend/backend
ipcMain.handle('station:sync', async (event, stationData) => {
  try {
    console.log('[Station] Syncing station data from frontend:', stationData?.code || stationData?.name);

    const result = StateManager.setStationConfig(stationData);

    // Update BackendClient with station info
    BackendClient.configure({
      stationId: stationData.id,
      bound: stationData.currentBound || stationData.boundACode || 'A'
    });

    // Notify renderer of station update
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('station:updated', result);
    }

    console.log(`[Station] Station synced: ${result.name} (${result.code}), Bidirectional: ${result.supportsBidirectional}`);

    return { success: true, station: result };
  } catch (error) {
    console.error('Error syncing station:', error);
    return { success: false, error: error.message };
  }
});

// Get current station configuration
ipcMain.handle('station:get', async () => {
  try {
    const station = StateManager.getStationConfig();
    return { success: true, station };
  } catch (error) {
    console.error('Error getting station config:', error);
    return { success: false, error: error.message };
  }
});

// Update current bound (for bidirectional stations)
ipcMain.handle('station:set-bound', async (event, bound) => {
  try {
    const sm = StateManager.getInstance();
    const station = sm.station;

    if (!station.supportsBidirectional) {
      return { success: false, error: 'Station does not support bidirectional weighing' };
    }

    // Validate bound value
    if (bound !== station.boundACode && bound !== station.boundBCode && bound !== 'A' && bound !== 'B') {
      return { success: false, error: `Invalid bound value: ${bound}` };
    }

    sm.currentBound = bound;

    // Update BackendClient
    BackendClient.configure({ bound });

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('station:bound-changed', {
        bound,
        station: StateManager.getStationConfig()
      });
    }

    console.log(`[Station] Bound changed to: ${bound}`);

    return { success: true, bound, station: StateManager.getStationConfig() };
  } catch (error) {
    console.error('Error setting bound:', error);
    return { success: false, error: error.message };
  }
});

// =============================================
// Scale Status Handlers
// =============================================

// Get scale connection status
ipcMain.handle('scale:get-status', async (event, scaleId) => {
  try {
    const status = StateManager.getScaleStatus(scaleId);
    return { success: true, scales: status };
  } catch (error) {
    console.error('Error getting scale status:', error);
    return { success: false, error: error.message };
  }
});

// Update scale status (from input manager or manual test)
ipcMain.handle('scale:update-status', async (event, { scaleId, status }) => {
  try {
    const result = StateManager.updateScaleStatus(scaleId, status);

    // Notify renderer of scale status change
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scale:status-changed', {
        scaleId,
        status: result,
        allScales: StateManager.getScaleStatus()
      });
    }

    return { success: true, scale: result };
  } catch (error) {
    console.error('Error updating scale status:', error);
    return { success: false, error: error.message };
  }
});

// Simulate scale connection (for testing)
ipcMain.handle('scale:simulate-connection', async (event, { scaleId, connected }) => {
  try {
    const sm = StateManager.getInstance();

    // Update the scale status
    const status = {
      connected,
      weight: connected ? 0 : 0,
      battery: connected ? Math.floor(Math.random() * 30 + 70) : 0,
      temperature: connected ? Math.floor(Math.random() * 10 + 20) : 0,
      signalStrength: connected ? Math.floor(Math.random() * 20 + 80) : 0
    };

    const result = StateManager.updateScaleStatus(scaleId, status);

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scale:status-changed', {
        scaleId,
        status: result,
        allScales: StateManager.getScaleStatus()
      });
    }

    console.log(`[Scale] Simulated ${scaleId} ${connected ? 'connected' : 'disconnected'}`);

    return { success: true, scale: result };
  } catch (error) {
    console.error('Error simulating scale connection:', error);
    return { success: false, error: error.message };
  }
});

// System handlers
ipcMain.handle('app:get-version', () => {
  return { version: app.getVersion() };
});

ipcMain.handle('app:restart', () => {
  app.relaunch();
  app.exit(0);
});

// =============================================
// Connection Pool Handlers
// =============================================

// Get all connected WebSocket clients
ipcMain.handle('pool:get-clients', async () => {
  try {
    const OutputManager = require('./src/output/OutputManager');
    const wsOutput = OutputManager.getInstance()?.outputs?.websocket;

    if (!wsOutput) {
      return { success: true, clients: [], totalClients: 0, registeredClients: 0 };
    }

    const clientList = [];
    for (const [clientId, client] of wsOutput.clients) {
      clientList.push({
        clientId,
        clientName: client.clientName || `Client ${clientId}`,
        clientType: client.clientType || 'unknown',
        stationCode: client.stationCode || null,
        bound: client.bound || null,
        mode: client.mode || null,
        registered: client.registered || false,
        connectedAt: client.connectedAt || null,
        ip: client.ip || null
      });
    }

    return {
      success: true,
      clients: clientList,
      totalClients: wsOutput.clients.size,
      registeredClients: wsOutput.getRegisteredClientCount ? wsOutput.getRegisteredClientCount() : 0
    };
  } catch (error) {
    console.error('Error getting connected clients:', error);
    return { success: false, error: error.message, clients: [] };
  }
});

// Prevent app quit when all windows are closed
app.on('window-all-closed', (e) => {
  console.log('All windows closed, keeping app in tray');
  e.preventDefault();
});

// Cleanup on quit
app.on('before-quit', async () => {
  appIsQuitting = true;

  // Stop simulation if running
  try {
    const SimulationEngine = require('./src/simulation/SimulationEngine');
    if (SimulationEngine.getStatus().enabled) {
      SimulationEngine.stop();
    }
  } catch (err) {
    console.error('Error stopping simulation:', err);
  }

  // Stop input manager
  try {
    await InputManager.stop();
    console.log('Input manager stopped');
  } catch (err) {
    console.error('Error stopping input manager:', err);
  }

  // Stop output manager (WebSocket server)
  try {
    await OutputManager.stop();
    console.log('Output manager stopped');
  } catch (err) {
    console.error('Error stopping output manager:', err);
  }

  if (rduCommunicator && typeof rduCommunicator.shutdown === 'function') {
    rduCommunicator.shutdown();
  }

  Database.close();

  console.log('TruConnect shutdown complete');
});

// =====================================================
// Input Source IPC Handlers
// =====================================================

// Get input source status
ipcMain.handle('input:get-status', async () => {
  return InputManager.getStatus();
});

// Get available input sources
ipcMain.handle('input:get-sources', async () => {
  return InputManager.getAvailableSources();
});

// Switch input source
ipcMain.handle('input:switch-source', async (event, sourceName) => {
  try {
    // Disable simulation first if switching to a real input
    if (sourceName !== 'none') {
      await disableSimulation();
    }
    await switchInputSource(sourceName);
    return { success: true, activeSource: sourceName };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get available serial ports
ipcMain.handle('input:get-ports', async () => {
  return InputManager.getAvailablePorts();
});

// Enable/disable simulation
ipcMain.handle('simulation:toggle', async (event, enabled) => {
  try {
    if (enabled) {
      const simConfig = ConfigManager.get('simulation') || {};
      await enableSimulation(simConfig);
    } else {
      await disableSimulation();
    }
    return { success: true, enabled };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get simulation status
ipcMain.handle('simulation:get-status', async () => {
  const SimulationEngine = require('./src/simulation/SimulationEngine');
  return SimulationEngine.getStatus();
});

// Auto-updater IPC handlers
ipcMain.handle('updater:check-for-updates', async () => {
  if (!autoUpdater) return { error: 'Auto-updater not available' };
  try {
    const updateCheckResult = await autoUpdater.checkForUpdates();
    if (!updateCheckResult) return { updateAvailable: false };
    
    return {
      updateAvailable: updateCheckResult.updateInfo.version !== app.getVersion(),
      currentVersion: app.getVersion(),
      newVersion: updateCheckResult.updateInfo.version,
      releaseNotes: updateCheckResult.updateInfo.releaseNotes,
      releaseDate: updateCheckResult.updateInfo.releaseDate
    };
  } catch (error) {
    log.error('Error checking for updates:', error);
    return { error: error.message };
  }
});

ipcMain.handle('updater:download-update', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (error) {
    log.error('Error downloading update:', error);
    return { error: error.message };
  }
});

ipcMain.handle('updater:install-update', () => {
  if (autoUpdater) {
    autoUpdater.quitAndInstall();
  }
});

ipcMain.handle('updater:get-current-version', () => {
  return {
    version: app.getVersion(),
    productName: app.getName()
  };
});

// Auto-updater event handlers
if (autoUpdater) {
  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for update...');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:checking');
    }
  });

  autoUpdater.on('update-available', (info) => {
    log.info('Update available:', info.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:available', {
        version: info.version,
        releaseNotes: info.releaseNotes,
        releaseDate: info.releaseDate
      });
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info('Update not available');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:not-available');
    }
  });

  autoUpdater.on('error', (err) => {
    log.error('Update error:', err);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:error', err.message);
    }
  });

  autoUpdater.on('download-progress', (progressObj) => {
    let log_message = "Download speed: " + progressObj.bytesPerSecond;
    log_message = log_message + ' - Downloaded ' + progressObj.percent + '%';
    log_message = log_message + ' (' + progressObj.transferred + "/" + progressObj.total + ')';
    log.info(log_message);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:download-progress', {
        percent: progressObj.percent,
        speed: progressObj.bytesPerSecond,
        transferred: progressObj.transferred,
        total: progressObj.total
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded:', info.version);

    const options = {
      type: 'info',
      title: 'Update Ready',
      message: `A new version (${info.version}) of TruConnect has been downloaded and is ready to install.`,
      detail: 'The application will restart to complete the update.',
      buttons: ['Restart and Install', 'Later'],
      defaultId: 0,
      cancelId: 1
    };

    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, options).then((result) => {
        if (result.response === 0) {
          log.info('User chose to restart and install update');
          autoUpdater.quitAndInstall();
        }
      });

      mainWindow.webContents.send('updater:downloaded', {
        version: info.version,
        releaseNotes: info.releaseNotes
      });
    } else {
      // If no window, just install
      autoUpdater.quitAndInstall();
    }
  });
}

// Check for updates on startup (but not immediately, wait a bit)
setTimeout(() => {
  if (!appIsQuitting && autoUpdater) {
    autoUpdater.checkForUpdates().catch(err => {
      log.error('Startup update check failed:', err.message);
    });
  }
}, 5000); // 5 seconds after startup

// Auto-start registration on Windows
if (process.platform === 'win32') {
  const AutoLaunch = require('auto-launch');

  const autoLauncher = new AutoLaunch({
    name: 'TruConnect',
    path: process.execPath,
    isHidden: false
  });

  // Register for auto-start
  autoLauncher.enable().catch(err => {
    log.warn('Failed to register auto-start:', err);
  });

  // IPC handler to manage auto-start
  ipcMain.handle('autostart:toggle', async (event, enabled) => {
    try {
      if (enabled) {
        await autoLauncher.enable();
      } else {
        await autoLauncher.disable();
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('autostart:is-enabled', async () => {
    try {
      return await autoLauncher.isEnabled();
    } catch (error) {
      return false;
    }
  });
}

// Export current version for preload script
global.currentVersion = app.getVersion();
