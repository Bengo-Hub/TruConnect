/**
 * SimulationEngine - Generates simulated weight data for testing
 *
 * Modes:
 * - static: Fixed weights for all decks
 * - dynamic: Random weights within range
 * - pattern: Simulates vehicle weighing patterns (mobile/multideck)
 */

const EventBus = require('../core/EventBus');
const StateManager = require('../core/StateManager');
const WeightGenerator = require('./WeightGenerator');

class SimulationEngine {
  constructor() {
    this.enabled = false;
    this.mode = 'static'; // 'static' | 'dynamic' | 'pattern'
    this.config = {
      updateInterval: 1000,
      staticWeight: 5000,
      minWeight: 1000,
      maxWeight: 50000,
      pattern: 'multideck', // 'mobile' | 'multideck'
      deckCount: 4,
      defaultMultideckVehicleType: 'lorry2axle' // 2A weights by default for multideck simulation
    };

    this.generator = new WeightGenerator();
    this.timer = null;
    this.patternState = null;

    // Mobile mode state: hold stable weight until capture
    this.mobileState = {
      currentWeight: 0,        // Current stable weight being displayed
      isWeightLocked: false,   // True when weight is locked (waiting for capture)
      lastCapturedAxle: 0,     // Track which axle was last captured
      awaitingNextAxle: false  // True after capture, waiting for new axle
    };

    // Subscribe to axle capture events to trigger new weight generation
    EventBus.on('axle:captured', (data) => this.handleAxleCaptured(data));
    EventBus.on('session:reset', () => this.handleSessionReset());
  }

  /**
   * Initialize simulation engine
   */
  initialize(config = {}) {
    this.config = { ...this.config, ...config };
    this.generator.initialize(this.config);
    EventBus.emit('simulation:initialized', { config: this.config });
    return this;
  }

  /**
   * Start simulation
   */
  start() {
    if (this.enabled) return;

    this.enabled = true;
    this.patternState = null;

    // Reset mobile state for fresh start
    this.mobileState = {
      currentWeight: 0,
      isWeightLocked: false,
      lastCapturedAxle: 0,
      awaitingNextAxle: false
    };

    console.log(`Starting simulation in ${this.mode} mode (pattern: ${this.config.pattern})`);

    // Update StateManager simulation flag
    StateManager.setSimulation(true);

    // Update input source info to indicate simulation
    StateManager.setInputSource({
      name: 'simulation',
      protocol: 'SIMULATED',
      connectionType: 'internal',
      connected: true
    });

    // Set both scales as connected for mobile mode (PAW/simulation)
    // PAW and simulation only provide combined weight, but we report both scales as connected
    // since the weight is split between them (total / 2 each)
    if (this.config.pattern === 'mobile') {
      StateManager.updateScaleStatus('scaleA', {
        connected: true,
        battery: 100,
        temperature: 25,
        signalStrength: 100
      });
      StateManager.updateScaleStatus('scaleB', {
        connected: true,
        battery: 100,
        temperature: 25,
        signalStrength: 100
      });
    }

    // Generate initial weights
    this.generateWeights();

    // Start update timer
    this.timer = setInterval(() => {
      this.generateWeights();
    }, this.config.updateInterval);

    EventBus.emit('simulation:started', { mode: this.mode, pattern: this.config.pattern });
  }

  /**
   * Stop simulation
   */
  stop() {
    if (!this.enabled) return;

    this.enabled = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Reset weights to zero
    for (let i = 1; i <= 4; i++) {
      StateManager.setDeckWeight(i, 0);
    }
    StateManager.setCurrentMobileWeight(0, true);

    this.patternState = null;

    // Reset mobile state
    this.mobileState = {
      currentWeight: 0,
      isWeightLocked: false,
      lastCapturedAxle: 0,
      awaitingNextAxle: false
    };

    // Update StateManager simulation flag
    StateManager.setSimulation(false);

    // Reset input source
    StateManager.setInputSource({
      name: null,
      protocol: null,
      connectionType: null,
      connected: false
    });

    // Disconnect both scales
    StateManager.updateScaleStatus('scaleA', { connected: false, weight: 0 });
    StateManager.updateScaleStatus('scaleB', { connected: false, weight: 0 });

    EventBus.emit('simulation:stopped');
  }

