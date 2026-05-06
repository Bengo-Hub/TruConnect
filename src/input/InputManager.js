/**
 * InputManager - Orchestrates all input sources
 *
 * Supports:
 * - Mobile scales: PAW (serial), Haenni (API)
 * - Multideck indicators: ZM, Cardinal, Cardinal2, 1310, Custom
 * - Connection types: Serial, TCP, UDP, API
 *
 * IMPORTANT: Only ONE input source can be active at a time.
 * Activating a new source automatically deactivates the current one.
 */

const EventBus = require('../core/EventBus');
const StateManager = require('../core/StateManager');
const ParserFactory = require('../parsers/ParserFactory');

// Available input source types
const INPUT_SOURCES = [
  'paw',
  'haenni',
  'mcgs',
  'indicator_zm',
  'indicator_cardinal',
  'indicator_cardinal2',
  'indicator_1310',
  'custom',
  'udp_legacy'
];

class InputManager {
  constructor() {
    this.config = {};
    this.activeSource = null;      // Currently active source name (e.g., 'paw', 'haenni')
    this.activeInput = null;       // Active input instance
    this.activeParser = null;      // Active parser instance
    this.isRunning = false;

    // Data buffer for accumulating partial messages
    this.buffer = '';

    // Query command timer for serial polling
    this.queryTimer = null;
    this.queryInterval = 500;      // Default 500ms query interval
    this.queryCommand = null;      // Command to send for weight query

    // Bind event handlers
    this._handleData = this._handleData.bind(this);
    this._handleError = this._handleError.bind(this);
  }

  /**
   * Initialize input manager with configuration
   * @param {Object} inputConfig - Full input configuration from ConfigManager
   */
  async initialize(inputConfig) {
    this.config = inputConfig || {};

    // Get active source from config
    const activeSource = this.config.activeSource || 'none';

    console.log(`InputManager initialized. Active source: ${activeSource}`);
    EventBus.emit('input:initialized', { activeSource });

    return this;
  }

  /**
   * Start the configured active input source
   */
  async start() {
    const sourceToActivate = this.config.activeSource || 'none';

    if (sourceToActivate === 'none') {
      console.log('No input source configured (activeSource = none)');
      return;
    }

    return this.activateSource(sourceToActivate);
  }

  /**
   * Activate a specific input source
   * Automatically deactivates any currently active source
   * @param {string} sourceName - Source to activate (e.g., 'paw', 'haenni', 'indicator_zm')
   */
  async activateSource(sourceName) {
    if (sourceName === 'none') {
      await this.stop();
      return;
    }

    // Validate source name
    if (!INPUT_SOURCES.includes(sourceName)) {
      throw new Error(`Unknown input source: ${sourceName}. Valid sources: ${INPUT_SOURCES.join(', ')}`);
    }

    // Get source configuration
    const sourceConfig = this.config[sourceName];
    if (!sourceConfig) {
      throw new Error(`Configuration not found for source: ${sourceName}`);
    }

    // Deactivate current source if different
    if (this.isRunning && this.activeSource !== sourceName) {
      console.log(`Deactivating current source (${this.activeSource}) before activating ${sourceName}`);
      await this.stop();
    }

    // Skip if already running this source
    if (this.isRunning && this.activeSource === sourceName) {
      console.log(`Source ${sourceName} already active`);
      return;
    }

    try {
      // Create parser based on protocol
      const protocol = sourceConfig.protocol || 'ZM';
      this.activeParser = ParserFactory.create(protocol, sourceConfig.parserConfig || {});
      console.log(`Parser created: ${protocol}`);

      // Start the appropriate input type
      const inputType = sourceConfig.type || 'serial';
      const connectionType = sourceConfig.connectionType || inputType;

      switch (inputType) {
        case 'serial':
          if (connectionType === 'tcp' && sourceConfig.tcp) {
            await this._startTcp(sourceConfig.tcp);
          } else {
            await this._startSerial(sourceConfig.serial);
          }
          break;
        case 'tcp':
          await this._startTcp(sourceConfig.tcp);
          break;
        case 'udp':
          await this._startUdp(sourceConfig.udp);
          break;
        case 'api':
          await this._startApi(sourceConfig.api);
          break;
        default:
          throw new Error(`Unknown input type: ${inputType}`);
      }

      this.activeSource = sourceName;
      this.isRunning = true;

      // Update config to reflect active source
      this.config.activeSource = sourceName;

      EventBus.emit('input:source-activated', {
        source: sourceName,
        type: inputType,
        protocol,
        connectionType
      });

      console.log(`Input source activated: ${sourceName} (${inputType}/${protocol})`);

    } catch (error) {
      console.error(`Failed to activate source ${sourceName}:`, error.message);
      EventBus.emit('input:error', {
        error: error.message,
        source: sourceName,
        type: 'activation'
      });
      throw error;
    }
  }

