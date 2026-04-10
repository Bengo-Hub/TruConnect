/**
 * StateManager - Centralized application state management
 * Handles weights, vehicle detection, station/bound configuration
 */

const EventBus = require('./EventBus');

class StateManager {
  static instance = null;

  constructor() {
    this.eventBus = EventBus.getInstance();

    // Weight state
    this.weights = {
      deck1: 0,
      deck2: 0,
      deck3: 0,
      deck4: 0,
      gvw: 0
    };

    // Weight stability tracking
    this.lastWeights = { ...this.weights };
    this.weightThreshold = 10; // kg - for change detection
    this.vehicleThreshold = 50; // kg - for vehicle detection

    // Vehicle state
    this.vehicleOnDeck = false;

    // Station configuration (synced from TruLoad frontend/backend)
    this.station = {
      id: null,               // Station GUID from backend
      code: null,             // Primary station code
      name: null,             // Station name
      stationType: null,      // weigh_bridge, mobile_unit, yard
      supportsBidirectional: false,
      boundACode: 'A',        // Virtual code for Bound A
      boundBCode: 'B',        // Virtual code for Bound B
      organizationId: null,
      organizationName: null,
      location: null,
      latitude: null,
      longitude: null
    };
    // Active bound selection
    this.currentBound = 'A';

    // Scale connection status (for mobile weighing with paired scales)
    this.scaleConnections = {
      scaleA: {
        connected: false,
        weight: 0,
        battery: 100,
        temperature: 25,
        signalStrength: 100,
        lastUpdate: null,
        make: null,
        model: null,
        serialNumber: null
      },
      scaleB: {
        connected: false,
        weight: 0,
        battery: 100,
        temperature: 25,
        signalStrength: 100,
        lastUpdate: null,
        make: null,
        model: null,
        serialNumber: null
      }
    };

    // Current plate (from TruLoad client)
    this.currentPlate = null;
    this.plateSource = null;
    this.plateTimestamp = null;

    // Connection states
    this.simulation = false;
    this.connections = {
      indicators: [],
      rdus: [],
      clients: []
    };

    // Input source metadata
    this.inputSource = {
      name: null,           // e.g., 'paw', 'haenni', 'indicator_zm'
      protocol: null,       // e.g., 'PAW', 'ZM', 'Cardinal'
      connectionType: null, // e.g., 'serial', 'tcp', 'udp', 'api'
      connected: false
    };

    // Mobile scale metadata (for PAW, Haenni, etc.)
    this.mobileScaleInfo = {
      battery: 100,         // Battery percentage (default 100%)
      temperature: 25,      // Temperature in Celsius (default 25°C)
      signalStrength: 100,  // Signal strength percentage
      serialNumber: null,
      firmwareVersion: null,
      make: null,           // Scale manufacturer (e.g., 'Intercomp', 'PAW')
      model: null           // Scale model (e.g., 'LP600', 'WL103')
    };

    // Indicator metadata (for multideck mode - ZM, Cardinal, etc.)
    this.indicatorInfo = {
      make: null,           // Indicator manufacturer (e.g., 'Zedem', 'Avery')
      model: null,          // Indicator model (e.g., 'ZM-400', 'E1205')
      serialNumber: null,
      firmwareVersion: null,
      signalStrength: 100   // Connection quality percentage
    };

    // Mode
    this.mode = 'multideck'; // 'multideck' | 'mobile'

    // Mobile mode current weight (live reading from scale)
    this.currentMobileWeight = 0;
    this.mobileWeightStable = true;

    // Cumulative weight tracking for MCGS scales
    // Instead of relying on sum of captured axle weights (which can drift if captures are missed),
    // we track the raw MCGS cumulative reading at the moment of each axle capture.
    // This provides a robust baseline for subtraction regardless of missed WS notifications.
    this.lastRawCumulativeWeight = 0;    // Latest raw reading from MCGS (updated every frame)
    this.cumulativeBaseOffset = 0;       // Raw cumulative reading at last axle capture point

    // Mobile mode state
    this.mobileState = {
      currentAxle: 0,
      totalAxles: 0,
      axles: []
    };

    // Axle configuration from frontend (expected axles to capture)
    this.axleConfig = {
      expectedAxles: 0,            // Total axles expected (from axle configuration)
      axleConfigurationId: null,   // ID of the axle configuration
      axleConfigurationCode: null, // Code like "2+3" (2 front, 3 rear)
      vehicleId: null,             // Vehicle ID from frontend
      plateNumber: null            // Plate number for this session
    };

    // Transaction sync state (from TruLoad frontend via WebSocket)
    this.transactionSync = {
      transactionId: null,         // Backend transaction ID (links autoweigh to frontend txn)
      vehicleRegNumber: null,      // Vehicle registration
      axleConfigCode: null,        // Axle configuration code (e.g., "2A", "6C")
      totalAxles: 0,               // Expected number of axles
      stationId: null,             // Station GUID
      bound: null,                 // Direction A/B
      weighingMode: null,          // 'mobile' or 'multideck'
      syncedAt: null               // When the sync was received
    };

    // Auto-detection state for next axle
    this.autoDetection = {
      enabled: false,              // Whether auto-detection is enabled
      state: 'idle',               // 'idle' | 'waiting_zero' | 'waiting_stable'
      lastWeight: 0,               // Last weight reading
      zeroThreshold: 50,           // Weight below this is considered "off scale"
      stableThreshold: 100,        // Minimum weight for valid reading
      stabilityCount: 0,           // Count of stable readings
      requiredStableReadings: 3    // Required stable readings before capture ready
    };
  }

