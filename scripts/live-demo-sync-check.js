#!/usr/bin/env node
/**
 * Live verification script: runs TruConnect's REAL ConfigSyncService/BackendClient/
 * ComplianceEngine modules against the actual demo backend, using the dedicated
 * middleware-demo@truconnect.local service account (seeded by truload-backend's
 * UserSeeder.SeedMiddlewareDemoServiceUserAsync, linked to CODEVERTEX-DEMO org /
 * DEMO-WB-01 station - see that file's own doc comment for why this account exists
 * separately from the live middleware@truconnect.local one).
 *
 * This is a MANUAL/ops verification script, not part of the automated tests/ suite -
 * it makes real network calls to a real backend and should be run deliberately, not in
 * CI. Read-only by default: it syncs reference data and computes an offline compliance
 * preview from it, but never posts a real weighing (no --allow-write, no autoweigh/
 * complete call is ever made).
 *
 * Requires a Node runtime whose ABI matches the compiled better-sqlite3 binary (the
 * repo has no test runner set up for anything else) - e.g. via Electron's own bundled
 * Node:
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron.cmd scripts/live-demo-sync-check.js
 *
 * Override any of these via environment variables if your demo backend/credentials
 * differ from the documented defaults:
 *   TRUCONNECT_DEMO_BASE_URL   (default: https://truloadapi.codevertexafrica.com - the
 *                                real production ingress host, devops-k8s
 *                                apps/truload-backend/values.yaml. NOT
 *                                kuraweighapitest.masterspace.co.ke, a legacy pre-rebrand
 *                                test-era hostname that truload-docs' own Swagger link
 *                                still stales-references - that domain resolves to the
 *                                raw cluster IP with no CDN in front of it, unlike every
 *                                current codevertexafrica.com host.)
 *   TRUCONNECT_DEMO_EMAIL      (default: middleware-demo@truconnect.local)
 *   TRUCONNECT_DEMO_PASSWORD   (default: ChangeMe123! - truload-backend UserSeeder's
 *                                documented, non-secret demo/dev default)
 *   TRUCONNECT_DEMO_STATION_CODE (default: DEMO-WB-01)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const BASE_URL = process.env.TRUCONNECT_DEMO_BASE_URL || 'https://truloadapi.codevertexafrica.com';
const EMAIL = process.env.TRUCONNECT_DEMO_EMAIL || 'middleware-demo@truconnect.local';
const PASSWORD = process.env.TRUCONNECT_DEMO_PASSWORD || 'ChangeMe123!';
const STATION_CODE = process.env.TRUCONNECT_DEMO_STATION_CODE || 'DEMO-WB-01';

function log(label, ...rest) {
  console.log(`[live-demo-check] ${label}`, ...rest);
}

async function main() {
  const dbPath = path.join(os.tmpdir(), `truconnect-livedemo-${Date.now()}.db`);
  log('Using temp DB:', dbPath);
  log('Target backend:', BASE_URL);
  log('Demo account:', EMAIL);

  const Database = require('../src/database/Database');
  Database.initialize({ dbPath });

  const BackendClient = require('../src/backend/BackendClient');
  const ConfigSyncService = require('../src/backend/ConfigSyncService');
  const ComplianceEngine = require('../src/backend/ComplianceEngine');
  const ConfigManager = require('../src/config/ConfigManager').getInstance();
  ConfigManager.initialize(Database.getDb());
  ConfigManager.set('station.code', STATION_CODE);

  BackendClient.initialize({
    enabled: true,
    baseUrl: BASE_URL,
    authEndpoint: '/api/v1/auth/login',
    autoweighEndpoint: '/api/v1/weighing-transactions/autoweigh',
    email: EMAIL,
    password: PASSWORD,
    stationId: null,
    bound: 'A'
  });

  // -----------------------------------------------------------------
  // Step 1: real authentication against the live backend.
  // -----------------------------------------------------------------
  log('Authenticating...');
  const authOk = await BackendClient.authenticate();
  if (!authOk) {
    log('AUTH FAILED. Nothing else in this script can run. Check TRUCONNECT_DEMO_* env vars and network reachability.');
    process.exitCode = 1;
    Database.close();
    return;
  }
  log('Authenticated successfully.');

  // -----------------------------------------------------------------
  // Step 2: real reference-data sync (Stations, AxleConfiguration +
  // weight references, ToleranceSettings) - read-only GET calls only.
  // -----------------------------------------------------------------
  log('Running ConfigSyncService.runSync() against the live backend...');
  const summary = await ConfigSyncService.runSync();
  log('Sync summary:', JSON.stringify(summary, null, 2));

  if (!summary.success) {
    log('SYNC REPORTED AN ERROR:', summary.error);
  }

  const db = Database.getDb();
  const stations = db.all('SELECT code, name, organization_name FROM backend_stations');
  log(`Synced ${stations.length} station(s):`, stations.map((s) => `${s.code} (${s.name})`).join(', ') || 'none');

  const configs = db.all('SELECT id, axle_code, axle_name, axle_number FROM backend_axle_configurations');
  log(`Synced ${configs.length} axle configuration(s).`);

  const refCounts = db.all(`
    SELECT axle_configuration_id, COUNT(*) as n
    FROM backend_axle_weight_references
    GROUP BY axle_configuration_id
  `);
  const refCountMap = new Map(refCounts.map((r) => [r.axle_configuration_id, r.n]));
  for (const c of configs) {
    log(`  - ${c.axle_code} (${c.axle_name || 'unnamed'}): ${c.axle_number} axles, ${refCountMap.get(c.id) || 0} weight reference(s) synced`);
  }

  const toleranceCount = db.get('SELECT COUNT(*) as n FROM backend_tolerance_settings').n;
  log(`Synced ${toleranceCount} tolerance setting row(s).`);

  if (!summary.stationId) {
    log(`WARNING: local station.code '${STATION_CODE}' did not resolve to a backend station GUID - check it matches one of the synced station codes above.`);
  } else {
    log(`Station resolved: ${summary.stationId}`);
  }

  // -----------------------------------------------------------------
  // Step 3: prove the FULL offline-decision pipeline against REAL
  // synced reference data - pick the first config that has weight
  // references and compute a compliance preview using its own
  // permissible weights (so the input is guaranteed schema-valid).
  // -----------------------------------------------------------------
  const configWithRefs = configs.find((c) => (refCountMap.get(c.id) || 0) > 0);
  if (!configWithRefs) {
    log('No synced axle configuration has weight references yet - cannot demonstrate the local compliance engine against real data. This is expected if the demo tenant has no axle configs seeded; not a code defect.');
  } else {
    const refs = db.all('SELECT * FROM backend_axle_weight_references WHERE axle_configuration_id = ? ORDER BY axle_position', [configWithRefs.id]);
    const axles = refs.map((r) => ({ axleNumber: r.axle_position, measuredWeightKg: r.axle_legal_weight_kg }));
    log(`Computing a local compliance preview for ${configWithRefs.axle_code} using its own permissible weights as the reading (expect LEGAL, zero overload)...`);
    const result = ComplianceEngine.computeOfflineComplianceFromDb(db, { axleConfigurationId: configWithRefs.id, axles });
    if (!result) {
      log('FAILED: computeOfflineComplianceFromDb returned null against real synced data - this would be a real bug.');
      process.exitCode = 1;
    } else {
      log('Local compliance result:', JSON.stringify(result, null, 2));
      if (result.overallStatus === 'LEGAL' && result.gvwOverloadKg === 0) {
        log('CONFIRMED: the full offline pipeline (real sync -> local SQLite mirror -> ComplianceEngine) works end-to-end against live demo data.');
      } else {
        log(`NOTE: expected LEGAL/0 overload feeding the config its own permissible weights, got ${result.overallStatus}/${result.gvwOverloadKg}kg - worth a second look, though a non-zero operational allowance could explain a small WARNING.`);
      }
    }
  }

  log('Read-only verification complete. No weighing was posted to the live backend (use --allow-write and extend this script deliberately if that is ever needed).');

  Database.close();
  try {
    fs.unlinkSync(dbPath);
    fs.unlinkSync(dbPath + '-wal');
    fs.unlinkSync(dbPath + '-shm');
  } catch {
    // best-effort cleanup
  }
}

main().catch((err) => {
  console.error('[live-demo-check] Script crashed:', err);
  process.exitCode = 1;
});
