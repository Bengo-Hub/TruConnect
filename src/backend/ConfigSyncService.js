/**
 * ConfigSyncService - Syncs Station + AxleConfiguration reference data from truload-backend
 *
 * Closes a real gap: today `BackendClient.config.stationId` is populated ONLY by an
 * inbound `station:sync` IPC call from a connected browser frontend - which does not
 * exist at a frontend-less offline quarry deployment. This service instead resolves
 * the locally-configured `station.code` (typed into Settings) to the backend's
 * station GUID from a local mirror table, and feeds it into BackendClient directly.
 *
 * That resolution (resolveAndApplyStationId) is a pure local SQLite lookup with NO
 * network call, so it works even after a long offline stretch - it only needs the
 * mirror table to have been populated at least once, which is what runSync() (network
 * dependent) does on-demand, every 6h, and on the backend:online reconnect edge.
 *
 * Two new local tables (`backend_stations`, `backend_axle_configurations`) mirror the
 * backend's raw shape. These are a mapping layer only - the existing operator-typed
 * `stations`/`station_bounds` tables and `station.*` settings are never overwritten
 * automatically; drift is surfaced via an event + Settings banner instead.
 */

const EventBus = require('../core/EventBus');
const ConfigManager = require('../config/ConfigManager');
const StateManager = require('../core/StateManager');

const STATIONS_ENDPOINT = '/api/v1/Stations';
const AXLE_CONFIG_ENDPOINT = '/api/v1/AxleConfiguration';
const DEFAULT_PERIODIC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h - slow-moving reference data

/**
 * Pure function: resolve a local station code to a backend station GUID.
 * Exported standalone so it can be exercised by a plain script without any
 * Electron/SQLite dependencies (the repo has no test runner set up).
 *
 * @param {string} localCode - value of the local `station.code` setting
 * @param {Array<{id: string, code: string}>} backendStations
 * @returns {string|null} the matching backend station id, or null if none/ambiguous input
 */
function resolveStationGuidForCode(localCode, backendStations) {
  if (!localCode) return null;
  const normalized = String(localCode).trim().toUpperCase();
  if (!normalized || !Array.isArray(backendStations)) return null;

  const match = backendStations.find(
    (s) => String(s.code || '').trim().toUpperCase() === normalized
  );
  return match ? match.id : null;
}

/**
 * Pure function: diff local operator-typed station values against the backend-mirrored
 * values for the resolved station. Returns which fields differ - callers decide what to
 * do with that (surface a banner), this never mutates anything.
 *
 * @param {{name?: string, bidirectional?: boolean, boundACode?: string, boundBCode?: string}} localStation
 * @param {{name?: string, supportsBidirectional?: boolean, boundACode?: string, boundBCode?: string}} backendStation
 * @returns {{hasDrift: boolean, fields: Array<{field: string, local: any, backend: any}>}}
 */
function detectStationDrift(localStation, backendStation) {
  if (!backendStation) return { hasDrift: false, fields: [] };

  const fields = [];
  const localName = (localStation.name || '').trim();
  const backendName = (backendStation.name || '').trim();
  if (localName && backendName && localName !== backendName) {
    fields.push({ field: 'name', local: localName, backend: backendName });
  }

  const localBidirectional = Boolean(localStation.bidirectional);
  const backendBidirectional = Boolean(backendStation.supportsBidirectional);
  if (localBidirectional !== backendBidirectional) {
    fields.push({ field: 'bidirectional', local: localBidirectional, backend: backendBidirectional });
  }

  const localBoundA = localStation.boundACode || 'A';
  const localBoundB = localStation.boundBCode || 'B';
  const backendBoundA = backendStation.boundACode || 'A';
  const backendBoundB = backendStation.boundBCode || 'B';
  if (localBoundA !== backendBoundA) {
    fields.push({ field: 'boundACode', local: localBoundA, backend: backendBoundA });
  }
  if (localBoundB !== backendBoundB) {
    fields.push({ field: 'boundBCode', local: localBoundB, backend: backendBoundB });
  }

  return { hasDrift: fields.length > 0, fields };
}

