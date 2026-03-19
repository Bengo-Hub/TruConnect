/**
 * OutputManager - Orchestrates all output destinations
 *
 * Supports:
 * - WebSocket server (realtime mode - port 3030)
 * - REST API server (polling fallback - port 3031)
 * - Serial RDU (direct COM port display)
 * - Network RDU (USR-TCP232 serial-to-ethernet)
 *
 * BOTH WebSocket AND API servers run simultaneously to support:
 * - Real-time weight updates via WebSocket
 * - Status/health checks and fallback polling via REST API
 */

const EventBus = require('../core/EventBus');
const StateManager = require('../core/StateManager');

class OutputManager {
  constructor() {
    this.outputs = {
      websocket: null,
      api: null,
      serialRdu: null,
      networkRdu: null
    };

    this.mode = 'realtime'; // 'realtime' (WebSocket) | 'polling' (API)
    this.isRunning = false;
    this.config = {};

    // Subscribe to weight updates
    EventBus.on('input:weight', (data) => this.broadcastWeight(data));
    EventBus.on('state:gvw-updated', (data) => this.broadcastGvw(data));
  }

  /**
   * Initialize with configuration
   */
  async initialize(config = {}) {
    this.config = config;
    this.mode = config.mode || 'realtime';

    EventBus.emit('output:initialized', { mode: this.mode });
    return this;
  }

  /**
   * Start outputs - BOTH WebSocket AND API servers run simultaneously
   */
  async start() {
    if (this.isRunning) {
      console.warn('OutputManager already running');
      return;
    }

    try {
      // Start BOTH WebSocket and API servers for full compatibility
      // WebSocket (port 3030) - real-time weight updates
      await this.startWebSocket();

      // API (port 3031) - status checks, health endpoint, polling fallback
      await this.startApi();

      // Start RDU outputs if configured
      if (this.config.rdu?.enabled) {
        if (this.config.rdu.type === 'serial') {
          await this.startSerialRdu();
        } else if (this.config.rdu.type === 'network') {
          await this.startNetworkRdu();
        }
      }

      this.isRunning = true;
      EventBus.emit('output:started', { mode: this.mode, websocket: true, api: true });

    } catch (error) {
      console.error(`Failed to start outputs: ${error.message}`);
      EventBus.emit('output:error', { error: error.message });
      throw error;
    }
  }

  /**
   * Stop all outputs
   */
  async stop() {
    if (!this.isRunning) return;

    const stopPromises = [];

    for (const [name, output] of Object.entries(this.outputs)) {
      if (output) {
        stopPromises.push(
          output.stop().catch(err => console.error(`Error stopping ${name}: ${err.message}`))
        );
      }
    }

    await Promise.all(stopPromises);

    this.outputs = {
      websocket: null,
      api: null,
      serialRdu: null,
      networkRdu: null
    };

    this.isRunning = false;
    EventBus.emit('output:stopped');
  }

  /**
   * Switch output mode (legacy - both servers now run simultaneously)
   * This method is kept for backwards compatibility but has minimal effect
   * since both WebSocket and API servers are always running.
   */
  async switchMode(newMode) {
    if (newMode === this.mode) return;

    console.log(`Output mode preference changed from ${this.mode} to ${newMode}`);
    console.log('Note: Both WebSocket (3030) and API (3031) servers remain running');

    this.mode = newMode;

    // Ensure both servers are running
    if (!this.outputs.websocket) {
      await this.startWebSocket();
    }
    if (!this.outputs.api) {
      await this.startApi();
    }

    EventBus.emit('output:mode-changed', { mode: newMode });
  }

  /**
   * Start WebSocket server
   */
  async startWebSocket() {
    const WebSocketOutput = require('./WebSocketOutput');
    const wsConfig = this.config.websocket || {};

    const port = wsConfig.port || 3030; // Default port is 3030
    this.outputs.websocket = new WebSocketOutput({
      port: port,
      pingInterval: wsConfig.pingInterval || 30000,
      pingTimeout: wsConfig.pingTimeout || 5000
    });

    await this.outputs.websocket.start();
    console.log(`WebSocket server started on port ${port}`);
  }

