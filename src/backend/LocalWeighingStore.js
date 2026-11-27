/**
 * LocalWeighingStore - one row per PHYSICAL weighing, in `local_weighings`.
 *
 * Distinct from SyncQueue's `weighing_queue` table, which is one row per NETWORK CALL
 * (autoweigh or complete) and is purely a transport/idempotency concern. This store
 * exists so the capture UI can show "your pending offline captures" and so a physical
 * weighing is never silently lost when the backend is unreachable OR the local station
 * code hasn't resolved to a backend GUID yet - both previously caused
 * BackendClient.sendAutoweigh()/completeSession() to no-op before anything was queued
 * at all (see the offline-weighing redesign plan's Phase 4).
 */

'use strict';

function db() {
  return require('../database/Database').getDb();
}

/**
 * Insert-or-update one physical weighing record by local_id.
 *
 * @param {{
 *   localId: string,
 *   mode: 'enforcement'|'commercial',
 *   vehicleRegNumber: string,
 *   axleConfigurationId?: string|null,
 *   weighingType?: string|null,
 *   axleReadings?: any,
 *   gvwMeasuredKg?: number|null,
 *   provisionalResult?: any,
 *   captureSource?: string,
 *   isFinal?: boolean,
 *   backendTransactionId?: string|null,
 *   syncStatus?: string
 * }} fields
 */
function upsert(fields) {
  const now = new Date().toISOString();
  const existing = db().get('SELECT local_id FROM local_weighings WHERE local_id = ?', [fields.localId]);

  const row = {
    localId: fields.localId,
    mode: fields.mode === 'commercial' ? 'commercial' : 'enforcement',
    vehicleRegNumber: fields.vehicleRegNumber || 'UNKNOWN',
    axleConfigurationId: fields.axleConfigurationId || null,
    weighingType: fields.weighingType || null,
    axleReadings: JSON.stringify(fields.axleReadings ?? []),
    gvwMeasuredKg: fields.gvwMeasuredKg ?? null,
    provisionalResult: fields.provisionalResult != null ? JSON.stringify(fields.provisionalResult) : null,
    captureSource: fields.captureSource || 'auto',
    isFinal: fields.isFinal ? 1 : 0,
    backendTransactionId: fields.backendTransactionId || null,
    syncStatus: fields.syncStatus || 'pending',
    updatedAt: now
  };

  if (existing) {
    db()
      .prepare(
        `UPDATE local_weighings SET
          mode = @mode,
          vehicle_reg_number = @vehicleRegNumber,
          axle_configuration_id = @axleConfigurationId,
          weighing_type = @weighingType,
          axle_readings = @axleReadings,
          gvw_measured_kg = @gvwMeasuredKg,
          provisional_result = COALESCE(@provisionalResult, provisional_result),
          capture_source = @captureSource,
          is_final = @isFinal,
          backend_transaction_id = COALESCE(@backendTransactionId, backend_transaction_id),
          sync_status = @syncStatus,
          updated_at = @updatedAt
        WHERE local_id = @localId`
      )
      .run(row);
  } else {
    db()
      .prepare(
        `INSERT INTO local_weighings
          (local_id, mode, vehicle_reg_number, axle_configuration_id, weighing_type, axle_readings,
           gvw_measured_kg, provisional_result, capture_source, is_final, backend_transaction_id, sync_status, updated_at)
         VALUES
          (@localId, @mode, @vehicleRegNumber, @axleConfigurationId, @weighingType, @axleReadings,
           @gvwMeasuredKg, @provisionalResult, @captureSource, @isFinal, @backendTransactionId, @syncStatus, @updatedAt)`
      )
      .run(row);
  }

  return get(fields.localId);
}

/**
 * Permanently abandon a pending local weighing (operator-initiated "Discard", mirroring
 * truload-frontend's own Pending Transactions panel). Marks it dead_letter + final rather
 * than hard-deleting, so a mistaken capture leaves an auditable trace instead of vanishing.
 */
function discard(localId) {
  db()
    .prepare('UPDATE local_weighings SET is_final = 1, sync_status = ?, updated_at = ? WHERE local_id = ?')
    .run('dead_letter', new Date().toISOString(), localId);
  return get(localId);
}

/** Calls for this weighing that TruConnect still has to send. */
function openQueueCount(localId) {
  const row = db().get(
    `SELECT COUNT(*) as n FROM weighing_queue
     WHERE local_session_id = ? AND status IN ('pending', 'sending')`,
    [localId]
  );
  return row ? row.n : 0;
}

function latestSyncedTransactionId(localId) {
  const row = db().get(
    `SELECT backend_transaction_id FROM weighing_queue
     WHERE local_session_id = ? AND status = 'synced' AND backend_transaction_id IS NOT NULL
     ORDER BY updated_at DESC LIMIT 1`,
    [localId]
  );
  return row ? row.backend_transaction_id : null;
}

function finalize(localId, syncStatus, backendTransactionId, vehicleRegNumber) {
  db()
    .prepare(
      `UPDATE local_weighings SET
        is_final = 1,
        sync_status = ?,
        backend_transaction_id = COALESCE(?, backend_transaction_id),
        vehicle_reg_number = CASE WHEN vehicle_reg_number = 'UNKNOWN' AND ? IS NOT NULL THEN ? ELSE vehicle_reg_number END,
        updated_at = ?
       WHERE local_id = ?`
    )
    .run(syncStatus, backendTransactionId || null, vehicleRegNumber || null, vehicleRegNumber || null, new Date().toISOString(), localId);
  return get(localId);
}

