/**
 * Standalone verification script for Phase 3 (offline sync queue) and Phase 4
 * (Stations/AxleConfiguration config sync). No test framework in this repo (see other
 * files in this directory) - run directly with `node tests/sync-queue-and-config-sync-test.js`.
 *
 * Uses a real temporary SQLite database (so the actual Database.js migrations run) and
 * monkey-patches BackendClient's network methods (_fetch / _getAuthHeader) so nothing
 * here makes a real HTTP call.
 *
 * Covers:
 *   (a) enqueue -> attempt -> synced happy path
 *   (b) enqueue -> attempt fails -> backoff scheduled -> retry -> synced
 *   (c) autoweigh -> complete dependency chain resolving weighingTransactionId
 *   (d) config-sync resolving a station code -> GUID and populating BackendClient.config.stationId
 *       plus the pure detectStationDrift() diff function
 */

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
  const dbPath = path.join(os.tmpdir(), `truconnect-synctest-${Date.now()}.db`);
  console.log(`Using temp DB: ${dbPath}`);

  const Database = require('../src/database/Database');
  Database.initialize({ dbPath });

  const BackendClient = require('../src/backend/BackendClient');
  const SyncQueue = require('../src/backend/SyncQueue');
  const ConfigSyncService = require('../src/backend/ConfigSyncService');
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
  // Never actually authenticate over the network.
  client._getAuthHeader = async () => 'Bearer fake-token';

  // ---------------------------------------------------------------
  // (a) enqueue -> attempt -> synced happy path
  // ---------------------------------------------------------------
  console.log('\n--- (a) happy path ---');
  let fetchCallCount = 0;
  client._fetch = async (url, options) => {
    fetchCallCount++;
    return {
      ok: true,
      json: async () => ({
        weighingId: 'txn-guid-AAA',
        ticketNumber: 'TCK-0001',
        gvwMeasuredKg: 12000,
        captureStatus: 'auto'
      })
    };
  };

  const rowA = SyncQueue.enqueue({
    localSessionId: 'session-A',
    requestType: 'autoweigh',
    endpoint: '/api/v1/weighing-transactions/autoweigh',
    payload: { stationId: 'station-1', vehicleRegNumber: 'KAA123A', axles: [{ axleNumber: 1, measuredWeightKg: 4000 }] }
  });
  assert(rowA.status === 'pending', 'row written as pending BEFORE any network attempt (durable capture)');

  const resultA = await SyncQueue.attempt(rowA.id);
  assert(resultA && resultA.weighingId === 'txn-guid-AAA', 'attempt() returns backend result on 2xx');
  assert(fetchCallCount === 1, 'exactly one network call made');

  const freshA = Database.getDb().get('SELECT * FROM weighing_queue WHERE id = ?', [rowA.id]);
  assert(freshA.status === 'synced', 'row status transitions to synced');
  assert(freshA.backend_transaction_id === 'txn-guid-AAA', 'backend_transaction_id stored on the row');

  // ---------------------------------------------------------------
  // (b) enqueue -> attempt fails -> backoff -> retry -> synced
  // ---------------------------------------------------------------
  console.log('\n--- (b) fail then retry then succeed ---');
  let attemptNum = 0;
  client._fetch = async () => {
    attemptNum++;
    if (attemptNum < 3) {
      // Simulate a transient 503 - retryable
      return { ok: false, status: 503, text: async () => 'Service Unavailable' };
    }
    return { ok: true, json: async () => ({ weighingId: 'txn-guid-BBB', ticketNumber: 'TCK-0002' }) };
  };

  const rowB = SyncQueue.enqueue({
    localSessionId: 'session-B',
    requestType: 'autoweigh',
    endpoint: '/api/v1/weighing-transactions/autoweigh',
    payload: { stationId: 'station-1', vehicleRegNumber: 'KBB456B', axles: [{ axleNumber: 1, measuredWeightKg: 5000 }] }
  });

  const firstTry = await SyncQueue.attempt(rowB.id);
  assert(firstTry === null, 'first failing attempt returns null (queued, not thrown)');
  let freshB = Database.getDb().get('SELECT * FROM weighing_queue WHERE id = ?', [rowB.id]);
  assert(freshB.status === 'pending', 'row stays pending after a retryable failure');
  assert(freshB.attempts === 1, 'attempts incremented to 1');
  const backoffMs1 = new Date(freshB.next_attempt_at).getTime() - Date.now();
  assert(backoffMs1 > 4000 && backoffMs1 <= 5000, `first backoff ~5000ms (ported from CloudConnectionManager formula), got ${Math.round(backoffMs1)}ms`);

  const secondTry = await SyncQueue.attempt(rowB.id);
  assert(secondTry === null, 'second failing attempt also returns null');
  freshB = Database.getDb().get('SELECT * FROM weighing_queue WHERE id = ?', [rowB.id]);
  assert(freshB.attempts === 2, 'attempts incremented to 2');
  const backoffMs2 = new Date(freshB.next_attempt_at).getTime() - Date.now();
  assert(backoffMs2 > 7000 && backoffMs2 <= 7500, `second backoff ~7500ms (5000 * 1.5^1), got ${Math.round(backoffMs2)}ms`);

  const thirdTry = await SyncQueue.attempt(rowB.id);
  assert(thirdTry && thirdTry.weighingId === 'txn-guid-BBB', 'third attempt succeeds once backend recovers');
  freshB = Database.getDb().get('SELECT * FROM weighing_queue WHERE id = ?', [rowB.id]);
  assert(freshB.status === 'synced', 'row status transitions to synced after eventual success');

  // Dead-letter path: a non-retryable 4xx should dead-letter immediately (no backoff wait)
  client._fetch = async () => ({ ok: false, status: 400, text: async () => 'Bad Request: invalid axle data' });
  const rowDead = SyncQueue.enqueue({
    localSessionId: 'session-dead',
    requestType: 'autoweigh',
    endpoint: '/api/v1/weighing-transactions/autoweigh',
    payload: { stationId: 'station-1', vehicleRegNumber: 'KDD000D', axles: [] }
  });
  await SyncQueue.attempt(rowDead.id);
  const freshDead = Database.getDb().get('SELECT * FROM weighing_queue WHERE id = ?', [rowDead.id]);
  assert(freshDead.status === 'dead_letter', 'non-retryable 4xx moves straight to dead_letter (no backoff)');

  const retryResult = SyncQueue.retryDeadLetters();
  assert(retryResult.requeued === 1, 'retryDeadLetters() requeues the dead-letter row');
  const freshDeadRequeued = Database.getDb().get('SELECT * FROM weighing_queue WHERE id = ?', [rowDead.id]);
  assert(freshDeadRequeued.status === 'pending' && freshDeadRequeued.attempts === 0, 'requeued row reset to pending with attempts=0');

  // ---------------------------------------------------------------
  // (c) autoweigh -> complete dependency chain
  // ---------------------------------------------------------------
  console.log('\n--- (c) autoweigh -> complete dependency chain ---');
  client._fetch = async () => ({ ok: false, status: 503, text: async () => 'down' }); // autoweigh not synced yet

  const rowAuto = SyncQueue.enqueue({
    localSessionId: 'session-C',
    requestType: 'autoweigh',
    endpoint: '/api/v1/weighing-transactions/autoweigh',
    payload: { stationId: 'station-1', vehicleRegNumber: 'KCC789C', axles: [{ axleNumber: 1, measuredWeightKg: 6000 }] }
  });
  await SyncQueue.attempt(rowAuto.id); // fails, stays pending

  const rowComplete = SyncQueue.enqueue({
    localSessionId: 'session-C',
    requestType: 'complete',
    endpoint: '/api/v1/weighing-transactions/autoweigh',
    payload: { stationId: 'station-1', vehicleRegNumber: 'KCC789C', axles: [{ axleNumber: 1, measuredWeightKg: 6000 }], weighingTransactionId: null }
  });

  const completeAttemptTooEarly = await SyncQueue.attempt(rowComplete.id);
  assert(completeAttemptTooEarly === null, 'complete row is not eligible while its autoweigh sibling is still pending');
  const freshCompleteEarly = Database.getDb().get('SELECT * FROM weighing_queue WHERE id = ?', [rowComplete.id]);
  assert(freshCompleteEarly.status === 'pending' && freshCompleteEarly.attempts === 0, 'skipped dependency check does not count as a failed attempt');

  // Now let the autoweigh call succeed
  client._fetch = async () => ({ ok: true, json: async () => ({ weighingId: 'txn-guid-CCC', ticketNumber: 'TCK-0003' }) });
  const autoweighResult = await SyncQueue.attempt(rowAuto.id);
  assert(autoweighResult && autoweighResult.weighingId === 'txn-guid-CCC', 'autoweigh sibling eventually syncs');

  const completeResult = await SyncQueue.attempt(rowComplete.id);
  assert(completeResult && completeResult.weighingId === 'txn-guid-CCC', 'complete row sends successfully once its sibling is synced');

  const freshCompletePayload = JSON.parse(Database.getDb().get('SELECT payload FROM weighing_queue WHERE id = ?', [rowComplete.id]).payload);
  assert(freshCompletePayload.weighingTransactionId === 'txn-guid-CCC', 'complete payload inherited weighingTransactionId from the autoweigh sibling\'s backend_transaction_id');

  const rowAutoData = Database.getDb().get('SELECT client_local_id FROM weighing_queue WHERE id = ?', [rowAuto.id]);
  const rowCompleteData = Database.getDb().get('SELECT client_local_id FROM weighing_queue WHERE id = ?', [rowComplete.id]);
  assert(rowAutoData.client_local_id !== rowCompleteData.client_local_id, 'autoweigh and complete got DIFFERENT client_local_id values (critical idempotency bug avoided)');

  // ---------------------------------------------------------------
  // (d) config-sync: station code -> GUID resolution + drift detection
  // ---------------------------------------------------------------
  console.log('\n--- (d) config sync: station resolution + drift ---');
  const { resolveStationGuidForCode, detectStationDrift } = ConfigSyncService;

  const backendStations = [
    { id: 'guid-nrb-01', code: 'nrb-mobile-01' },
    { id: 'guid-msa-01', code: 'MSA-MOBILE-01' }
  ];
  assert(resolveStationGuidForCode('NRB-MOBILE-01', backendStations) === 'guid-nrb-01', 'resolves station code case-insensitively');
  assert(resolveStationGuidForCode('  msa-mobile-01  ', backendStations) === 'guid-msa-01', 'resolves station code with whitespace trimmed');
  assert(resolveStationGuidForCode('UNKNOWN-CODE', backendStations) === null, 'returns null for an unmatched code');
  assert(resolveStationGuidForCode('', backendStations) === null, 'returns null for an empty local code');

  const driftResult = detectStationDrift(
    { name: 'Old Name', bidirectional: false, boundACode: 'A', boundBCode: 'B' },
    { name: 'New Backend Name', supportsBidirectional: true, boundACode: 'NRB-A', boundBCode: 'NRB-B' }
  );
  assert(driftResult.hasDrift === true, 'detects drift when local and backend values differ');
  assert(driftResult.fields.length === 4, `detects all 4 differing fields (got ${driftResult.fields.length})`);

  const noDriftResult = detectStationDrift(
    { name: 'Same Name', bidirectional: true, boundACode: 'A', boundBCode: 'B' },
    { name: 'Same Name', supportsBidirectional: true, boundACode: 'A', boundBCode: 'B' }
  );
  assert(noDriftResult.hasDrift === false, 'reports no drift when values match');

  // Now exercise resolveAndApplyStationId() end-to-end against the real local DB mirror
  ConfigManager.set('station.code', 'NRB-MOBILE-01', false);
  Database.getDb().run(
    `INSERT INTO backend_stations (id, code, name, supports_bidirectional, bound_a_code, bound_b_code, is_active, raw_json, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ['guid-nrb-01', 'NRB-MOBILE-01', 'Nairobi Mobile Unit 01', 1, 'NRB-A', 'NRB-B', JSON.stringify({
      id: 'guid-nrb-01', code: 'NRB-MOBILE-01', name: 'Nairobi Mobile Unit 01', supportsBidirectional: true, boundACode: 'NRB-A', boundBCode: 'NRB-B'
    }), new Date().toISOString()]
  );

  const resolvedGuid = ConfigSyncService.resolveAndApplyStationId();
  assert(resolvedGuid === 'guid-nrb-01', 'resolveAndApplyStationId() resolves the configured station.code against the local mirror (no network call)');
  assert(client.config.stationId === 'guid-nrb-01', 'BackendClient.config.stationId populated purely from local cache - this is what lets Phase 3 work fully offline after the first sync');

  // ---------------------------------------------------------------
  // (e) REAL-TRANSPORT airplane test.
  //
  // Everything above monkey-patches _fetch/_getAuthHeader, which cannot exercise how the
  // code behaves against an actual socket (a destroyed connection is not the same failure
  // shape as a thrown Error), and can only count calls from the CLIENT side. This section
  // runs the unmodified BackendClient against a real local HTTP server that can be taken
  // down and brought back up, so exactly-once is verified from what the BACKEND actually
  // received, and the idempotency key is verified on the wire rather than in the DB.
  await realTransportAirplaneTest();

  // ---------------------------------------------------------------
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);

  Database.close();
  try {
    fs.unlinkSync(dbPath);
    fs.unlinkSync(dbPath + '-wal');
    fs.unlinkSync(dbPath + '-shm');
  } catch {
    // best-effort cleanup
  }

  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Drives the REAL BackendClient (no monkey-patching) against a controllable local HTTP
 * server, in a second temp database, to prove the offline -> reconnect -> exactly-once
 * round trip end to end at the transport layer.
 */
async function realTransportAirplaneTest() {
  console.log('\n--- (e) real-transport airplane test ---');

  const http = require('http');
  let serverUp = false;
  const autoweighPosts = [];
  const completePosts = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      // While "offline", drop the connection outright rather than replying - this is what
      // an unreachable backend actually looks like to fetch(), unlike a thrown stub.
      if (!serverUp) { req.socket.destroy(); return; }

      if (req.url.includes('/auth/login')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ accessToken: 'mock-token', expiresIn: 3600 }));
      }
      if (req.url.includes('autoweigh')) {
        autoweighPosts.push(JSON.parse(body || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ weighingId: 'txn-guid-WIRE' }));
      }
      completePosts.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ weighingId: 'txn-guid-WIRE', completed: true }));
    });
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const dbPath = path.join(os.tmpdir(), `truconnect-wiretest-${Date.now()}.db`);
  const Database = require('../src/database/Database');
  const BackendClient = require('../src/backend/BackendClient');
  const SyncQueue = require('../src/backend/SyncQueue');

  // Fresh singletons pointed at a second temp DB, so this section is independent of (a)-(d).
  Database.close();
  Database.initialize({ dbPath });
  const db = Database.getDb();
  SyncQueue.reset && SyncQueue.reset();

  const client = BackendClient.getInstance();

  // Sections (a)-(d) above assign stubbed _fetch/_getAuthHeader as OWN properties on this
  // shared singleton. Deleting them uncovers the real prototype methods again - without
  // this, "real transport" would silently keep using the last stub (and pass for the
  // wrong reason, which is exactly what happened the first time this was written).
  delete client._fetch;
  delete client._getAuthHeader;
  assert(typeof client._fetch === 'function' && !Object.prototype.hasOwnProperty.call(client, '_fetch'),
    'real transport: stubs removed, genuine BackendClient._fetch restored before this section runs');

  client.auth.accessToken = null;
  client.configure({
    baseUrl,
    authEndpoint: '/api/v1/auth/login',
    autoweighEndpoint: '/api/v1/weighing-transactions/autoweigh',
    email: 'wire@test.local',
    password: 'mock',
    stationId: '00000000-0000-0000-0000-000000000001'
  });

  // --- offline capture -------------------------------------------------------
  serverUp = false;
  const session = 'WIRE-SESSION-1';
  const aw = SyncQueue.enqueue({
    localSessionId: session,
    requestType: 'autoweigh',
    endpoint: '/api/v1/weighing-transactions/autoweigh',
    payload: { vehicleRegNumber: 'KDA 123X', grossWeightKg: 32000 }
  });
  await SyncQueue.drain();
  let awRow = db.get('SELECT * FROM weighing_queue WHERE id = ?', [aw.id]);
  assert(awRow.status === 'pending' && awRow.attempts === 1,
    'real transport: a genuinely unreachable backend leaves the capture pending, never lost');
  assert(autoweighPosts.length === 0, 'real transport: nothing reached the backend while offline');

  const cp = SyncQueue.enqueue({
    localSessionId: session,
    requestType: 'complete',
    endpoint: '/api/v1/weighing-transactions/complete',
    payload: { finalWeightKg: 32000 }
  });

  // --- reconnect -------------------------------------------------------------
  serverUp = true;
  db.run(`UPDATE weighing_queue SET next_attempt_at = ? WHERE status = 'pending'`,
    [new Date(Date.now() - 1000).toISOString()]);
  await SyncQueue.drain();   // autoweigh syncs
  await SyncQueue.drain();   // complete becomes eligible

  awRow = db.get('SELECT * FROM weighing_queue WHERE id = ?', [aw.id]);
  const cpRow = db.get('SELECT * FROM weighing_queue WHERE id = ?', [cp.id]);
  assert(awRow.status === 'synced' && awRow.backend_transaction_id === 'txn-guid-WIRE',
    'real transport: autoweigh syncs on reconnect and stores the backend id');
  assert(cpRow.status === 'synced' && JSON.parse(cpRow.payload).weighingTransactionId === 'txn-guid-WIRE',
    'real transport: complete syncs after its dependency and inherits the backend id');

  // --- exactly-once, verified from the BACKEND side --------------------------
  await SyncQueue.drain();   // must be a no-op
  assert(autoweighPosts.length === 1, `backend received exactly ONE autoweigh POST (got ${autoweighPosts.length})`);
  assert(completePosts.length === 1, `backend received exactly ONE complete POST (got ${completePosts.length})`);
  assert(autoweighPosts[0].clientLocalId === aw.client_local_id,
    'idempotency key is actually transmitted on the wire, not just stored locally');
  assert(autoweighPosts[0].clientLocalId !== completePosts[0].clientLocalId,
    'the two calls transmit DIFFERENT idempotency keys (reusing one would strand the txn server-side)');

  server.close();
  Database.close();
  try {
    fs.unlinkSync(dbPath);
    fs.unlinkSync(dbPath + '-wal');
    fs.unlinkSync(dbPath + '-shm');
  } catch {
    // best-effort cleanup
  }
}

main().catch(err => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