class ConfigSyncService {
  constructor() {
    this.periodicTimer = null;
    this.periodicIntervalMs = DEFAULT_PERIODIC_INTERVAL_MS;
    this.lastSyncedAt = null;
    this.lastError = null;
    this.lastDrift = null;
    this._subscribedToReconnect = false;
  }

  _db() {
    return require('../database/Database').getDb();
  }

  /**
   * Wire up the reconnect-triggered sync + start the periodic timer, and resolve
   * whatever station GUID is already cached locally (works fully offline). Call once
   * at app startup, after BackendClient.initialize().
   */
  initialize(options = {}) {
    if (options.periodicIntervalMs) this.periodicIntervalMs = options.periodicIntervalMs;

    if (!this._subscribedToReconnect) {
      EventBus.on('backend:online', () => {
        console.log('[ConfigSyncService] Backend online - triggering config sync');
        this.runSync().catch(err => console.error('[ConfigSyncService] Reconnect sync failed:', err.message));
      });
      this._subscribedToReconnect = true;
    }

    // Best-effort, no network: populate BackendClient.config.stationId from whatever
    // is already cached from a previous sync, so the offline queue has a usable
    // stationId even before this run's (network-dependent) runSync() completes.
    this.resolveAndApplyStationId();

    this.startPeriodicSync(this.periodicIntervalMs);
    return this;
  }

  async _authorizedGet(path) {
    const BackendClient = require('./BackendClient');
    const client = BackendClient.getInstance();
    if (!client.config.enabled || !client.config.baseUrl) {
      throw new Error('Backend not configured');
    }
    const authHeader = await client._getAuthHeader();
    if (!authHeader) {
      throw new Error('Authentication failed');
    }
    const response = await client._fetch(`${client.config.baseUrl}${path}`, {
      method: 'GET',
      headers: { 'Authorization': authHeader }
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`GET ${path} failed: HTTP ${response.status} ${text}`);
    }
    return response.json();
  }

  /**
   * Fetch the org's Stations from the backend and upsert into the local mirror table.
   */
  async syncStations() {
    const stations = await this._authorizedGet(STATIONS_ENDPOINT);
    this._upsertBackendStations(Array.isArray(stations) ? stations : []);
    return stations;
  }

  /**
   * Fetch AxleConfiguration catalog from the backend and upsert into the local mirror table.
   */
  async syncAxleConfigurations() {
    const configs = await this._authorizedGet(AXLE_CONFIG_ENDPOINT);
    this._upsertBackendAxleConfigurations(Array.isArray(configs) ? configs : []);
    return configs;
  }

  _upsertBackendStations(stations) {
    const db = this._db();
    const now = new Date().toISOString();
    const upsert = db.prepare(`
      INSERT INTO backend_stations
        (id, code, name, station_type, organization_id, organization_name, supports_bidirectional, bound_a_code, bound_b_code, is_active, raw_json, synced_at)
      VALUES (@id, @code, @name, @stationType, @organizationId, @organizationName, @supportsBidirectional, @boundACode, @boundBCode, @isActive, @rawJson, @syncedAt)
      ON CONFLICT(id) DO UPDATE SET
        code = excluded.code,
        name = excluded.name,
        station_type = excluded.station_type,
        organization_id = excluded.organization_id,
        organization_name = excluded.organization_name,
        supports_bidirectional = excluded.supports_bidirectional,
        bound_a_code = excluded.bound_a_code,
        bound_b_code = excluded.bound_b_code,
        is_active = excluded.is_active,
        raw_json = excluded.raw_json,
        synced_at = excluded.synced_at
    `);

    db.transaction(() => {
      for (const s of stations) {
        upsert.run({
          id: String(s.id),
          code: s.code || '',
          name: s.name || '',
          stationType: s.stationType || null,
          organizationId: s.organizationId ? String(s.organizationId) : null,
          organizationName: s.organizationName || null,
          supportsBidirectional: s.supportsBidirectional ? 1 : 0,
          boundACode: s.boundACode || null,
          boundBCode: s.boundBCode || null,
          isActive: s.isActive === false ? 0 : 1,
          rawJson: JSON.stringify(s),
          syncedAt: now
        });
      }
    });

    console.log(`[ConfigSyncService] Synced ${stations.length} station(s) into backend_stations`);
  }

