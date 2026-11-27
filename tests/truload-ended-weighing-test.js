/**
 * Local weighings that TruLoad finishes itself must leave the pending list.
 *
 * TruLoad's mobile screen captures every axle before Next creates its transaction, so
 * TruConnect writes an auto record and a local weighing first. TruLoad then submits the
 * final weights straight to the backend, so the local weighing has to be closed when
 * TruLoad ends the session, and a weighing finalized offline has to become synced once
 * its queued calls go out.
 *
 * Run with Electron's Node, which matches the compiled better-sqlite3:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron.cmd tests/truload-ended-weighing-test.js
 */

'use strict';

const path = require('path');
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
  const Database = require('../src/database/Database');
  Database.initialize({ dbPath: path.join(os.tmpdir(), `truconnect-truload-ended-${Date.now()}.db`) });

  const BackendClient = require('../src/backend/BackendClient');
  const LocalWeighingStore = require('../src/backend/LocalWeighingStore');
  const SyncQueue = require('../src/backend/SyncQueue');
  const ConfigManager = require('../src/config/ConfigManager').getInstance();
  ConfigManager.initialize(Database.getDb());

  BackendClient.initialize({
    enabled: true,
    baseUrl: 'http://fake-backend.local',
    autoweighEndpoint: '/api/v1/weighing-transactions/autoweigh',
    email: 'middleware@truconnect.local',
    password: '<REPLACE_ME>',
    stationId: 'station-guid',
    bound: 'A'
  });
  const client = BackendClient.getInstance();
  client._getAuthHeader = async () => 'Bearer fake-token';

  let online = true;
  const sentBodies = [];
  let nextId = 1;
  client._fetch = async (url, options) => {
    if (!online) throw new Error('offline');
    const body = JSON.parse(options.body);
    sentBodies.push(body);
    const weighingId = body.weighingTransactionId || `auto-${nextId++}`;
    return { ok: true, status: 200, json: async () => ({ weighingId, ticketNumber: 'TKT', captureStatus: 'auto' }) };
  };

  const axles = [{ axleNumber: 1, weight: 6000 }, { axleNumber: 2, weight: 9000 }];
  const pending = () => LocalWeighingStore.countPending();

  // 1. Mobile flow: capture before the transaction, TruLoad submits, sends weights-captured
  client.resetSession();
  client.startSession({});
  await client.sendAutoweigh({ plateNumber: 'KDA 123X', axles, gvw: 15000 });
  const firstId = client.getSession().localSessionId;
  assert(LocalWeighingStore.get(firstId).syncStatus === 'queued', 'auto record before the transaction is held as pending');

  client.syncTransactionSession({ transactionId: 'txn-1', vehicleRegNumber: 'KDA 123X', weighingMode: 'mobile', workflow: 'enforcement' });
  assert(client.getSession().localSessionId === firstId, 'transaction-sync keeps the capture taken before it');
  client.syncTransactionSession({ transactionId: 'txn-1', vehicleRegNumber: 'KDA 123X', weighingMode: 'mobile', workflow: 'enforcement' });
  assert(client.getSession().localSessionId === firstId, 'a repeated sync on an axle-config change keeps it too');

  client.finishTruLoadSession({ submitted: true });
  const first = LocalWeighingStore.get(firstId);
  assert(first.isFinal && first.syncStatus === 'synced', 'weights-captured closes the weighing as synced');
  assert(first.backendTransactionId === 'txn-1', 'the closed weighing points at TruLoad\'s transaction');
  assert(client.getSession().localSessionId === null, 'the session is reset for the next vehicle');
  assert(pending() === 0, 'nothing is left pending after TruLoad submits');

  // 2. A different vehicle's capture is not taken over by the next transaction
  client.startSession({});
  await client.sendAutoweigh({ plateNumber: 'KBB 111A', axles, gvw: 15000 });
  const otherId = client.getSession().localSessionId;
  client.syncTransactionSession({ transactionId: 'txn-2', vehicleRegNumber: 'KCC 222B', weighingMode: 'mobile', workflow: 'enforcement' });
  assert(client.getSession().localSessionId !== otherId, 'a capture for another plate is not adopted');
  client.finishTruLoadSession({ submitted: true });
  assert(!LocalWeighingStore.get(otherId).isFinal, 'that other capture is left for the startup sweep');

  // 3. Cancel on the capture step, before any transaction: the capture is discarded
  client.startSession({});
  await client.sendAutoweigh({ plateNumber: 'KDD 333C', axles, gvw: 15000 });
  const cancelledId = client.getSession().localSessionId;
  client.finishTruLoadSession({ submitted: false });
  const cancelled = LocalWeighingStore.get(cancelledId);
  assert(cancelled.isFinal && cancelled.syncStatus === 'dead_letter', 'reset before a transaction discards the capture');

  // 4. Multideck: reset-session after the final submit, with a transaction, closes as synced
  client.startSession({});
  client.syncTransactionSession({ transactionId: 'txn-4', vehicleRegNumber: 'KEE 444D', weighingMode: 'multideck', workflow: 'enforcement' });
  await client.sendAutoweigh({ plateNumber: 'KEE 444D', axles, gvw: 15000 });
  const multideckId = client.getSession().localSessionId;
  client.finishTruLoadSession({ submitted: false });
  assert(LocalWeighingStore.get(multideckId).syncStatus === 'synced', 'reset-session with a transaction closes the weighing as synced');

  // 5. Offline: the auto record waits, is linked to TruLoad's transaction, then syncs
  online = false;
  client.startSession({});
  await client.sendAutoweigh({ plateNumber: 'KFF 555E', axles, gvw: 15000 });
  const offlineId = client.getSession().localSessionId;
  client.syncTransactionSession({ transactionId: 'txn-5', vehicleRegNumber: 'KFF 555E', weighingMode: 'mobile', workflow: 'enforcement' });
  client.finishTruLoadSession({ submitted: true });
  let offline = LocalWeighingStore.get(offlineId);
  assert(offline.isFinal && offline.syncStatus === 'queued', 'offline it stays queued, but final so the panel drops it');
  const queued = Database.getDb().get(`SELECT * FROM weighing_queue WHERE local_session_id = ?`, [offlineId]);
  assert(JSON.parse(queued.payload).weighingTransactionId === 'txn-5', 'the queued auto record now carries TruLoad\'s transaction');
  online = true;
  Database.getDb().run(`UPDATE weighing_queue SET next_attempt_at = NULL WHERE local_session_id = ?`, [offlineId]);
  await SyncQueue.drain();
  offline = LocalWeighingStore.get(offlineId);
  assert(offline.syncStatus === 'synced', 'once the queue drains the weighing is synced');
  assert(sentBodies[sentBodies.length - 1].weighingTransactionId === 'txn-5', 'the late auto record was sent against TruLoad\'s transaction');

  // 6. Startup sweep closes rows an older version left open
  const stuckId = 'stuck-from-older-version';
  LocalWeighingStore.upsert({ localId: stuckId, mode: 'enforcement', vehicleRegNumber: 'KGG 666F', axleReadings: axles, gvwMeasuredKg: 15000, syncStatus: 'queued' });
  SyncQueue.enqueue({ localSessionId: stuckId, requestType: 'autoweigh', endpoint: '/x', payload: {} });
  Database.getDb().run(`UPDATE weighing_queue SET status = 'synced', backend_transaction_id = 'txn-old' WHERE local_session_id = ?`, [stuckId]);
  const commercialId = 'commercial-first-weight';
  LocalWeighingStore.upsert({ localId: commercialId, mode: 'commercial', vehicleRegNumber: 'KHH 777G', syncStatus: 'local_only' });

  const closed = LocalWeighingStore.closeStaleOpenWeighings();
  assert(closed === 2, 'the sweep closes the stuck row and the unadopted capture');
  const stuck = LocalWeighingStore.get(stuckId);
  assert(stuck.isFinal && stuck.syncStatus === 'synced' && stuck.backendTransactionId === 'txn-old', 'a stuck row whose auto record reached the backend is synced');
  assert(LocalWeighingStore.get(otherId).isFinal, 'the unadopted capture is closed');
  assert(!LocalWeighingStore.get(commercialId).isFinal, 'an open commercial first weight is kept for its resume');
  assert(pending() === 0, 'the pending count is back to zero');

  SyncQueue.stopPeriodicDrain();
  console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
