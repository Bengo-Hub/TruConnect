const { SerialPort } = require('serialport');
const net = require('net');

/**
 * RDUCommunicator - Remote Display Unit Communication
 *
 * Supports:
 * - Single RDU device with multiple panels (1-5)
 * - Serial (COM port) and USR-TCP232 network connections
 * - Model-specific message formats (KELI, Yaohua, XK3190, Cardinal, etc.)
 * - Configurable panels for Deck 1-4 and GVW
 *
 * Format Types:
 * - 'reversed': KELI/Yaohua/XK3190 - digits reversed, trailing zeros (200 → 00200000)
 * - 'leading': Cardinal/Avery/Generic - leading zeros only (200 → 00000200)
 */

// Models that use reversed digit format
const REVERSED_FORMAT_MODELS = ['KELI', 'YAOHUA', 'YAOHUA_YHL', 'XK3190'];

class RDUCommunicator {
  constructor(config = {}) {
    this.config = config;
    this.connections = [];
    this.currentWeights = [0, 0, 0, 0, 0]; // deck1, deck2, deck3, deck4, gvw
    this.WEIGHT_THRESHOLD = 10;
    this.enabled = config.enabled || false;

    // Message format - default KELI format
    this.messageFormat = config.format || '$={WEIGHT}=';

    // Determine format type based on model
    const model = (config.model || 'KELI').toUpperCase();
    this.useReversedFormat = REVERSED_FORMAT_MODELS.includes(model);

    // USR device connection (for network mode)
    this.usrClient = null;
    this.usrConnected = false;
  }

  /**
   * Format weight value for RDU display
   * @param {number} weight - Weight in kg
   * @returns {string} - Formatted message for RDU
   *
   * Two format types supported:
   * 1. KELI/Yaohua/XK3190 (reversed): 200 → "002" reversed → "00200000" trailing zeros
   *    With format "$={WEIGHT}=" → "$=00200000="
   *
   * 2. Cardinal/Avery/Generic (leading): 200 → "00000200" leading zeros
   *    With format "{WEIGHT}" → "00000200"
   */
  formatMessage(weight) {
    const str = Math.abs(Math.round(weight)).toString();
    let padded;

    if (this.useReversedFormat) {
      // KELI/Yaohua format: reverse digits and pad with trailing zeros
      const reversed = str.split('').reverse().join('');
      padded = reversed.padEnd(8, '0');
    } else {
      // Generic format: pad with leading zeros
      padded = str.padStart(8, '0');
    }

    // Replace {WEIGHT} placeholder in format string
    return this.messageFormat.replace('{WEIGHT}', padded);
  }

  /**
   * Initialize connections based on config
   */
  initializeConnections() {
    if (!this.enabled || !this.config.panels || this.config.panels.length === 0) {
      console.log('RDU disabled or no panels configured');
      return;
    }

    console.log(`Initializing RDU (${this.config.model || 'GENERIC'}) with ${this.config.panels.length} panels`);

    if (this.config.connectionType === 'serial') {
      this.initializeSerialConnections();
    } else if (this.config.connectionType === 'usr') {
      this.initializeUsrConnection();
    }
  }

  /**
   * Initialize direct serial port connections for each panel
   */
  initializeSerialConnections() {
    this.config.panels.forEach((panel, index) => {
      if (!panel.port || panel.port === 'COM0') {
        console.warn(`Panel ${index} has no valid COM port configured`);
        return;
      }

      const conn = {
        id: `panel-${panel.deckIndex}`,
        deckIndex: panel.deckIndex,
        type: 'SERIAL',
        active: false,
        serialPort: null,
        baudRate: panel.baudRate || 1200
      };

      this.setupSerialConnection(conn, panel);
      this.connections.push(conn);
    });
  }

  /**
   * Initialize USR-TCP232 network connection
   * All panels share the same USR device
   */
  initializeUsrConnection() {
    if (!this.config.usr || !this.config.usr.ip) {
      console.warn('USR device IP not configured');
      return;
    }

    const connectUsr = () => {
      this.usrClient = new net.Socket();

      this.usrClient.connect(this.config.usr.port || 4196, this.config.usr.ip, () => {
        console.log(`USR device connected: ${this.config.usr.ip}:${this.config.usr.port}`);
        this.usrConnected = true;
      });

      this.usrClient.on('error', err => {
        console.error('USR connection error:', err.message);
        this.usrConnected = false;
        setTimeout(connectUsr, 5000);
      });

      this.usrClient.on('close', () => {
        console.warn('USR connection closed');
        this.usrConnected = false;
        setTimeout(connectUsr, 5000);
      });
    };

    connectUsr();

    // Create virtual connections for each panel (channel-based)
    this.config.panels.forEach((panel, index) => {
      this.connections.push({
        id: `panel-${panel.deckIndex}`,
        deckIndex: panel.deckIndex,
        type: 'USR',
        channel: panel.channel || index,
        active: true, // Depends on USR connection
        baudRate: panel.baudRate || 1200
      });
    });
  }

