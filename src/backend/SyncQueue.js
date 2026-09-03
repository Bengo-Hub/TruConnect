/**
 * SyncQueue - Durable offline capture + sync queue for backend weighing calls
 *
 * Replaces the old "try the network call, log-on-failure" pattern in BackendClient
 * with "write to SQLite first, then attempt the network call". This is what makes
 * weighing capture survive an app crash, a machine reboot, or an extended offline
 * period at a remote site.
 *
 * Each row is one queued network call (autoweigh or complete) for one physical
 * weighing. The two calls for the same weighing share a `local_session_id` (used
 * only to group them) but MUST each get their own `client_local_id` - that value is
 * sent as the backend's ClientLocalId idempotency key. Reusing one id across both
 * calls would make the second call short-circuit on the idempotent-return path and
 * leave the transaction stuck at CaptureStatus="auto" forever.
 *
 * A `complete` row depends on its session's `autoweigh` row: it is not eligible to
 * send until that sibling row is `synced`, at which point its resolved
 * `backend_transaction_id` (the backend's WeighingId) is patched into the queued
 * `complete` payload as `weighingTransactionId`.
 *
 * Backoff formula is ported verbatim from CloudConnectionManager._scheduleReconnect
 * (base 5000ms, x1.5 per attempt, capped at 30000ms) rather than inventing a new one.
 */

const crypto = require('crypto');
const EventBus = require('../core/EventBus');

const DEFAULT_MAX_ATTEMPTS = 10;
const BASE_BACKOFF_MS = 5000;
const BACKOFF_MULTIPLIER = 1.5;
const MAX_BACKOFF_MS = 30000;
const DEFAULT_DRAIN_INTERVAL_MS = 20000;

class SyncQueue {
  constructor() {
    this.draining = false;
    this.drainTimer = null;
    this.drainIntervalMs = DEFAULT_DRAIN_INTERVAL_MS;
  }

  _db() {
    return require('../database/Database').getDb();
  }

