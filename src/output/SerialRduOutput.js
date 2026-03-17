/**
 * SerialRduOutput - Serial port output for RDU displays
 *
 * Sends weight data to remote display units (RDU) via COM port.
 *
 * Format: $=XXXXXXXX=
 * - $= : Start marker
 * - XXXXXXXX : 8-digit weight in Newtons (reversed, zero-padded)
 * - = : End marker
 *
 * Example: Weight 5200 kg
 *   Step 1: 5200 * 10 = 52000 (convert to Newtons)
 *   Step 2: Pad to 8 digits: "00052000"
 *   Step 3: Reverse: "00025000"
 *   Step 4: Format: "$=00025000="
 *
 * Typical settings: 1200 baud, 8N1
 */

const { EventEmitter } = require('events');

let SerialPort;
try {
  SerialPort = require('serialport').SerialPort;
} catch (e) {
  console.warn('serialport not available for RDU');
  SerialPort = null;
}

class SerialRduOutput extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      port: config.port || '',
      baudRate: config.baudRate || 1200,
      dataBits: 8,
      parity: 'none',
      stopBits: 1
    };

    this.serialPort = null;
    this.isConnected = false;
    this.lastWeight = 0;
    this.sendInterval = null;
    this.updateIntervalMs = config.updateInterval || 200; // 5 Hz update rate
  }

  /**
   * Start RDU output
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

        this.serialPort.on('open', () => {
          console.log(`RDU serial port ${this.config.port} opened`);
          this.isConnected = true;
          this.startPeriodicSend();
          resolve();
        });

        this.serialPort.on('error', (error) => {
          console.error(`RDU serial error: ${error.message}`);
          this.isConnected = false;
          this.emit('error', error);
        });

        this.serialPort.on('close', () => {
          console.log(`RDU serial port ${this.config.port} closed`);
          this.isConnected = false;
        });

        this.serialPort.open((err) => {
          if (err) {
            reject(new Error(`Failed to open RDU port ${this.config.port}: ${err.message}`));
          }
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop RDU output
   */
  async stop() {
    this.stopPeriodicSend();

    return new Promise((resolve) => {
      if (this.serialPort && this.serialPort.isOpen) {
        this.serialPort.close((err) => {
          if (err) {
            console.warn(`Error closing RDU port: ${err.message}`);
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
   * Send weight to RDU
   * @param {number} weightKg - Weight in kilograms
   */
  sendWeight(weightKg) {
    this.lastWeight = weightKg;

    if (!this.serialPort || !this.serialPort.isOpen) {
      return;
    }

    const formatted = this.formatWeight(weightKg);

    try {
      this.serialPort.write(formatted, (err) => {
        if (err) {
          console.error(`RDU write error: ${err.message}`);
        }
      });
    } catch (error) {
      console.error(`RDU send error: ${error.message}`);
    }
  }

  /**
   * Format weight for RDU display
   *
   * @param {number} weightKg - Weight in kilograms
   * @returns {string} Formatted RDU string
   */
  formatWeight(weightKg) {
    // Convert kg to Newtons (multiply by 10 based on iConnect convention)
    const newtons = Math.round(Math.abs(weightKg) * 10);

    // Pad to 8 digits
    const padded = String(newtons).padStart(8, '0');

    // Reverse the string
    const reversed = padded.split('').reverse().join('');

    // Format as $=XXXXXXXX=
    return `$=${reversed}=`;
  }

  /**
   * Start periodic weight sending
   * RDU displays typically expect continuous updates
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
   * Get connection status
   */
  getStatus() {
    return {
      port: this.config.port,
      baudRate: this.config.baudRate,
      connected: this.isConnected,
      lastWeight: this.lastWeight
    };
  }
}

module.exports = SerialRduOutput;
