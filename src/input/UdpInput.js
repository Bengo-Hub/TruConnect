/**
 * UdpInput - UDP server input source
 *
 * Listens for UDP packets from portable scales (PAW).
 * Typically receives IEEE 754 float weight data.
 */

const { EventEmitter } = require('events');
const dgram = require('dgram');

class UdpInput extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      port: config.port || 13805,
      multicast: config.multicast || false,
      multicastAddress: config.multicastAddress || '224.0.0.1',
      reuseAddr: config.reuseAddr !== false
    };

    this.socket = null;
    this.isConnected = false;
    this.lastDataTime = null;
  }

  /**
   * Start UDP server
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket({
        type: 'udp4',
        reuseAddr: this.config.reuseAddr
      });

      this.socket.on('listening', () => {
        const address = this.socket.address();
        console.log(`UDP listening on ${address.address}:${address.port}`);

        // Join multicast group if configured
        if (this.config.multicast) {
          try {
            this.socket.addMembership(this.config.multicastAddress);
            console.log(`Joined multicast group ${this.config.multicastAddress}`);
          } catch (err) {
            console.warn(`Could not join multicast: ${err.message}`);
          }
        }

        this.isConnected = true;
        this.emit('connected');
        resolve();
      });

      this.socket.on('message', (msg, rinfo) => {
        this.lastDataTime = new Date();
        this.emit('data', msg, rinfo);
      });

      this.socket.on('error', (error) => {
        console.error(`UDP error: ${error.message}`);
        this.emit('error', error);
        this.isConnected = false;
        reject(error);
      });

      this.socket.on('close', () => {
        console.log('UDP socket closed');
        this.isConnected = false;
        this.emit('disconnected');
      });

      // Bind to port
      try {
        this.socket.bind(this.config.port);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop UDP server
   */
  async stop() {
    return new Promise((resolve) => {
      if (this.socket) {
        // Leave multicast group
        if (this.config.multicast) {
          try {
            this.socket.dropMembership(this.config.multicastAddress);
          } catch (e) {
            // Ignore
          }
        }

        this.socket.close(() => {
          this.socket = null;
          this.isConnected = false;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Send UDP message
   */
  async send(data, host, port) {
    if (!this.socket) {
      throw new Error('UDP socket not initialized');
    }

    return new Promise((resolve, reject) => {
      this.socket.send(data, port, host, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      port: this.config.port,
      listening: this.isConnected,
      lastData: this.lastDataTime,
      multicast: this.config.multicast
    };
  }
}

module.exports = UdpInput;
