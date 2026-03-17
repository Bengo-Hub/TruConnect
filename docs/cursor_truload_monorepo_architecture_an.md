# TruLoad monorepo architecture analysis
_Exported on 3/1/2026 at 18:44:05 GMT+3 from Cursor (2.5.26)_

---

**User**

You are analyzing a monorepo under D:\Projects\Codevertex\TruLoad. Goal: understand the TruConnect middleware, truload-frontend, and truload-backend flows, especially auto-weight, device integrations, and configuration for input sources.

Please do the following:
1) Identify directories and key files for:
   - TruConnect middleware (integration/middleware services, device handling, input sources)
   - truload-frontend (where it talks to TruConnect, connection/workflow docs)
   - truload-backend (auto-weight flow, how it triggers TruConnect, API endpoints)
   - Any .md documentation describing TruConnect, integrations, workflows, and auto-weight flows.
2) Summarize the current architecture:
   - How TruConnect communicates with frontend and backend (protocols, APIs, queues, notifications).
   - How device integrations and input sources are modeled/configured (e.g., TCP/UDP/Serial, COM ports, IP/port, commands).
   - Existing flows for auto-weight during mobile axle-by-axle capture and multideck capture.
3) Identify any explicit references to MCGS, mobile scales, or weight console integrations and list the relevant files.
4) Based on the above, list concrete gaps or limitations you see around:
   - Device/input source configuration flexibility (protocol selection, COM ports, IP/ports, per-command configuration).
   - Middleware-trigger points and how robust/clear the flows are between frontend, backend, and TruConnect.

Return:
- A structured summary with sections: `Architecture Overview`, `TruConnect Middleware`, `truload-frontend`, `truload-backend & Auto-Weight`, `Device/Input Configuration Model`, `Existing MCGS/Mobile Scale References`, `Identified Gaps & Improvement Opportunities`.
- For each section, include bullet points with key files/paths and a short description of their role.
- Focus on facts from the code/docs; avoid speculation unless clearly marked as such.

---

**Cursor**

I’ll first scan the repo structure and search for key terms (`TruConnect`, `truload-frontend`, `truload-backend`, auto-weight, MCGS/mobile scale) in parallel, then drill into the most relevant files to extract concrete architecture and flow details. I’ll keep everything read-only and then organize findings into the sections you requested.

I’ve located the main TruConnect, frontend, backend, and documentation directories plus high-signal files. Next I’ll open the most relevant docs and source files in each to extract concrete details about architecture, device/input modeling, and auto-weight flows.

## Architecture Overview

- **Monorepo layout & roles**
  - `TruConnect/`: **Electron/Node.js middleware** that talks to physical scales/indicators (serial/TCP/UDP/HTTP), parses weight data, maintains real‑time state, and exposes it via WebSocket/REST to TruLoad plus optional RDU/Cloud.
  - `truload-frontend/`: **Next.js PWA** that connects directly to local TruConnect (WebSocket + HTTP fallback), manages weighing workflows (mobile & multideck), and calls the backend for transactions/compliance.
  - `truload-backend/`: **ASP.NET Core Web API** that owns all business logic (weighing transactions, compliance, permits, scale tests, analytics) and exposes `/api/v1` endpoints, including unified capture and `autoweigh`.

- **Key architecture docs**
  - `TruConnect/docs/architecture.md`: High‑level TruConnect architecture (input/core/output/UI/persistence layers, data flow, event bus).
  - `TruConnect/docs/integrations.md`: Protocol‑level integrations (indicators, RDU, WebSocket/API, external systems).
  - `TruConnect/docs/AUTO_WEIGH_FLOW.md`: End‑to‑end **auto‑weigh flow** across TruConnect, backend, and frontend (local vs cloud modes).
  - `truload-frontend/docs/frontend-architecture.md`: Frontend app architecture, shared patterns, and explicit statement that frontend connects to **local TruConnect**.
  - `truload-frontend/docs/integration.md`: Integration guide (Backend, TruConnect, Superset, offline sync, etc.).
  - `truload-backend/docs/integrations/integration.md`: Backend integration doc, including **TruConnect Microservice Integration** (real‑time + polling, message formats and station/bound semantics).
  - `truload-backend/docs/plan.md` and `docs/sprints/*.md`: Backend implementation plan and sprint‑level summaries for weighing & scale tests.
  - `truload-backend/docs/Master-FRD-KURAWEIGH.md`, `docs/axle-erd-map.md`: Functional requirements and axle data model/ERD documentation.

