/**
 * BackendClient - Communicates with TruLoad Backend API
 *
 * Handles auto-weigh submission and session management with the backend.
 * Supports both online (backend API) and offline (local storage) modes.
 */

const crypto = require('crypto');
const EventBus = require('../core/EventBus');
const ConfigManager = require('../config/ConfigManager');
const StateManager = require('../core/StateManager');

class BackendClient {
  static instance = null;

  constructor() {
    this.eventBus = EventBus.getInstance();

    // Backend configuration
    this.config = {
      enabled: false,        // Whether backend integration is enabled
      baseUrl: '',           // e.g., 'http://localhost:4000'
      authEndpoint: '/api/v1/auth/login',
      autoweighEndpoint: '/api/v1/weighing-transactions/autoweigh',
      email: '',             // Service account email
      password: '',          // Service account password
      stationId: null,       // Station ID (Guid)
      bound: 'A',            // Direction for bidirectional stations
      timeout: 30000,        // Request timeout in ms
      retryCount: 3,         // Number of retries on failure
      retryDelay: 1000       // Delay between retries in ms
    };

    // JWT token state
    this.auth = {
      accessToken: null,
      refreshToken: null,
      expiresAt: null        // Date when token expires
    };

    // Current session state
    this.currentSession = {
      transactionId: null,   // Backend transaction ID (if exists)
      weighingTransactionId: null, // Frontend-created transaction ID (from transaction-sync)
      vehicleRegNumber: null,
      vehicleId: null,
      axleConfigurationId: null,
      weighingMode: null,    // 'mobile' or 'multideck'
      isAutoweighSent: false,
      autoweighGvw: 0,
      localSessionId: null    // Groups this vehicle's autoweigh+complete sync-queue rows
    };

    // Connection state
    this.isConnected = false;
    this.lastError = null;

    // Connectivity poll state (started via startConnectivityPoll)
    this._connectivityPollTimer = null;
    this._connectivityPollIntervalMs = 30000;
    this._lastKnownOnline = null; // null = unknown until first poll
  }

  /**
   * Get singleton instance
   */
  static getInstance() {
    if (!BackendClient.instance) {
      BackendClient.instance = new BackendClient();
    }
    return BackendClient.instance;
  }

  /**
   * Initialize with configuration from defaults/settings
   */
  initialize(config = {}) {
    this.config = {
      ...this.config,
      ...config
    };

    console.log(`[BackendClient] Initialized: enabled=${this.config.enabled}, baseUrl=${this.config.baseUrl || '(not configured)'}`);
  }

  /**
   * Configure backend connection from settings
   */
  configure(settings) {
    if (settings.enabled !== undefined) this.config.enabled = settings.enabled;
    if (settings.baseUrl) this.config.baseUrl = settings.baseUrl;
    if (settings.authEndpoint) this.config.authEndpoint = settings.authEndpoint;
    if (settings.autoweighEndpoint) this.config.autoweighEndpoint = settings.autoweighEndpoint;
    if (settings.email) this.config.email = settings.email;
    if (settings.password) this.config.password = settings.password;
    if (settings.stationId) this.config.stationId = settings.stationId;
    if (settings.bound) this.config.bound = settings.bound;

    // Clear existing token when credentials change
    this.auth = { accessToken: null, refreshToken: null, expiresAt: null };

    console.log(`[BackendClient] Configured: enabled=${this.config.enabled}, Station=${this.config.stationId}, Bound=${this.config.bound}`);
  }

