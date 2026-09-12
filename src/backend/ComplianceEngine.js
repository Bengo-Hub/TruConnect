/**
 * Local offline compliance engine (enforcement) + lightweight commercial capture math.
 *
 * A hand-port of truload-frontend's `src/lib/offline/compliance.ts`
 * (`computeProvisionalCompliance`, parity-tested 30/30 against the real backend) so
 * TruConnect can produce the SAME per-axle-group + GVW overload decision entirely
 * offline, using only what `ConfigSyncService` has already mirrored locally
 * (`backend_axle_configurations`, `backend_axle_weight_references`,
 * `backend_tolerance_settings`). The result is flagged `provisional`: the backend
 * recomputes authoritatively (plus fees/case/prosecution) once the weighing syncs.
 *
 * IMPORTANT: this must stay in lockstep with `AxleGroupAggregationService`
 * (truload-backend) exactly like the frontend copy does. Do not diverge the pure
 * functions below from `compliance.ts` without re-validating both.
 *
 * Commercial mode intentionally does NOT get a local tolerance-exceeded decision here:
 * that check depends on org+cargo-scoped `CommercialToleranceSettings` rows TruConnect
 * does not mirror (a cloud-only concept, per the redesign plan's explicit scope). Only
 * the raw tare/gross/net arithmetic — a pure function needing nothing but the two
 * captured weights — is computed locally; tolerance/billing is resolved on sync.
 */

'use strict';

// ── small string helpers (mirrors compliance.ts's up/eq) ──────────────────────
function up(s) {
  return (s ?? '').toString().toUpperCase();
}
function eq(a, b) {
  return up(a) === up(b);
}

/**
 * Resolve the effective tolerance setting for (framework, appliesTo), faithfully
 * mirroring ToleranceRepository.GetToleranceAsync: match exact framework OR 'BOTH' OR
 * 'GLOBAL', and exact appliesTo OR 'BOTH'; then prioritise exact framework (2) > BOTH
 * (1) > GLOBAL (0), then exact appliesTo > BOTH.
 */
function getTolerance(settings, legalFramework, appliesTo) {
  const f = up(legalFramework);
  const a = up(appliesTo);
  const fwPriority = (s) => (up(s.legalFramework) === f ? 2 : up(s.legalFramework) === 'BOTH' ? 1 : 0);
  const applPriority = (s) => (up(s.appliesTo) === a ? 1 : 0);
  const candidates = settings.filter(
    (s) =>
      (up(s.legalFramework) === f || up(s.legalFramework) === 'BOTH' || up(s.legalFramework) === 'GLOBAL') &&
      (up(s.appliesTo) === a || up(s.appliesTo) === 'BOTH')
  );
  if (candidates.length === 0) return null;
  candidates.sort((x, y) => fwPriority(y) - fwPriority(x) || applPriority(y) - applPriority(x));
  return candidates[0];
}

function getByCode(settings, code) {
  return settings.find((s) => eq(s.code, code)) ?? null;
}

/** kg from a setting: fixed kg wins, else percentage of permissible, else 0. */
function toleranceKgOf(setting, permissibleKg) {
  if (!setting) return 0;
  if (setting.toleranceKg != null && setting.toleranceKg > 0) return setting.toleranceKg;
  if (setting.tolerancePercentage > 0) return Math.round(permissibleKg * (setting.tolerancePercentage / 100));
  return 0;
}

/**
 * Per-axle-group tolerance — mirrors CalculateGroupToleranceAsync precedence:
 *   1. Act-specific AXLE setting (exists => final, even 0% = strict).
 *   2. STANDARD_LAW_SINGLE (<=1 axle) / STANDARD_LAW_GROUP (2+) — only if no act AXLE setting.
 *   3. 0% strict.
 */
function groupToleranceKg(settings, legalFramework, axleCount, groupPermissibleKg) {
  const actSetting = getTolerance(settings, legalFramework, 'AXLE');
  if (actSetting) return toleranceKgOf(actSetting, groupPermissibleKg);

  const standard = getByCode(settings, axleCount <= 1 ? 'STANDARD_LAW_SINGLE' : 'STANDARD_LAW_GROUP');
  return toleranceKgOf(standard, groupPermissibleKg);
}

