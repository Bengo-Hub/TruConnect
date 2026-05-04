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
    this.enabled = config.enabled || false;
    this.keepAliveTimer = null;

    // Message format - default format (no $ prefix, matches Zedem 510 RDU expectations)
    this.messageFormat = config.format || '={WEIGHT}=';

    // Determine format type based on model
    const model = (config.model || 'KELI').toUpperCase();
    this.useReversedFormat = REVERSED_FORMAT_MODELS.includes(model);
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

    // Keep-alive: send current weights every 500 ms so RDU panels never show "no comm"
    this.startKeepAlive(500);
  }

  /**
   * Start a periodic keep-alive that continuously sends current weights to all RDU panels.
   * Prevents RDU "no comm" when weights are stable or no vehicle is on deck.
   */
  startKeepAlive(intervalMs = 500) {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      this.sendToAllRdus(true);
    }, intervalMs);
  }

  stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
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
   * Initialize USR-TCP232 network connections — one TCP socket per panel/deck.
   * Each panel connects to its own port on the USR device (e.g. 20, 21, 22, 23, 24).
   */
  initializeUsrConnection() {
    if (!this.config.usr || !this.config.usr.ip) {
      console.warn('USR device IP not configured');
      return;
    }

    this.config.panels.forEach((panel) => {
      const conn = {
        id: `panel-${panel.deckIndex}`,
        deckIndex: panel.deckIndex,
        type: 'USR',
        active: false,
        socket: null,
        baudRate: panel.baudRate || 1200
      };

      this.setupUsrConnection(conn, panel);
      this.connections.push(conn);
    });
  }

  /**
   * Open and maintain a TCP connection for one USR panel.
   * Reconnects automatically on error or close.
   */
  setupUsrConnection(conn, panel) {
    const ip = this.config.usr.ip;
    const port = panel.usrPort;

    if (!port) {
      console.warn(`${conn.id}: no usrPort configured, skipping`);
      return;
    }

    const connect = () => {
      conn.socket = new net.Socket();

      conn.socket.connect(port, ip, () => {
        console.log(`${conn.id} connected to USR ${ip}:${port}`);
        conn.active = true;
      });

      conn.socket.on('error', err => {
        console.error(`${conn.id} USR socket error (${ip}:${port}): ${err.message}`);
        conn.active = false;
        setTimeout(connect, 5000);
      });

      conn.socket.on('close', () => {
        console.warn(`${conn.id} USR socket closed (${ip}:${port}), reconnecting...`);
        conn.active = false;
        setTimeout(connect, 5000);
      });
    };

    connect();
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
   * Update current weights.
   * Always stores the latest values so the keep-alive sends them continuously.
   * @param {number[]} newWeights - Array of weights [deck1, deck2, deck3, deck4] or with GVW
   */
  updateWeights(newWeights) {
    const weights = [...newWeights];
    while (weights.length < 4) weights.push(0);

    // Calculate GVW from deck sum if not provided
    if (weights.length === 4) {
      weights.push(weights.reduce((sum, w) => sum + w, 0));
    }

    this.currentWeights = weights;
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
   * Send message via the panel's dedicated USR TCP socket.
   */
  sendUsr(conn, message, log = false) {
    if (!conn.active || !conn.socket?.writable) return;

    conn.socket.write(message, err => {
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
        active: c.active
      }))
    };
  }

  /**
   * Shutdown all connections and stop keep-alive
   */
  shutdown() {
    this.stopKeepAlive();
    this.connections.forEach(conn => {
      if (conn.serialPort?.isOpen) {
        try {
          conn.serialPort.close();
        } catch (e) {
          console.error(`Error closing ${conn.id}:`, e.message);
        }
      }
      if (conn.socket) {
        try {
          conn.socket.destroy();
        } catch (e) {
          console.error(`Error closing USR socket for ${conn.id}:`, e.message);
        }
        conn.socket = null;
        conn.active = false;
      }
    });

    this.connections = [];
  }
}

module.exports = RDUCommunicator;
