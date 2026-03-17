/**
 * CloudConnectionManager - Manages connection to cloud/backend WebSocket
 *
 * Supports two operation modes:
 * - LOCAL: TruConnect serves weights via local WebSocket/API only
 * - LIVE: TruConnect also relays to backend WebSocket and syncs with cloud
 *
 * In LIVE mode:
 * - Connects to backend WebSocket (SignalR or native WS)
 * - Relays weight data to backend connection pool
 * - Receives commands from backend (plate info, session control)
 * - Falls back to local-only if backend is unavailable
 */

const WebSocket = require('ws');
const EventBus = require('../core/EventBus');
const StateManager = require('../core/StateManager');
const ConfigManager = require('../config/ConfigManager');

const OPERATION_MODES = {
  LOCAL: 'local',
  LIVE: 'live'
};

const CONNECTION_STATES = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  FAILED: 'failed'
};

class CloudConnectionManager {
  constructor() {
    this.ws = null;
    this.operationMode = OPERATION_MODES.LOCAL;
    this.connectionState = CONNECTION_STATES.DISCONNECTED;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.config = {};
    this.isInitialized = false;
    this.lastHeartbeat = null;
    this.messageQueue = [];  // Queue messages when disconnected

    // Bind event handlers
    this._onWeightUpdate = this._onWeightUpdate.bind(this);
    this._onPlateReceived = this._onPlateReceived.bind(this);
    this._onVehicleComplete = this._onVehicleComplete.bind(this);
  }

  /**
   * Initialize the cloud connection manager
   */
  async initialize(config = {}) {
    this.config = {
      backendWsUrl: config.backendWsUrl || ConfigManager.get('operationMode.backendWsUrl') || '',
      mode: config.mode || ConfigManager.get('operationMode.mode') || OPERATION_MODES.LOCAL,
      poolName: config.poolName || ConfigManager.get('operationMode.poolName') || 'truconnect-middleware',
      stationIdentifier: config.stationIdentifier || ConfigManager.get('station.id') || '',
      reconnectInterval: config.reconnectInterval || ConfigManager.get('cloudConnection.reconnectInterval') || 5000,
      maxReconnectAttempts: config.maxReconnectAttempts || ConfigManager.get('cloudConnection.maxReconnectAttempts') || 10,
      heartbeatInterval: config.heartbeatInterval || ConfigManager.get('operationMode.keepAliveInterval') || 25000,
      connectionTimeout: config.connectionTimeout || ConfigManager.get('operationMode.connectionTimeout') || 10000,
      syncToBackend: config.syncToBackend ?? ConfigManager.get('operationMode.syncToBackendInLive') ?? true,
      fallbackToLocal: config.fallbackToLocal ?? ConfigManager.get('operationMode.fallbackToLocalInLive') ?? true,
    };

    this.operationMode = this.config.mode;
    this.isInitialized = true;

    console.log(`CloudConnectionManager initialized in ${this.operationMode.toUpperCase()} mode`);

    // Subscribe to events for relaying to backend
    this._subscribeToEvents();

    // If in live mode and backend URL configured, connect
    if (this.operationMode === OPERATION_MODES.LIVE && this.config.backendWsUrl) {
      await this.connect();
    }

    EventBus.emit('cloud:initialized', {
      mode: this.operationMode,
      backendUrl: this.config.backendWsUrl
    });

    return this;
  }

  /**
   * Subscribe to weight/vehicle events for relay
   */
  _subscribeToEvents() {
    // Listen for weight updates to relay to backend
    EventBus.on('state:weights-updated', this._onWeightUpdate);
    EventBus.on('state:mobile-weight-updated', this._onWeightUpdate);
    EventBus.on('plate:received', this._onPlateReceived);
    EventBus.on('vehicle:complete', this._onVehicleComplete);
  }

  /**
   * Unsubscribe from events
   */
  _unsubscribeFromEvents() {
    EventBus.off('state:weights-updated', this._onWeightUpdate);
    EventBus.off('state:mobile-weight-updated', this._onWeightUpdate);
    EventBus.off('plate:received', this._onPlateReceived);
    EventBus.off('vehicle:complete', this._onVehicleComplete);
  }

