/**
 * Seed - Default data seeding for TruConnect
 *
 * IMPORTANT: This module ensures the database is initialized with migrations
 * before running any seeds. All seeds are versioned and idempotent.
 *
 * Seeds:
 * - Default admin user
 * - Default settings from defaults.js
 * - Sample station configurations
 * - Default thresholds
 */

const bcrypt = require('bcryptjs');
const defaults = require('../config/defaults');

// Current seed version - increment when adding new seeds
// v2.1.0: New input configuration structure with separate scale/indicator configs
const SEED_VERSION = '2.1.2';

const DEFAULT_ADMIN = {
  email: 'admin@codevertexitsolutions.com',
  password: 'Admin@123!',
  role: 'admin'
};

const TRUCONNECT_OPERATOR = {
  email: 'user@truconnect.com',
  password: 'User@1234',
  role: 'operator'
};

const DEFAULT_STATIONS = [
  {
    base_code: 'NRB',
    station_name: 'Nairobi Region Mobile Unit',
    bidirectional: false,
    multi_deck_per_bound: false,
    bounds: [
      { letter: 'A', full_code: 'NRBA', name: 'Default' },
    ]
  },
  {
    base_code: 'NYZ',
    station_name: 'Nyanza Region Mobile Unit',
    bidirectional: false,
    multi_deck_per_bound: false,
    bounds: [
      { letter: 'A', full_code: 'NYZA', name: 'Lane A' },
    ]
  }
];

/**
 * Flatten defaults object into key-value pairs for settings table
 */
function flattenDefaults(obj, prefix = '') {
  const result = {};

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenDefaults(value, fullKey));
    } else {
      // Convert arrays and other values to string
      result[fullKey] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
  }

  return result;
}

/**
 * Get settings to seed from defaults.js
 */
function getDefaultSettings() {
  // Exclude certain keys from seeding (they're structural, not settings)
  const excludeKeys = ['developer'];

  const flattened = flattenDefaults(defaults);

  // Filter out excluded keys
  const filtered = {};
  for (const [key, value] of Object.entries(flattened)) {
    const shouldExclude = excludeKeys.some(exclude => key.startsWith(exclude));
    if (!shouldExclude) {
      filtered[key] = value;
    }
  }

  return filtered;
}

/**
 * Ensure seed_versions table exists
 */
function ensureSeedVersionsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS seed_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seed_name TEXT NOT NULL,
      version TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(seed_name, version)
    )
  `);
}

/**
 * Check if a seed version has already been applied
 */
function isSeedApplied(db, seedName, version) {
  const existing = db.get(
    'SELECT id FROM seed_versions WHERE seed_name = ? AND version = ?',
    [seedName, version]
  );
  return !!existing;
}

/**
 * Mark a seed as applied
 */
function markSeedApplied(db, seedName, version) {
  db.run(
    'INSERT OR IGNORE INTO seed_versions (seed_name, version) VALUES (?, ?)',
    [seedName, version]
  );
}

/**
 * Seed the database with default data (idempotent)
 *
 * IMPORTANT: This function ensures the database is initialized first.
 * It will run migrations if they haven't been run yet.
 */
async function seed(options = {}) {
  const { force = false } = options;

  // Import Database module and ensure it's initialized
  const Database = require('./Database');

  console.log('Ensuring database is initialized before seeding...');

  // Initialize database (this runs migrations)
  Database.initialize();

  const db = Database.getDb();

  console.log(`Starting database seed (version ${SEED_VERSION})...`);

  // Ensure seed_versions table exists
  ensureSeedVersionsTable(db);

  // Seed admin and operator users
  await seedAdminUser(db, force);
  await seedOperatorUser(db, force);

  // Seed default settings from defaults.js
  await seedSettings(db, force);

  // Seed sample stations
  await seedStations(db, force);

  // Seed default thresholds
  await seedThresholds(db, force);

  // Seed default autoweigh config
  await seedAutoweighConfig(db, force);

  console.log('Database seed complete.');
}

/**
 * Seed admin user if not exists
 */
async function seedAdminUser(db, force = false) {
  const seedName = 'admin_user';

  if (!force && isSeedApplied(db, seedName, SEED_VERSION)) {
    console.log('Admin user seed already applied, skipping...');
    return;
  }

  const existingAdmin = db.get('SELECT id FROM users WHERE email = ?', [DEFAULT_ADMIN.email]);

  // Hash password
  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(DEFAULT_ADMIN.password, salt);

  if (existingAdmin) {
    if (force) {
      db.run(
        'UPDATE users SET password_hash = ?, role = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?',
        [passwordHash, DEFAULT_ADMIN.role, DEFAULT_ADMIN.email]
      );
      console.log('Admin user updated.');
    } else {
      console.log('Admin user already exists, skipping...');
    }
  } else {
    db.run(
      'INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)',
      [DEFAULT_ADMIN.email, passwordHash, DEFAULT_ADMIN.role]
    );
    console.log('Admin user created.');
  }

  markSeedApplied(db, seedName, SEED_VERSION);
}

/**
 * Seed operator user if not exists
 */
async function seedOperatorUser(db, force = false) {
  const seedName = 'operator_user';

  if (!force && isSeedApplied(db, seedName, SEED_VERSION)) {
    console.log('Operator user seed already applied, skipping...');
    return;
  }

  const existingUser = db.get('SELECT id FROM users WHERE email = ?', [TRUCONNECT_OPERATOR.email]);

  // Hash password
  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(TRUCONNECT_OPERATOR.password, salt);

  if (existingUser) {
    if (force) {
      db.run(
        'UPDATE users SET password_hash = ?, role = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?',
        [passwordHash, TRUCONNECT_OPERATOR.role, TRUCONNECT_OPERATOR.email]
      );
      console.log('Operator user updated.');
    } else {
      console.log('Operator user already exists, skipping...');
    }
  } else {
    db.run(
      'INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)',
      [TRUCONNECT_OPERATOR.email, passwordHash, TRUCONNECT_OPERATOR.role]
    );
    console.log('Operator user created.');
  }

  markSeedApplied(db, seedName, SEED_VERSION);
}

/**
 * Seed default settings from defaults.js
 */
async function seedSettings(db, force = false) {
  const seedName = 'default_settings';

  if (!force && isSeedApplied(db, seedName, SEED_VERSION)) {
    console.log('Settings seed already applied, skipping...');
    return;
  }

  const defaultSettings = getDefaultSettings();
  let inserted = 0;
  let updated = 0;

  for (const [key, value] of Object.entries(defaultSettings)) {
    const existing = db.get('SELECT key FROM settings WHERE key = ?', [key]);

    if (!existing) {
      db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
      inserted++;
    } else if (force) {
      db.run('UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?', [value, key]);
      updated++;
    }
  }

  console.log(`Settings seeded: ${inserted} inserted, ${updated} updated.`);
  markSeedApplied(db, seedName, SEED_VERSION);
}

/**
 * Seed sample stations
 */
async function seedStations(db, force = false) {
  const seedName = 'sample_stations';

  if (!force && isSeedApplied(db, seedName, SEED_VERSION)) {
    console.log('Stations seed already applied, skipping...');
    return;
  }

  db.transaction(() => {
    for (const station of DEFAULT_STATIONS) {
      const existing = db.get('SELECT id FROM stations WHERE base_code = ?', [station.base_code]);
      if (existing && !force) continue;

      let stationId;

      if (existing) {
        db.run(
          `UPDATE stations SET station_name = ?, bidirectional = ?, multi_deck_per_bound = ?
           WHERE base_code = ?`,
          [station.station_name, station.bidirectional ? 1 : 0, station.multi_deck_per_bound ? 1 : 0, station.base_code]
        );
        stationId = existing.id;
        db.run('DELETE FROM station_bounds WHERE station_id = ?', [stationId]);
      } else {
        const result = db.run(
          `INSERT INTO stations (base_code, station_name, bidirectional, multi_deck_per_bound)
           VALUES (?, ?, ?, ?)`,
          [station.base_code, station.station_name, station.bidirectional ? 1 : 0, station.multi_deck_per_bound ? 1 : 0]
        );
        stationId = result.lastInsertRowid;
      }

      for (const bound of station.bounds) {
        db.run(
          `INSERT INTO station_bounds (station_id, bound_letter, full_code, bound_name)
           VALUES (?, ?, ?, ?)`,
          [stationId, bound.letter, bound.full_code, bound.name]
        );
      }

      console.log(`Station ${station.station_name} seeded.`);
    }
  });

  markSeedApplied(db, seedName, SEED_VERSION);
}

/**
 * Seed default thresholds
 */
async function seedThresholds(db, force = false) {
  const seedName = 'default_thresholds';

  if (!force && isSeedApplied(db, seedName, SEED_VERSION)) {
    console.log('Thresholds seed already applied, skipping...');
    return;
  }

  const thresholdConfigs = [
    {
      name: 'default_multideck',
      mode: 'multideck',
      min_weight: defaults.thresholds.multideck.minWeight,
      max_weight: defaults.thresholds.multideck.maxWeight,
      vehicle_detection: defaults.thresholds.multideck.vehicleDetection,
      stable_tolerance: defaults.thresholds.multideck.stableTolerance,
      motion_timeout: defaults.thresholds.multideck.motionTimeout
    },
    {
      name: 'default_mobile',
      mode: 'mobile',
      min_weight: defaults.thresholds.mobile.minAxleWeight,
      max_weight: defaults.thresholds.mobile.maxAxleWeight,
      vehicle_detection: defaults.thresholds.multideck.vehicleDetection,
      stable_tolerance: defaults.thresholds.mobile.stableTolerance,
      motion_timeout: defaults.thresholds.mobile.motionTimeout
    }
  ];

  for (const config of thresholdConfigs) {
    const existing = db.get('SELECT id FROM thresholds WHERE name = ?', [config.name]);

    if (!existing) {
      db.run(
        `INSERT INTO thresholds (name, mode, min_weight, max_weight, vehicle_detection, stable_tolerance, motion_timeout)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [config.name, config.mode, config.min_weight, config.max_weight, config.vehicle_detection, config.stable_tolerance, config.motion_timeout]
      );
      console.log(`Threshold ${config.name} created.`);
    } else if (force) {
      db.run(
        `UPDATE thresholds SET mode = ?, min_weight = ?, max_weight = ?, vehicle_detection = ?,
         stable_tolerance = ?, motion_timeout = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?`,
        [config.mode, config.min_weight, config.max_weight, config.vehicle_detection, config.stable_tolerance, config.motion_timeout, config.name]
      );
      console.log(`Threshold ${config.name} updated.`);
    }
  }

  markSeedApplied(db, seedName, SEED_VERSION);
}