  /**
   * Authenticate with backend using email/password → JWT token
   * @returns {boolean} true if authentication succeeded
   */
  async authenticate() {
    if (!this.config.baseUrl || !this.config.email || !this.config.password) {
      console.log('[BackendClient] Cannot authenticate - missing baseUrl, email, or password');
      return false;
    }

    try {
      const response = await this._fetch(`${this.config.baseUrl}${this.config.authEndpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: this.config.email,
          password: this.config.password
        }),
        timeout: 10000
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Auth failed ${response.status}: ${errorText}`);
      }

      const result = await response.json();

      this.auth.accessToken = result.accessToken;
      this.auth.refreshToken = result.refreshToken;
      // Set expiry with 5-minute buffer before actual expiration
      this.auth.expiresAt = new Date(Date.now() + (result.expiresIn - 300) * 1000);
      this.isConnected = true;

      console.log(`[BackendClient] Authenticated as ${this.config.email}`);
      this.eventBus.emitEvent('backend:authenticated', { email: this.config.email });

      return true;
    } catch (error) {
      this.isConnected = false;
      this.lastError = error.message;
      console.error('[BackendClient] Authentication failed:', error.message);
      this.eventBus.emitEvent('backend:auth-failed', { error: error.message });
      return false;
    }
  }

  /**
   * Get a valid authorization header, re-authenticating if token expired
   * @returns {string|null} Bearer token header value or null
   */
  async _getAuthHeader() {
    // Check if token is expired or missing
    if (!this.auth.accessToken || !this.auth.expiresAt || new Date() >= this.auth.expiresAt) {
      const success = await this.authenticate();
      if (!success) return null;
    }
    return `Bearer ${this.auth.accessToken}`;
  }

  /**
   * Check if backend is configured and reachable, then authenticate
   */
  async checkConnection() {
    if (!this.config.enabled || !this.config.baseUrl) {
      this.isConnected = false;
      return false;
    }

    try {
      const response = await this._fetch(`${this.config.baseUrl}/api/v1/health`, {
        method: 'GET',
        timeout: 5000
      });

      if (!response.ok) {
        this.isConnected = false;
        return false;
      }

      // Authenticate if we don't have a valid token
      if (!this.auth.accessToken || new Date() >= this.auth.expiresAt) {
        return await this.authenticate();
      }

      this.isConnected = true;
      return true;
    } catch (error) {
      this.isConnected = false;
      this.lastError = error.message;
      console.error('[BackendClient] Connection check failed:', error.message);
      return false;
    }
  }

  /**
   * Start polling checkConnection() on an interval and emit backend:online/backend:offline
   * ONLY on state transitions (not every poll). On the online edge, also kick an immediate
   * SyncQueue drain so queued weighings don't wait for the queue's own periodic drain tick.
   */
  startConnectivityPoll(intervalMs) {
    this.stopConnectivityPoll();
    this._connectivityPollIntervalMs = intervalMs || this._connectivityPollIntervalMs;
    this._lastKnownOnline = null; // force a fresh determination on the next tick

    this._connectivityPollTimer = setInterval(() => {
      this._pollConnection().catch(err => console.error('[BackendClient] Connectivity poll error:', err.message));
    }, this._connectivityPollIntervalMs);
    if (this._connectivityPollTimer.unref) this._connectivityPollTimer.unref();

    console.log(`[BackendClient] Connectivity poll started (every ${this._connectivityPollIntervalMs}ms)`);
  }

  stopConnectivityPoll() {
    if (this._connectivityPollTimer) {
      clearInterval(this._connectivityPollTimer);
      this._connectivityPollTimer = null;
    }
  }

  /**
   * Stop and restart the poll (e.g. after backend settings change) so the next tick
   * re-evaluates connectivity from scratch instead of waiting out the old interval.
   */
  restartConnectivityPoll(intervalMs) {
    this.startConnectivityPoll(intervalMs || this._connectivityPollIntervalMs);
  }

  async _pollConnection() {
    if (!this.config.enabled || !this.config.baseUrl) return;

    const wasOnline = this._lastKnownOnline;
    const isOnline = await this.checkConnection();

    if (isOnline === wasOnline) return; // no state transition - stay quiet

    this._lastKnownOnline = isOnline;

    if (isOnline) {
      console.log('[BackendClient] Backend connectivity restored (online)');
      this.eventBus.emitEvent('backend:online', { baseUrl: this.config.baseUrl });
      try {
        const SyncQueue = require('./SyncQueue');
        SyncQueue.drain().catch(err => console.error('[SyncQueue] drain-on-reconnect error:', err.message));
      } catch (err) {
        console.error('[BackendClient] Failed to trigger drain on reconnect:', err.message);
      }
    } else {
      console.log('[BackendClient] Backend connectivity lost (offline)');
      this.eventBus.emitEvent('backend:offline', { baseUrl: this.config.baseUrl });
    }
  }

  /**
   * Start a new weighing session
   * Resets session state and prepares for new vehicle
   */
  startSession(vehicleInfo = {}) {
    // Reset previous session
    this.currentSession = {
      transactionId: null,
      weighingTransactionId: vehicleInfo.weighingTransactionId || null,
      vehicleRegNumber: vehicleInfo.regNumber || null,
      vehicleId: vehicleInfo.vehicleId || null,
      axleConfigurationId: vehicleInfo.axleConfigurationId || null,
      weighingMode: vehicleInfo.weighingMode || null,
      isAutoweighSent: false,
      autoweighGvw: 0,
      // Fresh id for this physical weighing - groups its autoweigh+complete sync-queue rows.
      // Generated here (not lazily inside sendAutoweigh) so it's stable across both calls
      // even if the app restarts between them.
      localSessionId: crypto.randomUUID()
    };

    console.log(`[BackendClient] Session started for vehicle: ${this.currentSession.vehicleRegNumber || 'unknown'}${this.currentSession.weighingTransactionId ? ` (txnId: ${this.currentSession.weighingTransactionId})` : ''}`);
    this.eventBus.emitEvent('backend:session-started', this.currentSession);
  }

  /**
   * Hard guard: block a real network send when SimulationEngine is active and this device is
   * not explicitly marked as targeting the codevertex-demo tenant (operationMode.isDemoTenant).
   * Closes a real gap: today simulated fake scale readings had no guard preventing them from
   * being auto-submitted as real transactions to a live organization. Emits
   * 'backend:blocked-simulated-data' so the UI/logs can surface it. Real (non-simulated)
   * weighings are never affected - this only trips when StateManager.isSimulation() is true.
   *
   * @param {string} callName - 'sendAutoweigh' | 'completeSession', for logging/eventing only
   * @returns {boolean} true if the caller must no-op (return null) instead of sending
   */
  _isSimulationSendBlocked(callName) {
    if (!StateManager.isSimulation()) return false;

    const isDemoTenant = ConfigManager.get('operationMode.isDemoTenant', false) === true;
    if (isDemoTenant) return false;

    console.warn(`[BackendClient] Blocked ${callName}: simulation is active and operationMode.isDemoTenant is not true`);
    this.eventBus.emitEvent('backend:blocked-simulated-data', {
      call: callName,
      reason: 'simulation-active-without-demo-tenant'
    });
    return true;
  }

  /**
   * Send auto-weigh data to backend when all axles are captured
   * Creates preliminary record with CaptureStatus: "auto"
   *
   * @param {Object} weighingData - Captured weighing data
   * @returns {Object} - Backend response or null if offline
   */
  async sendAutoweigh(weighingData) {
    if (this._isSimulationSendBlocked('sendAutoweigh')) {
      return null;
    }

    if (!this.config.enabled || !this.config.baseUrl || !this.config.stationId) {
      console.log('[BackendClient] Backend not configured - skipping autoweigh submission');
      return null;
    }

    if (!this.currentSession.localSessionId) {
      // Defensive fallback - normally set by startSession()
      this.currentSession.localSessionId = crypto.randomUUID();
    }

    const payload = {
      stationId: this.config.stationId,
      bound: this.config.bound,
      vehicleRegNumber: weighingData.plateNumber || this.currentSession.vehicleRegNumber || 'UNKNOWN',
      vehicleId: weighingData.vehicleId || this.currentSession.vehicleId,
      axles: weighingData.axles.map((axle, index) => ({
        axleNumber: axle.axleNumber || (index + 1),
        measuredWeightKg: axle.weight,
        axleConfigurationId: weighingData.axleConfigurationId || this.currentSession.axleConfigurationId
      })),
      weighingMode: this.currentSession.weighingMode || 'mobile',
      capturedAt: new Date().toISOString(),
      source: 'TruConnect',
      captureSource: 'auto',
      isFinalCapture: false,  // This is preliminary auto-weigh data
      weighingTransactionId: this.currentSession.weighingTransactionId || null
    };

    console.log(`[BackendClient] Capturing autoweigh (durable): ${payload.axles.length} axles, GVW=${weighingData.gvw}kg`);

    // Durable capture: the row lands in SQLite via _queueForSync BEFORE any network
    // attempt. attempt() then tries to send it immediately - if that succeeds we get
    // the same synchronous result as before; if not, the row stays queued and the
    // sync queue's own retry/backoff/drain machinery takes over.
    const queueRow = this._queueForSync('autoweigh', payload, this.currentSession.localSessionId);

    const SyncQueue = require('./SyncQueue');
    const result = await SyncQueue.attempt(queueRow.id);

    if (result) {
      // Update session with transaction info
      this.currentSession.transactionId = result.weighingId;
      this.currentSession.isAutoweighSent = true;
      this.currentSession.autoweighGvw = weighingData.gvw;

      console.log(`[BackendClient] Autoweigh sent successfully: TransactionId=${result.weighingId}, Ticket=${result.ticketNumber}`);

      this.eventBus.emitEvent('backend:autoweigh-sent', {
        transactionId: result.weighingId,
        ticketNumber: result.ticketNumber,
        gvw: result.gvwMeasuredKg,
        captureStatus: result.captureStatus
      });
    } else {
      console.log('[BackendClient] Autoweigh captured locally and queued - will sync automatically when the backend is reachable');
      this.eventBus.emitEvent('backend:autoweigh-failed', {
        error: 'Queued locally for later sync (offline or backend error)',
        payload
      });
    }

    return result;
  }

  /**
   * Notify backend that weighing session is complete
   * Updates existing auto-weigh record with CaptureStatus: "captured"
   *
   * @param {Object} finalData - Final weighing data from frontend
   * @returns {Object} - Backend response or null if offline
   */
  async completeSession(finalData) {
    if (this._isSimulationSendBlocked('completeSession')) {
      return null;
    }

    if (!this.config.enabled || !this.config.baseUrl || !this.config.stationId) {
      console.log('[BackendClient] Backend not configured - skipping session completion');
      return null;
    }

    if (!this.currentSession.localSessionId) {
      // Defensive fallback - normally set by startSession()
      this.currentSession.localSessionId = crypto.randomUUID();
    }
    const localSessionId = this.currentSession.localSessionId;

    const payload = {
      stationId: this.config.stationId,
      bound: this.config.bound,
      vehicleRegNumber: finalData.plateNumber || this.currentSession.vehicleRegNumber || 'UNKNOWN',
      vehicleId: finalData.vehicleId || this.currentSession.vehicleId,
      axles: finalData.axles.map((axle, index) => ({
        axleNumber: axle.axleNumber || (index + 1),
        measuredWeightKg: axle.weight,
        axleConfigurationId: finalData.axleConfigurationId || this.currentSession.axleConfigurationId
      })),
      weighingMode: this.currentSession.weighingMode || 'mobile',
      capturedAt: new Date().toISOString(),
      source: 'TruConnect',
      captureSource: 'frontend',
      isFinalCapture: true,  // This is the final capture from frontend
      // Left null unless a frontend already synced a transaction id - the sync queue
      // resolves this from the sibling autoweigh row's backend_transaction_id once
      // that row has synced (see SyncQueue.attempt's dependency-chaining logic).
      weighingTransactionId: this.currentSession.weighingTransactionId || null
    };

    console.log(`[BackendClient] Capturing session completion (durable): ${payload.axles.length} axles, GVW=${finalData.gvw}kg`);

    // Durable capture, same pattern as sendAutoweigh: write first, attempt second.
    // Note this row may not be eligible to send yet if its autoweigh sibling hasn't
    // synced - attempt() will simply leave it pending in that case (see SyncQueue).
    const queueRow = this._queueForSync('complete', payload, localSessionId);

    const SyncQueue = require('./SyncQueue');
    const result = await SyncQueue.attempt(queueRow.id);

    if (result) {
      console.log(`[BackendClient] Session completed: TransactionId=${result.weighingId}, Status=${result.controlStatus}`);

      this.eventBus.emitEvent('backend:session-completed', {
        transactionId: result.weighingId,
        ticketNumber: result.ticketNumber,
        gvw: result.gvwMeasuredKg,
        isCompliant: result.isCompliant,
        controlStatus: result.controlStatus,
        captureStatus: result.captureStatus
      });
    } else {
      console.log('[BackendClient] Session completion captured locally and queued - will sync automatically (waiting on its autoweigh sibling and/or backend reachability)');
      this.eventBus.emitEvent('backend:complete-failed', {
        error: 'Queued locally for later sync (offline, dependency pending, or backend error)',
        payload
      });
    }

    // Reset session regardless of sync outcome: the physical weighing is already
    // durably captured in the sync queue (payload is self-contained), so the operator
    // must be free to start the next vehicle immediately rather than being blocked on
    // this one's sync completing.
    this.resetSession();

    return result;
  }

  /**
   * Cancel the current weighing session
   * Marks any pending auto-weigh record as not_weighed
   */
  async cancelSession() {
    console.log(`[BackendClient] Session cancelled for vehicle: ${this.currentSession.vehicleRegNumber}`);

    // Emit event before resetting
    this.eventBus.emitEvent('backend:session-cancelled', {
      vehicleRegNumber: this.currentSession.vehicleRegNumber,
      transactionId: this.currentSession.transactionId,
      wasAutoweighSent: this.currentSession.isAutoweighSent
    });

    this.resetSession();
  }

  /**
   * Reset the current session state
   */
  resetSession() {
    this.currentSession = {
      transactionId: null,
      weighingTransactionId: null,
      vehicleRegNumber: null,
      vehicleId: null,
      axleConfigurationId: null,
      weighingMode: null,
      isAutoweighSent: false,
      autoweighGvw: 0,
      localSessionId: null
    };
  }

  /**
   * Get current session state
   */
  getSession() {
    return { ...this.currentSession };
  }

  /**
   * Sync session from frontend transaction-sync event
   * Updates the session with the transaction ID so autoweigh links to the right transaction
   * @param {Object} syncData - Transaction sync data from frontend
   */
  syncFromTransaction(syncData) {
    this.currentSession.weighingTransactionId = syncData.transactionId || null;
    this.currentSession.vehicleRegNumber = syncData.vehicleRegNumber || this.currentSession.vehicleRegNumber;
    this.currentSession.weighingMode = syncData.weighingMode || this.currentSession.weighingMode;

    if (syncData.stationId) {
      this.config.stationId = syncData.stationId;
    }
    if (syncData.bound) {
      this.config.bound = syncData.bound;
    }

    console.log(`[BackendClient] Synced from transaction: txnId=${syncData.transactionId}, plate=${syncData.vehicleRegNumber}, mode=${syncData.weighingMode}`);
  }

  /**
   * Check if autoweigh was already sent for this session
   */
  isAutoweighSent() {
    return this.currentSession.isAutoweighSent;
  }

  /**
   * True when frontend has synced a weighing transaction (frontend-led flow).
   * When set, middleware must not create/update via autoweigh; only frontend submits via capture-weights.
   */
  hasSyncedTransaction() {
    return Boolean(this.currentSession.weighingTransactionId);
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      enabled: this.config.enabled,
      isConnected: this.isConnected,
      isAuthenticated: !!this.auth.accessToken && new Date() < this.auth.expiresAt,
      baseUrl: this.config.baseUrl,
      email: this.config.email,
      stationId: this.config.stationId,
      bound: this.config.bound,
      lastError: this.lastError,
      currentSession: this.getSession()
    };
  }

  /**
   * Internal fetch wrapper with timeout
   */
  async _fetch(url, options = {}) {
    const timeout = options.timeout || this.config.timeout;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Durably persist a request to the sync queue (SQLite) BEFORE any network attempt.
   * This is the "durable capture" primitive both sendAutoweigh and completeSession use -
   * a real delegation to SyncQueue.enqueue(), not the old stub that only console.log'd.
   *
   * @param {'autoweigh'|'complete'} type
   * @param {Object} payload
   * @param {string} localSessionId - groups this call with its autoweigh/complete sibling
   * @returns {Object} the inserted weighing_queue row
   */
  _queueForSync(type, payload, localSessionId) {
    const SyncQueue = require('./SyncQueue');
    const row = SyncQueue.enqueue({
      localSessionId: localSessionId || this.currentSession.localSessionId || crypto.randomUUID(),
      requestType: type,
      endpoint: this.config.autoweighEndpoint,
      payload
    });

    console.log(`[BackendClient] Queued ${type} for sync (queueId=${row.id}):`, payload.vehicleRegNumber);

    this.eventBus.emitEvent('backend:queued-for-sync', {
      type,
      vehicleRegNumber: payload.vehicleRegNumber,
      queueId: row.id,
      clientLocalId: row.client_local_id,
      timestamp: new Date().toISOString()
    });

    return row;
  }
}