  _upsertBackendAxleConfigurations(configs) {
    const db = this._db();
    const now = new Date().toISOString();
    const upsert = db.prepare(`
      INSERT INTO backend_axle_configurations
        (id, axle_code, axle_name, axle_number, gvw_permissible_kg, is_standard, is_active, raw_json, synced_at)
      VALUES (@id, @axleCode, @axleName, @axleNumber, @gvwPermissibleKg, @isStandard, @isActive, @rawJson, @syncedAt)
      ON CONFLICT(id) DO UPDATE SET
        axle_code = excluded.axle_code,
        axle_name = excluded.axle_name,
        axle_number = excluded.axle_number,
        gvw_permissible_kg = excluded.gvw_permissible_kg,
        is_standard = excluded.is_standard,
        is_active = excluded.is_active,
        raw_json = excluded.raw_json,
        synced_at = excluded.synced_at
    `);

    db.transaction(() => {
      for (const c of configs) {
        upsert.run({
          id: String(c.id),
          axleCode: c.axleCode || '',
          axleName: c.axleName || null,
          axleNumber: c.axleNumber || 0,
          gvwPermissibleKg: c.gvwPermissibleKg || 0,
          isStandard: c.isStandard ? 1 : 0,
          isActive: c.isActive === false ? 0 : 1,
          rawJson: JSON.stringify(c),
          syncedAt: now
        });
      }
    });

    console.log(`[ConfigSyncService] Synced ${configs.length} axle configuration(s) into backend_axle_configurations`);
  }

  /**
   * Resolve the local station.code to a backend station GUID from the local mirror
   * table (no network call) and push it into BackendClient.config.stationId directly
   * (bypassing BackendClient.configure(), which would needlessly clear the cached
   * auth token on every sync tick).
   *
   * @returns {string|null} the resolved GUID, or null if unresolved
   */
  resolveAndApplyStationId() {
    const localCode = ConfigManager.get('station.code', '');
    if (!localCode) {
      console.log('[ConfigSyncService] No local station.code configured yet - cannot resolve backend station GUID');
      return null;
    }

    const rows = this._db().all('SELECT id, code FROM backend_stations');
    const guid = resolveStationGuidForCode(localCode, rows);

    const BackendClient = require('./BackendClient');
    const client = BackendClient.getInstance();

    if (guid) {
      if (client.config.stationId !== guid) {
        client.config.stationId = guid;
        console.log(`[ConfigSyncService] Resolved station code '${localCode}' -> backend station GUID ${guid}`);
      }
      EventBus.emit('config-sync:station-resolved', { code: localCode, stationId: guid });
    } else {
      console.warn(`[ConfigSyncService] No backend station found matching local code '${localCode}' (have you synced yet?)`);
      EventBus.emit('config-sync:station-unresolved', { code: localCode });
    }

    return guid;
  }

  _computeStationDrift(stationGuid) {
    if (!stationGuid) return { hasDrift: false, fields: [], backendStation: null };

    const row = this._db().get('SELECT raw_json FROM backend_stations WHERE id = ?', [stationGuid]);
    if (!row) return { hasDrift: false, fields: [], backendStation: null };

    const backendStation = JSON.parse(row.raw_json);
    const localStationConfig = StateManager.getStationConfig();
    const localStation = {
      name: ConfigManager.get('station.name', ''),
      bidirectional: ConfigManager.get('station.bidirectional', false),
      boundACode: localStationConfig.boundACode,
      boundBCode: localStationConfig.boundBCode
    };

    const result = detectStationDrift(localStation, backendStation);
    return { ...result, backendStation };
  }