  /**
   * Deactivate current source and activate a new one
   * @param {string} newSource - New source to activate
   */
  async switchSource(newSource) {
    const previousSource = this.activeSource;

    console.log(`Switching input source: ${previousSource || 'none'} -> ${newSource}`);

    // This will automatically deactivate current source
    await this.activateSource(newSource);

    EventBus.emit('input:source-switched', {
      previous: previousSource,
      current: newSource
    });
  }

  /**
   * Stop current input source
   */
  async stop() {
    if (!this.isRunning) return;

    const stoppedSource = this.activeSource;

    try {
      // Stop query polling first
      this._stopQueryPolling();

      if (this.activeInput) {
        if (typeof this.activeInput.stop === 'function') {
          await this.activeInput.stop();
        } else if (typeof this.activeInput.close === 'function') {
          await this.activeInput.close();
        }
        this.activeInput = null;
      }

      this.isRunning = false;
      this.activeSource = null;
      this.activeParser = null;
      this.buffer = '';
      this.queryCommand = null;

      EventBus.emit('input:stopped', { source: stoppedSource });
      console.log(`Input source stopped: ${stoppedSource}`);

    } catch (error) {
      console.error(`Error stopping input: ${error.message}`);
    }
  }

  /**
   * Restart with new configuration
   */
  async restart(newConfig) {
    await this.stop();
    await this.initialize(newConfig);
    await this.start();
  }

  /**
   * Start serial port input
   */
  async _startSerial(serialConfig) {
    const SerialInput = require('./SerialInput');

    if (!serialConfig || !serialConfig.port) {
      throw new Error('Serial port not configured');
    }

    this.activeInput = new SerialInput({
      port: serialConfig.port,
      baudRate: serialConfig.baudRate || 9600,
      dataBits: serialConfig.dataBits || 8,
      parity: serialConfig.parity || 'none',
      stopBits: serialConfig.stopBits || 1
    });

    this.activeInput.on('data', this._handleData);
    this.activeInput.on('error', this._handleError);

    // Store query command for polling
    this.queryCommand = serialConfig.queryCommand || null;

    await this.activeInput.start();
    console.log(`Serial input started on ${serialConfig.port} @ ${serialConfig.baudRate} baud`);

    // Start query polling if query command is specified
    if (this.queryCommand) {
      this._startQueryPolling(this.queryInterval);
      console.log(`Serial query polling started (command: '${this.queryCommand}', interval: ${this.queryInterval}ms)`);
    } else {
      console.log('Serial input in continuous mode (no query command)');
    }
  }

  /**
   * Start periodic query polling for serial devices
   */
  _startQueryPolling(interval = 500) {
    this._stopQueryPolling();

    // Send initial query
    this._sendQuery();

    // Start polling timer
    this.queryTimer = setInterval(() => {
      this._sendQuery();
    }, interval);
  }

  /**
   * Stop query polling
   */
  _stopQueryPolling() {
    if (this.queryTimer) {
      clearInterval(this.queryTimer);
      this.queryTimer = null;
    }
  }