function determineStatus(overloadKg, opToleranceKg) {
  if (overloadKg <= 0) return 'LEGAL';
  if (overloadKg <= opToleranceKg) return 'WARNING';
  return 'OVERLOAD';
}

/**
 * Compute exact overload (GVW + per axle group) offline from cached reference data.
 *
 * @param {{
 *   axles: {axleNumber:number, measuredWeightKg:number, permissibleWeightKg:number, axleGrouping:string}[],
 *   gvwPermissibleKg: number,
 *   gvwConfigToleranceKg?: number|null,
 *   legalFramework: string,
 *   toleranceSettings: {code:string, legalFramework:string, tolerancePercentage:number, toleranceKg:number|null, appliesTo:string}[],
 * }} input
 */
function computeProvisionalCompliance(input) {
  const { axles, legalFramework, toleranceSettings } = input;

  const opSetting = getByCode(toleranceSettings, 'OPERATIONAL_ALLOWANCE');
  const operationalToleranceKg = opSetting?.toleranceKg ?? 200;

  // ── Axle groups (group by axleGrouping, ordered) ──
  const groupMap = new Map();
  for (const a of axles) {
    const arr = groupMap.get(a.axleGrouping) ?? [];
    arr.push(a);
    groupMap.set(a.axleGrouping, arr);
  }
  const groupResults = [...groupMap.keys()]
    .sort()
    .map((label) => {
      const groupAxles = groupMap.get(label);
      const groupWeightKg = groupAxles.reduce((s, a) => s + a.measuredWeightKg, 0);
      const groupPermissibleKg = groupAxles.reduce((s, a) => s + a.permissibleWeightKg, 0);
      const toleranceKg = groupToleranceKg(toleranceSettings, legalFramework, groupAxles.length, groupPermissibleKg);
      const effectiveLimitKg = groupPermissibleKg + toleranceKg;
      const overloadKg = Math.max(0, groupWeightKg - effectiveLimitKg);
      return {
        groupLabel: label,
        axleCount: groupAxles.length,
        groupWeightKg,
        groupPermissibleKg,
        toleranceKg,
        effectiveLimitKg,
        overloadKg,
        status: determineStatus(overloadKg, operationalToleranceKg)
      };
    });

  // ── GVW ──
  const gvwMeasuredKg = axles.reduce((s, a) => s + a.measuredWeightKg, 0);
  const gvwPermissibleKg = input.gvwPermissibleKg;
  // Per-config GVW override (>= 1000kg) wins; else regulatory GVW tolerance.
  const gvwToleranceKg =
    input.gvwConfigToleranceKg != null && input.gvwConfigToleranceKg >= 1000
      ? input.gvwConfigToleranceKg
      : toleranceKgOf(getTolerance(toleranceSettings, legalFramework, 'GVW'), gvwPermissibleKg);
  const gvwEffectiveLimitKg = gvwPermissibleKg + gvwToleranceKg;
  const gvwOverloadKg = Math.max(0, gvwMeasuredKg - gvwEffectiveLimitKg);

  const anyOverload = gvwOverloadKg > 0 || groupResults.some((g) => g.overloadKg > 0);
  const maxOverload = Math.max(gvwOverloadKg, ...groupResults.map((g) => g.overloadKg), 0);

  return {
    provisional: true,
    isCompliant: !anyOverload,
    overallStatus: determineStatus(maxOverload, operationalToleranceKg),
    gvwMeasuredKg,
    gvwPermissibleKg,
    gvwToleranceKg,
    gvwEffectiveLimitKg,
    gvwOverloadKg,
    operationalToleranceKg,
    groupResults
  };
}

/**
 * Glue: read the locally mirrored axle config + weight refs + tolerance settings from
 * SQLite and compute a provisional enforcement decision for a captured set of axle
 * readings. Returns null (fails closed, never guesses) if the axle config or its
 * weight references haven't been synced locally yet.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{axleConfigurationId: string, axles: {axleNumber:number, measuredWeightKg:number}[],
 *   legalFrameworkOverride?: string|null}} params
 */
