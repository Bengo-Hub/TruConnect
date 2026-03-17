/**
 * NetworkRduOutput - Network output for RDU displays via USR-TCP232
 *
 * Sends weight data to RDU displays through USR-TCP232
 * serial-to-ethernet converters.
 *
 * USR-TCP232 Configuration:
 * - Default port: 4196
 * - Work mode: TCP Client or TCP Server
 * - Baud rate matching: Usually 1200 for RDU
 *
 * Uses same format as SerialRduOutput: $=XXXXXXXX=
 */

const { EventEmitter } = require('events');
const net = require('net');

class NetworkRduOutput extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      host: config.host || '192.168.1.100',
      port: config.port || 4196,
      reconnectInterval: config.reconnectInterval || 5000,
      timeout: config.timeout || 10000
    };

    this.socket = null;
    this.isConnected = false;
    this.lastWeight = 0;
    this.sendInterval = null;
    this.reconnectTimer = null;
    this.shouldReconnect = true;
    this.updateIntervalMs = config.updateInterval || 200;
  }

  /**
   * Start network RDU connection
   */
  async start() {
    this.shouldReconnect = true;
    return this.connect();
  }

  /**
   * Connect to USR-TCP232
   */
  async connect() {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      this.socket.setTimeout(this.config.timeout);

      this.socket.on('connect', () => {
        console.log(`Network RDU connected to ${this.config.host}:${this.config.port}`);
        this.isConnected = true;
        this.socket.setTimeout(0);
        this.startPeriodicSend();
        this.emit('connected');
        resolve();
      });

      this.socket.on('error', (error) => {
        console.error(`Network RDU error: ${error.message}`);
        this.isConnected = false;
        this.emit('error', error);
      });

      this.socket.on('close', () => {
        console.log('Network RDU connection closed');
        this.isConnected = false;
        this.stopPeriodicSend();
        this.emit('disconnected');
        this.scheduleReconnect();
      });

      this.socket.on('timeout', () => {
        console.warn('Network RDU connection timeout');
        this.socket.destroy();
        reject(new Error('Connection timeout'));
      });

      // Connect
      this.socket.connect(this.config.port, this.config.host);
    });
  }

  /**
   * Stop network RDU connection
   */
  async stop() {
    this.shouldReconnect = false;
    this.stopPeriodicSend();
    this.clearReconnect();

    return new Promise((resolve) => {
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.destroy();
        this.socket = null;
      }
      this.isConnected = false;
      resolve();
    });
  }

  /**
   * Send weight to RDU
   * @param {number} weightKg - Weight in kilograms
   */
  sendWeight(weightKg) {
    this.lastWeight = weightKg;

    if (!this.socket || !this.isConnected) {
      return;
    }

    const formatted = this.formatWeight(weightKg);

    try {
      this.socket.write(formatted);
    } catch (error) {
      console.error(`Network RDU send error: ${error.message}`);
    }
  }

  /**
   * Format weight for RDU display (same as SerialRduOutput)
   */
  formatWeight(weightKg) {
    const newtons = Math.round(Math.abs(weightKg) * 10);
    const padded = String(newtons).padStart(8, '0');
    const reversed = padded.split('').reverse().join('');
    return `$=${reversed}=`;
  }

  /**
   * Start periodic weight sending
   */
  startPeriodicSend() {
    if (this.sendInterval) return;

    this.sendInterval = setInterval(() => {
      if (this.isConnected) {
        this.sendWeight(this.lastWeight);
      }
    }, this.updateIntervalMs);
  }

  /**
   * Stop periodic weight sending
   */
  stopPeriodicSend() {
    if (this.sendInterval) {
      clearInterval(this.sendInterval);
      this.sendInterval = null;
    }
  }

  /**
   * Schedule reconnection attempt
   */
  scheduleReconnect() {
    if (!this.shouldReconnect || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      console.log(`Attempting to reconnect to RDU at ${this.config.host}:${this.config.port}...`);

      try {
        await this.connect();
      } catch (error) {
        console.error(`RDU reconnect failed: ${error.message}`);
        this.scheduleReconnect();
      }
    }, this.config.reconnectInterval);
  }

  /**
   * Clear reconnection timer
   */
  clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      host: this.config.host,
      port: this.config.port,
      connected: this.isConnected,
      lastWeight: this.lastWeight
    };
  }
}

module.exports = NetworkRduOutput;