  /**
   * Start API server
   */
  async startApi() {
    const ApiOutput = require('./ApiOutput');
    const apiConfig = this.config.api || {};

    this.outputs.api = new ApiOutput({
      port: apiConfig.port || 3031,
      host: apiConfig.host || '127.0.0.1',
      basePath: apiConfig.basePath || '/api/v1'
    });

    await this.outputs.api.start();
    console.log(`API server started on ${apiConfig.host || '127.0.0.1'}:${apiConfig.port || 3031}`);
  }

  /**
   * Start Serial RDU output
   */
  async startSerialRdu() {
    const SerialRduOutput = require('./SerialRduOutput');
    const rduConfig = this.config.rdu || {};

    this.outputs.serialRdu = new SerialRduOutput({
      port: rduConfig.port,
      baudRate: rduConfig.baudRate || 1200
    });

    await this.outputs.serialRdu.start();
    console.log(`Serial RDU started on ${rduConfig.port}`);
  }

  /**
   * Start Network RDU output (USR-TCP232)
   */
  async startNetworkRdu() {
    const NetworkRduOutput = require('./NetworkRduOutput');
    const rduConfig = this.config.rdu || {};

    this.outputs.networkRdu = new NetworkRduOutput({
      host: rduConfig.host,
      port: rduConfig.networkPort || 4196
    });

    await this.outputs.networkRdu.start();
    console.log(`Network RDU started: ${rduConfig.host}:${rduConfig.networkPort || 4196}`);
  }

  /**
   * Broadcast weight to all active outputs
   * Uses WebSocketOutput.broadcastWeight() to ensure consistent data structure
   * matching the API /weights endpoint for smooth WebSocket/API fallback
   */
  broadcastWeight(weightData) {
    // Get current mode from StateManager
    const mode = StateManager.getMode();

    // WebSocket broadcast - use enhanced broadcastWeight for consistent data structure
    if (this.outputs.websocket) {
      this.outputs.websocket.broadcastWeight(weightData, mode);
    }

    // RDU outputs (send to active RDU)
    const rdu = this.outputs.serialRdu || this.outputs.networkRdu;
    if (rdu) {
      // Send GVW for multideck or current weight for mobile.
      // Prefer correctedWeight (currentWeight) over raw parser weight for MCGS cumulative mode.
      const weightToSend = mode === 'mobile'
        ? (weightData.currentWeight ?? weightData.weight ?? 0)
        : (weightData.gvw || StateManager.getGVW() || 0);
      rdu.sendWeight(weightToSend);
    }
  }

  /**
   * Broadcast GVW update
   */
  broadcastGvw(gvwData) {
    if (this.outputs.websocket) {
      this.outputs.websocket.broadcast('gvw', gvwData);
    }

    // Send GVW to RDU
    const rdu = this.outputs.serialRdu || this.outputs.networkRdu;
    if (rdu) {
      rdu.sendWeight(gvwData.gvw);
    }
  }

  /**
   * Send message to specific client (for two-way communication)
   */
  sendToClient(clientId, event, data) {
    if (this.outputs.websocket) {
      this.outputs.websocket.sendToClient(clientId, event, data);
    }
  }

  /**
   * Get output status
   */
  getStatus() {
    return {
      running: this.isRunning,
      mode: this.mode,
      websocket: this.outputs.websocket?.getStatus() || null,
      api: this.outputs.api?.getStatus() || null,
      endpoints: {
        websocket: this.outputs.websocket ? `ws://localhost:${this.outputs.websocket.config?.port || 3030}` : null,
        api: this.outputs.api ? `http://localhost:${this.outputs.api.config?.port || 3031}/api/v1` : null
      },
      rdu: {
        serial: this.outputs.serialRdu?.getStatus() || null,
        network: this.outputs.networkRdu?.getStatus() || null
      }
    };
  }

  /**
   * Get connected clients count
   */
  getClientCount() {
    if (this.outputs.websocket) {
      return this.outputs.websocket.getClientCount();
    }
    return 0;
  }
}

// Singleton instance
let instance = null;

module.exports = {
  getInstance() {
    if (!instance) {
      instance = new OutputManager();
    }
    return instance;
  },

  initialize(config) {
    return this.getInstance().initialize(config);
  },

  start() {
    return this.getInstance().start();
  },

  stop() {
    return this.getInstance().stop();
  },

  switchMode(mode) {
    return this.getInstance().switchMode(mode);
  },

  getStatus() {
    return this.getInstance().getStatus();
  },

  OutputManager
};
