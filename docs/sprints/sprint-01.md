# Sprint 01: Core Infrastructure & Database

**Duration**: 3-4 days  
**Goal**: Establish robust foundation with SQLite database, configuration management, and modular architecture

---

## Objectives

1. Upgrade project dependencies to latest versions
2. Restructure codebase into modular architecture
3. Implement enhanced SQLite database with migrations
4. Create comprehensive configuration management system
5. Seed default admin user and settings

---

## Tasks

### 1.1 Dependency Upgrades
- [x] Update `package.json` with latest versions:
  - electron: ^33.3.1
  - better-sqlite3: ^11.7.0 (sync, faster than sqlite3)
  - serialport: ^12.0.0
  - ws: ^8.18.0
  - express: ^4.21.2
  - axios: ^1.7.9
  - bcryptjs: ^2.4.3 (for password hashing)
- [x] Run `pnpm install` and verify no breaking changes
- [x] Update to pnpm package manager

### 1.2 Project Structure Setup
- [x] Create `src/` directory structure:
  ```
  src/
  ├── core/
  ├── input/
  ├── parsers/
  ├── output/
  ├── simulation/
  ├── auth/
  ├── database/
  └── config/
  ```
- [x] Create `src/database/Database.js` with better-sqlite3
- [x] Create `src/config/ConfigManager.js`
- [x] Create `src/core/EventBus.js` and `StateManager.js`

### 1.3 Database Enhancement
- [x] Create `src/database/Database.js`:
  - Use better-sqlite3 for synchronous operations
  - Connection pooling/management
  - Transaction support
- [x] Create migration system in Database.js:
  - Version tracking table
  - Migration runner
- [x] Create `src/database/Seed.js`:
  - Default settings insertion
  - Default admin user creation
- [x] Define tables:
  - settings (key, value, updated_at)
  - users (id, email, password_hash, role, created_at, updated_at)
  - sessions (for auth tokens)
  - thresholds (weight validation config)
  - devices, rdu_devices, custom_protocols, stations, station_bounds
  - autoweigh_config

### 1.4 Configuration System
- [x] Create `src/config/defaults.js`:
  - All default configuration values
  - Reset-to-defaults logic
  - Threshold configuration for mobile/multideck
  - Mobile mode workflow settings
- [x] Refactor `ConfigManager.js` to support new schema:
  - `GeneralSettings`: Add `mode` ('mobile'|'multideck') and `bidirectional`.
  - `ConnectionConfig`: `defaultMode` ('realtime'|'polling'), `wsPool`, and `apiPort`.
  - `OutputConfig`: `rdu` (direct/usrn), `autoweigh` (kenloadv2/truload formats).
  - Nested configuration support
  - Real-time config updates via events

### 1.5 Admin User Seeding
- [x] Hash default password: `Admin@123!`
- [x] Seed admin user on first run:
  - Email: `admin@truconnect.local`
  - Role: `admin`
- [x] Add developer info to about section:
  - Name: Titus Owuor
  - Company: Covertext IT Solutions
  - Address: Oginga Street, Kisumu
  - Tel: +254743793901

---

## Deliverables

1. Updated `package.json` with latest dependencies
2. Restructured project directory
3. Enhanced database module with migrations
4. Configuration management with defaults
5. Seeded admin user

---

## Verification

### Unit Tests
```bash
# Run configuration tests
npm test -- --grep "ConfigManager"

# Run database tests  
npm test -- --grep "Database"
```

### Manual Verification
1. Delete existing `truconnect.db`
2. Run `npm start`
3. Verify database is created with tables
4. Verify default settings are inserted
5. Verify admin user exists in users table
6. Check logs for successful initialization