/**
 * Seed default autoweigh config
 */
async function seedAutoweighConfig(db, force = false) {
  const seedName = 'default_autoweigh';

  if (!force && isSeedApplied(db, seedName, SEED_VERSION)) {
    console.log('Autoweigh config seed already applied, skipping...');
    return;
  }

  const existing = db.get('SELECT id FROM autoweigh_config WHERE id = 1');

  if (!existing) {
    db.run(
      `INSERT INTO autoweigh_config (id, enabled, server_host, server_port, protocol, data_format)
       VALUES (1, 0, '', 4444, 'http', 'truload')`
    );
    console.log('Autoweigh config created.');
  }

  markSeedApplied(db, seedName, SEED_VERSION);
}

/**
 * Create a new user
 */
function createUser(email, password, role = 'operator') {
  const Database = require('./Database');
  const db = Database.getDb();

  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(password, salt);

  const result = db.run(
    'INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)',
    [email, passwordHash, role]
  );

  return {
    id: result.lastInsertRowid,
    email,
    role
  };
}

/**
 * Get all users (without password hash)
 */
function getUsers() {
  const Database = require('./Database');
  const db = Database.getDb();
  return db.all('SELECT id, email, role, is_active, created_at FROM users');
}

/**
 * Get current seed version
 */
function getSeedVersion() {
  return SEED_VERSION;
}

/**
 * Get all applied seeds
 */
function getAppliedSeeds() {
  const Database = require('./Database');
  const db = Database.getDb();
  try {
    return db.all('SELECT * FROM seed_versions ORDER BY applied_at DESC');
  } catch (e) {
    return [];
  }
}

module.exports = {
  seed,
  seedAdminUser,
  seedSettings,
  seedStations,
  seedThresholds,
  seedAutoweighConfig,
  createUser,
  getUsers,
  getSeedVersion,
  getAppliedSeeds,
  DEFAULT_ADMIN,
  SEED_VERSION
};