  /**
   * Set simulation mode
   */
  setMode(mode) {
    if (!['static', 'dynamic', 'pattern'].includes(mode)) {
      throw new Error(`Invalid simulation mode: ${mode}`);
    }

    this.mode = mode;
    this.patternState = null;

    if (this.enabled) {
      this.generateWeights();
    }

    EventBus.emit('simulation:mode-changed', { mode });
  }

  /**
   * Update configuration
   */
  updateConfig(updates) {
    this.config = { ...this.config, ...updates };
    this.generator.initialize(this.config);
    EventBus.emit('simulation:config-changed', { config: this.config });
  }

  /**
   * Set capture pattern (mobile or multideck)
   * This switches the type of weights being simulated
   * @param {string} pattern - 'mobile' or 'multideck'
   */
  setCapturePattern(pattern) {
    if (!['mobile', 'multideck'].includes(pattern)) {
      console.warn(`[SimulationEngine] Invalid capture pattern: ${pattern}`);
      return;
    }

    const previousPattern = this.config.pattern;
    if (previousPattern === pattern) {
      return; // No change needed
    }

    console.log(`[SimulationEngine] Switching capture pattern: ${previousPattern} -> ${pattern}`);

    this.config.pattern = pattern;

    // Reset states when switching patterns
    this.patternState = null;

    if (pattern === 'mobile') {
      // Switching to mobile - reset mobile state for fresh start
      this.mobileState = {
        currentWeight: 0,
        isWeightLocked: false,
        lastCapturedAxle: 0,
        awaitingNextAxle: false
      };
      // Clear multideck weights
      for (let i = 1; i <= 4; i++) {
        StateManager.setDeckWeight(i, 0);
      }
      // Set both scales as connected (PAW/simulation uses combined weight split)
      if (this.enabled) {
        StateManager.updateScaleStatus('scaleA', {
          connected: true,
          battery: 100,
          temperature: 25,
          signalStrength: 100
        });
        StateManager.updateScaleStatus('scaleB', {
          connected: true,
          battery: 100,
          temperature: 25,
          signalStrength: 100
        });
      }
    } else {
      // Switching to multideck - clear mobile weight
      StateManager.setCurrentMobileWeight(0, true);
      // Disconnect scales (multideck uses indicator, not individual scales)
      if (this.enabled) {
        StateManager.updateScaleStatus('scaleA', { connected: false, weight: 0 });
        StateManager.updateScaleStatus('scaleB', { connected: false, weight: 0 });
      };
      StateManager.resetMobileSession();
    }

    // Update StateManager mode
    StateManager.setMode(pattern);

    // Generate initial weights for new pattern
    if (this.enabled) {
      this.generateWeights();
    }

    EventBus.emit('simulation:pattern-changed', { pattern, previousPattern });
  }

  /**
   * Generate weights based on current mode
   */
  generateWeights() {
    const captureMode = this.config.pattern || 'multideck';

    // For mobile mode, generate single axle weight
    if (captureMode === 'mobile') {
      return this.generateMobileWeight();
    }

    // For multideck mode, generate deck weights
    let weights;

    switch (this.mode) {
      case 'static':
        weights = this.generateStaticWeights();
        break;
      case 'dynamic':
        weights = this.generateDynamicWeights();
        break;
      case 'pattern':
        weights = this.generatePatternWeights();
        break;
      default:
        weights = [0, 0, 0, 0];
    }

    // Update state manager with deck weights
    for (let i = 0; i < 4; i++) {
      StateManager.setDeckWeight(i + 1, weights[i]);
    }

    // Emit weight update event for multideck
    EventBus.emit('input:weight', {
      deck: 0,
      weight: weights.reduce((a, b) => a + b, 0),
      decks: weights.map((w, i) => ({ deck: i + 1, weight: w })),
      source: 'simulation',
      mode: this.mode,
      stable: true,
      isMobile: false,
      timestamp: new Date()
    });
  }

