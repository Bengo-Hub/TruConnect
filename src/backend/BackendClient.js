/**
 * BackendClient - Communicates with TruLoad Backend API
 *
 * Handles auto-weigh submission and session management with the backend.
 * Supports both online (backend API) and offline (local storage) modes.
 */

const EventBus = require('../core/EventBus');
const ConfigManager = require('../config/ConfigManager');

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
      autoweighGvw: 0
    };

    // Connection state
    this.isConnected = false;
    this.lastError = null;
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
      autoweighGvw: 0
    };

    console.log(`[BackendClient] Session started for vehicle: ${this.currentSession.vehicleRegNumber || 'unknown'}${this.currentSession.weighingTransactionId ? ` (txnId: ${this.currentSession.weighingTransactionId})` : ''}`);
    this.eventBus.emitEvent('backend:session-started', this.currentSession);
  }

  /**
   * Send auto-weigh data to backend when all axles are captured
   * Creates preliminary record with CaptureStatus: "auto"
   *
   * @param {Object} weighingData - Captured weighing data
   * @returns {Object} - Backend response or null if offline
   */
  async sendAutoweigh(weighingData) {
    if (!this.config.enabled || !this.config.baseUrl || !this.config.stationId) {
      console.log('[BackendClient] Backend not configured - skipping autoweigh submission');
      return null;
    }

    const authHeader = await this._getAuthHeader();
    if (!authHeader) {
      console.error('[BackendClient] Cannot send autoweigh - authentication failed');
      return null;
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

    console.log(`[BackendClient] Sending autoweigh: ${payload.axles.length} axles, GVW=${weighingData.gvw}kg`);

    try {
      const response = await this._fetch(`${this.config.baseUrl}${this.config.autoweighEndpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Backend returned ${response.status}: ${errorText}`);
      }

      const result = await response.json();

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

      return result;
    } catch (error) {
      console.error('[BackendClient] Autoweigh submission failed:', error.message);
      this.lastError = error.message;

      // Queue for later sync if offline
      this._queueForSync('autoweigh', payload);

      this.eventBus.emitEvent('backend:autoweigh-failed', {
        error: error.message,
        payload
      });

      return null;
    }
  }

  /**
   * Notify backend that weighing session is complete
   * Updates existing auto-weigh record with CaptureStatus: "captured"
   *
   * @param {Object} finalData - Final weighing data from frontend
   * @returns {Object} - Backend response or null if offline
   */
  async completeSession(finalData) {
    if (!this.config.enabled || !this.config.baseUrl || !this.config.stationId) {
      console.log('[BackendClient] Backend not configured - skipping session completion');
      return null;
    }

    const authHeader = await this._getAuthHeader();
    if (!authHeader) {
      console.error('[BackendClient] Cannot complete session - authentication failed');
      return null;
    }

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
      weighingTransactionId: this.currentSession.weighingTransactionId || null
    };

    console.log(`[BackendClient] Completing session: ${payload.axles.length} axles, GVW=${finalData.gvw}kg`);

    try {
      const response = await this._fetch(`${this.config.baseUrl}${this.config.autoweighEndpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Backend returned ${response.status}: ${errorText}`);
      }

      const result = await response.json();

      console.log(`[BackendClient] Session completed: TransactionId=${result.weighingId}, Status=${result.controlStatus}`);

      this.eventBus.emitEvent('backend:session-completed', {
        transactionId: result.weighingId,
        ticketNumber: result.ticketNumber,
        gvw: result.gvwMeasuredKg,
        isCompliant: result.isCompliant,
        controlStatus: result.controlStatus,
        captureStatus: result.captureStatus
      });

      // Reset session after completion
      this.resetSession();

      return result;
    } catch (error) {
      console.error('[BackendClient] Session completion failed:', error.message);
      this.lastError = error.message;

      // Queue for later sync
      this._queueForSync('complete', payload);

      this.eventBus.emitEvent('backend:complete-failed', {
        error: error.message,
        payload
      });

      return null;
    }
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
      autoweighGvw: 0
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
   * Queue failed request for later sync (offline support)
   */
  _queueForSync(type, payload) {
    // For now, just log - could be extended to store in SQLite
    console.log(`[BackendClient] Queued ${type} for later sync:`, payload.vehicleRegNumber);

    // Could emit event for UI notification
    this.eventBus.emitEvent('backend:queued-for-sync', {
      type,
      vehicleRegNumber: payload.vehicleRegNumber,
      timestamp: new Date().toISOString()
    });
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