- **End‑to‑end communication**
  - **TruConnect ↔ Frontend**: Local `WebSocketOutput` on `ws://localhost:3030` plus `ApiOutput` REST on `http://localhost:3031/...` (TruConnect `docs/frontend-integration.md`, `truload-frontend/src/hooks/useMiddleware.ts`).
  - **TruConnect ↔ Backend**: HTTP calls from `TruConnect/src/backend/BackendClient.js` to backend `/api/v1` autoweigh and related endpoints (`TruConnect/docs/AUTO_WEIGH_FLOW.md`, `truload-backend/Controllers/WeighingOperations/WeighingController.cs`).
  - **Frontend ↔ Backend**: REST + JWT‑secured APIs, modeled in `truload-frontend/src/lib/api/weighing.ts` and consumed via query hooks in `src/hooks/queries/useWeighingQueries.ts`.

---

## TruConnect Middleware

- **Core architecture & docs**
  - `TruConnect/docs/architecture.md`: Describes modular, event‑driven architecture: Input layer (serial/TCP/UDP/API), parsers, core `StateManager`, `EventBus`, output layer (WebSocket/API/RDU), UI, SQLite persistence.
  - `TruConnect/docs/integrations.md`: Protocol catalog (ZM, Cardinal, 1310, PAW, Haenni WebServer, UDP Binary, Custom protocol) with detailed examples and parsing strategies.
  - `TruConnect/docs/AUTO_WEIGH_FLOW.md`: Explains how mobile auto‑weight is handled, including references to `MobileScaleParser.js`, `StateManager.js`, frontend `useMiddleware`, and backend `WeighingController.Autoweigh`.

- **Configuration & input modeling**
  - `TruConnect/src/config/defaults.js`: Central default **config model**:
    - Defines **input sources** (e.g. `paw_serial`, `paw_udp`, `haenni_api`, various multideck indicators, `udp_legacy`, `custom`) with protocol‑specific parameters (serial baud/parity, COM port, IP/port, HTTP URLs, polling intervals, parsing mode).
    - Defines **output settings** (WebSocket port, REST API port/paths, RDU serial/network settings).
    - Configures **thresholds**, auto‑weigh options, mobile mode, simulation, logging, backend URLs, and cloud connection parameters.

- **Input handling & device integrations**
  - `TruConnect/src/input/InputManager.js`: Orchestrates **all input sources**:
    - Starts and stops Serial/TCP/UDP/API inputs based on config, attaches appropriate parser instances via `ParserFactory`, and emits `input:weight` events on the `EventBus`.
    - Handles serial‑device **polling/query commands** and message buffering.
  - `TruConnect/src/input/UdpInput.js`: UDP server for portable/mobile scales (legacy binary protocols), binds to configured port, receives messages, optionally joins multicast groups.
  - `TruConnect/src/input/ApiInput.js`: HTTP polling input for devices exposing REST APIs (e.g., Haenni), periodically fetches JSON and forwards payloads to parsers.

- **Parsers (including mobile)**
  - `TruConnect/src/parsers/MobileScaleParser.js`: Specialized **mobile axle weigher parser**:
    - Handles PAW serial ASCII, PAW UDP binary, and Haenni REST JSON; supports combined vs separate scale readings and aggregates per‑axle data.
  - `TruConnect/src/parsers/I1310Parser.js`: Rice Lake 1310 text protocol parser (`Scale No: X` style messages).
  - `TruConnect/src/parsers/CustomParser.js`: Highly configurable generic parser:
    - Supports regex, delimiter‑based, fixed‑width, and JSON path modes; allows mapping arbitrary incoming strings to weight values using config in `defaults.js` / DB.
  - Additional protocol‑specific parsing examples and snippets are described in `docs/integrations.md` (e.g. `parseZM`, `parseCardinal`, `parsePAWWeight`, `parseUdpWeights`).