  /**
   * Convert command string with escape sequences (e.g. \\x02A\\x03) to Buffer
   */
  _commandStringToBuffer(str) {
    if (typeof str !== 'string') return str;
    // \\xHH -> byte
    const decoded = str.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
    // \\r \\n
    const withNewlines = decoded.replace(/\\r/g, '\r').replace(/\\n/g, '\n');
    return Buffer.from(withNewlines, 'utf8');
  }

  /**
   * Send query command to serial device.
   * For MCGS: if queryCommand is empty, uses serial.commands.weigh (STX 'A' ETX) when provided.
   */
  async _sendQuery() {
    if (!this.activeInput) return;

    let command = this.queryCommand;
    // MCGS: use weigh command when query command is not set (continuous stream) but client requested weight
    if (!command && this.activeSource === 'mcgs') {
      const mcgsSerial = this.config.mcgs?.serial;
      const weighCmd = mcgsSerial?.commands?.weigh;
      if (weighCmd) {
        command = weighCmd;
      }
    }
    if (!command) return;

    try {
      let toSend = command;
      if (typeof command === 'string') {
        // Single-byte escapes
        if (command === '\\x05' || command === '\x05') {
          toSend = Buffer.from([0x05]);
        } else if (command.includes('\\x')) {
          toSend = this._commandStringToBuffer(command);
        } else {
          toSend = Buffer.from(command.replace(/\\r/g, '\r').replace(/\\n/g, '\n'), 'utf8');
        }
      }
      await this.activeInput.write(toSend);
      if (this.activeSource === 'mcgs') {
        console.log('[MCGS] Weigh command sent (STX A ETX)');
      }
    } catch (error) {
      console.error(`Error sending query command: ${error.message}`);
    }
  }

  /**
   * Manually trigger a single weight query.
   * For MCGS this sends the weigh command so the console outputs current axle GVW.
   */
  async queryWeight() {
    return this._sendQuery();
  }