  /**
   * Generate weight for mobile mode (single axle weight)
   *
   * BEHAVIOR: Weight is generated once and held STABLE until the axle is captured.
   * After capture, a new weight is generated for the next axle.
   * This prevents continuous weight fluctuation during weighing.
   *
   * Weight varies by axle position:
   * - Front axles (1-2): 5500-7500kg (lighter, steering/cabin)
   * - Middle axles (3-4): 7000-9500kg (cargo area)
   * - Rear axles (5+): 8000-11000kg (heaviest, trailer)
   */
  generateMobileWeight() {
    // Check if we need to generate a new weight
    // Generate new weight only if:
    // 1. No weight has been set yet (currentWeight is 0)
    // 2. Session was reset
    // 3. Awaiting next axle (after previous was captured)
    if (this.mobileState.currentWeight === 0 || this.mobileState.awaitingNextAxle) {
      // Determine weight range based on axle position
      const axleNumber = this.mobileState.lastCapturedAxle + 1;
      let minWeight, maxWeight;

      if (axleNumber <= 2) {
        // Front axles - heavy (ensures 18k for 2 axles)
        minWeight = 9000;
        maxWeight = 11000;
      } else if (axleNumber <= 4) {
        // Middle axles - medium
        minWeight = 9500;
        maxWeight = 11500;
      } else {
        // Rear axles - heavier
        minWeight = 10000;
        maxWeight = 12000;
      }

      // Generate a new stable weight for this axle
      const baseWeight = this.generator.generateSingle(minWeight, maxWeight);
      this.mobileState.currentWeight = baseWeight;
      this.mobileState.isWeightLocked = true;
      this.mobileState.awaitingNextAxle = false;

      console.log(`[Simulation] Generated new axle weight: ${baseWeight}kg (Axle ${axleNumber}, range: ${minWeight}-${maxWeight}kg)`);
    }

    // Use the locked weight - only add tiny fluctuation for realism (±10kg)
    const tinyFluctuation = Math.floor(Math.random() * 20) - 10;
    const currentAxle = this.mobileState.lastCapturedAxle + 1;
    const minClamp = currentAxle <= 2 ? 9000 : (currentAxle <= 4 ? 9500 : 10000);
    const maxClamp = currentAxle <= 2 ? 11000 : (currentAxle <= 4 ? 11500 : 12000);
    const weight = Math.max(minClamp, Math.min(maxClamp, this.mobileState.currentWeight + tinyFluctuation));

    // Calculate individual scale weights (simulating PAW behavior)
    // PAW returns combined weight, so each scale = total / 2
    const scaleA = Math.round(weight / 2);
    const scaleB = weight - scaleA; // Ensure exact total

    // Update StateManager with current mobile weight and individual scale weights
    StateManager.setCurrentMobileWeight(weight, true, { scaleA, scaleB });

    // Emit weight update event for mobile mode
    // Includes individual scale weights (simulating PAW combined mode)
    EventBus.emit('input:weight', {
      weight: weight,
      currentWeight: weight,
      // Individual scale weights (PAW behavior: combined/2)
      scaleA: scaleA,
      scaleB: scaleB,
      scaleWeightMode: 'combined', // Simulation mimics PAW behavior
      source: 'simulation',
      mode: this.mode,
      stable: true,
      isMobile: true,
      axleNumber: currentAxle,
      timestamp: new Date()
    });

    // Return array for compatibility (only first element used)
    return [weight, 0, 0, 0];
  }

  /**
   * Handle axle captured event - trigger generation of next axle weight
   */
  handleAxleCaptured(data) {
    if (!this.enabled) return;
    if (this.config.pattern !== 'mobile') return;

    this.mobileState.lastCapturedAxle = data.axleNumber || (this.mobileState.lastCapturedAxle + 1);
    this.mobileState.awaitingNextAxle = true;
    this.mobileState.currentWeight = 0; // Reset to trigger new weight generation

    console.log(`[Simulation] Axle ${this.mobileState.lastCapturedAxle} captured - will generate new weight for next axle`);

    // Immediately generate weight for next axle
    // Small delay to simulate axle leaving and next one arriving
    setTimeout(() => {
      if (this.enabled && this.mobileState.awaitingNextAxle) {
        this.generateMobileWeight();
      }
    }, 500);
  }