- **Output & middleware interface**
  - `TruConnect/src/output/OutputManager.js`: Starts configured outputs (WebSocket + REST + RDU) and subscribes to `input:weight` and `state:gvw-updated` events to broadcast to clients.
  - `TruConnect/src/output/WebSocketOutput.js`:
    - Implements WebSocket server (default port 3030), manages client sessions, and defines the two‑way **messaging contract** (`register`, `weights`, `plate`, `axle-captured`, `vehicle-complete`, etc.) used by the frontend.
  - `TruConnect/src/output/ApiOutput.js`:
    - Express server exposing `/weights`, `/gvw`, `/status`, `/plate`, `/capture` endpoints used for **polling** or fallback when WebSocket is unavailable.

- **Backend & cloud connectivity**
  - `TruConnect/src/backend/BackendClient.js`:
    - Handles authentication, maintains session fields like `transactionId` and `vehicleRegNumber`, calls backend `autoweigh` and related endpoints, and implements **offline queueing** (`_queueForSync`, `_processQueue`) for failed requests.
  - `TruConnect/src/cloud/CloudConnectionManager.js`:
    - Manages optional cloud WebSocket connection in “LIVE” mode, relaying weights and commands between local TruConnect and the cloud backend using robust reconnection and message queueing.

- **State, simulation, persistence, and UI**
  - `TruConnect/src/core/StateManager.js`: Central in‑memory state:
    - Tracks deck weights, GVW, mobile axle capture progress, station configuration, device health/status, and emits `state:*` events when updated.
  - `TruConnect/src/simulation/SimulationEngine.js` & `src/simulation/WeightGenerator.js`:
    - Generate simulated weights for testing in mobile and multideck modes; hook into axle capture events to mimic realistic flows.
  - `TruConnect/src/database/Database.js` & `src/database/Seed.js`:
    - Wrap `better-sqlite3`, run schema migrations, seed configuration and reference data based on `defaults.js`, and persist settings/users/station info.
  - `TruConnect/pages/settings.html` & `pages/devices.html`:
    - Internal Electron UI pages to configure station, inputs, outputs, thresholds, backend settings, and to view/manage connected devices.

---

## truload-frontend

- **Architecture & integration docs**
  - `truload-frontend/docs/frontend-architecture.md`:
    - Defines Next.js 16 App Router structure, shared architecture patterns (Auth/RBAC, TanStack Query, Dexie offline, Shadcn UI, Zustand), and confirms **local TruConnect WebSocket** usage.
  - `truload-frontend/docs/integration.md`:
    - Integration overview of Backend, TruConnect microservice, Superset, offline sync, financial workflows; clearly states frontend **always talks directly to local TruConnect**, not relayed via backend.
  - `truload-frontend/docs/WEIGHING_SCREEN_SPECIFICATION.md`:
    - UI/UX spec for weighing screens, dual‑compliance layout, digital twin, and 4‑step workflow (Capture → Vehicle Details → Compliance Review → Decision).
  - `truload-frontend/docs/AXLE_WEIGHT_CONFIG_IMPLEMENTATION.md`:
    - Implementation guide for **AxleWeightConfig** UI and how it maps to backend API for axle reference data.

- **TruConnect connection layer**
  - `truload-frontend/src/hooks/useMiddleware.ts`:
    - Core **middleware hook**:
      - Tries local WebSocket (`ws://localhost:3030`) as primary, falls back to HTTP polling (`http://localhost:3031/api/v1/weights` or similar) when needed.
      - Exposes connection status and functions for sending `plate`, `axle-captured`, `vehicle-complete`, `query-weight` messages to TruConnect, aligning with `WebSocketOutput.js` protocol.
      - Explicitly avoids any backend WebSocket relay (documented in both code and `frontend-integration.md`).