  /**
   * Get singleton instance
   */
  static getInstance() {
    if (!StateManager.instance) {
      StateManager.instance = new StateManager();
    }
    return StateManager.instance;
  }

  /**
   * Update weights with change detection
   * @param {Object} newWeights - { deck1, deck2, deck3, deck4, gvw? }
   * @returns {boolean} - True if weights changed significantly
   */
  updateWeights(newWeights) {
    const hasChange = this.hasSignificantChange(newWeights);

    // Update current weights
    this.weights.deck1 = newWeights.deck1 ?? this.weights.deck1;
    this.weights.deck2 = newWeights.deck2 ?? this.weights.deck2;
    this.weights.deck3 = newWeights.deck3 ?? this.weights.deck3;
    this.weights.deck4 = newWeights.deck4 ?? this.weights.deck4;

    // Calculate GVW if not provided
    if (newWeights.gvw !== undefined) {
      this.weights.gvw = newWeights.gvw;
    } else {
      this.weights.gvw = this.weights.deck1 + this.weights.deck2 +
                         this.weights.deck3 + this.weights.deck4;
    }

    // Detect vehicle presence
    const wasOnDeck = this.vehicleOnDeck;
    this.vehicleOnDeck = this.weights.gvw > this.vehicleThreshold;

    // Emit events
    if (hasChange) {
      this.eventBus.emitEvent(EventBus.EVENTS.WEIGHTS_UPDATED, this.getWeightData());
    }

    if (this.vehicleOnDeck !== wasOnDeck) {
      if (this.vehicleOnDeck) {
        this.eventBus.emitEvent(EventBus.EVENTS.VEHICLE_DETECTED, this.getWeightData());
      } else {
        this.eventBus.emitEvent(EventBus.EVENTS.VEHICLE_DEPARTED, this.getWeightData());
      }
    }

    // Update last weights
    this.lastWeights = { ...this.weights };

    return hasChange;
  }

  /**
   * Check if weights changed significantly
   */
  hasSignificantChange(newWeights) {
    const d1 = Math.abs((newWeights.deck1 ?? this.weights.deck1) - this.lastWeights.deck1);
    const d2 = Math.abs((newWeights.deck2 ?? this.weights.deck2) - this.lastWeights.deck2);
    const d3 = Math.abs((newWeights.deck3 ?? this.weights.deck3) - this.lastWeights.deck3);
    const d4 = Math.abs((newWeights.deck4 ?? this.weights.deck4) - this.lastWeights.deck4);

    return d1 >= this.weightThreshold ||
           d2 >= this.weightThreshold ||
           d3 >= this.weightThreshold ||
           d4 >= this.weightThreshold;
  }

