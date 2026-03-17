/**
 * Database - SQLite database wrapper using better-sqlite3
 *
 * Features:
 * - Synchronous API for Electron main process
 * - Migration system for schema versioning
 * - Connection pooling (single connection, thread-safe)
 * - Automatic WAL mode for performance
 */

const path = require('path');
const fs = require('fs');
const EventBus = require('../core/EventBus');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('better-sqlite3 not installed. Run: npm install better-sqlite3');
  Database = null;
}

class DatabaseManager {
  constructor(options = {}) {
    this.options = {
      dbPath: options.dbPath || this.getDefaultDbPath(),
      verbose: options.verbose || false,
      ...options
    };

    this.db = null;
    this.isInitialized = false;
  }

  /**
   * Get default database path based on environment
   */
  getDefaultDbPath() {
    // In packaged Electron apps, the app directory (asar) is read-only and may not exist on disk
    // as a normal folder. Store runtime data under userData instead.
    try {
      // Require lazily to avoid breaking non-Electron tooling
      // eslint-disable-next-line global-require
      const electron = require('electron');
      const app = electron?.app || (electron?.remote && electron.remote.app);
      if (app?.getPath) {
        const dataDir = path.join(app.getPath('userData'), 'db');
        fs.mkdirSync(dataDir, { recursive: true });
        return path.join(dataDir, 'truconnect.db');
      }
    } catch {
      // Fall back to dev path below
    }

    // Dev fallback: project root directory for easy access
    // __dirname is src/database, so go up two levels
    const projectRoot = path.join(__dirname, '..', '..');
    return path.join(projectRoot, 'truconnect.db');
  }

  /**
   * Initialize database connection
   */
  initialize() {
    if (this.isInitialized) return this;

    if (!Database) {
      throw new Error('better-sqlite3 is not available');
    }

    try {
      this.db = new Database(this.options.dbPath, {
        verbose: this.options.verbose ? console.log : null
      });

      // Enable WAL mode for better performance
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('foreign_keys = ON');

      // Run migrations
      this.runMigrations();

      this.isInitialized = true;
      EventBus.emit('database:initialized', { path: this.options.dbPath });

      return this;
    } catch (error) {
      EventBus.emit('database:error', { error: error.message });
      throw error;
    }
  }

  /**
   * Run all pending migrations
   */
  runMigrations() {
    // Create migrations table if not exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const migrations = this.getMigrations();
    const appliedMigrations = this.db.prepare('SELECT name FROM migrations').all().map(m => m.name);

    for (const migration of migrations) {
      if (!appliedMigrations.includes(migration.name)) {
        console.log(`Running migration: ${migration.name}`);
        this.db.transaction(() => {
          this.db.exec(migration.sql);
          this.db.prepare('INSERT INTO migrations (name) VALUES (?)').run(migration.name);
        })();
      }
    }
  }