- **Weighing workflow & auto‑weight use**
  - `truload-frontend/src/hooks/useWeighing.ts`:
    - High‑level **weighing workflow hook**:
      - Orchestrates transaction lifecycle (initialize, capture, submit, confirm, reweigh), persists state to `localStorage`, and wires to backend autoweigh/compliance endpoints via query/mutation hooks.
  - `truload-frontend/src/hooks/queries/useWeighingQueries.ts`:
    - Encapsulates all weighing‑related backend API interactions (transactions, scale tests, references, PDFs, stats).
  - `truload-frontend/src/lib/api/weighing.ts`:
    - Typed API client for backend `/api/v1` weighing endpoints, including `AutoweighCaptureRequest` and capture/compliance operations.
  - `truload-frontend/src/lib/weighing-utils.ts`:
    - Utility functions for compliance status, GVW, PDF, tolerance, formatting, and constants like `WEIGHING_STEPS`.

- **Pages for mobile & multideck**
  - `truload-frontend/src/app/weighing/mobile/page.tsx`:
    - Main **mobile axle‑by‑axle** weighing screen:
      - Integrates `useMyStation`, `useWeighingAxleConfigurations`, `useWeighing`, and `useMiddleware`.
      - Drives the 3‑step UI (Capture/Vehicle/Decision) and uses live weights from TruConnect for axle capture.
  - `truload-frontend/src/app/weighing/multideck/page.tsx`:
    - Main **multideck** weighing screen:
      - Similar structure, but focused on multi‑deck weight display and "Take Vehicle Weight" operations using deck weights from TruConnect.

- **Shared weighing UI components**
  - `truload-frontend/src/components/weighing/CaptureScreen.tsx`:
    - Shared “Capture” step UI, shows weighing mode, station/bound, digital twin, vehicle image sections, plate entry (with ANPR), and scale test controls.
  - `truload-frontend/src/components/weighing/DigitalWeightDisplay.tsx`:
    - `MobileWeightDisplay` and `MultideckWeightDisplay` components presenting live weights and GVW, with an LCD‑style look akin to legacy systems.
  - `truload-frontend/src/components/weighing/WeightCaptureCard.tsx`:
    - Mobile mode card for displaying current axle weight and an “ASSIGN AXLE” action, wired to `useMiddleware` and `useWeighing`.
  - `truload-frontend/src/components/weighing/ScaleHealthPanel.tsx`:
    - Shows scale/indicator health, including mode, battery/signal (mobile), connection quality, and middleware sync/simulation indicators.
  - `truload-frontend/src/components/weighing/ScaleTestModal.tsx`:
    - UI for daily scale tests (calibration weight or 2‑axle vehicle), tailored to mobile/multideck modes, with live/simulated readings and pass/fail logic.

- **Settings, calibration & types**
  - `truload-frontend/src/components/settings/CalibrationConfigTab.tsx`:
    - Settings UI for scale test frequency and annual calibration thresholds.
  - `truload-frontend/src/types/weighing.ts`:
    - Shared TypeScript types for weights, modes, compliance, axle configuration, scale tests, etc., aligning frontend with backend DTOs.

---

## truload-backend & Auto-Weight

- **Integration & planning docs**
  - `truload-backend/docs/integrations/integration.md`:
    - Describes **TruConnect Microservice Integration**:
      - Real‑time WebSocket vs HTTP polling fallback from frontend to TruConnect.
      - Two‑way message formats between backend and TruConnect, including station code/bound and weight payloads (multideck and mobile).
  - `truload-backend/docs/plan.md`:
    - Global backend plan: module breakdown, weighing/scale test/permit workflows, legal frameworks, performance, and integration strategies.
  - `truload-backend/docs/sprints/sprint-03-weighing-setup.md` and `sprint-04-weighing-core.md`:
    - Sprint‑level narratives showing progressive completion of weighing setup, unified capture endpoint, and compliance logic.
  - `truload-backend/docs/Master-FRD-KURAWEIGH.md`:
    - Functional requirements, including **Screen B - Weight Capture**, with axle‑by‑axle capture and compliance evaluation behavior.
  - `truload-backend/docs/axle-erd-map.md`:
    - ERD for axle master data and transaction tables (TyreType, AxleGroup, AxleConfiguration, AxleWeightReference, WeighingAxle, AxleFeeSchedule).

