/**
 * WebSocketOutput - WebSocket server for realtime communication
 *
 * Primary output mode for TruConnect.
 * Supports two-way communication with TruLoad clients.
 *
 * Server → Client Events:
 * - connected: { clientId, serverTime }
 * - weights: { mode, deck1-4, gvw, stable, simulation, source } (multideck)
 * - weight: { mode, weight, axleNumber, axleWeights, runningTotal, stable, simulation } (mobile)
 * - scale-status: { mode, connected, simulation, protocol, scaleA, scaleB }
 * - register-ack: { success, stationCode, bound, mode }
 * - plate-ack: { success, plateNumber, vehicleId }
 * - transaction-sync-ack: { success, transactionId, vehicleRegNumber }
 * - axle-captured-ack: { success, axleNumber, weight, isComplete, capturedAxles, expectedAxles, gvw }
 * - vehicle-complete-ack: { success, gvw }
 * - autoweigh-submitted: { success, ticketNumber, transactionId, gvw, captureStatus }
 * - session-reset-ack: { success }
 * - error: { message, code }
 *
 * Client → Server Events:
 * - register: { stationCode, bound, mode }
 * - plate: { plateNumber, vehicleType, anprImagePath, overviewImagePath }
 * - bound-switch: { bound: 'A' | 'B' }
 * - status-request: {}
 * - transaction-sync: { transactionId, vehicleRegNumber, axleConfigCode, totalAxles, stationId, bound, weighingMode }
 * - axle-captured: { axleNumber, weight, axleConfigurationId }
 * - vehicle-complete: { transactionId, totalAxles, axleWeights, gvw, axleConfigurationCode }
 * - reset-session: {}
 * - query-weight: { type: 'current' | 'next-axle' }
 * - capture-request: { deck, type }
 */

const WebSocket = require('ws');
const { EventEmitter } = require('events');
const EventBus = require('../core/EventBus');
const StateManager = require('../core/StateManager');
const BackendClient = require('../backend/BackendClient');
const ConfigManager = require('../config/ConfigManager');
const SimulationEngine = require('../simulation/SimulationEngine');