  /**
   * Compute retry backoff, same shape as CloudConnectionManager._scheduleReconnect:
   * delay = min(base * 1.5^(attempts-1), 30000)
   */
  _computeBackoffMs(attempts) {
    return Math.min(
      BASE_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, Math.max(0, attempts - 1)),
      MAX_BACKOFF_MS
    );
  }

  /**
   * Write a new queued request to SQLite. This happens BEFORE any network attempt -
   * the durable-capture guarantee comes entirely from this write landing first.
   *
   * @param {Object} descriptor
   * @param {string} descriptor.localSessionId - groups the autoweigh+complete pair
   * @param {'autoweigh'|'complete'} descriptor.requestType
   * @param {string} descriptor.endpoint - path appended to backend baseUrl
   * @param {Object} descriptor.payload - JSON body (without clientLocalId - added at send time)
   * @param {number} [descriptor.maxAttempts]
   * @returns {Object} the inserted row
   */
  enqueue(descriptor) {
    const { localSessionId, requestType, endpoint, payload, maxAttempts } = descriptor;
    if (!localSessionId) throw new Error('SyncQueue.enqueue requires localSessionId');
    if (requestType !== 'autoweigh' && requestType !== 'complete') {
      throw new Error(`SyncQueue.enqueue: invalid requestType "${requestType}"`);
    }

    const db = this._db();
    const clientLocalId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO weighing_queue
        (local_session_id, client_local_id, request_type, endpoint, payload, status, attempts, max_attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
      [
        localSessionId,
        clientLocalId,
        requestType,
        endpoint,
        JSON.stringify(payload || {}),
        maxAttempts || DEFAULT_MAX_ATTEMPTS,
        now,
        now,
        now
      ]
    );

    const row = db.get('SELECT * FROM weighing_queue WHERE client_local_id = ?', [clientLocalId]);
    console.log(`[SyncQueue] Enqueued ${requestType} (id=${row.id}, session=${localSessionId}, clientLocalId=${clientLocalId})`);
    EventBus.emit('sync-queue:enqueued', {
      id: row.id,
      requestType,
      localSessionId,
      clientLocalId
    });
    EventBus.emit('sync-queue:status-changed', this.getStatus());
    return row;
  }

  /**
   * Find the (most recent) autoweigh row for a session - the dependency a queued
   * complete row waits on.
   */
  _findAutoweighRow(localSessionId) {
    return this._db().get(
      `SELECT * FROM weighing_queue
       WHERE local_session_id = ? AND request_type = 'autoweigh'
       ORDER BY created_at DESC LIMIT 1`,
      [localSessionId]
    );
  }

  _patchWeighingTransactionId(row, backendTransactionId) {
    const db = this._db();
    const payload = JSON.parse(row.payload);
    if (payload.weighingTransactionId) return payload; // already resolved (e.g. frontend-synced) - don't override
    payload.weighingTransactionId = backendTransactionId;
    db.run('UPDATE weighing_queue SET payload = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(payload),
      new Date().toISOString(),
      row.id
    ]);
    return payload;
  }

  _handleFailure(row, errorMessage) {
    const db = this._db();
    const attempts = row.attempts + 1;
    const now = new Date().toISOString();

    if (attempts >= row.max_attempts) {
      db.run(
        `UPDATE weighing_queue SET status = 'dead_letter', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        [attempts, errorMessage, now, row.id]
      );
      console.warn(`[SyncQueue] Row ${row.id} (${row.request_type}) moved to dead_letter after ${attempts} attempts: ${errorMessage}`);
      EventBus.emit('sync-queue:dead-letter', { id: row.id, requestType: row.request_type, attempts, error: errorMessage });
      EventBus.emit('sync-queue:status-changed', this.getStatus());
      return null;
    }

    const backoffMs = this._computeBackoffMs(attempts);
    const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
    db.run(
      `UPDATE weighing_queue SET status = 'pending', attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
      [attempts, errorMessage, nextAttemptAt, now, row.id]
    );
    console.log(`[SyncQueue] Row ${row.id} (${row.request_type}) attempt ${attempts} failed, retrying in ${Math.round(backoffMs / 1000)}s: ${errorMessage}`);
    EventBus.emit('sync-queue:retry-scheduled', { id: row.id, requestType: row.request_type, attempts, nextAttemptAt, error: errorMessage });
    EventBus.emit('sync-queue:status-changed', this.getStatus());
    return null;
  }

  _handleDeadLetter(row, errorMessage) {
    const db = this._db();
    const now = new Date().toISOString();
    db.run(
      `UPDATE weighing_queue SET status = 'dead_letter', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
      [errorMessage, now, row.id]
    );
    console.warn(`[SyncQueue] Row ${row.id} (${row.request_type}) moved to dead_letter (non-retryable): ${errorMessage}`);
    EventBus.emit('sync-queue:dead-letter', { id: row.id, requestType: row.request_type, error: errorMessage });
    EventBus.emit('sync-queue:status-changed', this.getStatus());
    return null;
  }

  /**
   * Attempt to send one queued row now. Never throws - failures are recorded on the
   * row and null is returned so callers can treat "queued for later" and "failed
   * permanently" uniformly.
   *
   * @param {number} rowId
   * @returns {Object|null} the backend response body on success, else null
   */
  async attempt(rowId) {
    const db = this._db();
    const row = db.get('SELECT * FROM weighing_queue WHERE id = ?', [rowId]);
    if (!row) return null;
    if (row.status === 'synced') {
      // Already synced (e.g. attempt() called twice) - return what we know without re-sending.
      return { weighingId: row.backend_transaction_id, alreadySynced: true };
    }
    if (row.status === 'dead_letter') return null;

    let payload = JSON.parse(row.payload);

    // Dependency gate: a complete row can't send until its autoweigh sibling has synced,
    // and inherits that sibling's backend transaction id as weighingTransactionId.
    if (row.request_type === 'complete') {
      const dep = this._findAutoweighRow(row.local_session_id);
      if (!dep || dep.status !== 'synced') {
        // Not eligible yet - leave the row pending untouched. This is not a failed
        // attempt, so attempts/backoff are not touched.
        return null;
      }
      if (dep.backend_transaction_id) {
        payload = this._patchWeighingTransactionId(row, dep.backend_transaction_id);
      }
    }

    const BackendClient = require('./BackendClient');
    const client = BackendClient.getInstance();

    if (!client.config.baseUrl) {
      return this._handleFailure(row, 'Backend base URL not configured');
    }

    const now = new Date().toISOString();
    db.run(`UPDATE weighing_queue SET status = 'sending', updated_at = ? WHERE id = ?`, [now, row.id]);

    const authHeader = await client._getAuthHeader();
    if (!authHeader) {
      return this._handleFailure(row, 'Authentication failed (offline or invalid credentials)');
    }

    try {
      const response = await client._fetch(`${client.config.baseUrl}${row.endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader
        },
        body: JSON.stringify({ ...payload, clientLocalId: row.client_local_id })
      });

      if (response.ok) {
        const result = await response.json();
        const syncedAt = new Date().toISOString();
        db.run(
          `UPDATE weighing_queue SET status = 'synced', backend_transaction_id = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
          [result.weighingId ? String(result.weighingId) : null, syncedAt, row.id]
        );
        console.log(`[SyncQueue] Row ${row.id} (${row.request_type}) synced: backendTransactionId=${result.weighingId}`);
        EventBus.emit('sync-queue:synced', {
          id: row.id,
          requestType: row.request_type,
          localSessionId: row.local_session_id,
          backendTransactionId: result.weighingId,
          result
        });
        EventBus.emit('sync-queue:status-changed', this.getStatus());
        return result;
      }

      const errorText = await response.text().catch(() => '');

      // A stale-but-not-yet-expired cached token can still be rejected server-side.
      // Force re-authentication on the next attempt and treat this as retryable.
      if (response.status === 401) {
        client.auth.accessToken = null;
        return this._handleFailure(row, `HTTP 401 Unauthorized: ${errorText}`);
      }
      // Rate limiting and server errors are transient - retry with backoff.
      if (response.status === 429 || response.status >= 500) {
        return this._handleFailure(row, `HTTP ${response.status}: ${errorText}`);
      }
      // Any other 4xx is a permanent client error (bad payload, validation failure) -
      // retrying won't help, so dead-letter immediately for operator review.
      return this._handleDeadLetter(row, `HTTP ${response.status}: ${errorText}`);
    } catch (err) {
      return this._handleFailure(row, err.message);
    }
  }

  /**
   * Process all due pending rows. Rows are processed in creation order, which
   * naturally sends an autoweigh row before its complete sibling (the complete
   * row is always enqueued strictly after its autoweigh row). A complete row whose
   * dependency isn't synced yet is skipped (left pending) and picked up on a later
   * drain pass.
   */
  async drain() {
    if (this.draining) return { processed: 0, skipped: true };
    this.draining = true;
    let processed = 0;

    try {
      const db = this._db();
      const now = new Date().toISOString();
      const rows = db.all(
        `SELECT id FROM weighing_queue
         WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC`,
        [now]
      );

      for (const { id } of rows) {
        // Re-check status in case an earlier row in this same pass changed it
        // (e.g. its autoweigh sibling just synced, unblocking a complete row).
        const fresh = db.get('SELECT status FROM weighing_queue WHERE id = ?', [id]);
        if (!fresh || fresh.status !== 'pending') continue;
        await this.attempt(id);
        processed++;
      }
    } finally {
      this.draining = false;
    }

    return { processed };
  }

  /**
   * Move all dead_letter rows back to pending for a fresh attempt cycle, then
   * kick a drain. Used by the operator-facing "Retry dead letters" action.
   */
  retryDeadLetters() {
    const db = this._db();
    const now = new Date().toISOString();
    const result = db.run(
      `UPDATE weighing_queue SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL, updated_at = ? WHERE status = 'dead_letter'`,
      [now, now]
    );
    const requeued = result.changes || 0;
    console.log(`[SyncQueue] Requeued ${requeued} dead-letter row(s) for retry`);
    EventBus.emit('sync-queue:status-changed', this.getStatus());
    if (requeued > 0) {
      setImmediate(() => this.drain().catch(err => console.error('[SyncQueue] drain after retry error:', err.message)));
    }
    return { requeued };
  }

  /**
   * Summary counts for the Settings UI.
   */
  getStatus() {
    const db = this._db();
    const counts = db.all('SELECT status, COUNT(*) as count FROM weighing_queue GROUP BY status');
    const summary = { pending: 0, sending: 0, dead_letter: 0, synced: 0 };
    for (const c of counts) {
      summary[c.status] = c.count;
    }
    const oldest = db.get(
      `SELECT MIN(created_at) as oldest FROM weighing_queue WHERE status IN ('pending', 'sending')`
    );
    return { ...summary, oldestPendingAt: oldest ? oldest.oldest : null };
  }

  startPeriodicDrain(intervalMs) {
    this.stopPeriodicDrain();
    this.drainIntervalMs = intervalMs || this.drainIntervalMs;
    this.drainTimer = setInterval(() => {
      this.drain().catch(err => console.error('[SyncQueue] periodic drain error:', err.message));
    }, this.drainIntervalMs);
    if (this.drainTimer.unref) this.drainTimer.unref();
    console.log(`[SyncQueue] Periodic drain started (every ${this.drainIntervalMs}ms)`);
  }

  stopPeriodicDrain() {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }
}

// Singleton instance
let instance = null;

function getInstance() {
  if (!instance) {
    instance = new SyncQueue();
  }
  return instance;
}

module.exports = {
  getInstance,
  enqueue: (descriptor) => getInstance().enqueue(descriptor),
  attempt: (rowId) => getInstance().attempt(rowId),
  drain: () => getInstance().drain(),
  retryDeadLetters: () => getInstance().retryDeadLetters(),
  getStatus: () => getInstance().getStatus(),
  startPeriodicDrain: (intervalMs) => getInstance().startPeriodicDrain(intervalMs),
  stopPeriodicDrain: () => getInstance().stopPeriodicDrain(),
  SyncQueue
};