- **Controllers & endpoints (including `autoweigh`)**
  - `truload-backend/Controllers/WeighingOperations/WeighingController.cs`:
    - Core weighing API controller:
      - `CaptureWeights` endpoint: unified capture for all modes (Static, WIM, Mobile).
      - `Autoweigh` endpoint: receives **auto‑weight data from TruConnect** (via `BackendClient.js`) with idempotency safeguards (using client/local IDs).
      - Search, retrieval, update, delete, stats, and PDF ticket endpoints.
  - `truload-backend/Controllers/WeighingOperations/ScaleTestsController.cs`:
    - Scale test endpoints: status for a station, fetching latest/historical tests, and creating new tests.

- **Services & business logic**
  - `truload-backend/Services/Interfaces/Weighing/IWeighingService.cs`:
    - Defines operations used by controllers:
      - `InitiateWeighingAsync`, `CaptureWeightsAsync`, `ProcessAutoweighAsync`, `CalculateComplianceAsync`, `GetComplianceResultAsync`, `InitiateReweighAsync`, `GenerateWeightTicketPdfAsync`.
  - `truload-backend/Services/Implementations/Weighing/WeighingService.cs`:
    - Implements **full weighing lifecycle**:
      - Validates daily scale tests, generates ticket numbers, handles reweighs and permits, aggregates axle groups, computes GVW/overloads, applies EAC/Traffic Act rules, calculates fees and Pavement Damage Factor, and triggers downstream actions like yard entries or case registration.

- **Data models & DTOs**
  - `truload-backend/Models/Weighing/WeighingTransaction.cs`:
    - Transaction entity capturing ticket, vehicle/driver/transport details, station/bound, weighing type/mode, GVW and overload, control status, autoweigh‑related fields (`AutoweighGvwKg`, `AutoweighAt`, `ClientLocalId`, `CaptureSource`, `CaptureStatus`, `SyncStatus`).
  - `truload-backend/Models/Weighing/WeighingAxle.cs`:
    - Axle entity with measured/permissible weights, grouping, spacing, PDF, group aggregates, tyre types, and per‑axle fee.
  - `truload-backend/DTOs/Weighing/WeighingTransactionDto.cs`:
    - DTO surfacing a ready‑to‑render view of transactions for frontend (additional friendly names, tags, alerts, deck/A weights).
  - `truload-backend/DTOs/Weighing/ScaleTestDto.cs`, `Models/Infrastructure/ScaleTests.cs`, `Models/Technical/AnnualCalibrationRecord.cs`:
    - Scale test and annual calibration data, used to enforce daily test pre‑conditions and ensure instruments are within permitted deviation.

- **Repositories & configuration**
  - `truload-backend/Repositories/Infrastructure/ScaleTestRepository.cs` and `IScaleTestRepository.cs`:
    - EF‑based repository providing queries for scale tests and helper methods `HasPassedDailyCalibrationalAsync` / `GetTodaysPassingTestAsync`.
  - `truload-backend/Data/Configurations/Infrastructure/InfrastructureModuleDbContextConfiguration.cs`:
    - EF configurations for scale tests, axle/vehicle reference entities, and related infrastructure tables.

---

## Device/Input Configuration Model

- **TruConnect configuration schema**
  - `TruConnect/src/config/defaults.js`:
    - **Input sources** are modeled as named configurations, each with:
      - `type` (e.g. `serial`, `tcp`, `udp`, `api`), hardware connection details (COM port, baud/parity/data bits, IP/port, URL, polling interval), and parser settings (protocol type, regex/delimiter/fixed/JSON options).
    - **Indicator/scale protocols** are linked via `IndicatorConfig` or parser choices (ZM, Cardinal, 1310, PAW, Haenni, Custom, UDP Legacy).
    - **Output channels** (`WebSocket`, `Api`, `RduSerial`, `RduNetwork`) have their own config blocks with ports, framing, and formatting options.
    - **Operational parameters** (thresholds, capture mode, mobile vs multideck, simulation, backend URLs, cloud modes, auth) are centralized in the same file.

