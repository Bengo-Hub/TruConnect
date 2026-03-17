/**
 * TcpInput - TCP client input source
 *
 * Connects to network-enabled indicators via TCP.
 * Supports USR-TCP232 serial-to-ethernet converters.
 */

const { EventEmitter } = require('events');
const net = require('net');

class TcpInput extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      host: config.host || '192.168.1.100',
      port: config.port || 4001,
      reconnectInterval: config.reconnectInterval || 5000,
      timeout: config.timeout || 30000
    };

    this.socket = null;
    this.isConnected = false;
    this.lastDataTime = null;
    this.reconnectTimer = null;
    this.shouldReconnect = true;
  }

  /**
   * Start TCP connection
   */
  async start() {
    this.shouldReconnect = true;

    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();

      // Connection timeout
      this.socket.setTimeout(this.config.timeout);

      this.socket.on('connect', () => {
        console.log(`TCP connected to ${this.config.host}:${this.config.port}`);
        this.isConnected = true;
        this.socket.setTimeout(0); // Disable timeout after connection
        this.emit('connected');
        resolve();
      });

      this.socket.on('data', (data) => {
        this.lastDataTime = new Date();
        this.emit('data', data);
      });

      this.socket.on('error', (error) => {
        console.error(`TCP error: ${error.message}`);
        this.isConnected = false;
        this.emit('error', error);
      });

      this.socket.on('close', () => {
        console.log('TCP connection closed');
        this.isConnected = false;
        this.emit('disconnected');
        this.scheduleReconnect();
      });

      this.socket.on('timeout', () => {
        console.warn('TCP connection timeout');
        this.socket.destroy();
        reject(new Error('Connection timeout'));
      });

      // Connect
      this.socket.connect(this.config.port, this.config.host);
    });
  }

  /**
   * Stop TCP connection
   */
  async stop() {
    this.shouldReconnect = false;
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
   * Write data to TCP socket
   */
  async write(data) {
    if (!this.socket || !this.isConnected) {
      throw new Error('TCP not connected');
    }

    return new Promise((resolve, reject) => {
      this.socket.write(data, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Schedule reconnection attempt
   */
  scheduleReconnect() {
    if (!this.shouldReconnect || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      console.log(`Attempting to reconnect to ${this.config.host}:${this.config.port}...`);

      try {
        await this.start();
      } catch (error) {
        console.error(`Reconnect failed: ${error.message}`);
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
      lastData: this.lastDataTime
    };
  }
}

module.exports = TcpInput;