  /**
   * Get all migration definitions
   */
  getMigrations() {
    return [
      {
        name: '001_create_users',
        sql: `
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'operator',
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
        `
      },
      {
        name: '002_create_sessions',
        sql: `
          CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT UNIQUE NOT NULL,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
          CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
        `
      },
      {
        name: '003_create_custom_protocols',
        sql: `
          CREATE TABLE IF NOT EXISTS custom_protocols (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            config TEXT NOT NULL,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_protocols_category ON custom_protocols(category);
        `
      },
      {
        name: '004_create_stations',
        sql: `
          CREATE TABLE IF NOT EXISTS stations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            base_code TEXT UNIQUE NOT NULL,
            station_name TEXT NOT NULL,
            bidirectional INTEGER DEFAULT 0,
            multi_deck_per_bound INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_stations_code ON stations(base_code);
        `
      },
      {
        name: '005_create_station_bounds',
        sql: `
          CREATE TABLE IF NOT EXISTS station_bounds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            station_id INTEGER NOT NULL,
            bound_letter TEXT NOT NULL,
            full_code TEXT NOT NULL,
            bound_name TEXT NOT NULL,
            FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE,
            UNIQUE(station_id, bound_letter)
          );
          CREATE INDEX IF NOT EXISTS idx_bounds_station ON station_bounds(station_id);
          CREATE INDEX IF NOT EXISTS idx_bounds_code ON station_bounds(full_code);
        `
      },
      {
        name: '006_create_settings',
        sql: `
          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `
      },
      {
        name: '007_create_devices',
        sql: `
          CREATE TABLE IF NOT EXISTS devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            protocol TEXT NOT NULL,
            connection_type TEXT NOT NULL,
            config TEXT NOT NULL,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_devices_type ON devices(type);
        `
      },
      {
        name: '008_create_thresholds',
        sql: `
          CREATE TABLE IF NOT EXISTS thresholds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            mode TEXT NOT NULL,
            min_weight INTEGER NOT NULL DEFAULT 200,
            max_weight INTEGER NOT NULL DEFAULT 100000,
            vehicle_detection INTEGER NOT NULL DEFAULT 500,
            stable_tolerance INTEGER NOT NULL DEFAULT 50,
            motion_timeout INTEGER NOT NULL DEFAULT 5000,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_thresholds_mode ON thresholds(mode);
        `
      },
      {
        name: '009_create_rdu_devices',
        sql: `
          CREATE TABLE IF NOT EXISTS rdu_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            connection_type TEXT NOT NULL,
            port TEXT,
            host TEXT,
            network_port INTEGER,
            baud_rate INTEGER DEFAULT 1200,
            deck_index INTEGER NOT NULL,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_rdu_type ON rdu_devices(type);
        `
      },
      {
        name: '010_create_autoweigh_config',
        sql: `
          CREATE TABLE IF NOT EXISTS autoweigh_config (
            id INTEGER PRIMARY KEY,
            enabled INTEGER DEFAULT 0,
            server_host TEXT,
            server_port INTEGER DEFAULT 4444,
            protocol TEXT DEFAULT 'http',
            auth_endpoint TEXT DEFAULT '/AuthManagement/Login',
            post_endpoint TEXT DEFAULT '/autoweigh',
            data_format TEXT DEFAULT 'truload',
            email TEXT,
            password TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `
      },
      {
        name: '011_add_threshold_value',
        sql: `
          ALTER TABLE thresholds ADD COLUMN threshold_value INTEGER NOT NULL DEFAULT 50;
        `
      },
      {
        name: '012_update_default_capture_mode',
        sql: `
          UPDATE settings SET value = 'mobile', updated_at = CURRENT_TIMESTAMP
          WHERE key = 'app.captureMode' AND value = 'multideck';
        `
      },
      {
        name: '013_create_rdu_models',
        sql: `
          -- RDU Model presets table
          CREATE TABLE IF NOT EXISTS rdu_models (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            model_code TEXT UNIQUE NOT NULL,
            model_name TEXT NOT NULL,
            manufacturer TEXT NOT NULL,
            format_string TEXT NOT NULL,
            format_description TEXT,
            baud_rate INTEGER DEFAULT 1200,
            is_active INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_rdu_models_code ON rdu_models(model_code);

          -- Seed KELI model (reversed digits, trailing zeros)
          INSERT OR IGNORE INTO rdu_models (model_code, model_name, manufacturer, format_string, format_description, baud_rate, is_active)
          VALUES ('KELI', 'KELI DPM Remote Display', 'KELI Sensing (Ningbo)', '$={WEIGHT}=', 'Weight reversed and trailing zero padded to 8 digits. Example: 200 -> $=00200000=', 1200, 0);

          -- Seed Yaohua YHL model (same as KELI - uses Keli/Yaohua protocol)
          INSERT OR IGNORE INTO rdu_models (model_code, model_name, manufacturer, format_string, format_description, baud_rate, is_active)
          VALUES ('YAOHUA_YHL', 'Yaohua YHL Scoreboard', 'Shanghai Yaohua', '$={WEIGHT}=', 'Compatible with KELI format. Weight reversed and trailing zero padded.', 600, 0);

          -- Seed XK3190 large screen display
          INSERT OR IGNORE INTO rdu_models (model_code, model_name, manufacturer, format_string, format_description, baud_rate, is_active)
          VALUES ('XK3190', 'XK3190 Large Screen Display', 'Yaohua/Generic Chinese', '={WEIGHT}=', 'Standard XK3190 scoreboard format. Weight reversed and trailing zero padded.', 600, 0);

          -- Seed Cardinal Remote Display
          INSERT OR IGNORE INTO rdu_models (model_code, model_name, manufacturer, format_string, format_description, baud_rate, is_active)
          VALUES ('CARDINAL', 'Cardinal Remote Display', 'Cardinal Scale', '{WEIGHT}', 'Simple weight format with leading zeros. Example: 200 -> 00000200', 9600, 0);

          -- Seed Avery Weigh-Tronix
          INSERT OR IGNORE INTO rdu_models (model_code, model_name, manufacturer, format_string, format_description, baud_rate, is_active)
          VALUES ('AVERY_WT', 'Avery Weigh-Tronix Display', 'Avery Weigh-Tronix', 'W{WEIGHT}', 'Avery format with W prefix and leading zeros.', 9600, 0);

          -- Seed Generic model (leading zeros only)
          INSERT OR IGNORE INTO rdu_models (model_code, model_name, manufacturer, format_string, format_description, baud_rate, is_active)
          VALUES ('GENERIC', 'Generic LED Display', 'Various', '{WEIGHT}', 'Simple format with leading zeros to 8 digits. Example: 200 -> 00000200', 1200, 0);

          -- Create trigger to ensure only one RDU model is active at a time
          CREATE TRIGGER IF NOT EXISTS trg_exclusive_rdu_active
          AFTER UPDATE OF is_active ON rdu_models
          WHEN NEW.is_active = 1
          BEGIN
            UPDATE rdu_models SET is_active = 0 WHERE id != NEW.id AND is_active = 1;
          END;
        `
      }
    ];
  }