- **Configuration documentation & UI**
  - `TruConnect/docs/architecture.md`:
    - Documents `InputConfig`, `IndicatorConfig`, and `RduConfig` schemas and how they are persisted/edited.
  - `TruConnect/docs/integrations.md`:
    - Provides concrete **JSON examples** for PAW, Haenni, and Custom protocol definitions, including how to map raw serial/TCP/UDP/API messages to weight values.
  - `TruConnect/pages/settings.html`:
    - Configuration UI for:
      - General station and capture mode.
      - Input sources (selection of protocol type, COM ports, IP/port, custom protocol fields).
      - Outputs (WebSocket/API/RDU), thresholds, backend integration, appearance.

- **Runtime use of configuration**
  - `TruConnect/src/input/InputManager.js`, `src/input/UdpInput.js`, `src/input/ApiInput.js`:
    - Read input definitions from the configuration source (defaults + DB) and instantiate appropriate input classes with their parser configuration.
  - `TruConnect/src/parsers/CustomParser.js`:
    - Uses config to construct parsing rules at runtime, enabling integration with arbitrary weight consoles that obey somewhat structured output.
  - `TruConnect/src/database/Seed.js`:
    - Seeds default input/output configurations into SQLite, establishing initial stations and device setups cloned from `defaults.js`.

---

## Existing MCGS/Mobile Scale References

- **MCGS‑specific artifacts**
  - `TruConnect/docs/MCGS-WEIGHT-STRING.md`:
    - Contains raw sample **MCGS weight strings** like `SG+0000000kR`, used as reference for understanding that console’s serial format.
  - `TruConnect/tests/mcgs-test.js`:
    - Test harness using `SerialPort` + `ReadlineParser` to:
      - Connect to a COM port, listen for lines starting with `"SG"`, parse out **Scale A/B/Total** numeric components, and expose latest readings via a simple HTTP endpoint.

- **Mobile scale handling**
  - `TruConnect/src/parsers/MobileScaleParser.js`:
    - Implements **mobile axle capture** logic for PAW and Haenni devices (serial, UDP, HTTP), aggregating axle weights and handling dual scales and combined readings.
  - `TruConnect/docs/AUTO_WEIGH_FLOW.md`:
    - Describes:
      - Mobile scale behaviors for **PAW vs Haenni**, including when auto‑weight is triggered, how axles are accumulated, and how data is sent to backend via `BackendClient`.
  - `TruConnect/src/simulation/SimulationEngine.js`:
    - Supports mobile mode simulation, mimicking axle‑by‑axle capture events for mobile scales.

- **Weight indicator / console integrations (non‑MCGS)**
  - `TruConnect/docs/integrations.md`:
    - Lists supported **indicator consoles** (ZM, Cardinal, Cardinal2, 1310, PAW, Haenni, UDP Legacy), their serial/TCP/UDP parameters, and parsing examples.
  - `TruConnect/pages/devices.html`:
    - UI demonstrating device entries and actions for various connected scales/indicators (though largely illustrative).

---

## Identified Gaps & Improvement Opportunities

*(Based on docs/code reviewed; items below may already be addressed elsewhere but are not clearly documented or obvious from current sources.)*

- **Device/input configuration flexibility**
  - **Per‑command and multi‑stage polling**:
    - While serial query commands and basic polling intervals are supported (per `docs/architecture.md` and `InputManager.js`), there is no clearly documented way to configure **complex command sequences**, conditional queries, or protocol‑specific keep‑alive messages solely via configuration (likely requires code changes).
  - **Multiple instances and station/lane mapping**:
    - `defaults.js` shows named input sources, but it is not clearly documented how to model:
      - Multiple instances of the same protocol type (e.g., two PAW or two multideck indicators) with distinct configurations per **lane/station**, and how frontend/backend map to a specific instance.
  - **Runtime extensibility for new consoles**:
    - `CustomParser` gives strong parsing flexibility, but adding a brand‑new scale with **non‑trivial handshake/command protocol** appears to still require JavaScript changes (e.g., new input type or poll logic), not just config, which could be a limitation for rapid deployment of new consoles.