/**
 * Close an enforcement weighing that TruLoad ended itself. TruLoad submits the final
 * weights straight to the backend, so TruConnect never runs completeSession for it and
 * the row would otherwise stay pending for ever.
 *
 * @param {string} localId
 * @param {{transactionId?: string|null, vehicleRegNumber?: string|null, submitted: boolean}} outcome
 *   submitted is false when TruLoad reset before any transaction existed, which is an
 *   abandoned capture and is closed the same way as the operator's Discard.
 */
function closeEndedByTruLoad(localId, { transactionId, vehicleRegNumber, submitted }) {
  const row = get(localId);
  if (!row || row.isFinal || row.mode !== 'enforcement') return row;
  if (!submitted && !transactionId) return discard(localId);
  const syncStatus = openQueueCount(localId) > 0 ? 'queued' : 'synced';
  return finalize(localId, syncStatus, transactionId || latestSyncedTransactionId(localId), vehicleRegNumber);
}

/**
 * A finished weighing becomes synced once none of its calls are left to send. Run after
 * each queued call syncs, so captures made offline stop showing as pending.
 */
function reconcile(localId) {
  const row = get(localId);
  if (!row || !row.isFinal || !['pending', 'queued'].includes(row.syncStatus)) return row;
  if (openQueueCount(localId) > 0) return row;
  return markSyncStatus(localId, 'synced', latestSyncedTransactionId(localId));
}

/**
 * Close enforcement weighings left open by an earlier run. Their session lived in memory
 * only and enforcement has no resume, so nothing can finish them: they were ended in
 * TruLoad or abandoned. A row whose call reached the backend is synced, one with a call
 * still queued keeps waiting for it, and one that never left this device is discarded.
 * Runs at startup, before any new session exists.
 *
 * @returns {number} rows closed
 */
function closeStaleOpenWeighings() {
  const rows = db().all(
    `SELECT local_id FROM local_weighings
     WHERE is_final = 0 AND mode = 'enforcement'
       AND sync_status IN ('pending', 'queued', 'awaiting_station_resolution')`
  );
  for (const { local_id: localId } of rows) {
    const transactionId = latestSyncedTransactionId(localId);
    if (openQueueCount(localId) > 0) finalize(localId, 'queued', transactionId);
    else if (transactionId) finalize(localId, 'synced', transactionId);
    else discard(localId);
  }
  return rows.length;
}

function markSyncStatus(localId, syncStatus, backendTransactionId) {
  db()
    .prepare(
      `UPDATE local_weighings SET
        sync_status = ?,
        backend_transaction_id = COALESCE(?, backend_transaction_id),
        updated_at = ?
       WHERE local_id = ?`
    )
    .run(syncStatus, backendTransactionId || null, new Date().toISOString(), localId);
  return get(localId);
}

function get(localId) {
  const row = db().get('SELECT * FROM local_weighings WHERE local_id = ?', [localId]);
  return row ? deserialize(row) : null;
}

/** Every record still awaiting either station resolution or the sync queue draining, newest first. */
function listPending(limit) {
  const rows = db()
    .all(
      `SELECT * FROM local_weighings
       WHERE sync_status IN ('pending', 'queued', 'awaiting_station_resolution')
       ORDER BY captured_at DESC
       LIMIT ?`,
      [limit || 25]
    );
  return rows.map(deserialize);
}

function countPending() {
  const row = db().get(
    `SELECT COUNT(*) as n FROM local_weighings
     WHERE sync_status IN ('pending', 'queued', 'awaiting_station_resolution')`
  );
  return row ? row.n : 0;
}

/**
 * Open (not yet finalized) local weighings for a plate, used by the commercial capture
 * UI to resume a first-weight-only visit recorded on TruConnect itself (mirrors
 * truload-frontend's ResumeWeighingDialog, at a much lighter weight - no reweigh-count
 * bookkeeping, just "does this vehicle already have an unfinished local capture").
 */
function listOpenByPlate(vehicleRegNumber, mode) {
  const normalized = String(vehicleRegNumber || '').toUpperCase().replace(/\s+/g, '');
  const rows = db().all(
    `SELECT * FROM local_weighings
     WHERE is_final = 0 AND mode = ?
     ORDER BY captured_at DESC`,
    [mode === 'commercial' ? 'commercial' : 'enforcement']
  );
  return rows
    .map(deserialize)
    .filter((r) => String(r.vehicleRegNumber || '').toUpperCase().replace(/\s+/g, '') === normalized);
}

function deserialize(row) {
  let axleReadings = [];
  let provisionalResult = null;
  try {
    axleReadings = JSON.parse(row.axle_readings || '[]');
  } catch {
    axleReadings = [];
  }
  try {
    provisionalResult = row.provisional_result ? JSON.parse(row.provisional_result) : null;
  } catch {
    provisionalResult = null;
  }

  return {
    localId: row.local_id,
    mode: row.mode,
    vehicleRegNumber: row.vehicle_reg_number,
    axleConfigurationId: row.axle_configuration_id,
    weighingType: row.weighing_type,
    axleReadings,
    gvwMeasuredKg: row.gvw_measured_kg,
    provisionalResult,
    captureSource: row.capture_source,
    isFinal: Boolean(row.is_final),
    backendTransactionId: row.backend_transaction_id,
    syncStatus: row.sync_status,
    capturedAt: row.captured_at,
    updatedAt: row.updated_at
  };
}

module.exports = {
  upsert,
  markSyncStatus,
  discard,
  closeEndedByTruLoad,
  reconcile,
  closeStaleOpenWeighings,
  get,
  listPending,
  countPending,
  listOpenByPlate
};