  /**
   * Get current weight data for output
   */
  getWeightData() {
    return {
      mode: this.mode,
      stationCode: this.getFullStationCode(),
      bound: this.currentBound,
      decks: [
        { index: 1, weight: this.weights.deck1, stable: true },
        { index: 2, weight: this.weights.deck2, stable: true },
        { index: 3, weight: this.weights.deck3, stable: true },
        { index: 4, weight: this.weights.deck4, stable: true }
      ],
      gvw: this.weights.gvw,
      status: 'stable',
      vehicleOnDeck: this.vehicleOnDeck,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get full station code including bound
   */
  getFullStationCode() {
    if (!this.station.code) return null;
    if (!this.station.supportsBidirectional) return this.station.code;
    return `${this.station.code}${this.currentBound}`;
  }

  /**
   * Set station configuration (from TruLoad frontend)
   * @param {Object} config - Station configuration from backend
   */
  setStationConfig(config) {
    this.station = {
      id: config.id || config.stationId || null,
      code: config.code || null,
      name: config.name || null,
      stationType: config.stationType || null,
      supportsBidirectional: config.supportsBidirectional ?? false,
      boundACode: config.boundACode || 'A',
      boundBCode: config.boundBCode || 'B',
      organizationId: config.organizationId || null,
      organizationName: config.organizationName || null,
      location: config.location || null,
      latitude: config.latitude || null,
      longitude: config.longitude || null
    };

    this.currentBound = config.currentBound || this.station.boundACode || 'A';

    console.log(`[StateManager] Station config updated: ${this.station.name} (${this.station.code}), Bidirectional: ${this.station.supportsBidirectional}`);

    this.eventBus.emitEvent('station:updated', this.getStationConfig());

    return this.getStationConfig();
  }

  /**
   * Get current station configuration
   */
  getStationConfig() {
    return {
      ...this.station,
      currentBound: this.currentBound
    };
  }

  // ============ Scale Connection Methods ============

  /**
   * Update scale connection status
   * @param {string} scaleId - 'scaleA' or 'scaleB'
   * @param {Object} status - { connected, weight, battery, temperature, signalStrength, make, model, serialNumber }
   */
  updateScaleStatus(scaleId, status) {
    if (!this.scaleConnections[scaleId]) {
      console.warn(`[StateManager] Unknown scale: ${scaleId}`);
      return;
    }

    const scale = this.scaleConnections[scaleId];
    if (status.connected !== undefined) scale.connected = status.connected;
    if (status.weight !== undefined) scale.weight = status.weight;
    if (status.battery !== undefined) scale.battery = status.battery;
    if (status.temperature !== undefined) scale.temperature = status.temperature;
    if (status.signalStrength !== undefined) scale.signalStrength = status.signalStrength;
    if (status.make !== undefined) scale.make = status.make;
    if (status.model !== undefined) scale.model = status.model;
    if (status.serialNumber !== undefined) scale.serialNumber = status.serialNumber;
    scale.lastUpdate = new Date().toISOString();

    this.eventBus.emitEvent('scale:status-updated', {
      scaleId,
      status: scale,
      allScales: this.getScaleStatus()
    });

    return scale;
  }

  /**
   * Get scale connection status
   * @param {string} [scaleId] - Optional: 'scaleA' or 'scaleB'. If omitted, returns all.
   */
  getScaleStatus(scaleId) {
    if (scaleId) {
      return { ...this.scaleConnections[scaleId] };
    }
    return {
      scaleA: { ...this.scaleConnections.scaleA },
      scaleB: { ...this.scaleConnections.scaleB },
      anyConnected: this.scaleConnections.scaleA.connected || this.scaleConnections.scaleB.connected,
      allConnected: this.scaleConnections.scaleA.connected && this.scaleConnections.scaleB.connected,
      mode: this.mode,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Check if at least one scale is connected
   */
  hasScaleConnection() {
    return this.scaleConnections.scaleA.connected || this.scaleConnections.scaleB.connected;
  }

  /**
   * Switch bound (for bidirectional stations)
   */
  switchBound(newBound, newStationCode) {
    const oldBound = this.currentBound;
    this.currentBound = newBound;

    if (newStationCode) {
      this.station.code = newStationCode.replace(/[AB]$/, '');
    }

    this.eventBus.emitEvent(EventBus.EVENTS.BOUND_CHANGED, {
      oldBound,
      newBound,
      stationCode: this.getFullStationCode()
    });
  }

  /**
   * Set vehicle plate (from TruLoad)
   */
  setPlate(plate, source) {
    this.currentPlate = plate;
    this.plateSource = source;
    this.plateTimestamp = new Date().toISOString();

    this.eventBus.emitEvent(EventBus.EVENTS.PLATE_RECEIVED, {
      plate,
      source,
      timestamp: this.plateTimestamp
    });
  }

  /**
   * Get current plate
   */
  getCurrentPlate() {
    return {
      plate: this.currentPlate,
      source: this.plateSource,
      timestamp: this.plateTimestamp
    };
  }

  /**
   * Clear plate (after weighing complete)
   */
  clearPlate() {
    this.currentPlate = null;
    this.plateSource = null;
    this.plateTimestamp = null;
  }

  /**
   * Set simulation mode
   */
  setSimulation(enabled) {
    this.simulation = enabled;
    this.eventBus.emitEvent(EventBus.EVENTS.SIMULATION_STATE, { enabled });
  }

  /**
   * Update connection status
   */
  updateConnectionStatus(type, id, connected) {
    const list = this.connections[type + 's'];
    if (!list) return;

    const existing = list.find(c => c.id === id);
    if (existing) {
      existing.connected = connected;
      existing.lastSeen = new Date().toISOString();
    } else {
      list.push({ id, connected, lastSeen: new Date().toISOString() });
    }

    this.eventBus.emitEvent(EventBus.EVENTS.CONNECTION_STATUS, {
      type,
      id,
      connected,
      connections: this.connections
    });
  }

  /**
   * Get connection status summary
   */
  getConnectionStatus() {
    return {
      connected: true,
      simulation: this.simulation,
      indicators: this.connections.indicators,
      rdus: this.connections.rdus,
      clients: this.connections.clients
    };
  }

  /**
   * Reset all weighing state (both mobile and multideck)
   */
  reset() {
    // Reset weights
    this.weights = { deck1: 0, deck2: 0, deck3: 0, deck4: 0, gvw: 0 };
    this.lastWeights = { ...this.weights };
    this.vehicleOnDeck = false;
    this.currentMobileWeight = 0;
    this.mobileWeightStable = true;

    // Reset cumulative weight tracking
    this.lastRawCumulativeWeight = 0;
    this.cumulativeBaseOffset = 0;

    // Reset vehicle state
    this.currentPlate = null;
    this.plateSource = null;
    this.plateTimestamp = null;

    // Reset mobile session state
    this.mobileState = {
      currentAxle: 0,
      totalAxles: 0,
      axles: []
    };

    // Reset configuration
    this.axleConfig = {
      expectedAxles: 0,
      axleConfigurationId: null,
      axleConfigurationCode: null,
      vehicleId: null,
      plateNumber: null
    };

    // Reset sync and detection
    this.clearTransactionSync();
    this.autoDetection.state = 'idle';
    this.autoDetection.stabilityCount = 0;

    console.log('[StateManager] Full state reset performed');
    this.eventBus.emitEvent('session:reset', {});
  }

  /**
   * Reset mobile weighing session (partial reset)
   */
  resetMobileSession() {
    this.reset();
  }

  // ============ Mobile Mode Methods ============

  /**
   * Get mobile weighing state
   */
  getMobileState() {
    return {
      currentAxle: this.mobileState.currentAxle,
      totalAxles: this.mobileState.totalAxles,
      axles: [...this.mobileState.axles],
      gvw: this.mobileState.axles.reduce((sum, a) => sum + a.weight, 0)
    };
  }

  /**
   * Add captured axle weight (mobile mode)
   * 
   * IMPORTANT: Stores the weight directly without re-applying cumulative logic.
   * The cumulative weight logic should be applied ONCE at setCurrentMobileWeight(),
   * and the handlers should pass currentMobileWeight directly to this method.
   * 
   * For MCGS scales with cumulative mode:
   * 1. setCurrentMobileWeight(rawReading) applies: trueWeight = raw - sessionGVW
   * 2. Frontend displays trueWeight via currentMobileWeight  
   * 3. Handlers call addAxleWeight(currentMobileWeight) ← Already corrected
   * 4. This method stores it directly
   * 
   * @param {number} weight - Axle weight in kg (should already be corrected by setCurrentMobileWeight)
   * @returns {Object} - Axle data with calculated GVW
   */
  addAxleWeight(weight) {
    this.mobileState.currentAxle++;
    const axleData = {
      axleNumber: this.mobileState.currentAxle,
      weight: weight,  // Store weight as provided (should already be corrected)
      timestamp: new Date().toISOString()
    };
    this.mobileState.axles.push(axleData);
    this.mobileState.totalAxles = this.mobileState.axles.length;

    // Update cumulative base offset to the current raw MCGS reading.
    // This means the NEXT reading will be subtracted from THIS capture point,
    // regardless of whether previous captures were missed by the middleware.
    // This is the key fix: even if the frontend captured axle N but the WS was down
    // and the middleware never got the notification, setting the base here when we DO
    // get a capture ensures the next subtraction is correct.
    if (this.lastRawCumulativeWeight > 0) {
      this.cumulativeBaseOffset = this.lastRawCumulativeWeight;
      console.log(`[StateManager.addAxleWeight] Axle ${axleData.axleNumber}: ${weight}kg, cumulativeBase updated to ${this.cumulativeBaseOffset}kg`);
    }

    const gvw = this.mobileState.axles.reduce((sum, a) => sum + a.weight, 0);

    this.eventBus.emitEvent('axle:added', {
      ...axleData,
      totalAxles: this.mobileState.totalAxles,
      gvw: gvw
    });

    return { ...axleData, gvw };
  }



  // ============ Axle Configuration Methods ============

  /**
   * Set axle configuration from frontend
   * @param {Object} config - Axle configuration
   */
  setAxleConfiguration(config) {
    this.axleConfig = {
      expectedAxles: config.expectedAxles || config.totalAxles || 0,
      axleConfigurationId: config.axleConfigurationId || null,
      axleConfigurationCode: config.axleConfigurationCode || null,
      vehicleId: config.vehicleId || null,
      plateNumber: config.plateNumber || this.currentPlate
    };

    // Also set the plate if provided
    if (config.plateNumber) {
      this.setCurrentPlate(config.plateNumber);
    }

    console.log(`[StateManager] Axle config set: ${this.axleConfig.expectedAxles} axles expected (${this.axleConfig.axleConfigurationCode})`);
    this.eventBus.emitEvent('axle:config-set', this.axleConfig);
    return this.axleConfig;
  }

  /**
   * Get current axle configuration
   */
  getAxleConfiguration() {
    return { ...this.axleConfig };
  }

  /**
   * Check if all expected axles have been captured
   */
  isWeighingComplete() {
    if (this.axleConfig.expectedAxles === 0) {
      return false; // No config set
    }
    return this.mobileState.axles.length >= this.axleConfig.expectedAxles;
  }

  /**
   * Get remaining axles to capture
   */
  getRemainingAxles() {
    return Math.max(0, this.axleConfig.expectedAxles - this.mobileState.axles.length);
  }

  // ============ Transaction Sync Methods ============

  /**
   * Set transaction sync data from TruLoad frontend
   * Links middleware autoweigh to frontend-created transaction
   * @param {Object} data - Transaction sync data from frontend
   */
  setTransactionSync(data) {
    this.transactionSync = {
      transactionId: data.transactionId || null,
      vehicleRegNumber: data.vehicleRegNumber || null,
      axleConfigCode: data.axleConfigCode || null,
      totalAxles: data.totalAxles || 0,
      stationId: data.stationId || null,
      bound: data.bound || null,
      weighingMode: data.weighingMode || null,
      syncedAt: new Date().toISOString()
    };

    // Also update axle config with synced data
    if (data.totalAxles) {
      this.axleConfig.expectedAxles = data.totalAxles;
    }
    if (data.axleConfigCode) {
      this.axleConfig.axleConfigurationCode = data.axleConfigCode;
    }
    if (data.vehicleRegNumber) {
      this.setPlate(data.vehicleRegNumber, 'transaction-sync');
    }

    console.log(`[StateManager] Transaction synced: txnId=${data.transactionId}, plate=${data.vehicleRegNumber}, axles=${data.totalAxles}, mode=${data.weighingMode}`);
    this.eventBus.emitEvent('transaction:synced', this.transactionSync);
    return this.transactionSync;
  }

  /**
   * Get current transaction sync data
   */
  getTransactionSync() {
    return { ...this.transactionSync };
  }

  /**
   * Clear transaction sync data
   */
  clearTransactionSync() {
    this.transactionSync = {
      transactionId: null,
      vehicleRegNumber: null,
      axleConfigCode: null,
      totalAxles: 0,
      stationId: null,
      bound: null,
      weighingMode: null,
      syncedAt: null
    };
  }

  // ============ Auto-Detection Methods ============

  /**
   * Enable/disable auto-detection for next axle
   */
  setAutoDetection(enabled, options = {}) {
    this.autoDetection.enabled = enabled;
    if (options.zeroThreshold !== undefined) {
      this.autoDetection.zeroThreshold = options.zeroThreshold;
    }
    if (options.stableThreshold !== undefined) {
      this.autoDetection.stableThreshold = options.stableThreshold;
    }
    if (options.requiredStableReadings !== undefined) {
      this.autoDetection.requiredStableReadings = options.requiredStableReadings;
    }
    console.log(`[StateManager] Auto-detection ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Process weight reading for auto-detection
   * Call this on each weight update to detect next axle readiness
   * @param {number} weight - Current weight reading
   * @param {boolean} stable - Whether reading is stable
   * @returns {Object} - Detection result
   */
  processAutoDetection(weight, stable) {
    if (!this.autoDetection.enabled) {
      return { ready: false, state: 'disabled' };
    }

    const prevState = this.autoDetection.state;
    const prevWeight = this.autoDetection.lastWeight;
    this.autoDetection.lastWeight = weight;

    // State machine for detecting next axle
    switch (this.autoDetection.state) {
      case 'idle':
        // After axle capture, start waiting for weight to drop (vehicle moving)
        if (this.mobileState.axles.length > 0) {
          this.autoDetection.state = 'waiting_zero';
          console.log('[AutoDetect] Axle captured, waiting for vehicle to move...');
        }
        break;

      case 'waiting_zero':
        // Waiting for weight to drop below threshold (vehicle moving to next axle)
        if (weight < this.autoDetection.zeroThreshold) {
          this.autoDetection.state = 'waiting_stable';
          this.autoDetection.stabilityCount = 0;
          console.log('[AutoDetect] Scale cleared, waiting for next axle...');
          this.eventBus.emitEvent('axle:vehicle-moving', {
            previousAxle: this.mobileState.axles.length,
            nextAxle: this.mobileState.axles.length + 1
          });
        }
        break;

      case 'waiting_stable':
        // Waiting for stable weight above threshold (next axle on scale)
        if (weight >= this.autoDetection.stableThreshold && stable) {
          this.autoDetection.stabilityCount++;

          if (this.autoDetection.stabilityCount >= this.autoDetection.requiredStableReadings) {
            // Next axle is ready for capture
            console.log(`[AutoDetect] Next axle ready: ${weight}kg (stable)`);
            this.autoDetection.state = 'idle';
            this.autoDetection.stabilityCount = 0;

            this.eventBus.emitEvent('axle:next-ready', {
              axleNumber: this.mobileState.axles.length + 1,
              weight: weight,
              stable: true,
              remainingAxles: this.getRemainingAxles()
            });

            return {
              ready: true,
              state: 'ready',
              weight: weight,
              axleNumber: this.mobileState.axles.length + 1,
              remainingAxles: this.getRemainingAxles()
            };
          }
        } else if (weight < this.autoDetection.stableThreshold) {
          // Reset stability count if weight drops
          this.autoDetection.stabilityCount = 0;
        }
        break;
    }

    return {
      ready: false,
      state: this.autoDetection.state,
      weight: weight,
      stabilityCount: this.autoDetection.stabilityCount
    };
  }

  /**
   * Start auto-detection after manual capture
   * Call this after addAxleWeight to begin monitoring for next axle
   */
  startNextAxleDetection() {
    if (this.autoDetection.enabled) {
      this.autoDetection.state = 'waiting_zero';
      this.autoDetection.stabilityCount = 0;
      console.log('[AutoDetect] Started monitoring for next axle');
    }
  }

  /**
   * Get mobile mode weight data structure for WebSocket
   * This is the format sent to TruLoad clients in mobile mode
   */
  getMobileWeightData() {
    const gvw = this.mobileState.axles.reduce((sum, a) => sum + a.weight, 0);
    return {
      mode: 'mobile',
      stationCode: this.getFullStationCode(),
      bound: this.currentBound,
      currentWeight: this.currentMobileWeight, // Current scale reading (not deck weight)
      stable: this.mobileWeightStable,
      session: {
        currentAxle: this.mobileState.currentAxle,
        totalAxles: this.mobileState.totalAxles,
        axles: this.mobileState.axles.map(a => ({
          axleNumber: a.axleNumber,
          weight: a.weight
        })),
        gvw: gvw
      },
      plate: this.currentPlate,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get multideck mode weight data structure for WebSocket
   * This is the format sent to TruLoad clients in multideck mode
   */
  getMultideckWeightData() {
    return {
      mode: 'multideck',
      stationCode: this.getFullStationCode(),
      bound: this.currentBound,
      decks: [
        { index: 1, weight: this.weights.deck1, stable: true },
        { index: 2, weight: this.weights.deck2, stable: true },
        { index: 3, weight: this.weights.deck3, stable: true },
        { index: 4, weight: this.weights.deck4, stable: true }
      ],
      gvw: this.weights.gvw,
      status: 'stable',
      vehicleOnDeck: this.vehicleOnDeck,
      plate: this.currentPlate,
      timestamp: new Date().toISOString()
    };
  }

  // ============ Compatibility Methods ============

  /**
   * Set weights (called from main.js)
   */
  setWeights(weights) {
    return this.updateWeights(weights);
  }

  /**
   * Get current weights
   */
  getWeights() {
    return { ...this.weights };
  }

  /**
   * Set individual deck weight
   * @param {number} deckNumber - Deck number (1-4)
   * @param {number} weight - Weight in kg
   */
  setDeckWeight(deckNumber, weight) {
    const key = `deck${deckNumber}`;
    if (this.weights.hasOwnProperty(key)) {
      this.weights[key] = weight;
      // Recalculate GVW
      this.weights.gvw = this.weights.deck1 + this.weights.deck2 +
                         this.weights.deck3 + this.weights.deck4;
    }
  }

  /**
   * Set current plate
   */
  setCurrentPlate(plate, vehicleType) {
    this.setPlate(plate, vehicleType);
  }

  /**
   * Set client info (for WebSocket clients)
   * Uses unique identifier (clientName + clientType) to avoid duplicates
   * Note: stationCode and mode excluded from key since same client can switch stations/modes
   */
  setClientInfo(clientId, info) {
    // Unique key based on clientName + clientType only (not stationCode or mode)
    // This ensures the same browser session is treated as one client
    const uniqueKey = `${info.clientName || ''}|${info.clientType || ''}`;

    // Remove ALL existing entries with the same unique key (not just one)
    // This handles cases where multiple reconnections created duplicates
    const existingClients = this.connections.clients.filter(c => {
      const clientKey = `${c.clientName || ''}|${c.clientType || ''}`;
      return clientKey === uniqueKey && c.id !== clientId;
    });

    if (existingClients.length > 0) {
      const removedIds = existingClients.map(c => c.id);
      this.connections.clients = this.connections.clients.filter(c => !removedIds.includes(c.id));
      console.log(`[StateManager] Removed ${removedIds.length} stale client entries: [${removedIds.join(', ')}] (replaced by ${clientId})`);
    }

    // Now add/update the client
    const client = this.connections.clients.find(c => c.id === clientId);
    if (client) {
      Object.assign(client, info);
    } else {
      this.connections.clients.push({ id: clientId, ...info });
    }
  }

  /**
   * Clean up stale client entries
   * Removes clients that are not in the provided list of active client IDs
   */
  cleanupStaleClients(activeClientIds) {
    const before = this.connections.clients.length;
    this.connections.clients = this.connections.clients.filter(c => activeClientIds.includes(c.id));
    const removed = before - this.connections.clients.length;
    if (removed > 0) {
      console.log(`[StateManager] Cleaned up ${removed} stale clients`);
    }
    return removed;
  }

  /**
   * Remove client info (when WebSocket disconnects)
   */
  removeClientInfo(clientId) {
    const index = this.connections.clients.findIndex(c => c.id === clientId);
    if (index !== -1) {
      const removed = this.connections.clients.splice(index, 1)[0];
      console.log(`[StateManager] Removed client: ${clientId} (${removed.clientName || 'unknown'})`);
      return true;
    }
    return false;
  }

  /**
   * Get full state for status request
   */
  getState() {
    return {
      mode: this.mode,
      station: this.station,
      bound: this.currentBound,
      weights: this.getWeights(),
      vehicleOnDeck: this.vehicleOnDeck,
      plate: this.getCurrentPlate(),
      mobile: this.getMobileState(),
      scales: this.getScaleStatus(),
      connections: this.getConnectionStatus(),
      inputSource: this.inputSource,
      simulation: this.simulation
    };
  }

  // ============ Input Source Methods ============

  /**
   * Set input source metadata
   * @param {Object} sourceInfo - { name, protocol, connectionType, connected }
   */
  setInputSource(sourceInfo) {
    this.inputSource = {
      name: sourceInfo.name || null,
      protocol: sourceInfo.protocol || null,
      connectionType: sourceInfo.connectionType || null,
      connected: sourceInfo.connected || false
    };
  }

  /**
   * Get input source metadata
   */
  getInputSource() {
    return { ...this.inputSource };
  }

  /**
   * Update mobile scale info (battery, temp, make, model, etc.)
   * @param {Object} info - { battery, temperature, signalStrength, serialNumber, firmwareVersion, make, model }
   */
  updateMobileScaleInfo(info) {
    if (info.battery !== undefined) this.mobileScaleInfo.battery = info.battery;
    if (info.temperature !== undefined) this.mobileScaleInfo.temperature = info.temperature;
    if (info.signalStrength !== undefined) this.mobileScaleInfo.signalStrength = info.signalStrength;
    if (info.serialNumber !== undefined) this.mobileScaleInfo.serialNumber = info.serialNumber;
    if (info.firmwareVersion !== undefined) this.mobileScaleInfo.firmwareVersion = info.firmwareVersion;
    if (info.make !== undefined) this.mobileScaleInfo.make = info.make;
    if (info.model !== undefined) this.mobileScaleInfo.model = info.model;
  }

  /**
   * Get mobile scale info
   */
  getMobileScaleInfo() {
    return { ...this.mobileScaleInfo };
  }

  /**
   * Update indicator info (for multideck mode)
   * @param {Object} info - { make, model, serialNumber, firmwareVersion, signalStrength }
   */
  updateIndicatorInfo(info) {
    if (info.make !== undefined) this.indicatorInfo.make = info.make;
    if (info.model !== undefined) this.indicatorInfo.model = info.model;
    if (info.serialNumber !== undefined) this.indicatorInfo.serialNumber = info.serialNumber;
    if (info.firmwareVersion !== undefined) this.indicatorInfo.firmwareVersion = info.firmwareVersion;
    if (info.signalStrength !== undefined) this.indicatorInfo.signalStrength = info.signalStrength;
  }

  /**
   * Get indicator info
   */
  getIndicatorInfo() {
    return { ...this.indicatorInfo };
  }

  /**
   * Set capture mode
   * @param {string} mode - 'mobile' or 'multideck'
   */
  setMode(mode) {
    this.mode = mode;
  }

  /**
   * Get capture mode
   */
  getMode() {
    return this.mode;
  }
}

// Static wrapper methods for convenient access
StateManager.getWeights = function() {
  return StateManager.getInstance().getWeights();
};

StateManager.setWeights = function(weights) {
  return StateManager.getInstance().setWeights(weights);
};

StateManager.getState = function() {
  return StateManager.getInstance().getState();
};

StateManager.getMobileState = function() {
  return StateManager.getInstance().getMobileState();
};

StateManager.addAxleWeight = function(weight) {
  return StateManager.getInstance().addAxleWeight(weight);
};

StateManager.resetMobileSession = function() {
  return StateManager.getInstance().resetMobileSession();
};

StateManager.getMobileWeightData = function() {
  return StateManager.getInstance().getMobileWeightData();
};

StateManager.getMultideckWeightData = function() {
  return StateManager.getInstance().getMultideckWeightData();
};

StateManager.setPlate = function(plate, source) {
  return StateManager.getInstance().setPlate(plate, source);
};

StateManager.clearPlate = function() {
  return StateManager.getInstance().clearPlate();
};

StateManager.getWeightData = function() {
  return StateManager.getInstance().getWeightData();
};

StateManager.updateWeights = function(weights) {
  return StateManager.getInstance().updateWeights(weights);
};

StateManager.setDeckWeight = function(deckNumber, weight) {
  return StateManager.getInstance().setDeckWeight(deckNumber, weight);
};

StateManager.setSimulation = function(enabled) {
  return StateManager.getInstance().setSimulation(enabled);
};

StateManager.setInputSource = function(sourceInfo) {
  return StateManager.getInstance().setInputSource(sourceInfo);
};

StateManager.getInputSource = function() {
  return StateManager.getInstance().getInputSource();
};

StateManager.updateMobileScaleInfo = function(info) {
  return StateManager.getInstance().updateMobileScaleInfo(info);
};

StateManager.getMobileScaleInfo = function() {
  return StateManager.getInstance().getMobileScaleInfo();
};

StateManager.updateIndicatorInfo = function(info) {
  return StateManager.getInstance().updateIndicatorInfo(info);
};

StateManager.getIndicatorInfo = function() {
  return StateManager.getInstance().getIndicatorInfo();
};

StateManager.setMode = function(mode) {
  return StateManager.getInstance().setMode(mode);
};

StateManager.getMode = function() {
  return StateManager.getInstance().getMode();
};

StateManager.getCurrentMobileWeight = function() {
  return StateManager.getInstance().currentMobileWeight || 0;
};

StateManager.getMobileWeightStable = function() {
  return StateManager.getInstance().mobileWeightStable !== false;
};

/**
 * Set current mobile weight from scale
 * @param {number} weight - Total axle weight (combined Scale A + B for PAW)
 * @param {boolean} stable - Whether the reading is stable
 * @param {Object} [scaleWeights] - Optional separate scale weights { scaleA, scaleB }
 *
 * For PAW scales: weight is combined (A+B), so we derive individual as weight/2
 * For Haenni: may have separate scaleA/scaleB provided
 *
 * IMPORTANT: This also marks both scales as connected because:
 * - PAW only provides combined weight but uses two physical wheel pads
 * - Simulation mimics PAW behavior
 * - The weight split is done for scale test and diagnostics
 */
StateManager.setCurrentMobileWeight = function(weight, stable = true, scaleWeights = null) {
  const sm = StateManager.getInstance();
  let trueWeight = weight;

  // Cumulative logic for MCGS and similar scales
  // Only apply if enabled in config AND NOT in simulation mode
  //
  // Uses cumulativeBaseOffset (raw MCGS reading at last capture) instead of
  // mobileState.axles.reduce(). This is more robust because:
  // - If a capture notification is missed (e.g. WebSocket dropped), the base offset
  //   is still correct from the LAST successful capture.
  // - The old approach (sum of individual weights) would drift if any capture was missed,
  //   corrupting ALL subsequent subtractions for the rest of the session.
  try {
    const ConfigManager = require('../config/ConfigManager');
    const activeSource = ConfigManager.get('input.activeSource');
    const useCumulative = ConfigManager.get(`input.${activeSource}.useCumulativeWeight`, false);

    if (useCumulative && !sm.simulation) {
      sm.lastRawCumulativeWeight = weight;
      trueWeight = Math.max(0, weight - sm.cumulativeBaseOffset);
    }
  } catch (err) {
    // Fallback if ConfigManager fails
  }

  sm.currentMobileWeight = trueWeight;
  sm.mobileWeightStable = stable;

  // Update individual scale weights
  // For PAW: weight is combined, so each scale = total / 2
  // For Haenni: may have explicit scaleA/scaleB
  let scaleA, scaleB;
  if (scaleWeights && scaleWeights.scaleA !== undefined && scaleWeights.scaleB !== undefined) {
    // Explicit individual scale weights (Haenni separate mode)
    scaleA = scaleWeights.scaleA;
    scaleB = scaleWeights.scaleB;
  } else {
    // Combined weight mode (PAW default) - derive individual scales
    // Each wheel pad gets approximately half the axle weight
    scaleA = Math.round(trueWeight / 2);
    scaleB = trueWeight - scaleA; // Ensure exact total
  }

  // Update scale connection weights AND status
  // Mark both scales as connected when receiving weight data
  // PAW and simulation report combined weight, but both physical wheel pads are in use
  const timestamp = new Date().toISOString();
  sm.scaleConnections.scaleA.weight = scaleA;
  // Mark both scales connected when we receive any reading (device is connected and streaming)
  sm.scaleConnections.scaleA.connected = true;
  sm.scaleConnections.scaleA.lastUpdate = timestamp;

  sm.scaleConnections.scaleB.weight = scaleB;
  sm.scaleConnections.scaleB.connected = true;
  sm.scaleConnections.scaleB.lastUpdate = timestamp;
};

// Axle configuration static methods
StateManager.setAxleConfiguration = function(config) {
  return StateManager.getInstance().setAxleConfiguration(config);
};

StateManager.getAxleConfiguration = function() {
  return StateManager.getInstance().getAxleConfiguration();
};

StateManager.isWeighingComplete = function() {
  return StateManager.getInstance().isWeighingComplete();
};

StateManager.getRemainingAxles = function() {
  return StateManager.getInstance().getRemainingAxles();
};

// Auto-detection static methods
StateManager.setAutoDetection = function(enabled, options) {
  return StateManager.getInstance().setAutoDetection(enabled, options);
};

StateManager.processAutoDetection = function(weight, stable) {
  return StateManager.getInstance().processAutoDetection(weight, stable);
};

StateManager.startNextAxleDetection = function() {
  return StateManager.getInstance().startNextAxleDetection();
};

// Station config static methods
StateManager.setStationConfig = function(config) {
  return StateManager.getInstance().setStationConfig(config);
};

StateManager.getStationConfig = function() {
  return StateManager.getInstance().getStationConfig();
};

// Scale status static methods
StateManager.updateScaleStatus = function(scaleId, status) {
  return StateManager.getInstance().updateScaleStatus(scaleId, status);
};

StateManager.getScaleStatus = function(scaleId) {
  return StateManager.getInstance().getScaleStatus(scaleId);
};

StateManager.hasScaleConnection = function() {
  return StateManager.getInstance().hasScaleConnection();
};

StateManager.isSimulation = function() {
  return StateManager.getInstance().simulation;
};

StateManager.setClientInfo = function(clientId, info) {
  return StateManager.getInstance().setClientInfo(clientId, info);
};

StateManager.removeClientInfo = function(clientId) {
  return StateManager.getInstance().removeClientInfo(clientId);
};

StateManager.getDeckWeight = function(deckNumber) {
  const sm = StateManager.getInstance();
  const key = `deck${deckNumber}`;
  if (sm.weights.hasOwnProperty(key)) {
    return sm.weights[key];
  }
  return null;
};

StateManager.getGVW = function() {
  return StateManager.getInstance().weights.gvw;
};

StateManager.cleanupStaleClients = function(activeClientIds) {
  return StateManager.getInstance().cleanupStaleClients(activeClientIds);
};

// Transaction sync static methods
StateManager.setTransactionSync = function(data) {
  return StateManager.getInstance().setTransactionSync(data);
};

StateManager.getTransactionSync = function() {
  return StateManager.getInstance().getTransactionSync();
};

StateManager.clearTransactionSync = function() {
  return StateManager.getInstance().clearTransactionSync();
};

module.exports = StateManager;