  /**
   * Setup serial port connection for a panel
   */
  setupSerialConnection(conn, panel) {
    const openSerial = () => {
      try {
        conn.serialPort = new SerialPort({
          path: panel.port,
          baudRate: panel.baudRate || 1200,
          autoOpen: false
        });

        conn.serialPort.open(err => {
          if (err) {
            console.error(`${conn.id} serial open error:`, err.message);
            setTimeout(openSerial, 5000);
            return;
          }
          console.log(`${conn.id} connected via Serial (${panel.port} @ ${panel.baudRate})`);
          conn.active = true;
        });

        conn.serialPort.on('error', err => {
          console.error(`${conn.id} serial error:`, err.message);
          conn.active = false;
        });

        conn.serialPort.on('close', () => {
          console.warn(`${conn.id} serial closed`);
          conn.active = false;
          setTimeout(openSerial, 5000);
        });
      } catch (err) {
        console.error(`Failed to create serial port for ${conn.id}:`, err.message);
        setTimeout(openSerial, 5000);
      }
    };

    openSerial();
  }

  /**
   * Update current weights
   * @param {number[]} newWeights - Array of weights [deck1, deck2, deck3, deck4] or with GVW
   * @returns {boolean} - True if weights changed significantly
   */
  updateWeights(newWeights) {
    // Ensure we have 5 values (deck1-4 + GVW)
    const weights = [...newWeights];
    while (weights.length < 4) weights.push(0);

    // Calculate GVW if not provided
    if (weights.length === 4) {
      weights.push(weights.reduce((sum, w) => sum + w, 0));
    }

    if (this.hasSignificantChange(weights)) {
      this.currentWeights = weights;
      return true;
    }
    return false;
  }

  /**
   * Check if weights changed significantly
   */
  hasSignificantChange(newWeights) {
    return newWeights.some((w, i) =>
      Math.abs(w - (this.currentWeights[i] || 0)) > this.WEIGHT_THRESHOLD
    );
  }

  /**
   * Send weights to all configured RDU panels
   * @param {boolean} force - Force send even if no significant change
   * @returns {Object} - Weight data sent
   */
  sendToAllRdus(force = false) {
    if (!this.enabled) {
      return this.getWeightData();
    }

    this.connections.forEach(conn => {
      // Get weight for this panel's deck index
      const weight = this.currentWeights[conn.deckIndex] || 0;
      const message = weight > 10 ? this.formatMessage(weight) : this.formatMessage(0);

      if (conn.type === 'SERIAL') {
        this.sendSerial(conn, message, force);
      } else if (conn.type === 'USR') {
        this.sendUsr(conn, message, force);
      }
    });

    return this.getWeightData();
  }

  /**
   * Send message via serial port
   */
  sendSerial(conn, message, log = false) {
    if (!conn.active || !conn.serialPort?.isOpen) return;

    conn.serialPort.write(message, err => {
      if (err) {
        console.error(`${conn.id} serial send error:`, err.message);
      } else if (log) {
        console.log(`[${conn.id}] Serial sent: ${message}`);
      }
    });
  }

  /**
   * Send message via USR device
   * USR-TCP232 typically routes data to connected serial ports based on config
   */
  sendUsr(conn, message, log = false) {
    if (!this.usrConnected || !this.usrClient?.writable) return;

    // For USR devices, we might need to prefix with channel info
    // This depends on the specific USR model configuration
    this.usrClient.write(message, err => {
      if (err) {
        console.error(`${conn.id} USR send error:`, err.message);
      } else if (log) {
        console.log(`[${conn.id}] USR sent: ${message}`);
      }
    });
  }

  /**
   * Get current weight data for UI
   */
  getWeightData() {
    return {
      deck1: this.currentWeights[0] || 0,
      deck2: this.currentWeights[1] || 0,
      deck3: this.currentWeights[2] || 0,
      deck4: this.currentWeights[3] || 0,
      gvw: this.currentWeights[4] || 0,
      connected: this.connections.map(c => c.active)
    };
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      enabled: this.enabled,
      model: this.config.model,
      connectionType: this.config.connectionType,
      panels: this.connections.map(c => ({
        id: c.id,
        deckIndex: c.deckIndex,
        type: c.type,
        active: c.type === 'USR' ? this.usrConnected : c.active
      }))
    };
  }

  /**
   * Shutdown all connections
   */
  shutdown() {
    this.connections.forEach(conn => {
      if (conn.serialPort?.isOpen) {
        try {
          conn.serialPort.close();
        } catch (e) {
          console.error(`Error closing ${conn.id}:`, e.message);
        }
      }
    });

    if (this.usrClient) {
      try {
        this.usrClient.end();
        this.usrClient.destroy();
      } catch (e) {
        console.error('Error closing USR connection:', e.message);
      }
    }

    this.connections = [];
    this.usrClient = null;
    this.usrConnected = false;
  }
}

module.exports = RDUCommunicator;