  /**
   * Full sync pass: fetch Stations + AxleConfiguration from the backend (best-effort -
   * either can fail independently without blocking the other), then ALWAYS re-resolve
   * the station GUID and recompute drift from whatever is now cached locally, even if
   * both fetches failed. That's what lets this run safely on a schedule while offline.
   */
  async runSync() {
    let stationsCount = null;
    let axleConfigCount = null;
    let error = null;

    try {
      const stations = await this.syncStations();
      stationsCount = Array.isArray(stations) ? stations.length : 0;
    } catch (err) {
      console.warn('[ConfigSyncService] Stations fetch failed (using cached mirror if any):', err.message);
      error = err.message;
    }

    try {
      const configs = await this.syncAxleConfigurations();
      axleConfigCount = Array.isArray(configs) ? configs.length : 0;
    } catch (err) {
      console.warn('[ConfigSyncService] AxleConfiguration fetch failed (using cached mirror if any):', err.message);
      error = error || err.message;
    }

    const stationGuid = this.resolveAndApplyStationId();
    const drift = this._computeStationDrift(stationGuid);

    this.lastSyncedAt = new Date().toISOString();
    this.lastError = error;
    this.lastDrift = drift;

    const success = !error;
    const summary = {
      success,
      syncedAt: this.lastSyncedAt,
      stationsCount,
      axleConfigCount,
      stationId: stationGuid,
      drift,
      error
    };

    EventBus.emit('config-sync:completed', summary);
    if (drift.hasDrift) {
      EventBus.emit('config-sync:drift-detected', drift);
    }

    return summary;
  }

  /**
   * Apply the backend's values for the currently-resolved station over the local
   * operator-typed config. Only ever called explicitly (Settings "Apply backend
   * values" button) - never automatic, since local values may be intentional.
   */
  applyBackendValues() {
    if (!this.lastDrift || !this.lastDrift.backendStation) {
      throw new Error('No backend station data available - run a sync first');
    }

    const b = this.lastDrift.backendStation;
    ConfigManager.set('station.name', b.name, true);
    ConfigManager.set('station.bidirectional', Boolean(b.supportsBidirectional), true);

    const current = StateManager.getStationConfig();
    StateManager.setStationConfig({
      ...current,
      name: b.name,
      supportsBidirectional: Boolean(b.supportsBidirectional),
      boundACode: b.boundACode || 'A',
      boundBCode: b.boundBCode || 'B'
    });

    // Refresh drift state - should now show no drift for the applied fields.
    const stationGuid = this.lastDrift.backendStation.id;
    this.lastDrift = this._computeStationDrift(stationGuid);

    console.log(`[ConfigSyncService] Applied backend values for station ${b.code} to local config`);
    EventBus.emit('config-sync:applied', { stationId: b.id, code: b.code });

    return { applied: true, drift: this.lastDrift };
  }

  getStatus() {
    return {
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
      drift: this.lastDrift,
      periodicIntervalMs: this.periodicIntervalMs
    };
  }

  startPeriodicSync(intervalMs) {
    this.stopPeriodicSync();
    this.periodicIntervalMs = intervalMs || this.periodicIntervalMs;
    this.periodicTimer = setInterval(() => {
      this.runSync().catch(err => console.error('[ConfigSyncService] periodic sync error:', err.message));
    }, this.periodicIntervalMs);
    if (this.periodicTimer.unref) this.periodicTimer.unref();
    console.log(`[ConfigSyncService] Periodic sync started (every ${this.periodicIntervalMs}ms)`);
  }

  stopPeriodicSync() {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }
}

// Singleton instance
let instance = null;

function getInstance() {
  if (!instance) {
    instance = new ConfigSyncService();
  }
  return instance;
}

module.exports = {
  getInstance,
  initialize: (options) => getInstance().initialize(options),
  runSync: () => getInstance().runSync(),
  syncStations: () => getInstance().syncStations(),
  syncAxleConfigurations: () => getInstance().syncAxleConfigurations(),
  resolveAndApplyStationId: () => getInstance().resolveAndApplyStationId(),
  applyBackendValues: () => getInstance().applyBackendValues(),
  getStatus: () => getInstance().getStatus(),
  startPeriodicSync: (intervalMs) => getInstance().startPeriodicSync(intervalMs),
  stopPeriodicSync: () => getInstance().stopPeriodicSync(),

  // Pure functions exported standalone for scriptable testing (no test runner in this repo).
  resolveStationGuidForCode,
  detectStationDrift,

  ConfigSyncService
};
