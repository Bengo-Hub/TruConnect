/**
 * Standalone verification script for ComplianceEngine.js's ported compliance math
 * (offline-weighing redesign, 2026-09). No test framework in this repo (see other files
 * in this directory) - run directly with `node tests/compliance-engine-test.js`.
 *
 * Fixtures are copied 1:1 from truload-frontend's own parity-locked unit tests
 * (src/lib/offline/__tests__/compliance.test.ts, itself real kuraweigh weighings /
 * settings) so this file proves the TruConnect hand-port produces byte-identical
 * results to the already-validated frontend engine, not just "looks plausible."
 *
 * This file only exercises the pure `computeProvisionalCompliance` function - it takes
 * no SQLite/`better-sqlite3` dependency, so it runs under plain `node` even in an
 * environment where the native module can't be loaded/compiled (see
 * `sync-queue-and-config-sync-test.js`, which DOES need better-sqlite3 and must be run
 * on a machine with a working build toolchain or via Electron's own bundled Node ABI).
 */

'use strict';

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    failures++;
    console.error(`[FAIL] ${message}`);
  } else {
    console.log(`[OK]   ${message}`);
  }
}

const { computeProvisionalCompliance } = require('../src/backend/ComplianceEngine');

// Mirror of tolerance_settings in kuraweigh (same fixture as the frontend's test).
const SETTINGS = [
  { code: 'BOTH_AXLE_TOLERANCE', legalFramework: 'BOTH', tolerancePercentage: 5, toleranceKg: null, appliesTo: 'AXLE' },
  { code: 'BOTH_GVW_TOLERANCE', legalFramework: 'BOTH', tolerancePercentage: 5, toleranceKg: null, appliesTo: 'GVW' },
  { code: 'EAC_AXLE_TOLERANCE', legalFramework: 'EAC', tolerancePercentage: 5, toleranceKg: null, appliesTo: 'AXLE' },
  { code: 'EAC_GVW_TOLERANCE', legalFramework: 'EAC', tolerancePercentage: 5, toleranceKg: null, appliesTo: 'GVW' },
  { code: 'STANDARD_LAW_SINGLE', legalFramework: 'GLOBAL', tolerancePercentage: 5, toleranceKg: null, appliesTo: 'AXLE' },
  { code: 'OPERATIONAL_ALLOWANCE', legalFramework: 'GLOBAL', tolerancePercentage: 0, toleranceKg: 200, appliesTo: 'BOTH' },
  { code: 'STANDARD_LAW_GROUP', legalFramework: 'GLOBAL', tolerancePercentage: 0, toleranceKg: null, appliesTo: 'BOTH' },
  { code: 'TRAFFIC_ACT_AXLE_TOLERANCE', legalFramework: 'TRAFFIC_ACT', tolerancePercentage: 5, toleranceKg: null, appliesTo: 'AXLE' },
  { code: 'TRAFFIC_ACT_GVW_TOLERANCE', legalFramework: 'TRAFFIC_ACT', tolerancePercentage: 0, toleranceKg: 3000, appliesTo: 'GVW' }
];

console.log('\n--- compliant 3-axle (perm 26000, meas 24600, GVW tol 3000) -> no GVW overload ---');
{
  const r = computeProvisionalCompliance({
    legalFramework: 'TRAFFIC_ACT',
    gvwPermissibleKg: 26000,
    gvwConfigToleranceKg: 3000,
    toleranceSettings: SETTINGS,
    axles: [
      { axleNumber: 1, measuredWeightKg: 6600, permissibleWeightKg: 8000, axleGrouping: 'A' },
      { axleNumber: 2, measuredWeightKg: 8700, permissibleWeightKg: 9000, axleGrouping: 'B' },
      { axleNumber: 3, measuredWeightKg: 9300, permissibleWeightKg: 9000, axleGrouping: 'B' }
    ]
  });
  assert(r.gvwMeasuredKg === 24600, `gvwMeasuredKg === 24600 (got ${r.gvwMeasuredKg})`);
  assert(r.gvwOverloadKg === 0, `gvwOverloadKg === 0 (got ${r.gvwOverloadKg})`);
  assert(r.provisional === true, 'provisional === true');
  assert(r.isCompliant === true, 'isCompliant === true');
}

