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
  get,
  listPending,
  countPending,
  listOpenByPlate
};