  /**
   * Handle weight update - relay to backend if in live mode
   */
  _onWeightUpdate(data) {
    if (this.operationMode !== OPERATION_MODES.LIVE || !this.config.syncToBackend) {
      return;
    }

    this._sendToBackend('weight-update', {
      ...data,
      stationId: this.config.stationIdentifier,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Handle plate received - relay to backend
   */
  _onPlateReceived(data) {
    if (this.operationMode !== OPERATION_MODES.LIVE) {
      return;
    }

    this._sendToBackend('plate-received', {
      ...data,
      stationId: this.config.stationIdentifier,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Handle vehicle complete - relay to backend
   */
  _onVehicleComplete(data) {
    if (this.operationMode !== OPERATION_MODES.LIVE) {
      return;
    }

    this._sendToBackend('vehicle-complete', {
      ...data,
      stationId: this.config.stationIdentifier,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Connect to backend WebSocket
   */
  async connect() {
    if (!this.config.backendWsUrl) {
      console.log('CloudConnectionManager: No backend WS URL configured');
      return false;
    }

    if (this.connectionState === CONNECTION_STATES.CONNECTED) {
      return true;
    }

    this.connectionState = CONNECTION_STATES.CONNECTING;
    EventBus.emit('cloud:connecting', { url: this.config.backendWsUrl });

    return new Promise((resolve) => {
      try {
        const timeoutId = setTimeout(() => {
          if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
            console.log('CloudConnectionManager: Connection timeout');
            this.ws.terminate();
            this.connectionState = CONNECTION_STATES.FAILED;
            resolve(false);
          }
        }, this.config.connectionTimeout);

        this.ws = new WebSocket(this.config.backendWsUrl);

        this.ws.on('open', () => {
          clearTimeout(timeoutId);
          console.log(`CloudConnectionManager: Connected to ${this.config.backendWsUrl}`);
          this.connectionState = CONNECTION_STATES.CONNECTED;
          this.reconnectAttempts = 0;

          // Register with backend
          this._registerWithBackend();

          // Start heartbeat
          this._startHeartbeat();

          // Process queued messages
          this._processMessageQueue();

          EventBus.emit('cloud:connected', { url: this.config.backendWsUrl });
          resolve(true);
        });

        this.ws.on('message', (data) => {
          this._handleBackendMessage(data);
        });

        this.ws.on('close', (code, reason) => {
          clearTimeout(timeoutId);
          console.log(`CloudConnectionManager: Disconnected (${code}: ${reason})`);
          this._stopHeartbeat();
          this.connectionState = CONNECTION_STATES.DISCONNECTED;

          EventBus.emit('cloud:disconnected', { code, reason: reason?.toString() });

          // Schedule reconnect if in live mode
          if (this.operationMode === OPERATION_MODES.LIVE) {
            this._scheduleReconnect();
          }

          resolve(false);
        });

        this.ws.on('error', (error) => {
          clearTimeout(timeoutId);
          console.error('CloudConnectionManager: WebSocket error:', error.message);
          this.connectionState = CONNECTION_STATES.FAILED;

          EventBus.emit('cloud:error', { error: error.message });
          resolve(false);
        });

      } catch (error) {
        console.error('CloudConnectionManager: Failed to create WebSocket:', error.message);
        this.connectionState = CONNECTION_STATES.FAILED;
        resolve(false);
      }
    });
  }

  /**
   * Disconnect from backend WebSocket
   */
  disconnect() {
    this._stopHeartbeat();
    this._clearReconnectTimer();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.connectionState = CONNECTION_STATES.DISCONNECTED;
    EventBus.emit('cloud:disconnected', { reason: 'manual' });
  }

  /**
   * Register with backend as middleware client
   */
  _registerWithBackend() {
    this._sendToBackend('register', {
      type: 'middleware',
      poolName: this.config.poolName,
      stationId: this.config.stationIdentifier,
      stationCode: ConfigManager.get('station.code'),
      stationName: ConfigManager.get('station.name'),
      bound: ConfigManager.get('station.bound') || 'A',
      mode: StateManager.getMode(),
      version: '2.0.0',
      capabilities: ['weight-relay', 'plate-relay', 'command-receiver']
    });
  }

  /**
   * Send message to backend
   */
  _sendToBackend(event, data) {
    const message = JSON.stringify({ event, data, timestamp: Date.now() });

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    } else if (this.operationMode === OPERATION_MODES.LIVE) {
      // Queue message for later
      this.messageQueue.push({ event, data, timestamp: Date.now() });
      // Limit queue size
      if (this.messageQueue.length > 100) {
        this.messageQueue.shift();
      }
    }
  }

  /**
   * Process queued messages after reconnect
   */
  _processMessageQueue() {
    while (this.messageQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      const { event, data } = this.messageQueue.shift();
      this._sendToBackend(event, data);
    }
  }

  /**
   * Handle message from backend
   */
  _handleBackendMessage(rawData) {
    try {
      const message = JSON.parse(rawData.toString());
      const { event, data } = message;

      console.log(`CloudConnectionManager: Received ${event} from backend`);

      switch (event) {
        case 'register-ack':
          console.log('CloudConnectionManager: Registration acknowledged by backend');
          EventBus.emit('cloud:registered', data);
          break;

        case 'plate-push':
          // Backend pushing plate info to middleware (e.g., from ANPR)
          EventBus.emit('plate:received', {
            ...data,
            source: 'backend'
          });
          break;

        case 'command':
          // Backend sending command to middleware
          this._handleBackendCommand(data);
          break;

        case 'pong':
          this.lastHeartbeat = Date.now();
          break;

        case 'error':
          console.error('CloudConnectionManager: Backend error:', data.message);
          EventBus.emit('cloud:error', data);
          break;

        default:
          // Emit as generic cloud event
          EventBus.emit(`cloud:${event}`, data);
      }

    } catch (error) {
      console.error('CloudConnectionManager: Failed to parse backend message:', error.message);
    }
  }

  /**
   * Handle command from backend
   */
  _handleBackendCommand(command) {
    const { type, payload } = command;

    switch (type) {
      case 'reset-session':
        EventBus.emit('session:reset', payload);
        break;

      case 'capture-weight':
        EventBus.emit('capture:requested', payload);
        break;

      case 'switch-mode':
        if (payload.mode) {
          StateManager.setMode(payload.mode);
        }
        break;

      case 'switch-bound':
        if (payload.bound) {
          StateManager.setBound(payload.bound);
        }
        break;

      default:
        console.log(`CloudConnectionManager: Unknown command type: ${type}`);
    }
  }

  /**
   * Start heartbeat to keep connection alive
   */
  _startHeartbeat() {
    this._stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this._sendToBackend('ping', { timestamp: Date.now() });
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * Stop heartbeat
   */
  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Schedule reconnection attempt
   */
  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.log('CloudConnectionManager: Max reconnect attempts reached');
      this.connectionState = CONNECTION_STATES.FAILED;
      EventBus.emit('cloud:reconnect-failed', { attempts: this.reconnectAttempts });
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.config.reconnectInterval * Math.pow(1.5, this.reconnectAttempts - 1),
      30000
    );

    console.log(`CloudConnectionManager: Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.connectionState = CONNECTION_STATES.RECONNECTING;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, delay);
  }

  /**
   * Clear reconnect timer
   */
  _clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Switch operation mode
   * @param {string} mode - 'local' or 'live'
   */
  async switchMode(mode) {
    if (!Object.values(OPERATION_MODES).includes(mode)) {
      throw new Error(`Invalid operation mode: ${mode}. Use 'local' or 'live'`);
    }

    if (mode === this.operationMode) {
      return;
    }

    const previousMode = this.operationMode;
    this.operationMode = mode;

    console.log(`CloudConnectionManager: Switching mode from ${previousMode} to ${mode}`);

    // Update config
    ConfigManager.set('operationMode.mode', mode);

    if (mode === OPERATION_MODES.LIVE) {
      // Switching to live mode - connect to backend
      if (this.config.backendWsUrl) {
        await this.connect();
      } else {
        console.warn('CloudConnectionManager: No backend URL configured for live mode');
      }
    } else {
      // Switching to local mode - disconnect from backend
      this.disconnect();
    }

    EventBus.emit('cloud:mode-changed', {
      previous: previousMode,
      current: mode
    });
  }

  /**
   * Configure backend URL and optionally switch to live mode
   */
  async setBackendUrl(url, autoConnect = false) {
    this.config.backendWsUrl = url;
    ConfigManager.set('operationMode.backendWsUrl', url);

    console.log(`CloudConnectionManager: Backend URL set to ${url}`);

    if (autoConnect && this.operationMode === OPERATION_MODES.LIVE) {
      this.disconnect();
      await this.connect();
    }

    EventBus.emit('cloud:backend-url-changed', { url });
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      mode: this.operationMode,
      connectionState: this.connectionState,
      backendUrl: this.config.backendWsUrl,
      isConnected: this.connectionState === CONNECTION_STATES.CONNECTED,
      reconnectAttempts: this.reconnectAttempts,
      lastHeartbeat: this.lastHeartbeat,
      queuedMessages: this.messageQueue.length
    };
  }

  /**
   * Cleanup on shutdown
   */
  async shutdown() {
    this._unsubscribeFromEvents();
    this.disconnect();
    this.isInitialized = false;
  }
}

// Singleton instance
let instance = null;

module.exports = {
  getInstance() {
    if (!instance) {
      instance = new CloudConnectionManager();
    }
    return instance;
  },

  async initialize(config) {
    return this.getInstance().initialize(config);
  },

  async connect() {
    return this.getInstance().connect();
  },

  disconnect() {
    return this.getInstance().disconnect();
  },

  async switchMode(mode) {
    return this.getInstance().switchMode(mode);
  },

  async setBackendUrl(url, autoConnect) {
    return this.getInstance().setBackendUrl(url, autoConnect);
  },

  getStatus() {
    return this.getInstance().getStatus();
  },

  async shutdown() {
    return this.getInstance().shutdown();
  },

  // Export constants
  OPERATION_MODES,
  CONNECTION_STATES,

  // Export class for testing
  CloudConnectionManager
};
