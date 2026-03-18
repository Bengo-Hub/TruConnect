/**
 * ApiOutput - REST API server for polling mode
 *
 * Fallback output mode when WebSocket is not suitable.
 * Only ONE mode (WebSocket OR API) should be active at a time.
 *
 * Endpoints:
 *   GET /api/v1/weights - Get current weights
 *   GET /api/v1/gvw - Get GVW
 *   GET /api/v1/status - Get system status
 *   POST /api/v1/plate - Submit plate number
 *   POST /api/v1/capture - Request weight capture
 */

const express = require('express');
const cors = require('cors');
const { EventEmitter } = require('events');
const StateManager = require('../core/StateManager');
const EventBus = require('../core/EventBus');
const ConfigManager = require('../config/ConfigManager');
const BackendClient = require('../backend/BackendClient');

class ApiOutput extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      port: config.port || 3031,
      host: config.host || '127.0.0.1',
      basePath: config.basePath || '/api/v1'
    };

    this.app = null;
    this.server = null;
    this.requestCount = 0;
  }

  /**
   * Start API server
   */
  async start() {
    return new Promise((resolve, reject) => {
      try {
        this.app = express();

        // Middleware
        this.app.use(cors());
        this.app.use(express.json());

        // Request logging
        this.app.use((req, res, next) => {
          this.requestCount++;
          next();
        });

        // Setup routes
        this.setupRoutes();

        // Start server - bind to specific host (default 127.0.0.1 for local-only)
        this.server = this.app.listen(this.config.port, this.config.host, () => {
          console.log(`API server listening on ${this.config.host}:${this.config.port}`);
          resolve();
        });

        this.server.on('error', (error) => {
          console.error('API server error:', error.message);
          reject(error);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop API server
   */
  async stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          this.app = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Setup API routes
   */
  setupRoutes() {
    const router = express.Router();

    // Health check
    router.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Get current weights (mode-specific response)
    router.get('/weights', (req, res) => {
      const mode = StateManager.getMode();
      const inputSource = StateManager.getInputSource();
      const simulation = StateManager.isSimulation();
      const timestamp = new Date().toISOString();

      // Get active source config for metadata (make/model)
      const activeSource = ConfigManager.get('input.activeSource') || 'none';
      const sourceConfig = activeSource !== 'none' ? ConfigManager.get(`input.${activeSource}`) : null;
      const metadata = sourceConfig?.metadata || {};

      // Common connection info with device metadata
      const connection = {
        source: simulation ? 'simulation' : (inputSource.name || 'unknown'),
        protocol: simulation ? 'SIMULATED' : inputSource.protocol,
        type: simulation ? 'internal' : inputSource.connectionType,
        connected: simulation ? true : inputSource.connected,
        outputMode: 'api',
        device: {
          make: simulation ? 'Virtual' : (metadata.make || null),
          model: simulation ? (mode === 'mobile' ? 'Scale' : 'Indicator') : (metadata.model || null),
          capacity: metadata.capacity || null
        }
      };

      if (mode === 'mobile') {
        // Mobile mode response - use static getters for consistency
        const mobileState = StateManager.getMobileState();
        const scaleInfo = StateManager.getMobileScaleInfo();
        const scaleStatus = StateManager.getScaleStatus();
        const currentWeight = StateManager.getCurrentMobileWeight();
        const stable = StateManager.getMobileWeightStable();

        // Calculate GVW values
        const capturedGvw = mobileState.gvw || 0;  // Sum of captured axles
        const runningGvw = capturedGvw + currentWeight;  // Real-time total (captured + current)

        // Individual scale weights (PAW: derived from combined weight, Haenni: may be separate)
        const scaleAWeight = scaleStatus.scaleA?.weight || Math.round(currentWeight / 2);
        const scaleBWeight = scaleStatus.scaleB?.weight || (currentWeight - scaleAWeight);

        // Debug logging
        console.log(`[API /weights] Mobile mode - currentWeight: ${currentWeight}, capturedGvw: ${capturedGvw}, runningGvw: ${runningGvw}, simulation: ${simulation}`);

        const wsPort = ConfigManager.get('output.websocket.port', 3030);
        res.json({
          success: true,
          mode: 'mobile',
          simulation,
          websocketAvailable: true,
          websocketUrl: `ws://localhost:${wsPort}`,
          data: {
            currentWeight: currentWeight,  // Live scale reading (total axle weight)
            // Individual scale weights (for scale test and diagnostics)
            // PAW: derived from combined weight (total/2)
            // Haenni: may be provided separately
            scaleA: scaleAWeight,
            scaleB: scaleBWeight,
            scaleWeightMode: 'combined', // 'combined' (PAW) or 'separate' (Haenni)
            // Scale connection status: use scale status, fallback to connection.connected (device connected)
            scaleAStatus: {
              connected: scaleStatus.scaleA?.connected ?? connection.connected ?? false,
              weight: scaleAWeight,
              battery: simulation ? 100 : (scaleStatus.scaleA?.battery || scaleInfo.battery || 100),
              temperature: simulation ? 25 : (scaleStatus.scaleA?.temperature || scaleInfo.temperature || 25),
              signalStrength: simulation ? 100 : (scaleStatus.scaleA?.signalStrength || scaleInfo.signalStrength || 100)
            },
            scaleBStatus: {
              connected: scaleStatus.scaleB?.connected ?? connection.connected ?? false,
              weight: scaleBWeight,
              battery: simulation ? 100 : (scaleStatus.scaleB?.battery || scaleInfo.battery || 100),
              temperature: simulation ? 25 : (scaleStatus.scaleB?.temperature || scaleInfo.temperature || 25),
              signalStrength: simulation ? 100 : (scaleStatus.scaleB?.signalStrength || scaleInfo.signalStrength || 100)
            },
            runningGvw: runningGvw,        // Real-time total (captured + current on scale)
            stable: stable,
            simulation,
            session: {
              currentAxle: mobileState.currentAxle,
              totalAxles: mobileState.totalAxles,
              axles: mobileState.axles,
              gvw: capturedGvw  // Sum of captured axles only (for reference)
            },
            scaleInfo: {
              battery: simulation ? 100 : scaleInfo.battery,
              temperature: simulation ? 25 : scaleInfo.temperature,
              signalStrength: simulation ? 100 : scaleInfo.signalStrength,
              make: simulation ? 'Virtual' : (scaleInfo.make || metadata.make || null),
              model: simulation ? 'Scale' : (scaleInfo.model || metadata.model || null)
            }
          },
          connection,
          timestamp
        });
      } else {
        // Multideck mode response
        const weights = StateManager.getWeights();
        const indicatorInfo = StateManager.getIndicatorInfo();
        const wsPortDeck = ConfigManager.get('output.websocket.port', 3030);
        res.json({
          success: true,
          mode: 'multideck',
          simulation,
          websocketAvailable: true,
          websocketUrl: `ws://localhost:${wsPortDeck}`,
          data: {
            decks: [
              { index: 1, weight: weights.deck1, stable: true },
              { index: 2, weight: weights.deck2, stable: true },
              { index: 3, weight: weights.deck3, stable: true },
              { index: 4, weight: weights.deck4, stable: true }
            ],
            gvw: weights.gvw,
            vehicleOnDeck: weights.gvw > 50,
            simulation,
            indicatorInfo: {
              make: simulation ? 'Virtual' : (indicatorInfo.make || metadata.make || null),
              model: simulation ? 'Indicator' : (indicatorInfo.model || metadata.model || null),
              signalStrength: simulation ? 100 : (indicatorInfo.signalStrength || 100)
            }
          },
          connection,
          timestamp
        });
      }
    });

    // Get specific deck weight
    router.get('/weights/:deck', (req, res) => {
      const deck = parseInt(req.params.deck, 10);
      const weight = StateManager.getDeckWeight(deck);

      if (weight === null) {
        return res.status(404).json({
          success: false,
          error: `Deck ${deck} not found`
        });
      }

      res.json({
        success: true,
        data: { deck, weight },
        timestamp: new Date().toISOString()
      });
    });

    // Get GVW (total weight)
    router.get('/gvw', (req, res) => {
      const mode = StateManager.getMode();
      const inputSource = StateManager.getInputSource();
      let gvw;

      if (mode === 'mobile') {
        const mobileState = StateManager.getMobileState();
        gvw = mobileState.gvw;
      } else {
        const weights = StateManager.getWeights();
        gvw = weights.gvw;
      }

      res.json({
        success: true,
        mode,
        data: { gvw },
        connection: {
          source: inputSource.name,
          protocol: inputSource.protocol,
          type: inputSource.connectionType,
          connected: inputSource.connected
        },
        timestamp: new Date().toISOString()
      });
    });

    // Get system status
    router.get('/status', (req, res) => {
      const state = StateManager.getState();
      const inputSource = StateManager.getInputSource();
      const scaleInfo = StateManager.getMobileScaleInfo();
      const indicatorInfo = StateManager.getIndicatorInfo();

      // Get device metadata from active source config
      const activeSource = ConfigManager.get('input.activeSource') || 'none';
      const sourceConfig = activeSource !== 'none' ? ConfigManager.get(`input.${activeSource}`) : null;
      const metadata = sourceConfig?.metadata || {};

      // Get station config from ConfigManager (fallback to state)
      const stationFromConfig = {
        id: ConfigManager.get('station.id') || state.station?.id || null,
        code: ConfigManager.get('station.code') || state.station?.code || null,
        name: ConfigManager.get('station.name') || state.station?.name || 'TruConnect Station',
        stationType: ConfigManager.get('station.type') || state.station?.stationType || 'mobile_unit',
        supportsBidirectional: ConfigManager.get('station.bidirectional') ?? state.station?.supportsBidirectional ?? false,
        boundACode: ConfigManager.get('station.boundACode') || state.station?.boundACode || 'A',
        boundBCode: ConfigManager.get('station.boundBCode') || state.station?.boundBCode || 'B',
        organizationId: ConfigManager.get('station.organizationId') || state.station?.organizationId || null,
        organizationName: ConfigManager.get('station.organizationName') || state.station?.organizationName || null,
        location: ConfigManager.get('station.location') || state.station?.location || null,
        latitude: ConfigManager.get('station.latitude') || state.station?.latitude || null,
        longitude: ConfigManager.get('station.longitude') || state.station?.longitude || null
      };

      // Get simulation status
      const SimulationEngine = require('../simulation/SimulationEngine');
      const simStatus = SimulationEngine.getStatus();

      // Get output status for endpoint info
      const OutputManager = require('./OutputManager');
      const outputStatus = OutputManager.getStatus();

      // For mobile mode, include current mobile weight in weights response
      const mobileCurrentWeight = StateManager.getCurrentMobileWeight();
      const weightsData = state.mode === 'mobile'
        ? {
            ...state.weights,
            currentMobileWeight: mobileCurrentWeight,
            runningGvw: (state.mobile?.gvw || 0) + mobileCurrentWeight
          }
        : state.weights;

      res.json({
        success: true,
        data: {
          mode: state.mode,
          station: stationFromConfig,
          bound: state.bound || ConfigManager.get('station.bound') || 'A',
          weights: weightsData,
          vehicleOnDeck: state.vehicleOnDeck,
          plate: state.plate,
          mobile: state.mode === 'mobile' ? {
            ...state.mobile,
            currentWeight: mobileCurrentWeight,
            runningGvw: (state.mobile?.gvw || 0) + mobileCurrentWeight
          } : state.mobile,
          scales: state.scales,
          connections: {
            ...state.connections,
            websocket: outputStatus.websocket,
            api: outputStatus.api
          },
          inputSource: {
            ...inputSource,
            activeSource: activeSource,
            connected: inputSource.connected || simStatus.enabled
          },
          simulation: simStatus.enabled,
          simulationMode: simStatus.mode,
          deviceMetadata: {
            make: metadata.make || null,
            model: metadata.model || null,
            capacity: metadata.capacity || null
          },
          scaleInfo: state.mode === 'mobile' ? {
            ...scaleInfo,
            make: scaleInfo.make || metadata.make || null,
            model: scaleInfo.model || metadata.model || null
          } : undefined,
          indicatorInfo: state.mode === 'multideck' ? {
            ...indicatorInfo,
            make: indicatorInfo.make || metadata.make || null,
            model: indicatorInfo.model || metadata.model || null
          } : undefined,
          endpoints: outputStatus.endpoints,
          server: {
            name: 'TruConnect Middleware',
            version: '2.0.0',
            uptime: process.uptime()
          }
        },
        timestamp: new Date().toISOString()
      });
    });

    // Submit plate number (for auto-weigh)
    router.post('/plate', (req, res) => {
      const { plateNumber, vehicleType, stationCode, bound } = req.body;

      if (!plateNumber) {
        return res.status(400).json({
          success: false,
          error: 'plateNumber is required'
        });
      }

      // Store plate
      StateManager.setCurrentPlate(plateNumber, vehicleType);

      // Emit event
      EventBus.emit('plate:received', {
        stationCode,
        bound,
        plateNumber,
        vehicleType,
        source: 'api'
      });

      res.json({
        success: true,
        data: { plateNumber, accepted: true },
        timestamp: new Date().toISOString()
      });
    });

    // Request weight capture
    router.post('/capture', (req, res) => {
      const { deck, type } = req.body;

      EventBus.emit('capture:requested', {
        deck: deck || 0,
        type: type || 'gvw',
        source: 'api'
      });

      // Get current weight for response
      const weights = StateManager.getWeights();
      const gvw = StateManager.getGVW();

      res.json({
        success: true,
        data: {
          weights,
          gvw,
          capturedAt: new Date().toISOString()
        },
        timestamp: new Date().toISOString()
      });
    });

    // Transaction sync (mirrors WebSocket transaction-sync)
    router.post('/transaction-sync', (req, res) => {
      const data = req.body;
      if (!data || !data.transactionId || !data.vehicleRegNumber) {
        return res.status(400).json({
          success: false,
          error: 'transactionId and vehicleRegNumber are required',
          timestamp: new Date().toISOString()
        });
      }
      try {
        StateManager.setTransactionSync(data);
        BackendClient.syncFromTransaction(data);
        BackendClient.startSession({
          weighingTransactionId: data.transactionId,
          regNumber: data.vehicleRegNumber,
          weighingMode: data.weighingMode
        });
        if (data.totalAxles) {
          StateManager.setAxleConfiguration({
            expectedAxles: data.totalAxles,
            axleConfigurationCode: data.axleConfigCode,
            plateNumber: data.vehicleRegNumber
          });
        }
        EventBus.emit('transaction:synced', { ...data, source: 'api' });
        res.json({
          success: true,
          data: { transactionId: data.transactionId, vehicleRegNumber: data.vehicleRegNumber },
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.error('[ApiOutput] transaction-sync error:', err.message);
        res.status(500).json({ success: false, error: err.message, timestamp: new Date().toISOString() });
      }
    });

    // Axle captured (mirrors WebSocket axle-captured; when last axle: send autoweigh then reset)
    router.post('/axle-captured', (req, res) => {
      const { axleNumber, weight, axleConfigurationId } = req.body;
      if (axleNumber == null || weight == null) {
        return res.status(400).json({
          success: false,
          error: 'axleNumber and weight are required',
          timestamp: new Date().toISOString()
        });
      }
      try {
        StateManager.addAxleWeight(weight);
        EventBus.emit('axle:captured', { axleNumber, weight, source: 'api' });
        const isComplete = StateManager.isWeighingComplete();
        const mobileState = StateManager.getMobileState();
        const expectedAxles = StateManager.getAxleConfiguration().expectedAxles;

        if (isComplete && !BackendClient.isAutoweighSent() && !BackendClient.hasSyncedTransaction()) {
          const axleConfig = StateManager.getAxleConfiguration();
          BackendClient.sendAutoweigh({
            plateNumber: axleConfig.plateNumber || StateManager.getInstance().currentPlate,
            vehicleId: axleConfig.vehicleId,
            axleConfigurationId: axleConfig.axleConfigurationId,
            axles: mobileState.axles,
            gvw: mobileState.gvw
          }).then(() => {}).catch(err => console.error('[ApiOutput] Autoweigh failed:', err.message))
            .finally(() => {
              StateManager.resetMobileSession();
              console.log('[ApiOutput] Weighing session reset after auto-weigh attempt');
            });
        } else if (isComplete && BackendClient.hasSyncedTransaction()) {
          StateManager.resetMobileSession();
          console.log('[ApiOutput] All axles captured but frontend has synced transaction - session reset, no autoweigh');
        }

        res.json({
          success: true,
          data: {
            axleNumber,
            weight,
            isComplete,
            capturedAxles: mobileState.axles.length,
            expectedAxles,
            gvw: mobileState.gvw
          },
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.error('[ApiOutput] axle-captured error:', err.message);
        res.status(500).json({ success: false, error: err.message, timestamp: new Date().toISOString() });
      }
    });

    // Vehicle complete (mirrors WebSocket vehicle-complete; send autoweigh then reset)
    router.post('/vehicle-complete', (req, res) => {
      const { transactionId, totalAxles, axleWeights, gvw, axleConfigurationCode } = req.body;
      if (!axleWeights || !Array.isArray(axleWeights)) {
        return res.status(400).json({
          success: false,
          error: 'axleWeights array is required',
          timestamp: new Date().toISOString()
        });
      }
      try {
        const statePlate = StateManager.getState().plate;
        const plateNumber = (statePlate && typeof statePlate === 'object' ? statePlate.plate : statePlate) || null;
        EventBus.emit('vehicle:complete', { totalAxles, axleWeights, gvw, plateNumber, source: 'api' });
        const axles = axleWeights.map((weight, index) => ({ axleNumber: index + 1, weight }));
        const gvwSum = gvw || axles.reduce((sum, a) => sum + a.weight, 0);

        if (!BackendClient.isAutoweighSent() && !BackendClient.hasSyncedTransaction() && axles.length > 0) {
          const axleConfig = StateManager.getAxleConfiguration();
          BackendClient.sendAutoweigh({
            plateNumber: axleConfig.plateNumber || plateNumber,
            vehicleId: axleConfig.vehicleId,
            axleConfigurationId: axleConfig.axleConfigurationId,
            axles,
            gvw: gvwSum
          }).then(() => {}).catch(err => console.error('[ApiOutput] Autoweigh failed:', err.message))
            .finally(() => {
              StateManager.resetMobileSession();
              StateManager.getInstance().reset();
              console.log('[ApiOutput] Weighing session and deck weights reset after vehicle-complete');
            });
        } else if (BackendClient.hasSyncedTransaction() && axles.length > 0) {
          StateManager.resetMobileSession();
          StateManager.getInstance().reset();
          console.log('[ApiOutput] Vehicle complete but frontend has synced transaction - session reset, no autoweigh');
        }

        res.json({
          success: true,
          data: { success: true, gvw: gvwSum },
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.error('[ApiOutput] vehicle-complete error:', err.message);
        res.status(500).json({ success: false, error: err.message, timestamp: new Date().toISOString() });
      }
    });

    // Reset session (mirrors WebSocket reset-session)
    router.post('/reset-session', (req, res) => {
      try {
        EventBus.emit('session:reset', { source: 'api' });
        StateManager.setPlate(null, null);
        StateManager.clearTransactionSync();
        BackendClient.resetSession();
        StateManager.getInstance().reset();
        res.json({
          success: true,
          data: { success: true },
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.error('[ApiOutput] reset-session error:', err.message);
        res.status(500).json({ success: false, error: err.message, timestamp: new Date().toISOString() });
      }
    });

    // Register station (for compatibility)
    router.post('/register', (req, res) => {
      const { stationCode, bound } = req.body;

      if (!stationCode) {
        return res.status(400).json({
          success: false,
          error: 'stationCode is required'
        });
      }

      // API clients don't maintain persistent connections
      // Just acknowledge the registration
      res.json({
        success: true,
        data: { stationCode, bound: bound || 'A' },
        message: 'Note: API polling does not maintain persistent connection',
        timestamp: new Date().toISOString()
      });
    });

    // Mount router at base path
    this.app.use(this.config.basePath, router);

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        success: false,
        error: 'Endpoint not found'
      });
    });

    // Error handler
    this.app.use((err, req, res, next) => {
      console.error('API error:', err);
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    });
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      running: this.server !== null,
      port: this.config.port,
      basePath: this.config.basePath,
      requestCount: this.requestCount
    };
  }
}

module.exports = ApiOutput;