console.log('\n--- overloaded 2-axle (perm 18000, meas 19700, GVW tol 1500) -> 200kg GVW overload ---');
{
  const r = computeProvisionalCompliance({
    legalFramework: 'TRAFFIC_ACT',
    gvwPermissibleKg: 18000,
    gvwConfigToleranceKg: 1500,
    toleranceSettings: SETTINGS,
    axles: [
      { axleNumber: 1, measuredWeightKg: 6500, permissibleWeightKg: 8000, axleGrouping: 'A' },
      { axleNumber: 2, measuredWeightKg: 13200, permissibleWeightKg: 10000, axleGrouping: 'B' }
    ]
  });
  assert(r.gvwMeasuredKg === 19700, `gvwMeasuredKg === 19700 (got ${r.gvwMeasuredKg})`);
  assert(r.gvwOverloadKg === 200, `gvwOverloadKg === 200 (got ${r.gvwOverloadKg}) — 19700 - (18000 + 1500)`);
  assert(r.overallStatus === 'OVERLOAD', `overallStatus === 'OVERLOAD' (got ${r.overallStatus})`);
  const b = r.groupResults.find((g) => g.groupLabel === 'B');
  assert(!!b && b.overloadKg === 2700, `group B overloadKg === 2700 (got ${b && b.overloadKg}) — 13200 - (10000 + 5%=500)`);
}

console.log("\n--- replicates GetToleranceAsync precedence: regulatory GVW used when no config override ---");
{
  const r = computeProvisionalCompliance({
    legalFramework: 'TRAFFIC_ACT',
    gvwPermissibleKg: 26000,
    gvwConfigToleranceKg: null,
    toleranceSettings: SETTINGS,
    axles: [{ axleNumber: 1, measuredWeightKg: 30000, permissibleWeightKg: 26000, axleGrouping: 'A' }]
  });
  assert(r.gvwToleranceKg === 3000, `gvwToleranceKg === 3000 (got ${r.gvwToleranceKg})`);
  assert(r.gvwOverloadKg === 1000, `gvwOverloadKg === 1000 (got ${r.gvwOverloadKg}) — 30000 - 29000`);
}

console.log('\n--- config override below 1000kg is ignored in favour of regulatory tolerance ---');
{
  const r = computeProvisionalCompliance({
    legalFramework: 'TRAFFIC_ACT',
    gvwPermissibleKg: 26000,
    gvwConfigToleranceKg: 500,
    toleranceSettings: SETTINGS,
    axles: [{ axleNumber: 1, measuredWeightKg: 30000, permissibleWeightKg: 26000, axleGrouping: 'A' }]
  });
  assert(r.gvwToleranceKg === 3000, `gvwToleranceKg === 3000 (got ${r.gvwToleranceKg}), 500kg override must be ignored`);
}

console.log('\n--- no tolerance settings at all -> strict 0% everywhere ---');
{
  const r = computeProvisionalCompliance({
    legalFramework: 'TRAFFIC_ACT',
    gvwPermissibleKg: 10000,
    gvwConfigToleranceKg: null,
    toleranceSettings: [],
    axles: [{ axleNumber: 1, measuredWeightKg: 10050, permissibleWeightKg: 10000, axleGrouping: 'A' }]
  });
  assert(r.gvwToleranceKg === 0, `gvwToleranceKg === 0 with no settings configured (got ${r.gvwToleranceKg})`);
  assert(r.gvwOverloadKg === 50, `gvwOverloadKg === 50 (got ${r.gvwOverloadKg})`);
  assert(r.operationalToleranceKg === 200, `operationalToleranceKg falls back to 200 when OPERATIONAL_ALLOWANCE isn't cached (got ${r.operationalToleranceKg})`);
  assert(r.overallStatus === 'WARNING', `overallStatus === 'WARNING' (50kg over is within the 200kg operational allowance) (got ${r.overallStatus})`);
}

console.log('\n--- commercial capture math: gross-first (outbound) resolves tare/gross/net correctly ---');
{
  const { computeCommercialCaptureResult } = require('../src/backend/ComplianceEngine');
  const r1 = computeCommercialCaptureResult({ firstWeightKg: 32400, firstWeightType: 'gross', secondWeightKg: 24800 });
  assert(r1.tareWeightKg === 24800 && r1.grossWeightKg === 32400 && r1.netWeightKg === 7600,
    `gross-first: tare=24800 gross=32400 net=7600 (got tare=${r1.tareWeightKg} gross=${r1.grossWeightKg} net=${r1.netWeightKg})`);

  const r2 = computeCommercialCaptureResult({ firstWeightKg: 12000, firstWeightType: 'tare', secondWeightKg: 29500 });
  assert(r2.tareWeightKg === 12000 && r2.grossWeightKg === 29500 && r2.netWeightKg === 17500,
    `tare-first: tare=12000 gross=29500 net=17500 (got tare=${r2.tareWeightKg} gross=${r2.grossWeightKg} net=${r2.netWeightKg})`);
  assert(r2.toleranceExceeded === null, 'toleranceExceeded is explicitly null offline (cloud-only, resolved on sync)');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
