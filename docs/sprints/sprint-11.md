# Sprint 11: 255-D WD2 Scale and TruLoad Sync

**Duration**: 2026-11-04
**Goal**: Add the Bluetooth 255-D axle scale, and make TruLoad and TruConnect agree on the setup, the operator and each weighing.

---

## Delivered

### Scale

- New `wd2` source for the Portable axle scale 255-D (WD2-88888-5.0). The frame format and console behaviour are in `docs/WD2-WEIGHT-STRING.md`.
- Checked on real 2, 3 and 4 axle runs. The frame is a held running total, so TruConnect reads each axle from the change in that total.
- Minimum axle capture weight is configurable in settings and defaults to 50 kg.
- If frames stop for 10 seconds while the port stays open, TruConnect reopens the port and keeps trying. It waits 2 seconds before reopening, because an immediate reopen failed with Windows error 1168.
- A total that rises during a pause reads normally, with a notice to check the console's axle list.
- The same held-total protection is on for MCGS scales. It has not been tested on MCGS hardware.

### TruLoad and TruConnect

- TruLoad fills TruConnect's setup: mode, plate, axle configuration, tenant and station. The fields stay editable.
- A device binds to one org slug. If a different org connects, the operator confirms the change. TruLoad decides the station.
- Plate, axle configuration and step 2 details are sent when Next is pressed, not while the operator types. See `docs/integrations.md`.
- A capture in TruLoad now updates TruConnect's screen.
- The commercial second weight sends the opposite of the first weight's tare or gross.
- TruConnect's start-up WebSocket keepalive no longer drops healthy clients.

### Sign-in

- TruConnect accepts a TruLoad account. The password is stored encrypted with Electron safeStorage, and the last good password works offline.
- Demo mode is off by default.
- `WEIGHING_OPERATOR` gains `config.read`, `station.read`, `weighing.read` and `weighing.webhook`.

### Auto-weigh

- With auto-weigh on and the backend connected, TruConnect sends the auto record first, then the operator's final capture updates the same record to `captured`. See `docs/AUTO_WEIGH_FLOW.md`.
- An `auto` record stores its weights and compliance result. Case, yard entry, prohibition, notifications and the manual tag check wait for the final capture.
- Commercial weighings do not use auto records.

### Fixes found during testing

| Problem | Cause | Fix |
|---------|-------|-----|
| Crash when frames paused in the released build | `OutputManager.broadcastWeight` was not exported | Exported, and a test now scans `main.js` for missing module calls |
| Real readings shown as 0 | A restart rule zeroed readings with no axles captured | Rule removed when no axle has been captured |
| MCGS read 3900 instead of 6000 | The first held-total rule was too broad | Only the exact repeated total reads 0, and only before any capture |
| Second axle stayed at the first axle's value | TruConnect's session did not follow TruLoad's capture | `truload:session-changed` event |
| Multideck sent `transaction-sync` with each weight frame | The effect depended on the `useMiddleware` result, which is new on every render | The effect now depends on the connection state |
| Axle configuration changed in TruConnect at page load and during plate lookup | Effects sent it before a transaction existed | Removed, as Next already sends it |

---

## Verification

| Repo | Result | Commit |
|------|--------|--------|
| TruConnect | Workflow, parser and sync test scripts pass, CI passed | `0f676ab`, release v2.0.115 |
| truload-backend | Build clean, 253 of 253 tests pass, CI passed | `8cff5cc` |
| truload-frontend | `tsc`, 26 of 26 tests and production build pass | `dfde894` |

Live run through both apps: plate `KDS456S`, configuration 2A, axle 1 60 kg, axle 2 100 kg, GVW 160 kg. This run came before the Next-only sync and the 2 second reopen delay, so both still need a live retest.

---

## Open

| Item | State |
|------|-------|
| Live retest of Next-only sync and port reopen | Waiting on an operator at the scale |
| Scale frames stop 20 to 45 seconds after the port opens | Root cause unknown. Reopening recovers them |
| `Auth failed 500` at start-up, trace `0HNPQF592IU4D:00000006` | Client now logs in once at a time. Backend cause not investigated |
| MCGS held-total rule | Not tested on hardware |
| RDU driver instruction text | Waits on an RDU model that can display it |
| 23 backend compiler warnings | Not fixed |
| Next.js workspace-root warning, tiptap peer mismatch | Not fixed |
| Audit of queries, stats and reports, including `auto` records with no final capture | Not started |
| Pending transaction `009db876-00e1-4a0a-95ad-8e9030facb0c` from the `KDY074S` test | Not checked. The production read needs the user's approval |