- **Middleware ↔ frontend ↔ backend flow clarity**
  - **Single, canonical contract for auto‑weight**:
    - The `autoweigh` flow is documented across `TruConnect/docs/AUTO_WEIGH_FLOW.md`, `truload-backend/docs/integrations/integration.md`, frontend `useMiddleware`, and backend `WeighingController.Autoweigh`, but there is no **single API contract document** that precisely defines:
      - The JSON schema of auto‑weight payloads, expected event sequence, error conditions, and retry/idempotency semantics end‑to‑end.
  - **Error handling and resilience semantics**:
    - TruConnect’s `BackendClient.js` explains offline queueing, and backend models have `ClientLocalId` and `SyncStatus`, but there is limited documentation on:
      - How the frontend surfaces **partial failures** (e.g., auto‑weight accepted by backend but not confirmed back to TruConnect/front‑end) and what operators should do.
  - **Cloud vs local mode behavior**:
    - `CloudConnectionManager.js` and `frontend-integration` docs mention cloud/live modes and removal of backend WebSocket relay, but the **recommended architecture** for:
      - Central TruConnect vs per‑station TruConnect, and
      - How remote clients should connect in a cloud deployment
      is not fully spelled out, which may lead to inconsistent deployments.

- **MCGS and legacy console integration pathway**
  - **MCGS test vs production integration**:
    - `MCGS-WEIGHT-STRING.md` and `mcgs-test.js` show **experimental/test‑level work**, but there is no dedicated, production‑ready `McgsParser` or configuration pattern documented:
      - Integrating MCGS today likely requires either copying `mcgs-test.js` logic into custom code or encoding the string format in `CustomParser` by hand.
    - A more formalized example (parser + config + UI guide) for MCGS would make that integration clearer and less error‑prone.

- **Documentation consolidation**
  - **Scattered but rich documentation**:
    - There are excellent docs for each layer (TruConnect, frontend, backend), but operators and integrators must **cross‑reference many files** to understand one end‑to‑end use case (e.g., mobile auto‑weight with specific scale types).
    - A consolidated “**Device Integration Playbook**” (one doc linking concrete config examples, TruConnect parser choice, frontend expectations, backend autoweigh contract) per major hardware type (PAW, Haenni, MCGS, multideck indicators) would significantly improve clarity and onboarding.

# MCGS Mobile Scale Integration Plan (Corrected -- Combined A+B Frames)

**Status Legend**

-   [ ] Not Started\
-   \[\~\] In Progress\
-   [x] Completed

------------------------------------------------------------------------

# Phase 1 -- Ground Truth & Protocol Clarification

## 1.1 Confirm MCGS Frame Semantics

-   [x] Confirm frame format: `=SG+0000123kR`
-   [x] Confirm weight value is **already A+B combined**
-   [x] Confirm each frame = one full axle weight
-   [x] Confirm pairing consecutive frames causes double counting
-   [ ] Confirm stability semantics (if available in frame)
-   [ ] Confirm if polling command required or continuous stream

### Final Protocol Truth

Each MCGS frame:

    =SG+0000123kR

Represents:

-   A+B already combined\
-   One complete axle weight\
-   No per-wheel separation required\
-   No pairing logic required

------------------------------------------------------------------------

# Phase 2 -- Internal Representation Design (Corrected)

## 2.1 Target Internal Payload

Each frame should produce a mobile axle result:

``` json
{
  "mode": "mobile",
  "scaleWeightMode": "combined",
  "currentWeight": 123,
  "axleNumber": 1,
  "runningTotal": 123
}
```

## 2.2 Required Corrections from Prototype

-   [x] Remove wheel pairing logic\
-   [x] Do NOT buffer two readings\
-   [x] Do NOT attempt scaleA/scaleB separation\
-   [x] Treat each frame as a complete axle\
-   [x] Ensure cumulative total behaves like PAW/Haenni mobile mode