class WebSocketOutput extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      port: config.port || 3030,  // Default port is 3030
      pingInterval: config.pingInterval || 30000,
      pingTimeout: config.pingTimeout || 5000,
      maxConnections: config.maxConnections || 100
    };

    this.wss = null;
    this.clients = new Map(); // clientId -> { ws, stationCode, bound, registered }
    this.pingTimer = null;
    this.clientIdCounter = 0;
  }

  /**
   * Start WebSocket server
   */
  async start() {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocket.Server({
          port: this.config.port,
          maxPayload: 1024 * 1024 // 1MB
        });

        this.wss.on('listening', () => {
          console.log(`WebSocket server listening on port ${this.config.port}`);
          this.startPingInterval();
          resolve();
        });

        this.wss.on('connection', (ws, req) => {
          this.handleConnection(ws, req);
        });

        this.wss.on('error', (error) => {
          console.error('WebSocket server error:', error.message);
          this.emit('error', error);
          reject(error);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop WebSocket server
   */
  async stop() {
    this.stopPingInterval();

    // Close all client connections
    for (const [clientId, client] of this.clients) {
      try {
        client.ws.close(1000, 'Server shutdown');
      } catch (e) {
        // Ignore
      }
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          this.wss = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle new client connection
   */
  handleConnection(ws, req) {
    // Check max connections
    if (this.clients.size >= this.config.maxConnections) {
      ws.close(1013, 'Max connections exceeded');
      return;
    }

    const clientId = ++this.clientIdCounter;
    const clientIp = req.socket.remoteAddress;

    console.log(`Client connected: ${clientId} from ${clientIp}`);

    // Store client
    this.clients.set(clientId, {
      ws,
      ip: clientIp,
      stationCode: null,
      bound: null,
      registered: false,
      connectedAt: new Date()
    });

    // Set up event handlers
    ws.on('message', (data) => {
      this.handleMessage(clientId, data);
    });

    ws.on('close', (code, reason) => {
      const disconnectedClient = this.clients.get(clientId);
      console.log(`[WebSocket] Client disconnected: ${clientId} (code: ${code})`);
      this.clients.delete(clientId);

      // Remove from StateManager to clean up clients list
      StateManager.removeClientInfo(clientId);

      // Broadcast to remaining clients that a client left
      this.broadcastToRegistered('client-left', {
        message: `Client #${clientId} disconnected`,
        clientId,
        stationCode: disconnectedClient?.stationCode,
        bound: disconnectedClient?.bound,
        connectionPool: {
          totalClients: this.clients.size,
          registeredClients: this.getRegisteredClientCount()
        },
        timestamp: new Date().toISOString()
      });

      EventBus.emit('client:disconnected', { clientId });
    });

    ws.on('error', (error) => {
      console.error(`Client ${clientId} error: ${error.message}`);
      this.clients.delete(clientId);
      StateManager.removeClientInfo(clientId);
    });

    ws.on('pong', () => {
      const client = this.clients.get(clientId);
      if (client) {
        client.lastPong = Date.now();
      }
    });

    // Get station configuration for handshake
    const stationConfig = StateManager.getStationConfig ? StateManager.getStationConfig() : {};
    const captureMode = ConfigManager.get('app.captureMode', 'mobile');

    // Send hello/handshake message with connection pool info
    this.sendToClient(clientId, 'connected', {
      clientId,
      serverTime: new Date().toISOString(),
      message: `Hello! Welcome to TruConnect. You are client #${clientId}.`,
      server: {
        name: 'TruConnect Middleware',
        version: '2.0.0',
        captureMode,
        simulation: StateManager.isSimulation ? StateManager.isSimulation() : false
      },
      station: {
        code: stationConfig.code || ConfigManager.get('station.code', ''),
        name: stationConfig.name || ConfigManager.get('station.name', 'TruConnect Station'),
        supportsBidirectional: stationConfig.supportsBidirectional || false,
        currentBound: stationConfig.currentBound || 'A'
      },
      connectionPool: {
        totalClients: this.clients.size,
        registeredClients: this.getRegisteredClientCount(),
        yourClientId: clientId
      },
      endpoints: {
        websocket: `ws://localhost:${this.config.port}`,
        api: 'http://localhost:3031/api/v1'
      }
    });

    // Broadcast to other clients that a new client has joined
    this.broadcastToRegistered('client-joined', {
      message: `Client #${clientId} connected from ${clientIp}`,
      newClientId: clientId,
      totalClients: this.clients.size,
      timestamp: new Date().toISOString()
    });

    EventBus.emit('client:connected', { clientId, ip: clientIp });

    console.log(`[WebSocket] Hello sent to client ${clientId} - Pool size: ${this.clients.size}`);
  }

  /**
   * Handle incoming message from client
   */
  handleMessage(clientId, rawData) {
    try {
      const message = JSON.parse(rawData.toString());
      const { event, data } = message;

      console.log(`Message from ${clientId}: ${event}`);

      switch (event) {
        case 'register':
          this.handleRegister(clientId, data);
          break;

        case 'plate':
          this.handlePlate(clientId, data);
          break;

        case 'bound-switch':
          this.handleBoundSwitch(clientId, data);
          break;

        case 'status-request':
          this.handleStatusRequest(clientId);
          break;

        case 'capture-request':
          this.handleCaptureRequest(clientId, data);
          break;

        case 'transaction-sync':
          this.handleTransactionSync(clientId, data);
          break;

        case 'axle-captured':
          this.handleAxleCaptured(clientId, data);
          break;

        case 'vehicle-complete':
          this.handleVehicleComplete(clientId, data);
          break;

        case 'reset-session':
          this.handleResetSession(clientId);
          break;

        case 'query-weight':
          this.handleQueryWeight(clientId, data);
          break;

        default:
          console.warn(`Unknown event from ${clientId}: ${event}`);
      }

      EventBus.emit('client:message', { clientId, event, data });

    } catch (error) {
      console.error(`Invalid message from ${clientId}: ${error.message}`);
      this.sendToClient(clientId, 'error', { message: 'Invalid message format' });
    }
  }

  /**
   * Handle client registration
   * Expected data: { stationCode, bound, mode, clientName, clientType }
   * clientType: 'truload-frontend', 'truload-backend', 'mobile-app', 'api-client', etc.
   */
  handleRegister(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.stationCode = data.stationCode;
    client.bound = data.bound || 'A';
    client.mode = data.mode || 'mobile';
    client.clientName = data.clientName || `Client ${clientId}`;
    client.clientType = data.clientType || 'unknown';
    client.registered = true;

    console.log(`[WebSocket] Client ${clientId} (${client.clientName}/${client.clientType}) registered: ${data.stationCode} (Bound: ${data.bound}, Mode: ${data.mode})`);

    // Store in state
    StateManager.setClientInfo(clientId, {
      stationCode: data.stationCode,
      bound: data.bound,
      mode: data.mode,
      clientName: client.clientName,
      clientType: client.clientType
    });

    // Sync StateManager mode with client's requested mode
    StateManager.setMode(data.mode || 'mobile');

    // Sync simulation capture pattern if simulation is running
    const simStatus = SimulationEngine.getStatus();
    if (simStatus.enabled && data.mode) {
      SimulationEngine.setCapturePattern(data.mode);
    }

    // Emit client registered event for connection pool tracking
    EventBus.emit('client:registered', {
      clientId,
      clientName: client.clientName,
      clientType: client.clientType,
      stationCode: data.stationCode,
      bound: data.bound
    });

    // Get station configuration for response
    const stationConfig = StateManager.getStationConfig ? StateManager.getStationConfig() : {};
    const captureMode = ConfigManager.get('app.captureMode', 'mobile');

    // Acknowledge registration with full station info
    this.sendToClient(clientId, 'register-ack', {
      success: true,
      message: `Registration successful! Welcome to ${stationConfig.name || 'TruConnect Station'}.`,
      client: {
        clientId,
        stationCode: data.stationCode,
        bound: data.bound,
        mode: data.mode || captureMode
      },
      station: {
        id: stationConfig.id || ConfigManager.get('station.id'),
        code: stationConfig.code || ConfigManager.get('station.code', ''),
        name: stationConfig.name || ConfigManager.get('station.name', 'TruConnect Station'),
        supportsBidirectional: stationConfig.supportsBidirectional || false,
        boundACode: stationConfig.boundACode,
        boundBCode: stationConfig.boundBCode,
        currentBound: stationConfig.currentBound || data.bound || 'A'
      },
      server: {
        captureMode,
        simulation: StateManager.isSimulation ? StateManager.isSimulation() : false
      },
      connectionPool: {
        totalClients: this.clients.size,
        registeredClients: this.getRegisteredClientCount()
      }
    });

    // Broadcast to all registered clients that a new client registered
    this.broadcastToRegistered('client-registered', {
      message: `Client #${clientId} registered for station ${data.stationCode} (Bound ${data.bound})`,
      clientId,
      stationCode: data.stationCode,
      bound: data.bound,
      mode: data.mode,
      connectionPool: {
        totalClients: this.clients.size,
        registeredClients: this.getRegisteredClientCount()
      },
      timestamp: new Date().toISOString()
    });

    // Send current weights based on mode
    if (captureMode === 'mobile' || data.mode === 'mobile') {
      const mobileState = StateManager.getMobileState ? StateManager.getMobileState() : {};
      const currentWeight = StateManager.getCurrentMobileWeight ? StateManager.getCurrentMobileWeight() : 0;
      this.sendToClient(clientId, 'weight', {
        mode: 'mobile',
        weight: currentWeight,
        stable: true,
        session: mobileState,
        source: 'initial'
      });
    } else {
      const weights = StateManager.getWeights();
      this.sendToClient(clientId, 'weights', weights);
    }
  }

  /**
   * Handle plate number from client (for auto-weigh)
   */
  handlePlate(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client || !client.registered) {
      this.sendToClient(clientId, 'error', { message: 'Not registered' });
      return;
    }

    console.log(`Plate from ${client.stationCode}: ${data.plateNumber}`);

    // Store plate in state
    StateManager.setCurrentPlate(data.plateNumber, data.vehicleType);

    // Emit for auto-weigh processing
    EventBus.emit('plate:received', {
      clientId,
      stationCode: client.stationCode,
      bound: client.bound,
      plateNumber: data.plateNumber,
      vehicleType: data.vehicleType
    });

    // Acknowledge
    this.sendToClient(clientId, 'plate-ack', {
      success: true,
      plateNumber: data.plateNumber
    });
  }

  /**
   * Handle bound switch (A/B direction change)
   */
  handleBoundSwitch(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client) return;

    const newBound = data.bound?.toUpperCase();
    if (!['A', 'B'].includes(newBound)) {
      this.sendToClient(clientId, 'error', { message: 'Invalid bound' });
      return;
    }

    client.bound = newBound;

    console.log(`Client ${clientId} switched to bound ${newBound}`);

    this.sendToClient(clientId, 'bound-ack', {
      success: true,
      bound: newBound
    });
  }

  /**
   * Handle status request - returns full system and connection pool status
   */
  handleStatusRequest(clientId) {
    const status = StateManager.getState();
    const stationConfig = StateManager.getStationConfig ? StateManager.getStationConfig() : {};
    const captureMode = ConfigManager.get('app.captureMode', 'mobile');

    // Build connection pool details
    const poolDetails = [];
    for (const [id, client] of this.clients) {
      poolDetails.push({
        clientId: id,
        stationCode: client.stationCode,
        bound: client.bound,
        mode: client.mode,
        registered: client.registered,
        connectedAt: client.connectedAt,
        ip: client.ip
      });
    }

    this.sendToClient(clientId, 'status', {
      ...status,
      server: {
        name: 'TruConnect Middleware',
        version: '2.0.0',
        captureMode,
        uptime: process.uptime()
      },
      station: stationConfig,
      connectionPool: {
        totalClients: this.clients.size,
        registeredClients: this.getRegisteredClientCount(),
        clients: poolDetails
      },
      endpoints: {
        websocket: `ws://localhost:${this.config.port}`,
        api: 'http://localhost:3031/api/v1'
      }
    });
  }

  /**
   * Handle capture request (trigger weight capture)
   */
  handleCaptureRequest(clientId, data) {
    EventBus.emit('capture:requested', {
      clientId,
      deck: data.deck || 0,
      type: data.type || 'gvw'
    });

    this.sendToClient(clientId, 'capture-ack', { success: true });
  }

  /**
   * Handle transaction sync from TruLoad frontend
   * Links middleware session to the frontend-created transaction
   * Expected data: { transactionId, vehicleRegNumber, axleConfigCode, totalAxles, stationId, bound, weighingMode }
   */
  handleTransactionSync(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client || !client.registered) {
      this.sendToClient(clientId, 'error', { message: 'Not registered' });
      return;
    }

    console.log(`[WebSocket] Transaction sync from ${client.stationCode}: txnId=${data.transactionId}, plate=${data.vehicleRegNumber}, mode=${data.weighingMode}`);

    // Store transaction sync data in StateManager
    StateManager.setTransactionSync(data);

    // Sync to BackendClient so autoweigh includes the transaction ID
    BackendClient.syncFromTransaction(data);

    // Start a backend session with the synced data
    BackendClient.startSession({
      weighingTransactionId: data.transactionId,
      regNumber: data.vehicleRegNumber,
      weighingMode: data.weighingMode
    });

    // Update axle configuration if provided
    if (data.totalAxles) {
      StateManager.setAxleConfiguration({
        expectedAxles: data.totalAxles,
        axleConfigurationCode: data.axleConfigCode,
        plateNumber: data.vehicleRegNumber
      });
    }

    // Emit event for other components
    EventBus.emit('transaction:synced', {
      clientId,
      stationCode: client.stationCode,
      ...data
    });

    // Acknowledge
    this.sendToClient(clientId, 'transaction-sync-ack', {
      success: true,
      transactionId: data.transactionId,
      vehicleRegNumber: data.vehicleRegNumber
    });
  }

  /**
   * Handle axle captured notification (mobile mode)
   * TruLoad sends this after user confirms axle weight capture.
   * When all expected axles are captured, auto-submits to backend.
   * 
   * IMPORTANT: For MCGS cumulative scales, uses currentMobileWeight (already corrected)
   * instead of relying on frontend-provided weight, ensuring accurate individual axle weights.
   */
  handleAxleCaptured(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client || !client.registered) {
      this.sendToClient(clientId, 'error', { message: 'Not registered' });
      return;
    }

    const { axleNumber } = data;
    
    // Use currentMobileWeight (already cumulative-adjusted) for MCGS and similar
    // This prevents double-application of cumulative logic
    const weight = StateManager.getCurrentMobileWeight();

    console.log(`Axle ${axleNumber} captured: ${weight}kg from ${client.stationCode}`);

    // Add axle weight to StateManager (tracks captured axles)
    StateManager.addAxleWeight(weight);

    // Emit event for processing
    EventBus.emit('axle:captured', {
      clientId,
      stationCode: client.stationCode,
      bound: client.bound,
      axleNumber,
      weight
    });

    // Check if all axles are now captured
    const isComplete = StateManager.isWeighingComplete();
    const mobileState = StateManager.getMobileState();

    // Acknowledge capture
    this.sendToClient(clientId, 'axle-captured-ack', {
      success: true,
      axleNumber,
      weight,
      isComplete,
      capturedAxles: mobileState.axles.length,
      expectedAxles: StateManager.getAxleConfiguration().expectedAxles,
      gvw: mobileState.gvw
    });

    // Auto-submit to backend when all axles are captured (standalone mode only; skip when frontend owns the transaction)
    if (isComplete && !BackendClient.isAutoweighSent() && !BackendClient.hasSyncedTransaction()) {
      console.log(`[AutoWeigh] All ${mobileState.axles.length} axles captured via WebSocket - sending auto-weigh to backend...`);

      const axleConfig = StateManager.getAxleConfiguration();
      BackendClient.sendAutoweigh({
        plateNumber: axleConfig.plateNumber || StateManager.getInstance().currentPlate,
        vehicleId: axleConfig.vehicleId,
        axleConfigurationId: axleConfig.axleConfigurationId,
        axles: mobileState.axles,
        gvw: mobileState.gvw
      }).then(result => {
        if (result) {
          console.log(`[AutoWeigh] Auto-weigh sent via WebSocket: Ticket=${result.ticketNumber}`);
          this.sendToClient(clientId, 'autoweigh-submitted', {
            success: true,
            ticketNumber: result.ticketNumber,
            transactionId: result.weighingId,
            gvw: result.gvwMeasuredKg,
            captureStatus: result.captureStatus
          });
        }
      }).catch(err => {
        console.error('[AutoWeigh] Auto-weigh submission failed:', err.message);
      }).finally(() => {
        // Always reset middleware weights for next weighing session (success or fail)
        StateManager.resetMobileSession();
        console.log('[AutoWeigh] Weighing session reset after auto-weigh attempt');
      });
    } else if (isComplete && BackendClient.hasSyncedTransaction()) {
      // Frontend owns the transaction; only reset for next session, no autoweigh
      StateManager.resetMobileSession();
      console.log('[AutoWeigh] All axles captured but frontend has synced transaction - session reset, no autoweigh');
    }

    // Trigger query for next axle weight after configured delay
    // For MCGS this sends the weigh command so the console outputs the next axle GVW
    if (!isComplete) {
      EventBus.emit('axle:query-next', {
        clientId,
        nextAxle: axleNumber + 1
      });
      const InputManager = require('../input/InputManager');
      InputManager.queryWeight();
    }
  }

  /**
   * Handle vehicle weighing complete (multideck or mobile mode)
   * Auto-submits autoweigh to backend with all captured weights.
   */
  handleVehicleComplete(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client || !client.registered) {
      this.sendToClient(clientId, 'error', { message: 'Not registered' });
      return;
    }

    const { transactionId, totalAxles, axleWeights, gvw, axleConfigurationCode } = data;

    console.log(`Vehicle complete: ${totalAxles} axles, GVW: ${gvw}kg from ${client.stationCode}`);

    const plateData = StateManager.getCurrentPlate();
    const plateNumber = plateData?.plate || plateData || null;

    // Emit for processing
    EventBus.emit('vehicle:complete', {
      clientId,
      stationCode: client.stationCode,
      bound: client.bound,
      totalAxles,
      axleWeights,
      gvw,
      plateNumber
    });

    // Build axle data for autoweigh
    const axles = (axleWeights || []).map((weight, index) => ({
      axleNumber: index + 1,
      weight: weight
    }));

    // Auto-submit to backend (standalone mode only; skip when frontend owns the transaction)
    if (!BackendClient.isAutoweighSent() && !BackendClient.hasSyncedTransaction() && axles.length > 0) {
      console.log(`[AutoWeigh] Vehicle complete via WebSocket - sending auto-weigh to backend (${axles.length} axles, GVW=${gvw}kg)...`);

      const axleConfig = StateManager.getAxleConfiguration();
      BackendClient.sendAutoweigh({
        plateNumber: axleConfig.plateNumber || plateNumber,
        vehicleId: axleConfig.vehicleId,
        axleConfigurationId: axleConfig.axleConfigurationId,
        axles,
        gvw: gvw || axles.reduce((sum, a) => sum + a.weight, 0)
      }).then(result => {
        if (result) {
          console.log(`[AutoWeigh] Auto-weigh sent via WebSocket (vehicle-complete): Ticket=${result.ticketNumber}`);
          this.sendToClient(clientId, 'autoweigh-submitted', {
            success: true,
            ticketNumber: result.ticketNumber,
            transactionId: result.weighingId,
            gvw: result.gvwMeasuredKg,
            captureStatus: result.captureStatus
          });
        }
      }).catch(err => {
        console.error('[AutoWeigh] Auto-weigh submission failed:', err.message);
      }).finally(() => {
        // Always reset weights for next vehicle (mobile + multideck deck weights)
        StateManager.resetMobileSession();
        StateManager.getInstance().reset();
        console.log('[AutoWeigh] Weighing session and deck weights reset after vehicle-complete');
      });
    } else if (BackendClient.hasSyncedTransaction() && axles.length > 0) {
      // Frontend owns the transaction (e.g. after confirm); only reset, no autoweigh
      StateManager.resetMobileSession();
      StateManager.getInstance().reset();
      console.log('[AutoWeigh] Vehicle complete but frontend has synced transaction - session reset, no autoweigh');
    }

    // Acknowledge
    this.sendToClient(clientId, 'vehicle-complete-ack', {
      success: true,
      gvw
    });
  }

  /**
   * Handle reset weighing session
   */
  handleResetSession(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;

    console.log(`Session reset requested by ${clientId}`);

    // Full state reset in StateManager
    StateManager.getInstance().reset();

    // Reset backend session if applicable
    if (typeof BackendClient !== 'undefined' && BackendClient.resetSession) {
      BackendClient.resetSession();
    }

    this.sendToClient(clientId, 'session-reset-ack', { success: true });
  }

  /**
   * Handle manual weight query request
   */
  handleQueryWeight(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client || !client.registered) {
      this.sendToClient(clientId, 'error', { message: 'Not registered' });
      return;
    }

    console.log(`Weight query requested by ${clientId}`);

    // Emit event for InputManager to query the scale
    EventBus.emit('weight:query-requested', {
      clientId,
      type: data.type || 'current' // 'current' | 'next-axle'
    });

    this.sendToClient(clientId, 'query-weight-ack', { success: true });
  }

  /**
   * Send message to specific client
   */
  sendToClient(clientId, event, data) {
    const client = this.clients.get(clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      client.ws.send(JSON.stringify({
        event,
        data,
        timestamp: new Date().toISOString()
      }));
      return true;
    } catch (error) {
      console.error(`Failed to send to ${clientId}: ${error.message}`);
      return false;
    }
  }

  /**
   * Broadcast message to all connected clients
   */
  broadcast(event, data) {
    const message = JSON.stringify({
      event,
      data,
      timestamp: new Date().toISOString()
    });

    for (const [clientId, client] of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(message);
        } catch (error) {
          console.error(`Broadcast error to ${clientId}: ${error.message}`);
        }
      }
    }
  }

  /**
   * Broadcast to registered clients only
   */
  broadcastToRegistered(event, data) {
    const message = JSON.stringify({
      event,
      data,
      timestamp: new Date().toISOString()
    });

    for (const [clientId, client] of this.clients) {
      if (client.registered && client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(message);
        } catch (error) {
          console.error(`Broadcast error to ${clientId}: ${error.message}`);
        }
      }
    }
  }

  /**
   * Start ping interval for keepalive
   */
  startPingInterval() {
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      const activeClientIds = [];

      for (const [clientId, client] of this.clients) {
        // Check for stale connections
        if (client.lastPong && now - client.lastPong > this.config.pingTimeout * 2) {
          console.log(`Client ${clientId} timed out`);
          client.ws.terminate();
          this.clients.delete(clientId);
          StateManager.removeClientInfo(clientId);
          continue;
        }

        // Send ping
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.ping();
          activeClientIds.push(clientId);
        } else {
          // Clean up clients that are no longer open
          console.log(`[WebSocket] Removing client ${clientId} with state ${client.ws.readyState}`);
          this.clients.delete(clientId);
          StateManager.removeClientInfo(clientId);
        }
      }

      // Sync StateManager's client list with actual WebSocket clients
      // This ensures any orphaned entries are cleaned up
      StateManager.cleanupStaleClients(activeClientIds);
    }, this.config.pingInterval);
  }

  /**
   * Stop ping interval
   */
  stopPingInterval() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Get client count
   */
  getClientCount() {
    return this.clients.size;
  }

  /**
   * Get registered client count
   */
  getRegisteredClientCount() {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.registered) count++;
    }
    return count;
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      running: this.wss !== null,
      port: this.config.port,
      totalClients: this.clients.size,
      registeredClients: this.getRegisteredClientCount()
    };
  }

  /**
   * Broadcast scale status to all registered clients
   * Called when scale connection status changes
   */
  broadcastScaleStatus(scaleStatus) {
    this.broadcastToRegistered('scale-status', scaleStatus);
  }

  /**
   * Broadcast weight update to all registered clients
   * Uses consistent data structure matching API /weights endpoint for frontend compatibility
   * @param {Object} weightData - Weight data from parser
   * @param {string} mode - 'mobile' or 'multideck'
   */
  broadcastWeight(weightData, mode = 'multideck') {
    const inputSource = StateManager.getInputSource();
    const simulation = StateManager.isSimulation();

    // Get device metadata from active source config
    const activeSource = ConfigManager.get('input.activeSource') || 'none';
    const sourceConfig = activeSource !== 'none' ? ConfigManager.get(`input.${activeSource}`) : null;
    const metadata = sourceConfig?.metadata || {};

    // Common connection info (matches API /weights response structure)
    const connection = {
      source: simulation ? 'simulation' : (inputSource.name || weightData.source || 'unknown'),
      protocol: simulation ? 'SIMULATED' : inputSource.protocol,
      type: simulation ? 'internal' : inputSource.connectionType,
      connected: simulation ? true : inputSource.connected,
      outputMode: 'websocket',
      device: {
        make: simulation ? 'Virtual' : (metadata.make || null),
        model: simulation ? (mode === 'mobile' ? 'Scale' : 'Indicator') : (metadata.model || null),
        capacity: metadata.capacity || null
      }
    };

    if (mode === 'mobile') {
      // Mobile mode: single axle weight with accumulation
      const mobileState = StateManager.getMobileState();
      const scaleInfo = StateManager.getMobileScaleInfo();
      const scaleStatus = StateManager.getScaleStatus();
      // Prefer correctedWeight (set by setCurrentMobileWeight after cumulative subtraction).
      // weightData.weight is the raw parser value and will be the accumulated GVW for MCGS.
      const currentWeight = weightData.currentWeight ?? weightData.weight ?? weightData.gross ?? StateManager.getCurrentMobileWeight();

      // Individual scale weights:
      // StateManager.scaleConnections always holds corrected split weights (trueWeight/2),
      // set by setCurrentMobileWeight. Use these first so MCGS cumulative correction flows through.
      // Fall back to parser-provided values only when StateManager hasn't populated them yet.
      let scaleAWeight, scaleBWeight;
      if (scaleStatus.scaleA?.weight || scaleStatus.scaleB?.weight) {
        // StateManager has corrected split weights (already cumulative-adjusted)
        scaleAWeight = scaleStatus.scaleA?.weight || 0;
        scaleBWeight = scaleStatus.scaleB?.weight || 0;
      } else if (weightData.scaleA !== undefined && weightData.scaleB !== undefined) {
        // Fallback: parser-provided weights (used before StateManager is populated)
        scaleAWeight = weightData.scaleA;
        scaleBWeight = weightData.scaleB;
      } else {
        // Derive from corrected combined weight
        scaleAWeight = Math.round(currentWeight / 2);
        scaleBWeight = currentWeight - scaleAWeight;
      }

      // Calculate GVW values (matching API structure)
      const capturedGvw = mobileState.gvw || 0;  // Sum of captured axles
      const runningGvw = capturedGvw + currentWeight;  // Real-time total

      this.broadcastToRegistered('weight', {
        mode: 'mobile',
        // Current scale reading (total axle weight)
        weight: currentWeight,
        currentWeight: currentWeight,  // Alias for API compatibility
        // Individual scale weights (for scale test and diagnostics)
        // PAW: derived from combined weight (total/2)
        // Haenni: may be provided separately
        scaleA: scaleAWeight,
        scaleB: scaleBWeight,
        scaleWeightMode: weightData.scaleWeightMode || 'combined', // 'combined' (PAW) or 'separate' (Haenni)
        // Scale connection status: use scale status, fallback to connection (device connected)
        scaleAStatus: {
          connected: scaleStatus.scaleA?.connected ?? connection.connected ?? false,
          weight: scaleAWeight,
          battery: simulation ? 100 : (scaleStatus.scaleA?.battery || scaleInfo.battery || 100),
          temperature: simulation ? 25 : (scaleStatus.scaleA?.temperature || scaleInfo.temperature || 25),
          signalStrength: simulation ? 100 : (scaleStatus.scaleA?.signalStrength || scaleInfo.signalStrength || 100)
        },
        scaleBStatus: {
          connected: scaleStatus.scaleB?.connected ?? connection.connected ?? false,
          weight: scaleBWeight,
          battery: simulation ? 100 : (scaleStatus.scaleB?.battery || scaleInfo.battery || 100),
          temperature: simulation ? 25 : (scaleStatus.scaleB?.temperature || scaleInfo.temperature || 25),
          signalStrength: simulation ? 100 : (scaleStatus.scaleB?.signalStrength || scaleInfo.signalStrength || 100)
        },
        // Running totals
        runningTotal: runningGvw,
        runningGvw: runningGvw,  // Alias for API compatibility
        // Axle info
        axleNumber: weightData.axleNumber || mobileState.currentAxle || 1,
        axleWeights: weightData.axleWeights || mobileState.axles?.map(a => a.weight) || [],
        // Session state (matches API structure)
        session: {
          currentAxle: mobileState.currentAxle,
          totalAxles: mobileState.totalAxles,
          axles: mobileState.axles,
          gvw: capturedGvw
        },
        // Status
        stable: weightData.stable !== false,
        unit: weightData.unit || 'kg',
        simulation,  // Use StateManager simulation flag for consistency
        // Scale info (matches API structure)
        scaleInfo: {
          battery: simulation ? 100 : scaleInfo.battery,
          temperature: simulation ? 25 : scaleInfo.temperature,
          signalStrength: simulation ? 100 : scaleInfo.signalStrength,
          make: simulation ? 'Virtual' : (scaleInfo.make || metadata.make || null),
          model: simulation ? 'Scale' : (scaleInfo.model || metadata.model || null)
        },
        // Connection info (matches API structure)
        connection
      });
    } else {
      // Multideck mode: all deck weights simultaneously
      // IMPORTANT: Read weights from StateManager for consistency with API endpoint
      const weights = StateManager.getWeights();
      const indicatorInfo = StateManager.getIndicatorInfo();

      this.broadcastToRegistered('weights', {
        mode: 'multideck',
        // Flat deck weights (legacy format for backward compatibility)
        deck1: weights.deck1,
        deck2: weights.deck2,
        deck3: weights.deck3,
        deck4: weights.deck4,
        // Array format (matches API structure)
        decks: [
          { index: 1, weight: weights.deck1, stable: true },
          { index: 2, weight: weights.deck2, stable: true },
          { index: 3, weight: weights.deck3, stable: true },
          { index: 4, weight: weights.deck4, stable: true }
        ],
        gvw: weights.gvw,
        vehicleOnDeck: weights.gvw > 50,
        stable: weightData.stable !== false,
        simulation,  // Use StateManager simulation flag for consistency
        // Indicator info (matches API structure)
        indicatorInfo: {
          make: simulation ? 'Virtual' : (indicatorInfo.make || metadata.make || null),
          model: simulation ? 'Indicator' : (indicatorInfo.model || metadata.model || null),
          signalStrength: simulation ? 100 : (indicatorInfo.signalStrength || 100)
        },
        // Connection info (matches API structure)
        connection
      });
    }
  }
}

module.exports = WebSocketOutput;