function computeOfflineComplianceFromDb(db, { axleConfigurationId, axles, legalFrameworkOverride }) {
  const config = db.prepare('SELECT * FROM backend_axle_configurations WHERE id = ?').get(axleConfigurationId);
  if (!config) return null;

  const weightRefs = db
    .prepare('SELECT * FROM backend_axle_weight_references WHERE axle_configuration_id = ?')
    .all(axleConfigurationId);
  if (!weightRefs.length) return null;

  const rawConfig = JSON.parse(config.raw_json);
  // Enforcement (no override) resolves the framework from the axle config's OWN tag, as
  // before. Commercial pre-compliance passes the ORG's selected framework explicitly
  // instead - mirrors truload-backend's WeighingService.CalculateComplianceAsync, which
  // resolves legalFramework from Organization.SelectedLegalFramework for a commercial
  // transaction rather than the config's own tag or the enforcement-wide default act.
  const legalFramework = legalFrameworkOverride || rawConfig.legalFramework || 'TRAFFIC_ACT';

  const toleranceRows = db
    .prepare('SELECT * FROM backend_tolerance_settings WHERE is_active = 1')
    .all()
    .map((r) => ({
      code: r.code,
      legalFramework: r.legal_framework,
      tolerancePercentage: r.tolerance_percentage,
      toleranceKg: r.tolerance_kg,
      appliesTo: r.applies_to
    }));

  const refByPos = new Map(weightRefs.map((r) => [r.axle_position, r]));
  const engineAxles = axles.map((a) => {
    const ref = refByPos.get(a.axleNumber);
    return {
      axleNumber: a.axleNumber,
      measuredWeightKg: a.measuredWeightKg,
      permissibleWeightKg: ref ? ref.axle_legal_weight_kg : 0,
      axleGrouping: ref ? ref.axle_grouping : String(a.axleNumber)
    };
  });

  const compliance = computeProvisionalCompliance({
    axles: engineAxles,
    gvwPermissibleKg: config.gvw_permissible_kg,
    // AxleConfiguration GVW tolerance override (>=1000kg) — carried in raw_json since
    // backend_axle_configurations' own columns are a narrow projection (see ConfigSyncService).
    gvwConfigToleranceKg: rawConfig.toleranceKg ?? null,
    legalFramework,
    toleranceSettings: toleranceRows
  });

  return { ...compliance, legalFramework, axleConfigCode: config.axle_code };
}

/**
 * Lightweight commercial capture math: tare/gross/net resolution only, mirroring
 * CommercialWeighingService.cs's CaptureSubsequentWeightAsync (lines ~317-332). No
 * tolerance-exceeded/billing decision — those depend on org+cargo-scoped
 * CommercialToleranceSettings/CommercialTariffRule rows that are NOT mirrored locally
 * by design (cloud-only, resolved on sync).
 *
 * @param {{firstWeightKg:number, firstWeightType:'tare'|'gross', secondWeightKg:number}} params
 */
function computeCommercialCaptureResult({ firstWeightKg, firstWeightType, secondWeightKg }) {
  let tareWeightKg;
  let grossWeightKg;
  if (firstWeightType === 'tare') {
    tareWeightKg = firstWeightKg;
    grossWeightKg = secondWeightKg;
  } else {
    tareWeightKg = secondWeightKg;
    grossWeightKg = firstWeightKg;
  }

  return {
    provisional: true,
    tareWeightKg,
    grossWeightKg,
    netWeightKg: grossWeightKg - tareWeightKg,
    toleranceExceeded: null // unresolvable offline — resolved by the backend on sync
  };
}

module.exports = {
  computeProvisionalCompliance,
  computeOfflineComplianceFromDb,
  computeCommercialCaptureResult,
  // exported for the parity test only
  _internal: { getTolerance, getByCode, toleranceKgOf, groupToleranceKg, determineStatus }
};