------------------------------------------------------------------------

# Phase 3 -- TruConnect Code Changes

## 3.1 Add MCGS Input Source to defaults.js

-   [x] Add `mcgs` block under `input`
-   [x] Set default `enabled: false`
-   [x] Use `protocol: 'MCGS'`
-   [x] Default serial config (9600 8N1)

Example:

``` js
mcgs: {
  enabled: false,
  type: 'serial',
  protocol: 'MCGS',
  metadata: {
    make: 'MCGS',
    model: 'Console',
    capacity: 20000
  },
  serial: {
    port: 'COM8',
    baudRate: 9600,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    queryCommand: ''
  }
}
```

------------------------------------------------------------------------

## 3.2 Update InputManager

-   [x] Add `'mcgs'` to `INPUT_SOURCES`
-   [x] Include in mobile source detection:

``` js
const isMobileSource = ['paw', 'haenni', 'mcgs'].includes(this.activeSource);
```

------------------------------------------------------------------------

## 3.3 Extend MobileScaleParser (MCGS Mode)

-   [x] Add `mode: 'mcgs'`
-   [x] Implement `parseMcgsSerial(data)`
-   [x] Extract numeric portion from `=SG+0000123kR`
-   [x] Convert to number
-   [x] Call `createAxleResult(weight, raw, stable)`
-   [x] Increment axle counter
-   [x] Maintain running total
-   [x] Set `scaleWeightMode = 'combined'`

### Important: No Pairing Logic

-   [x] No buffering
-   [x] No scaleA/scaleB split
-   [x] One frame = one axle

------------------------------------------------------------------------

## 3.4 ParserFactory Update

-   [x] Add case:

``` js
case 'MCGS':
  return new MobileScaleParser({ mode: 'mcgs' });
```

------------------------------------------------------------------------

## 3.5 Database Seed

-   [x] Add disabled MCGS config to seed
-   [x] Ensure visible in UI settings

------------------------------------------------------------------------

# Phase 4 -- Frontend & Backend Compatibility

## 4.1 Frontend (No Changes Required)

-   [x] Payload format identical to existing mobile flow
-   [x] Auto-weigh UI continues working
-   [x] No protocol-specific frontend logic required

## 4.2 Backend (No Changes Required)

-   [x] AutoweighCaptureRequest unchanged
-   [x] WeighingService.ProcessAutoweighAsync unchanged
-   [x] Ticket generation unchanged

------------------------------------------------------------------------

# Phase 5 -- Documentation Updates

## 5.1 TruConnect Docs

-   [x] Add "MCGS Mobile Scale" section to integrations.md
-   [x] Update AUTO_WEIGH_FLOW.md
-   [x] Update architecture.md
-   [x] Convert raw capture notes into formal MCGS-WEIGHT-STRING.md

## 5.2 Backend Docs

-   [x] Mention MCGS under supported mobile scales
-   [x] Clarify normalization via TruConnect

## 5.3 Frontend Docs

-   [x] Note supported mobile scales: PAW, Haenni, MCGS
-   [x] State frontend remains protocol-agnostic

------------------------------------------------------------------------

# Phase 6 -- Testing

## 6.1 Unit Tests

-   [x] Single frame → single axle
-   [x] Multiple frames → multiple axles
-   [x] Running total correct
-   [x] No doubling occurs

## 6.2 Integration Test

-   [ ] Feed recorded `=SG+...kR` samples
-   [ ] Confirm correct mobile payload emitted
-   [ ] Confirm correct backend transaction

------------------------------------------------------------------------

# Phase 7 -- Rollout

-   [ ] Deploy to test station with MCGS hardware
-   [ ] Enable feature flag
-   [ ] Monitor logs
-   [ ] Validate ticket accuracy
-   [ ] Promote to production

------------------------------------------------------------------------

# Final Architectural Guarantee

MCGS behaves as:

-   Mobile scale
-   Combined axle frames
-   Normalized payload
-   Zero backend changes
-   Zero frontend protocol awareness
-   Fully consistent with existing mobile weighing flows

------------------------------------------------------------------------

**End of Document**