  /**
   * Handle session reset - start fresh with new weight
   */
  handleSessionReset() {
    console.log('[Simulation] Session reset - clearing mobile state');
    this.mobileState = {
      currentWeight: 0,
      isWeightLocked: false,
      lastCapturedAxle: 0,
      awaitingNextAxle: false
    };
  }

  /**
   * Generate static weights
   * Multideck: Different but stable weights for each deck (6500-12000kg range)
   * Simulates a realistic vehicle with different axle loads
   */
  generateStaticWeights() {
    // Default multideck simulation to 2A (2 axles): decks 1–2 only, decks 3–4 zero
    const effectiveDeckCount = this.config.staticDeckCount ?? (this.config.defaultMultideckVehicleType === 'lorry2axle' ? 2 : 4);

    const baseWeights = [
      9000,   // Deck 1
      9500,   // Deck 2
      10000,  // Deck 3
      10500   // Deck 4
    ];

    const weights = [];
    for (let i = 0; i < 4; i++) {
      if (i < effectiveDeckCount) {
        const variation = Math.floor(Math.random() * 400) - 200;
        weights.push(baseWeights[i] + variation);
      } else {
        weights.push(0);
      }
    }

    return weights;
  }

  /**
   * Generate dynamic random weights
   * Multideck: 6500-12000kg per deck
   */
  generateDynamicWeights() {
    // Multideck deck weight range: 9000-12000kg (ensure total >= 18k for 2+ decks)
    const minDeckWeight = 9000;
    const maxDeckWeight = 15000;

    return this.generator.generateRandom(
      this.config.deckCount,
      minDeckWeight,
      maxDeckWeight
    );
  }

  /**
   * Generate pattern-based weights (vehicle simulation)
   */
  generatePatternWeights() {
    if (this.config.pattern === 'mobile') {
      return this.generateMobilePattern();
    }
    return this.generateMultideckPattern();
  }

  /**
   * Simulate mobile scale pattern (step-through axle capture)
   */
  generateMobilePattern() {
    if (!this.patternState) {
      this.patternState = {
        phase: 'idle',
        axle: 0,
        maxAxles: Math.floor(Math.random() * 5) + 2, // 2-6 axles
        weights: [],
        stableCount: 0
      };
    }

    const state = this.patternState;

    switch (state.phase) {
      case 'idle':
        // Start new vehicle
        state.phase = 'approaching';
        state.axle = 1;
        state.weights = [];
        return [0, 0, 0, 0];

      case 'approaching':
        // Axle approaching scale
        state.phase = 'weighing';
        const approachWeight = this.generator.generateSingle(500, 2000);
        return [approachWeight, 0, 0, 0];

      case 'weighing':
        // Generate stable weight for current axle
        state.stableCount++;
        const axleWeight = this.generator.generateAxleWeight(state.axle, state.maxAxles);

        if (state.stableCount >= 3) {
          // Weight stable, capture axle
          state.weights.push(axleWeight);
          state.stableCount = 0;
          state.axle++;

          if (state.axle > state.maxAxles) {
            state.phase = 'complete';
          } else {
            state.phase = 'approaching';
          }
        }

        return [axleWeight, 0, 0, 0];

      case 'complete':
        // Vehicle complete, return to idle
        const gvw = state.weights.reduce((a, b) => a + b, 0);
        EventBus.emit('simulation:vehicle-complete', {
          axles: state.maxAxles,
          weights: state.weights,
          gvw
        });
        state.phase = 'idle';
        return [0, 0, 0, 0];

      default:
        return [0, 0, 0, 0];
    }
  }