  /**
   * Execute a raw SQL query
   */
  exec(sql) {
    return this.db.exec(sql);
  }

  /**
   * Prepare a statement
   */
  prepare(sql) {
    return this.db.prepare(sql);
  }

  /**
   * Run a query and return all results
   */
  all(sql, params = []) {
    return this.db.prepare(sql).all(...(Array.isArray(params) ? params : [params]));
  }

  /**
   * Run a query and return first result
   */
  get(sql, params = []) {
    return this.db.prepare(sql).get(...(Array.isArray(params) ? params : [params]));
  }

  /**
   * Run an insert/update/delete
   */
  run(sql, params = []) {
    return this.db.prepare(sql).run(...(Array.isArray(params) ? params : [params]));
  }

  /**
   * Execute multiple statements in a transaction
   */
  transaction(fn) {
    return this.db.transaction(fn)();
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.isInitialized = false;
      EventBus.emit('database:closed');
    }
  }

  /**
   * Get database stats
   */
  getStats() {
    const pragma = this.db.pragma('database_list', { simple: true });
    return {
      path: this.options.dbPath,
      size: require('fs').statSync(this.options.dbPath).size,
      walMode: this.db.pragma('journal_mode', { simple: true }),
      tables: this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    };
  }
}

// Singleton instance
let instance = null;

module.exports = {
  /**
   * Get or create database instance
   */
  getInstance(options) {
    if (!instance) {
      instance = new DatabaseManager(options);
    }
    return instance;
  },

  /**
   * Initialize the database
   */
  initialize(options) {
    return this.getInstance(options).initialize();
  },

  /**
   * Get the database instance (must be initialized first)
   */
  getDb() {
    if (!instance || !instance.isInitialized) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return instance;
  },

  /**
   * Close the database
   */
  close() {
    if (instance) {
      instance.close();
      instance = null;
    }
  },

  // Re-export DatabaseManager for testing
  DatabaseManager
};