  /**
   * Send MCGS console command (weigh, zero, stop). No-op if source is not MCGS.
   */
  async sendMcgsCommand(type) {
    if (this.activeSource !== 'mcgs' || !this.activeInput) return false;
    const mcgsSerial = this.config.mcgs?.serial;
    const cmdKey = type === 'weigh' ? 'weigh' : type === 'zero' ? 'zero' : type === 'stop' ? 'stop' : null;
    const cmd = cmdKey && mcgsSerial?.commands?.[cmdKey];
    if (!cmd) return false;
    try {
      const toSend = typeof cmd === 'string' ? this._commandStringToBuffer(cmd) : cmd;
      await this.activeInput.write(toSend);
      console.log(`[MCGS] Command sent: ${cmdKey}`);
      return true;
    } catch (error) {
      console.error(`[MCGS] Send command ${cmdKey} failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Start TCP client input
   */
  async _startTcp(tcpConfig) {
    const TcpInput = require('./TcpInput');

    if (!tcpConfig || !tcpConfig.host) {
      throw new Error('TCP host not configured');
    }

    this.activeInput = new TcpInput({
      host: tcpConfig.host,
      port: tcpConfig.port || 4001,
      reconnectInterval: tcpConfig.reconnectInterval || 5000
    });

    this.activeInput.on('data', this._handleData);
    this.activeInput.on('error', this._handleError);

    await this.activeInput.start();
    console.log(`TCP input started: ${tcpConfig.host}:${tcpConfig.port}`);
  }

  /**
   * Start UDP server input
   */
  async _startUdp(udpConfig) {
    const UdpInput = require('./UdpInput');

    this.activeInput = new UdpInput({
      port: udpConfig?.port || 13805,
      multicast: udpConfig?.multicast || false,
      multicastAddress: udpConfig?.multicastAddress
    });

    this.activeInput.on('data', this._handleData);
    this.activeInput.on('error', this._handleError);

    await this.activeInput.start();
    console.log(`UDP input started on port ${udpConfig?.port || 13805}`);
  }

  /**
   * Start API polling input
   */
  async _startApi(apiConfig) {
    const ApiInput = require('./ApiInput');

    if (!apiConfig || !apiConfig.url) {
      throw new Error('API URL not configured');
    }

    this.activeInput = new ApiInput({
      url: apiConfig.url,
      interval: apiConfig.interval || 500,
      method: apiConfig.method || 'GET',
      headers: apiConfig.headers || {}
    });

    this.activeInput.on('data', this._handleData);
    this.activeInput.on('error', this._handleError);

    await this.activeInput.start();
    console.log(`API input started: ${apiConfig.url} (${apiConfig.interval}ms interval)`);
  }

  /**
   * Handle incoming data from any input source
   */
  _handleData(data) {
    // Emit raw data for debugging
    EventBus.emit('input:raw', {
      data: data.toString(),
      source: this.activeSource
    });

    // For binary data (UDP), parse directly
    if (Buffer.isBuffer(data) && this.activeSource === 'udp_legacy') {
      this._parseAndEmit(data);
      return;
    }

    // For text-based protocols, buffer until complete message
    const strData = data.toString();
    this.buffer += strData;

    // Get terminator from parser or config
    const terminator = this.activeParser?.getTerminator?.() || '\r\n';

    // Process complete messages (terminator-delimited, e.g. \r\n)
    let terminatorIndex;
    while ((terminatorIndex = this.buffer.indexOf(terminator)) !== -1) {
      const message = this.buffer.substring(0, terminatorIndex);
      this.buffer = this.buffer.substring(terminatorIndex + terminator.length);

      if (message.trim()) {
        this._parseAndEmit(message);
      }
    }

    // MCGS: scale may stream frames without newlines (e.g. =SG+0000060kX=SG+0000060kX)
    // Extract and parse any complete MCGS frames from the buffer
    if (this.activeSource === 'mcgs' && this.buffer.length > 0) {
      const mcgsFramePattern = /(=?SG\+?-?\d+[kK][A-Za-z]?)/g;
      let match;
      const frames = [];
      while ((match = mcgsFramePattern.exec(this.buffer)) !== null) {
        frames.push(match[1]);
      }
      if (frames.length > 0) {
        // Remove the matched frames from buffer (keep any trailing partial data)
        const lastMatch = frames[frames.length - 1];
        const lastIndex = this.buffer.lastIndexOf(lastMatch);
        this.buffer = this.buffer.substring(lastIndex + lastMatch.length);

        for (const frame of frames) {
          if (frame.trim()) {
            this._parseAndEmit(frame);
          }
        }
      }
    }

    // Prevent buffer overflow
    if (this.buffer.length > 10000) {
      console.warn('Input buffer overflow, clearing');
      this.buffer = '';
    }
  }

  /**
   * Parse data and emit weight event
   */
  _parseAndEmit(data) {
    if (!this.activeParser) {
      console.warn('No parser configured');
      return;
    }

    try {
      const result = this.activeParser.parse(data);

      if (result) {
        // Handle array of results (multi-deck)
        const results = Array.isArray(result) ? result : [result];

        // Determine mode from active source - mobile sources (PAW, Haenni, MCGS) don't use deck weights
        const isMobileSource = ['paw', 'haenni', 'mcgs'].includes(this.activeSource);
        const captureMode = StateManager.getMode();

        if (isMobileSource || captureMode === 'mobile') {
          // Mobile mode: process each weight result individually (axle-by-axle)
          for (const weightData of results) {
            StateManager.setCurrentMobileWeight(weightData.weight, weightData.stable !== false);
            const correctedWeight = StateManager.getCurrentMobileWeight();

            console.log(`[Mobile Weight] Raw: ${weightData.weight}kg, Corrected: ${correctedWeight}kg, Stable: ${weightData.stable !== false}`);

            EventBus.emit('input:weight', {
              ...weightData,
              source: this.activeSource,
              protocol: this.config[this.activeSource]?.protocol,
              isMobile: true,
              currentWeight: correctedWeight
            });
          }
        } else {
          // Multideck mode: apply ALL deck weights to StateManager atomically first,
          // then emit ONE event. This prevents broadcastWeights from firing with
          // partial/intermediate state (e.g. deck3 updated but deck4 still old),
          // which causes RDU flickering and stale weight display.
          for (const weightData of results) {
            if (weightData.deck > 0) {
              StateManager.setDeckWeight(weightData.deck, weightData.weight);
            }
          }
          // Single emit — state is now consistent across all decks
          const representative = results[results.length - 1];
          EventBus.emit('input:weight', {
            ...representative,
            source: this.activeSource,
            protocol: this.config[this.activeSource]?.protocol,
            isMobile: false
          });
        }
      }
    } catch (error) {
      console.error(`Parse error: ${error.message}`);
      EventBus.emit('input:parse-error', {
        error: error.message,
        data: data.toString(),
        source: this.activeSource
      });
    }
  }

  /**
   * Handle input errors
   */
  _handleError(error) {
    console.error(`Input error (${this.activeSource}): ${error.message}`);
    EventBus.emit('input:error', {
      error: error.message,
      source: this.activeSource
    });
  }

  /**
   * Get current input status
   */
  getStatus() {
    const sourceConfig = this.activeSource ? this.config[this.activeSource] : null;

    return {
      running: this.isRunning,
      activeSource: this.activeSource,
      type: sourceConfig?.type || null,
      protocol: sourceConfig?.protocol || null,
      connectionType: sourceConfig?.connectionType || sourceConfig?.type || null,
      connected: this.activeInput?.isConnected || false,
      lastData: this.activeInput?.lastDataTime || null
    };
  }

  /**
   * Get available input sources with their configurations
   */
  getAvailableSources() {
    const sources = {};

    for (const sourceName of INPUT_SOURCES) {
      const config = this.config[sourceName];
      if (config) {
        sources[sourceName] = {
          enabled: config.enabled || false,
          type: config.type,
          protocol: config.protocol,
          isActive: this.activeSource === sourceName
        };
      }
    }

    return sources;
  }

  /**
   * Enable a source (mark as available, doesn't activate)
   */
  enableSource(sourceName) {
    if (this.config[sourceName]) {
      this.config[sourceName].enabled = true;
      EventBus.emit('input:source-enabled', { source: sourceName });
    }
  }

  /**
   * Disable a source (stops if active)
   */
  async disableSource(sourceName) {
    if (this.config[sourceName]) {
      this.config[sourceName].enabled = false;

      // Stop if this was the active source
      if (this.activeSource === sourceName) {
        await this.stop();
      }

      EventBus.emit('input:source-disabled', { source: sourceName });
    }
  }

  /**
   * Get available serial ports
   */
  async getAvailablePorts() {
    try {
      const { SerialPort } = require('serialport');
      return await SerialPort.list();
    } catch (error) {
      console.error('Could not list serial ports:', error.message);
      return [];
    }
  }

  /**
   * Update configuration for a specific source
   */
  updateSourceConfig(sourceName, updates) {
    if (this.config[sourceName]) {
      this.config[sourceName] = { ...this.config[sourceName], ...updates };
      EventBus.emit('input:source-config-updated', { source: sourceName, updates });

      // If this is the active source, may need to restart
      if (this.activeSource === sourceName && this.isRunning) {
        console.log(`Active source ${sourceName} config updated - restart may be needed`);
      }
    }
  }
}

// Singleton instance
let instance = null;

module.exports = {
  getInstance() {
    if (!instance) {
      instance = new InputManager();
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

  activateSource(sourceName) {
    return this.getInstance().activateSource(sourceName);
  },

  switchSource(newSource) {
    return this.getInstance().switchSource(newSource);
  },

  getStatus() {
    return this.getInstance().getStatus();
  },

  getAvailableSources() {
    return this.getInstance().getAvailableSources();
  },

  getAvailablePorts() {
    return this.getInstance().getAvailablePorts();
  },

  queryWeight() {
    return this.getInstance().queryWeight();
  },

  sendMcgsCommand(type) {
    return this.getInstance().sendMcgsCommand(type);
  },

  // Export class for testing
  InputManager,

  // Export available sources
  INPUT_SOURCES
};
