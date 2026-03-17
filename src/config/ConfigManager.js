/**
 * ConfigManager - Centralized configuration management
 *
 * Features:
 * - Merges defaults with database settings
 * - Environment variable overrides
 * - Validation and type coercion
 * - Event-driven config changes
 */

const defaults = require('./defaults');
const EventBus = require('../core/EventBus');

class ConfigManager {
  constructor() {
    this.config = JSON.parse(JSON.stringify(defaults)); // Deep clone
    this.db = null;
    this.isInitialized = false;
  }

  /**
   * Initialize with database connection
   */
  initialize(database) {
    this.db = database;

    // Load settings from database
    this.loadFromDatabase();

    // Apply environment overrides
    this.applyEnvironmentOverrides();

    this.isInitialized = true;
    EventBus.emit('config:initialized');

    return this;
  }

  /**
   * Load settings from database
   * Called during initialization - no authentication required
   */
  loadFromDatabase() {
    if (!this.db) {
      console.warn('ConfigManager: No database connection, using defaults only');
      return;
    }

    try {
      const settings = this.db.all('SELECT key, value FROM settings');
      console.log(`ConfigManager: Loading ${settings.length} settings from database`);

      let loadedCount = 0;
      for (const { key, value } of settings) {
        const parsedValue = this.parseValue(value);
        this.setByPath(key, parsedValue);
        loadedCount++;

        // Log important settings for debugging
        if (key.startsWith('simulation.') || key.startsWith('input.activeSource') || key === 'app.captureMode') {
          console.log(`  [DB] ${key} = ${JSON.stringify(parsedValue)}`);
        }
      }

      console.log(`ConfigManager: Loaded ${loadedCount} settings from database`);
    } catch (error) {
      console.warn('Could not load settings from database:', error.message);
    }
  }

  /**
   * Apply environment variable overrides
   * Format: TRUCONNECT_SECTION_KEY (e.g., TRUCONNECT_OUTPUT_WEBSOCKET_PORT)
   */
  applyEnvironmentOverrides() {
    const prefix = 'TRUCONNECT_';

    for (const [envKey, value] of Object.entries(process.env)) {
      if (envKey.startsWith(prefix)) {
        const configPath = envKey
          .substring(prefix.length)
          .toLowerCase()
          .replace(/_/g, '.');

        this.setByPath(configPath, this.parseValue(value));
      }
    }
  }

  /**
   * Parse string value to appropriate type
   */
  parseValue(value) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    if (/^\d+\.\d+$/.test(value)) return parseFloat(value);

    // Try JSON parsing for objects/arrays
    if (value.startsWith('{') || value.startsWith('[')) {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }

    return value;
  }

  /**
   * Get config value by dot path
   */
  get(path, defaultValue = undefined) {
    const value = this.getByPath(path);
    return value !== undefined ? value : defaultValue;
  }

  /**
   * Set config value by dot path
   */
  set(path, value, persist = true) {
    const oldValue = this.getByPath(path);
    this.setByPath(path, value);

    // Persist to database if requested
    if (persist && this.db) {
      this.persistToDatabase(path, value);
    }

    // Emit change event
    if (oldValue !== value) {
      EventBus.emit('config:changed', { path, oldValue, newValue: value });
    }

    return this;
  }

  /**
   * Get value by dot path
   */
  getByPath(path) {
    return path.split('.').reduce((obj, key) => {
      return obj && obj[key] !== undefined ? obj[key] : undefined;
    }, this.config);
  }

  /**
   * Set value by dot path (creates nested objects if needed)
   */
  setByPath(path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    let obj = this.config;

    for (const key of keys) {
      if (obj[key] === undefined) {
        obj[key] = {};
      }
      obj = obj[key];
    }

    obj[lastKey] = value;
  }

  /**
   * Persist value to database
   */
  persistToDatabase(path, value) {
    if (!this.db) return;

    const strValue = typeof value === 'object' ? JSON.stringify(value) : String(value);

    try {
      const existing = this.db.get('SELECT key FROM settings WHERE key = ?', [path]);

      if (existing) {
        this.db.run(
          'UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?',
          [strValue, path]
        );
      } else {
        this.db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [path, strValue]);
      }
    } catch (error) {
      console.error('Failed to persist config:', error.message);
    }
  }

  /**
   * Get entire config section
   */
  getSection(section) {
    return this.config[section] || {};
  }

  /**
   * Merge values into a section
   */
  mergeSection(section, values, persist = true) {
    const current = this.config[section] || {};
    this.config[section] = { ...current, ...values };

    if (persist) {
      for (const [key, value] of Object.entries(values)) {
        this.persistToDatabase(`${section}.${key}`, value);
      }
    }

    EventBus.emit('config:section-changed', { section, values });
    return this;
  }

  /**
   * Reset section to defaults
   */
  resetSection(section) {
    if (defaults[section]) {
      this.config[section] = JSON.parse(JSON.stringify(defaults[section]));
      EventBus.emit('config:section-reset', { section });
    }
    return this;
  }

  /**
   * Reset all config to defaults
   */
  resetAll() {
    this.config = JSON.parse(JSON.stringify(defaults));
    EventBus.emit('config:reset');
    return this;
  }

  /**
   * Validate configuration
   */
  validate() {
    const errors = [];

    // Validate output mode
    if (!['realtime', 'polling'].includes(this.get('output.mode'))) {
      errors.push('output.mode must be "realtime" or "polling"');
    }

    // Validate ports
    const wsPort = this.get('output.websocket.port');
    if (wsPort && (wsPort < 1 || wsPort > 65535)) {
      errors.push('output.websocket.port must be between 1 and 65535');
    }

    const apiPort = this.get('output.api.port');
    if (apiPort && (apiPort < 1 || apiPort > 65535)) {
      errors.push('output.api.port must be between 1 and 65535');
    }

    // Validate simulation weights
    const minWeight = this.get('simulation.minWeight');
    const maxWeight = this.get('simulation.maxWeight');
    if (minWeight >= maxWeight) {
      errors.push('simulation.minWeight must be less than simulation.maxWeight');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Export config as JSON (without sensitive data)
   */
  export() {
    const exported = JSON.parse(JSON.stringify(this.config));
    // Remove sensitive data if any
    delete exported.auth?.secret;
    return exported;
  }

  /**
   * Import config from JSON
   */
  import(config, persist = true) {
    for (const [section, values] of Object.entries(config)) {
      if (typeof values === 'object' && !Array.isArray(values)) {
        this.mergeSection(section, values, persist);
      } else {
        this.set(section, values, persist);
      }
    }
    return this;
  }
}

// Singleton instance
let instance = null;

module.exports = {
  /**
   * Get or create config instance
   */
  getInstance() {
    if (!instance) {
      instance = new ConfigManager();
    }
    return instance;
  },

  /**
   * Initialize config with database
   */
  initialize(database) {
    return this.getInstance().initialize(database);
  },

  /**
   * Shorthand for get
   */
  get(path, defaultValue) {
    return this.getInstance().get(path, defaultValue);
  },

  /**
   * Shorthand for set
   */
  set(path, value, persist = true) {
    return this.getInstance().set(path, value, persist);
  },

  // Re-export for testing
  ConfigManager,
  defaults
};
