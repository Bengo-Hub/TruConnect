/**
 * Standalone verification script for the offline-weighing redesign's SQLite-touching
 * paths that the implementing session could not originally run (no native-module
 * toolchain) - ConfigSyncService's new AxleWeightReference/ToleranceSetting mirrors,
 * ComplianceEngine.computeOfflineComplianceFromDb, LocalWeighingStore, and
 * BackendClient's "always persist locally first" behaviour (awaiting_station_resolution
 * and commercial local_only paths). Run with a Node runtime whose ABI matches the
 * compiled better-sqlite3 binary - e.g. via Electron's own bundled Node:
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron.cmd tests/local-weighing-and-db-integration-test.js
 *
 * Mirrors the existing sync-queue-and-config-sync-test.js's structure and conventions
 * (no test framework in this repo, plain assert() + a temp on-disk DB per run).
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    failures++;
    console.error(`[FAIL] ${message}`);
  } else {
    console.log(`[OK]   ${message}`);
  }
}

async function main() {
  const dbPath = path.join(os.tmpdir(), `truconnect-dbtest-${Date.now()}.db`);
  console.log(`Using temp DB: ${dbPath}`);

  const Database = require('../src/database/Database');
  Database.initialize({ dbPath });

  const BackendClient = require('../src/backend/BackendClient');
  const ConfigSyncService = require('../src/backend/ConfigSyncService');
  const ComplianceEngine = require('../src/backend/ComplianceEngine');
  const LocalWeighingStore = require('../src/backend/LocalWeighingStore');
  const ConfigManager = require('../src/config/ConfigManager').getInstance();
  ConfigManager.initialize(Database.getDb());

  BackendClient.initialize({
    enabled: true,
    baseUrl: 'http://fake-backend.local',
    autoweighEndpoint: '/api/v1/weighing-transactions/autoweigh',
    email: 'middleware@truconnect.local',
    password: 'ChangeMe123!',
    stationId: null,
    bound: 'A'
  });
  const client = BackendClient.getInstance();
  client._getAuthHeader = async () => 'Bearer fake-token';

  // ---------------------------------------------------------------------
  // (a) ConfigSyncService: AxleWeightReference + ToleranceSetting mirrors,
  // sourced from realistic backend DTO shapes (byte-shaped like the real
  // AxleConfigurationResponseDto / ToleranceSettingDto).
  // ---------------------------------------------------------------------
  console.log('\n--- (a) ConfigSyncService: full reference-data sync ---');

  const AXLE_CONFIG_ID = '11111111-1111-1111-1111-111111111111';
  const STATION_ID = '00000000-0000-0000-0000-000000000001';

  const fakeStations = [
    { id: STATION_ID, code: 'NRB-01', name: 'Nairobi Weighbridge 1', stationType: 'Mobile',
      organizationId: 'org-1', organizationName: 'Demo Org', supportsBidirectional: false,
      boundACode: 'A', boundBCode: 'B', isActive: true }
  ];
  const AXLE_CONFIG_ID_DERIVED = '22222222-2222-2222-2222-222222222222';
  const fakeAxleConfigs = [
    {
      id: AXLE_CONFIG_ID, axleCode: '3A', axleName: 'Tridem 3-axle', axleNumber: 3,
      gvwPermissibleKg: 26000, isStandard: true, isActive: true,
      legalFramework: 'TRAFFIC_ACT', toleranceKg: 3000,
      weightReferences: [
        { id: 'wr-1', axlePosition: 1, axleLegalWeightKg: 8000, axleGroupId: null, axleGrouping: 'A', isActive: true },
        { id: 'wr-2', axlePosition: 2, axleLegalWeightKg: 9000, axleGroupId: null, axleGrouping: 'B', isActive: true },
        { id: 'wr-3', axlePosition: 3, axleLegalWeightKg: 9000, axleGroupId: null, axleGrouping: 'B', isActive: true }
      ]
    },
    // Non-standard/derived, fewer axles, alphabetically-earlier code - deliberately
    // constructed so the OLD ordering (axle_number, axle_code) would list this BEFORE
    // the standard 3A above, and the NEW ordering (is_standard DESC, ...) must not
    // (2026-09-12 fix: standard configs list first regardless of axle count).
    {
      id: AXLE_CONFIG_ID_DERIVED, axleCode: '2X-CUSTOM', axleName: 'Derived 2-axle', axleNumber: 2,
      gvwPermissibleKg: 18000, isStandard: false, isActive: true,
      legalFramework: 'TRAFFIC_ACT', toleranceKg: null, weightReferences: []
    }
  ];
  const fakeTolerances = [
    { id: 't-1', code: 'TRAFFIC_ACT_AXLE_TOLERANCE', legalFramework: 'TRAFFIC_ACT', tolerancePercentage: 5, toleranceKg: null, appliesTo: 'AXLE', isActive: true },
    { id: 't-2', code: 'TRAFFIC_ACT_GVW_TOLERANCE', legalFramework: 'TRAFFIC_ACT', tolerancePercentage: 0, toleranceKg: 3000, appliesTo: 'GVW', isActive: true },
    { id: 't-3', code: 'STANDARD_LAW_GROUP', legalFramework: 'GLOBAL', tolerancePercentage: 0, toleranceKg: null, appliesTo: 'BOTH', isActive: true },
    { id: 't-4', code: 'OPERATIONAL_ALLOWANCE', legalFramework: 'GLOBAL', tolerancePercentage: 0, toleranceKg: 200, appliesTo: 'BOTH', isActive: true }
  ];

  // resolveAndApplyStationId() matches the OPERATOR-TYPED local station.code setting
  // (Settings screen, in the real app) against the synced backend_stations.code - it
  // never guesses, so the test must set this up explicitly too.
  ConfigManager.set('station.code', 'NRB-01');

  const fakeOrganization = { tenantType: 'CommercialWeighing', selectedLegalFramework: 'TRAFFIC_ACT' };

  client._fetch = async (url) => {
    if (url.includes('/organizations/current')) return { ok: true, json: async () => fakeOrganization };
    if (url.includes('/Stations')) return { ok: true, json: async () => fakeStations };
    if (url.includes('/AxleConfiguration')) return { ok: true, json: async () => fakeAxleConfigs };
    if (url.includes('/acts/tolerances')) {
      const framework = new URL(url).searchParams.get('legalFramework');
      return { ok: true, json: async () => fakeTolerances.filter((t) => t.legalFramework === framework || t.legalFramework === 'GLOBAL') };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };

  const syncSummary = await ConfigSyncService.runSync();
  assert(syncSummary.success, `runSync() reports success (error=${syncSummary.error})`);
  assert(syncSummary.stationsCount === 1, `synced 1 station (got ${syncSummary.stationsCount})`);
  assert(syncSummary.axleConfigCount === 2, `synced 2 axle configs (got ${syncSummary.axleConfigCount})`);
  assert(syncSummary.toleranceSettingsCount >= 2, `synced tolerance settings (got ${syncSummary.toleranceSettingsCount})`);

  const syncedStatus = ConfigSyncService.getStatus();
  assert(syncedStatus.selectedLegalFramework === 'TRAFFIC_ACT', `org's selected legal framework cached locally (got ${syncedStatus.selectedLegalFramework})`);
  assert(syncedStatus.axleConfigCount === 2, `getStatus() reports axle config count from the SQLite mirror, not lastSyncedAt (got ${syncedStatus.axleConfigCount})`);
  assert(syncedStatus.stationId === STATION_ID, `getStatus() reports the resolved station id (got ${syncedStatus.stationId})`);

  const db = Database.getDb();
  const refRows = db.all('SELECT * FROM backend_axle_weight_references WHERE axle_configuration_id = ?', [AXLE_CONFIG_ID]);
  assert(refRows.length === 3, `3 axle weight references persisted (got ${refRows.length})`);
  assert(refRows.find((r) => r.axle_position === 2).axle_grouping === 'B', 'axle position 2 correctly mapped to group B');

  const toleranceRows = db.all('SELECT * FROM backend_tolerance_settings');
  assert(toleranceRows.length >= 4, `tolerance settings persisted (got ${toleranceRows.length})`);

  // Standard-axle-first ordering (2026-09-12 fix): mirrors the exact ORDER BY main.js's
  // axle-config:list-local now uses. The 3-axle STANDARD config must list before the
  // 2-axle non-standard one, even though a plain axle_number/axle_code sort would have
  // put the 2-axle one first.
  const orderedConfigs = db.all(
    'SELECT id, axle_code, is_standard FROM backend_axle_configurations WHERE is_active = 1 ORDER BY is_standard DESC, axle_number, axle_code'
  );
  assert(orderedConfigs.length === 2, `both axle configs present for the ordering check (got ${orderedConfigs.length})`);
  assert(orderedConfigs[0].id === AXLE_CONFIG_ID && orderedConfigs[0].axle_code === '3A', `standard 3A lists first (got ${orderedConfigs[0] && orderedConfigs[0].axle_code})`);
  assert(orderedConfigs[1].id === AXLE_CONFIG_ID_DERIVED, `derived 2X-CUSTOM lists second despite fewer axles (got ${orderedConfigs[1] && orderedConfigs[1].axle_code})`);

  assert(client.config.stationId === STATION_ID, `station GUID resolved onto BackendClient.config.stationId (got ${client.config.stationId})`);

  // Re-run sync to confirm the delete-then-insert refresh doesn't duplicate rows.
  await ConfigSyncService.runSync();
  const refRowsAfterResync = db.all('SELECT * FROM backend_axle_weight_references WHERE axle_configuration_id = ?', [AXLE_CONFIG_ID]);
  assert(refRowsAfterResync.length === 3, `re-sync does not duplicate weight references (got ${refRowsAfterResync.length})`);

  // ---------------------------------------------------------------------
  // (b) ComplianceEngine.computeOfflineComplianceFromDb - the SQLite-glue
  // path that could not be exercised before (only the pure function was
  // testable without a native module).
  // ---------------------------------------------------------------------
  console.log('\n--- (b) ComplianceEngine.computeOfflineComplianceFromDb ---');

  const compliantResult = ComplianceEngine.computeOfflineComplianceFromDb(db, {
    axleConfigurationId: AXLE_CONFIG_ID,
    axles: [
      { axleNumber: 1, measuredWeightKg: 6600 },
      { axleNumber: 2, measuredWeightKg: 8700 },
      { axleNumber: 3, measuredWeightKg: 9300 }
    ]
  });
  assert(compliantResult !== null, 'computeOfflineComplianceFromDb returns a result when config+refs+tolerances are synced');
  assert(compliantResult.gvwMeasuredKg === 24600, `gvwMeasuredKg === 24600 (got ${compliantResult.gvwMeasuredKg})`);
  assert(compliantResult.gvwOverloadKg === 0, `no GVW overload (got ${compliantResult.gvwOverloadKg})`);
  assert(compliantResult.isCompliant === true, 'flagged compliant, matching the equivalent pure-function fixture');

  const overloadResult = ComplianceEngine.computeOfflineComplianceFromDb(db, {
    axleConfigurationId: AXLE_CONFIG_ID,
    axles: [
      { axleNumber: 1, measuredWeightKg: 9000 },
      { axleNumber: 2, measuredWeightKg: 12000 },
      { axleNumber: 3, measuredWeightKg: 12000 }
    ]
  });
  assert(overloadResult.overallStatus === 'OVERLOAD', `heavy load correctly flagged OVERLOAD (got ${overloadResult.overallStatus})`);
  const groupB = overloadResult.groupResults.find((g) => g.groupLabel === 'B');
  assert(groupB && groupB.overloadKg > 0, `group B (axles 2+3) shows a real overload (got ${groupB && groupB.overloadKg})`);

  const unknownConfigResult = ComplianceEngine.computeOfflineComplianceFromDb(db, {
    axleConfigurationId: 'not-a-real-config-id',
    axles: [{ axleNumber: 1, measuredWeightKg: 5000 }]
  });
  assert(unknownConfigResult === null, 'fails closed (returns null) for an unsynced/unknown axle configuration, never guesses');

  // legalFrameworkOverride (2026-09-12, N-axle commercial pre-compliance): the axle
  // config's OWN embedded framework (TRAFFIC_ACT) must NOT be what's used once an
  // override is passed - mirrors truload-backend resolving legalFramework from
  // Organization.SelectedLegalFramework for a commercial transaction, not the config's
  // tag. No EAC-specific tolerance row exists in this fixture set, so passing 'EAC' here
  // must fall back to the GLOBAL-only settings and therefore produce a DIFFERENT
  // (non-5%) axle tolerance than the TRAFFIC_ACT-default result above - proving the
  // override actually took effect rather than being silently ignored.
  const overrideResult = ComplianceEngine.computeOfflineComplianceFromDb(db, {
    axleConfigurationId: AXLE_CONFIG_ID,
    axles: [
      { axleNumber: 1, measuredWeightKg: 6600 },
      { axleNumber: 2, measuredWeightKg: 8700 },
      { axleNumber: 3, measuredWeightKg: 9300 }
    ],
    legalFrameworkOverride: 'EAC'
  });
  assert(overrideResult.legalFramework === 'EAC', `legalFrameworkOverride wins over the config's own TRAFFIC_ACT tag (got ${overrideResult && overrideResult.legalFramework})`);
  const overrideGroupB = overrideResult.groupResults.find((g) => g.groupLabel === 'B');
  const defaultGroupB = compliantResult.groupResults.find((g) => g.groupLabel === 'B');
  assert(overrideGroupB.toleranceKg !== defaultGroupB.toleranceKg,
    `EAC override falls back to GLOBAL-only tolerance (0%), genuinely different from TRAFFIC_ACT's 5% - not just accepted and ignored (got override=${overrideGroupB.toleranceKg}, default=${defaultGroupB.toleranceKg})`);

  // ---------------------------------------------------------------------
  // (c) LocalWeighingStore - direct CRUD/query behaviour
  // ---------------------------------------------------------------------
  console.log('\n--- (c) LocalWeighingStore ---');

  const localId1 = 'local-weighing-test-1';
  LocalWeighingStore.upsert({
    localId: localId1, mode: 'enforcement', vehicleRegNumber: 'KAA 001A',
    axleConfigurationId: AXLE_CONFIG_ID, axleReadings: [{ axleNumber: 1, weight: 6600 }],
    gvwMeasuredKg: 6600, provisionalResult: compliantResult, captureSource: 'auto',
    isFinal: false, syncStatus: 'queued'
  });
  const fetched = LocalWeighingStore.get(localId1);
  assert(fetched && fetched.vehicleRegNumber === 'KAA 001A', 'upsert + get round-trips a record correctly');
  assert(fetched.provisionalResult && fetched.provisionalResult.gvwMeasuredKg === 24600, 'provisionalResult JSON round-trips correctly');
  assert(fetched.isFinal === false, 'isFinal round-trips as a real boolean, not a raw 0/1');

  LocalWeighingStore.markSyncStatus(localId1, 'synced', 'backend-txn-123');
  const afterMark = LocalWeighingStore.get(localId1);
  assert(afterMark.syncStatus === 'synced' && afterMark.backendTransactionId === 'backend-txn-123', 'markSyncStatus updates status and backend id together');

  LocalWeighingStore.upsert({ localId: 'pending-1', mode: 'enforcement', vehicleRegNumber: 'KBZ 999Z', syncStatus: 'awaiting_station_resolution' });
  LocalWeighingStore.upsert({ localId: 'pending-2', mode: 'commercial', vehicleRegNumber: 'KCA 111B', syncStatus: 'local_only' });
  const pendingCount = LocalWeighingStore.countPending();
  assert(pendingCount === 1, `countPending only counts pending/queued/awaiting_station_resolution, not local_only or synced (got ${pendingCount})`);

  LocalWeighingStore.upsert({ localId: 'open-commercial-1', mode: 'commercial', vehicleRegNumber: 'KDD 222C', weighingType: 'gross', gvwMeasuredKg: 32400, isFinal: false, syncStatus: 'local_only' });
  const openByPlate = LocalWeighingStore.listOpenByPlate('kdd222c', 'commercial');
  assert(openByPlate.length === 1 && openByPlate[0].localId === 'open-commercial-1', 'listOpenByPlate matches on a normalized (case/space-insensitive) plate');

  // ---------------------------------------------------------------------
  // (d) BackendClient.sendAutoweigh - always persists locally, even before
  // the station has resolved (the fixed silent-drop bug).
  // ---------------------------------------------------------------------
  console.log('\n--- (d) BackendClient.sendAutoweigh: silent-drop fix ---');

  BackendClient.startSession({ regNumber: 'KEE 333D', axleConfigurationId: AXLE_CONFIG_ID });
  client.config.stationId = null; // simulate a fresh/never-synced install
  const localIdBeforeUnresolved = client.getSession().localSessionId;

  const unresolvedResult = await BackendClient.sendAutoweigh({
    plateNumber: 'KEE 333D', axleConfigurationId: AXLE_CONFIG_ID,
    axles: [{ axleNumber: 1, weight: 6600 }, { axleNumber: 2, weight: 8700 }, { axleNumber: 3, weight: 9300 }],
    gvw: 24600
  });
  assert(unresolvedResult === null, 'sendAutoweigh() returns null when station is unresolved (unchanged public behaviour)');
  const unresolvedRecord = LocalWeighingStore.get(localIdBeforeUnresolved);
  assert(unresolvedRecord !== null, 'CRITICAL: a local_weighings row now exists even though the station never resolved (this is the bug fix)');
  assert(unresolvedRecord.syncStatus === 'awaiting_station_resolution', `row correctly flagged awaiting_station_resolution (got ${unresolvedRecord.syncStatus})`);
  assert(unresolvedRecord.provisionalResult && unresolvedRecord.provisionalResult.overallStatus === 'LEGAL', 'a local provisional compliance result was still computed despite the backend being fully unreachable');
  const queueRowsForUnresolved = db.all('SELECT * FROM weighing_queue WHERE local_session_id = ?', [localIdBeforeUnresolved]);
  assert(queueRowsForUnresolved.length === 0, 'no network-queue row was created while unresolved (network step correctly skipped, not just deferred)');

  // Now resolve the station and confirm a fresh capture proceeds normally.
  client.config.stationId = STATION_ID;
  client._fetch = async () => ({ ok: true, json: async () => ({ weighingId: 'txn-resolved', ticketNumber: 'TCK-RESOLVED', gvwMeasuredKg: 24600, captureStatus: 'auto' }) });
  BackendClient.startSession({ regNumber: 'KFF 444E', axleConfigurationId: AXLE_CONFIG_ID });
  const localIdResolved = client.getSession().localSessionId;
  const resolvedResult = await BackendClient.sendAutoweigh({
    plateNumber: 'KFF 444E', axleConfigurationId: AXLE_CONFIG_ID,
    axles: [{ axleNumber: 1, weight: 6600 }, { axleNumber: 2, weight: 8700 }, { axleNumber: 3, weight: 9300 }],
    gvw: 24600
  });
  assert(resolvedResult && resolvedResult.weighingId === 'txn-resolved', 'once resolved, sendAutoweigh proceeds to a real network send exactly as before');
  const resolvedRecord = LocalWeighingStore.get(localIdResolved);
  assert(resolvedRecord.syncStatus === 'queued', `record status updated once queued for real network sync (got ${resolvedRecord.syncStatus})`);

  // ---------------------------------------------------------------------
  // (e) Commercial mode: local-only, never posts to the network; resume
  // correctly computes net weight from two visits.
  // ---------------------------------------------------------------------
  console.log('\n--- (e) Commercial capture: local-only + resume-to-net-weight ---');

  let networkCallCount = 0;
  client._fetch = async () => { networkCallCount++; return { ok: true, json: async () => ({}) }; };

  BackendClient.startCommercialSession({ plateNumber: 'KGG 555F', weighingType: 'gross' });
  const commercialLocalId1 = client.getSession().localSessionId;
  const firstVisitResult = await BackendClient.completeSession({ plateNumber: 'KGG 555F', axles: [{ axleNumber: 1, weight: 32400 }], gvw: 32400 });
  assert(firstVisitResult === null, 'commercial completeSession() returns null (local-only, never a live network result)');
  assert(networkCallCount === 0, `CRITICAL: zero network calls made for a commercial capture (got ${networkCallCount}) - confirms it never posts to the enforcement-shaped endpoint`);

  const firstVisitRecord = LocalWeighingStore.get(commercialLocalId1);
  assert(firstVisitRecord.syncStatus === 'local_only', `first commercial visit flagged local_only (got ${firstVisitRecord.syncStatus})`);
  assert(firstVisitRecord.isFinal === false, 'first commercial visit (no prior weight to compare) is NOT final - stays open for resume');
  assert(firstVisitRecord.provisionalResult === null, 'first commercial visit has no net-weight result yet (nothing to compare against)');

  const openCandidates = LocalWeighingStore.listOpenByPlate('KGG 555F', 'commercial');
  assert(openCandidates.length === 1 && openCandidates[0].localId === commercialLocalId1, 'the first visit is discoverable as a resumable open weighing');

  // Simulate the UI's resume flow: start a new session reusing the same local_id.
  BackendClient.startCommercialSession({
    plateNumber: 'KGG 555F', weighingType: 'tare',
    resume: { localId: commercialLocalId1, firstWeightKg: firstVisitRecord.gvwMeasuredKg, firstWeightType: firstVisitRecord.weighingType }
  });
  assert(client.getSession().localSessionId === commercialLocalId1, 'resume reuses the SAME local_id rather than starting a new physical-weighing record');
  const secondVisitResult = await BackendClient.completeSession({ plateNumber: 'KGG 555F', axles: [{ axleNumber: 1, weight: 24800 }], gvw: 24800 });
  assert(secondVisitResult === null, 'second (resumed) visit is also local-only');
  assert(networkCallCount === 0, 'still zero network calls after the resumed/finalizing visit');

  const finalRecord = LocalWeighingStore.get(commercialLocalId1);
  assert(finalRecord.isFinal === true, 'resumed visit that produced a real net weight IS flagged final');
  assert(finalRecord.provisionalResult && finalRecord.provisionalResult.netWeightKg === 7600, `net weight correctly computed as 32400-24800=7600 across the two visits (got ${finalRecord.provisionalResult && finalRecord.provisionalResult.netWeightKg})`);
  assert(finalRecord.provisionalResult.toleranceExceeded === null, 'toleranceExceeded stays null offline, as designed (resolved by the backend on sync instead)');

  const stillOpen = LocalWeighingStore.listOpenByPlate('KGG 555F', 'commercial');
  assert(stillOpen.length === 0, 'a finalized commercial weighing no longer shows up as resumable');

  // ---------------------------------------------------------------------
  // (f) Commercial N-axle pre-compliance capture (2026-09-12): when this org has
  // opted into a legal framework AND a real multi-axle config is used, a commercial
  // capture runs the SAME compliance engine as enforcement over its own axle
  // readings instead of tare/gross/net-only math - closes the deferred item from the
  // offline-weighing redesign follow-up.
  // ---------------------------------------------------------------------
  console.log('\n--- (f) Commercial capture: N-axle pre-compliance (legal framework configured) ---');

  BackendClient.startCommercialSession({
    plateNumber: 'KHH 666G', weighingType: 'gross',
    axleConfigurationId: AXLE_CONFIG_ID,
    commercialLegalFramework: 'TRAFFIC_ACT'
  });
  const nAxleLocalId1 = client.getSession().localSessionId;
  const firstNAxleResult = await BackendClient.completeSession({
    plateNumber: 'KHH 666G', axleConfigurationId: AXLE_CONFIG_ID,
    axles: [
      { axleNumber: 1, weight: 9000 },
      { axleNumber: 2, weight: 12000 },
      { axleNumber: 3, weight: 12000 }
    ],
    gvw: 33000
  });
  assert(firstNAxleResult === null, 'N-axle commercial capture is still local-only (never posts to the enforcement-shaped endpoint)');
  assert(networkCallCount === 0, `still zero network calls for the N-axle commercial capture (got ${networkCallCount})`);

  const firstNAxleRecord = LocalWeighingStore.get(nAxleLocalId1);
  assert(firstNAxleRecord.provisionalResult && firstNAxleRecord.provisionalResult.overallStatus === 'OVERLOAD',
    `first N-axle visit runs the real compliance engine instead of tare/gross/net math (got ${firstNAxleRecord.provisionalResult && firstNAxleRecord.provisionalResult.overallStatus})`);
  const nAxleGroupB = firstNAxleRecord.provisionalResult.groupResults.find((g) => g.groupLabel === 'B');
  assert(nAxleGroupB && nAxleGroupB.overloadKg > 0, `group B overload correctly detected on the N-axle commercial reading (got ${nAxleGroupB && nAxleGroupB.overloadKg})`);
  assert(firstNAxleRecord.provisionalResult.netInfo === null, 'no netInfo on the first/only visit - nothing to pair against yet');
  assert(firstNAxleRecord.isFinal === false,
    'CRITICAL: a first N-axle visit that DID get a (non-null) compliance verdict must still stay OPEN/resumable, not be mistaken for finalized just because provisionalResult is non-null');

  const nAxleOpenCandidates = LocalWeighingStore.listOpenByPlate('KHH 666G', 'commercial');
  assert(nAxleOpenCandidates.length === 1 && nAxleOpenCandidates[0].localId === nAxleLocalId1, 'the first N-axle visit is discoverable as a resumable open weighing');

  // Return visit (tare, empty): resumes the same local_id, pairs against the first
  // weight for a real net-weight figure, AND still gets its own compliance verdict for
  // this visit's own axle distribution (an empty vehicle, so LEGAL is expected).
  BackendClient.startCommercialSession({
    plateNumber: 'KHH 666G', weighingType: 'tare',
    axleConfigurationId: AXLE_CONFIG_ID,
    commercialLegalFramework: 'TRAFFIC_ACT',
    resume: { localId: nAxleLocalId1, firstWeightKg: firstNAxleRecord.gvwMeasuredKg, firstWeightType: firstNAxleRecord.weighingType }
  });
  assert(client.getSession().localSessionId === nAxleLocalId1, 'N-axle resume reuses the SAME local_id rather than starting a new physical-weighing record');
  const secondNAxleResult = await BackendClient.completeSession({
    plateNumber: 'KHH 666G', axleConfigurationId: AXLE_CONFIG_ID,
    axles: [
      { axleNumber: 1, weight: 2600 },
      { axleNumber: 2, weight: 3000 },
      { axleNumber: 3, weight: 3000 }
    ],
    gvw: 8600
  });
  assert(secondNAxleResult === null, 'second (resumed) N-axle visit is also local-only');
  assert(networkCallCount === 0, 'still zero network calls after the resumed N-axle finalizing visit');

  const finalNAxleRecord = LocalWeighingStore.get(nAxleLocalId1);
  assert(finalNAxleRecord.provisionalResult && finalNAxleRecord.provisionalResult.overallStatus === 'LEGAL',
    `second (empty/tare) N-axle visit's own compliance verdict is LEGAL (got ${finalNAxleRecord.provisionalResult && finalNAxleRecord.provisionalResult.overallStatus})`);
  assert(finalNAxleRecord.provisionalResult.netInfo && finalNAxleRecord.provisionalResult.netInfo.netWeightKg === 24400,
    `net weight correctly computed as 33000-8600=24400 across the two N-axle visits (got ${finalNAxleRecord.provisionalResult && finalNAxleRecord.provisionalResult.netInfo && finalNAxleRecord.provisionalResult.netInfo.netWeightKg})`);
  assert(finalNAxleRecord.isFinal === true, 'the paired (net-weight-bearing) N-axle visit correctly finalizes the physical weighing');

  const nAxleStillOpen = LocalWeighingStore.listOpenByPlate('KHH 666G', 'commercial');
  assert(nAxleStillOpen.length === 0, 'a finalized N-axle commercial weighing no longer shows up as resumable');

  // Control: legacy single-reading commercial capture (no commercialLegalFramework, e.g.
  // an org that never opted in) must be completely unaffected by the above - re-verify
  // scenario (e)'s exact shape still holds when a real axleConfigurationId IS present
  // (unlike scenario (e), which used none at all) but no framework was resolved for it.
  BackendClient.startCommercialSession({ plateNumber: 'KJJ 777H', weighingType: 'gross', axleConfigurationId: AXLE_CONFIG_ID });
  const legacyWithConfigLocalId = client.getSession().localSessionId;
  await BackendClient.completeSession({ plateNumber: 'KJJ 777H', axleConfigurationId: AXLE_CONFIG_ID, axles: [{ axleNumber: 1, weight: 32400 }], gvw: 32400 });
  const legacyWithConfigRecord = LocalWeighingStore.get(legacyWithConfigLocalId);
  assert(legacyWithConfigRecord.provisionalResult === null, 'an axle config present but NO legal framework resolved stays on the legacy path (no compliance verdict attempted on a single lump reading)');
  assert(legacyWithConfigRecord.isFinal === false, 'legacy first visit (no framework) still correctly stays open for resume');

  Database.close();
  try {
    fs.unlinkSync(dbPath);
    fs.unlinkSync(dbPath + '-wal');
    fs.unlinkSync(dbPath + '-shm');
  } catch {
    // best-effort cleanup
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