  /**
   * Simulate multideck pattern (vehicle entering platform)
   */
  generateMultideckPattern() {
    if (!this.patternState) {
      this.patternState = {
        phase: 'empty',
        vehicleType: null,
        targetWeights: [0, 0, 0, 0],
        currentWeights: [0, 0, 0, 0],
        stableCount: 0,
        cycleCount: 0
      };
    }

    const state = this.patternState;

    switch (state.phase) {
      case 'empty':
        // Start new vehicle cycle
        state.cycleCount++;
        if (state.cycleCount > 5) {
          // Random delay between vehicles
          state.cycleCount = 0;
          return [0, 0, 0, 0];
        }

        state.phase = 'entering';
        state.vehicleType = this.config.defaultMultideckVehicleType || this.generator.randomVehicleType();
        state.targetWeights = this.generator.generateVehicleWeights(state.vehicleType);
        state.currentWeights = [0, 0, 0, 0];
        return state.currentWeights;

      case 'entering':
        // Vehicle progressively enters decks
        // Ensure even "entering" weights jump to at least 18,000kg immediately for heavy vehicles
        const hasZeroWeights = state.currentWeights.every(w => w === 0);

        for (let i = 0; i < 4; i++) {
          if (state.currentWeights[i] < state.targetWeights[i]) {
            // If starting from 0, jump to a significant portion of the weight
            // so we don't spend time in < 18,000kg range
            let step;
            if (hasZeroWeights && i === 0) {
              step = Math.max(18000, this.generator.generateSingle(18000, state.targetWeights[0]));
            } else {
              step = Math.min(
                this.generator.generateSingle(500, 1500),
                state.targetWeights[i] - state.currentWeights[i]
              );
            }
            state.currentWeights[i] += step;
          }
        }

        // Check if fully entered
        const allEntered = state.currentWeights.every(
          (w, i) => Math.abs(w - state.targetWeights[i]) < 100
        );

        if (allEntered) {
          state.phase = 'stable';
          state.stableCount = 0;
        }

        return state.currentWeights.map(Math.round);

      case 'stable':
        // Weight stable on deck
        state.stableCount++;

        // Add small fluctuations
        const weights = state.targetWeights.map(w =>
          w + this.generator.generateSingle(-20, 20)
        );

        if (state.stableCount >= 5) {
          // Capture and exit
          state.phase = 'exiting';
          EventBus.emit('simulation:vehicle-stable', {
            type: state.vehicleType,
            weights: state.targetWeights,
            gvw: state.targetWeights.reduce((a, b) => a + b, 0)
          });
        }

        return weights.map(Math.round);

      case 'exiting':
        // Vehicle exits decks
        for (let i = 3; i >= 0; i--) {
          if (state.currentWeights[i] > 0) {
            state.currentWeights[i] = Math.max(
              0,
              state.currentWeights[i] - this.generator.generateSingle(500, 1500)
            );
          }
        }

        // Check if fully exited
        if (state.currentWeights.every(w => w <= 0)) {
          state.phase = 'empty';
          state.cycleCount = 0;
        }

        return state.currentWeights.map(w => Math.max(0, Math.round(w)));

      default:
        return [0, 0, 0, 0];
    }
  }

  /**
   * Get current simulation status
   */
  getStatus() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      config: this.config,
      state: this.patternState
    };
  }

  /**
   * Manually trigger weight capture (for testing)
   */
  triggerCapture() {
    if (!this.enabled) return;

    const weights = StateManager.getWeights();
    const gvw = StateManager.getGVW();

    EventBus.emit('simulation:capture', {
      weights,
      gvw,
      timestamp: new Date()
    });
  }
}

// Singleton instance
let instance = null;

module.exports = {
  getInstance() {
    if (!instance) {
      instance = new SimulationEngine();
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

  setMode(mode) {
    return this.getInstance().setMode(mode);
  },

  setCapturePattern(pattern) {
    return this.getInstance().setCapturePattern(pattern);
  },

  getStatus() {
    return this.getInstance().getStatus();
  },

  SimulationEngine
};
