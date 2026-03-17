/**
 * SerialInput - Serial port input source
 *
 * Connects to COM port for direct indicator connection.
 * Uses serialport library for cross-platform support.
 */

const { EventEmitter } = require('events');

let SerialPort;
try {
  SerialPort = require('serialport').SerialPort;
} catch (e) {
  console.warn('serialport not available');
  SerialPort = null;
}

class SerialInput extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      port: config.port || '',
      baudRate: config.baudRate || 9600,
      dataBits: config.dataBits || 8,
      parity: config.parity || 'none',
      stopBits: config.stopBits || 1,
      autoOpen: false
    };

    this.serialPort = null;
    this.isConnected = false;
    this.lastDataTime = null;
    this.reconnectTimer = null;
    this.reconnectInterval = config.reconnectInterval || 5000;
  }

  /**
   * Start serial connection
   */
  async start() {
    if (!SerialPort) {
      throw new Error('serialport library not available');
    }

    if (!this.config.port) {
      throw new Error('Serial port not specified');
    }

    return new Promise((resolve, reject) => {
      try {
        this.serialPort = new SerialPort({
          path: this.config.port,
          baudRate: this.config.baudRate,
          dataBits: this.config.dataBits,
          parity: this.config.parity,
          stopBits: this.config.stopBits,
          autoOpen: false
        });

        // Event handlers
        this.serialPort.on('open', () => {
          console.log(`Serial port ${this.config.port} opened`);
          this.isConnected = true;
          this.emit('connected');
          resolve();
        });

        this.serialPort.on('data', (data) => {
          this.lastDataTime = new Date();
          this.emit('data', data);
        });

        this.serialPort.on('error', (error) => {
          console.error(`Serial error: ${error.message}`);
          this.isConnected = false;
          this.emit('error', error);
          this.scheduleReconnect();
        });

        this.serialPort.on('close', () => {
          console.log(`Serial port ${this.config.port} closed`);
          this.isConnected = false;
          this.emit('disconnected');
          this.scheduleReconnect();
        });

        // Open the port
        this.serialPort.open((err) => {
          if (err) {
            reject(new Error(`Failed to open ${this.config.port}: ${err.message}`));
          }
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop serial connection
   */
  async stop() {
    this.clearReconnect();

    return new Promise((resolve) => {
      if (this.serialPort && this.serialPort.isOpen) {
        this.serialPort.close((err) => {
          if (err) {
            console.warn(`Error closing serial port: ${err.message}`);
          }
          this.serialPort = null;
          this.isConnected = false;
          resolve();
        });
      } else {
        this.serialPort = null;
        this.isConnected = false;
        resolve();
      }
    });
  }

  /**
   * Write data to serial port
   */
  async write(data) {
    if (!this.serialPort || !this.serialPort.isOpen) {
      throw new Error('Serial port not open');
    }

    return new Promise((resolve, reject) => {
      this.serialPort.write(data, (err) => {
        if (err) {
          reject(err);
        } else {
          this.serialPort.drain(resolve);
        }
      });
    });
  }

  /**
   * Schedule reconnection attempt
   */
  scheduleReconnect() {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      console.log(`Attempting to reconnect to ${this.config.port}...`);

      try {
        await this.stop();
        await this.start();
      } catch (error) {
        console.error(`Reconnect failed: ${error.message}`);
        this.scheduleReconnect();
      }
    }, this.reconnectInterval);
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
      port: this.config.port,
      connected: this.isConnected,
      lastData: this.lastDataTime
    };
  }
}

module.exports = SerialInput;