// Static wrapper methods for convenient access
BackendClient.initialize = function(config) {
  return BackendClient.getInstance().initialize(config);
};

BackendClient.configure = function(settings) {
  return BackendClient.getInstance().configure(settings);
};

BackendClient.authenticate = function() {
  return BackendClient.getInstance().authenticate();
};

BackendClient.checkConnection = function() {
  return BackendClient.getInstance().checkConnection();
};

BackendClient.startConnectivityPoll = function(intervalMs) {
  return BackendClient.getInstance().startConnectivityPoll(intervalMs);
};

BackendClient.stopConnectivityPoll = function() {
  return BackendClient.getInstance().stopConnectivityPoll();
};

BackendClient.restartConnectivityPoll = function(intervalMs) {
  return BackendClient.getInstance().restartConnectivityPoll(intervalMs);
};

BackendClient.startSession = function(vehicleInfo) {
  return BackendClient.getInstance().startSession(vehicleInfo);
};

BackendClient.sendAutoweigh = function(weighingData) {
  return BackendClient.getInstance().sendAutoweigh(weighingData);
};

BackendClient.completeSession = function(finalData) {
  return BackendClient.getInstance().completeSession(finalData);
};

BackendClient.cancelSession = function() {
  return BackendClient.getInstance().cancelSession();
};

BackendClient.resetSession = function() {
  return BackendClient.getInstance().resetSession();
};

BackendClient.getSession = function() {
  return BackendClient.getInstance().getSession();
};

BackendClient.isAutoweighSent = function() {
  return BackendClient.getInstance().isAutoweighSent();
};

BackendClient.hasSyncedTransaction = function() {
  return BackendClient.getInstance().hasSyncedTransaction();
};

BackendClient.getStatus = function() {
  return BackendClient.getInstance().getStatus();
};

BackendClient.syncFromTransaction = function(syncData) {
  return BackendClient.getInstance().syncFromTransaction(syncData);
};

module.exports = BackendClient;
