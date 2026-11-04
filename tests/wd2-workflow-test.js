/**
 * wd2-workflow-test.js - 2-axle weighing workflow for the Portable axle scale 255-D
 *
 * Replays bytes captured from the real console through InputManager and
 * StateManager, capturing axles the way WebSocketOutput.handleAxleCaptured does.
 *
 * The console run being replayed (screen values, not derived):
 *   Axle-1: pad 1 = 40, pad 2 = 40, axle = 80,  main display = 80
 *   Axle-2: pad 1 = 80, pad 2 = 60, axle = 140, main display = 220
 */

const { InputManager } = require('../src/input/InputManager');
const StateManager = require('../src/core/StateManager');
const ConfigManager = require('../src/config/ConfigManager');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

// Chunks exactly as received from COM5, including the split STX
const EMPTY = ['022b30303030303030314203'];
const TOTAL_80 = ['02', '2b30303030383030313303'];
const TOTAL_220 = ['022b30303032323030314203', '02', '2b30303032323030314203'];
const TOTAL_100 = ['022b30303031303030314103'];

const originalGet = ConfigManager.get;
ConfigManager.get = function (key, defaultValue) {
  if (key === 'input.activeSource') return 'wd2';
  return originalGet.call(this, key, defaultValue);
};

assert(ConfigManager.get('input.wd2.useCumulativeWeight', false) === true, 'WD2 defaults enable cumulative weight');
assert(ConfigManager.get('input.wd2.serial.baudRate') === 19200, 'WD2 defaults use the console baud rate');

const ParserFactory = require('../src/parsers/ParserFactory');

setTimeout(() => {
  const manager = new InputManager();
  manager.config = { activeSource: 'wd2', wd2: { protocol: 'WD2' } };
  manager.activeSource = 'wd2';
  manager.activeParser = ParserFactory.create('WD2', {});

  const replay = (chunks) => chunks.forEach((hex) => manager._handleData(Buffer.from(hex, 'hex')));

  // Same steps as WebSocketOutput.handleAxleCaptured
  const capture = () => StateManager.addAxleWeight(StateManager.getCurrentMobileWeight());

  StateManager.getInstance().reset();
  StateManager.setAxleConfiguration({ expectedAxles: 2, plateNumber: 'TEST-2A' });

  // ── Before any weighing ─────────────────────────────────────────────────────

  replay(EMPTY);
  assert(StateManager.getCurrentMobileWeight() === 0, 'empty console reads 0 kg');
  assert(StateManager.isWeighingComplete() === false, 'weighing is not complete before captures');

  // ── Axle 1 ──────────────────────────────────────────────────────────────────

  replay(TOTAL_80);
  assert(StateManager.getCurrentMobileWeight() === 80, `axle 1 reads 80 kg (got ${StateManager.getCurrentMobileWeight()})`);
  capture();
  assert(StateManager.isWeighingComplete() === false, 'one captured axle does not complete a 2-axle weighing');

  // The console keeps sending 80 until the next Weighing press
  replay(TOTAL_80);
  assert(StateManager.getCurrentMobileWeight() === 0, `held total does not read as a new axle (got ${StateManager.getCurrentMobileWeight()})`);

  // ── Corrupted frame between axles ───────────────────────────────────────────

  replay(['022b30303039383030314203']);
  assert(StateManager.getCurrentMobileWeight() === 0, 'frame with a bad checksum does not change the weight');

  // ── Axle 2 ──────────────────────────────────────────────────────────────────

  replay(TOTAL_220);
  assert(StateManager.getCurrentMobileWeight() === 140, `axle 2 reads 140 kg, 220 - 80 (got ${StateManager.getCurrentMobileWeight()})`);
  capture();

  const state = StateManager.getMobileState();
  assert(state.axles.map((a) => a.weight).join(',') === '80,140', `stored axles match the console list (got ${state.axles.map((a) => a.weight)})`);
  assert(state.gvw === 220, `GVW matches the console main display (got ${state.gvw})`);
  assert(StateManager.isWeighingComplete() === true, 'second capture completes the 2-axle weighing');

  // ── Next vehicle ────────────────────────────────────────────────────────────

  StateManager.resetMobileSession();
  replay(EMPTY);
  assert(StateManager.getCurrentMobileWeight() === 0, 'console Clear reads 0 kg after the session reset');
  replay(TOTAL_100);
  assert(StateManager.getCurrentMobileWeight() === 100, `next vehicle starts from its own total (got ${StateManager.getCurrentMobileWeight()})`);

  // ── Multi-axle console runs ─────────────────────────────────────────────────

  // Frame text as captured from the console, axle weights read from its screen
  function replayRun(label, frames, consoleAxles, consoleTotal) {
    StateManager.resetMobileSession();
    StateManager.setAxleConfiguration({ expectedAxles: frames.length, plateNumber: 'TEST' });
    const frameHex = (text) => Buffer.from(`\x02${text}\x03`, 'latin1').toString('hex');

    replay(EMPTY);
    frames.forEach((text, i) => {
      assert(StateManager.isWeighingComplete() === false, `${label}: not complete before axle ${i + 1}`);
      replay([frameHex(text)]);
      const reading = StateManager.getCurrentMobileWeight();
      assert(reading === consoleAxles[i], `${label}: axle ${i + 1} reads ${consoleAxles[i]} kg (got ${reading})`);
      capture();

      // The console holds this total until the next Weighing press
      replay([frameHex(text), frameHex(text)]);
      assert(StateManager.getCurrentMobileWeight() === 0, `${label}: held total after axle ${i + 1} reads 0 kg`);
    });

    const result = StateManager.getMobileState();
    assert(result.axles.map((a) => a.weight).join(',') === consoleAxles.join(','), `${label}: stored axles match the console list (got ${result.axles.map((a) => a.weight)})`);
    assert(result.gvw === consoleTotal, `${label}: GVW matches the console total (got ${result.gvw})`);
    assert(StateManager.isWeighingComplete() === true, `${label}: last capture completes the weighing`);
  }

  replayRun('3-axle', ['+00004001F', '+00016001C', '+00032001A'], [40, 120, 160], 320);
  replayRun('4-axle', ['+000080013', '+00022001B', '+00032001A', '+000480017'], [80, 140, 100, 160], 480);

  // ── Console and session out of step ─────────────────────────────────────────

  const frameHex = (text) => Buffer.from(`\x02${text}\x03`, 'latin1').toString('hex');

  // Session resets while the console still holds the finished vehicle's total
  StateManager.resetMobileSession();
  StateManager.setAxleConfiguration({ expectedAxles: 2, plateNumber: 'TEST' });
  replay(EMPTY);
  replay([frameHex('+000080013')]);
  capture();
  replay([frameHex('+00022001B')]);
  capture();
  StateManager.resetMobileSession();
  replay([frameHex('+00022001B')]);
  assert(StateManager.getCurrentMobileWeight() === 0, `reset without console Clear: held total reads 0 kg (got ${StateManager.getCurrentMobileWeight()})`);

  // Console Clear after that reset, then the next vehicle's first axle
  replay(EMPTY);
  replay([frameHex('+00010001A')]);
  assert(StateManager.getCurrentMobileWeight() === 100, `Clear after reset: next axle reads its own weight (got ${StateManager.getCurrentMobileWeight()})`);

  // Second capture before the next frame arrives, as frames are a second apart
  StateManager.getInstance().reset();
  replay(EMPTY);
  replay([frameHex('+000080013')]);
  capture();
  assert(StateManager.getCurrentMobileWeight() === 0, `axle already captured reads 0 kg before the next frame (got ${StateManager.getCurrentMobileWeight()})`);

  // Console Clear pressed part way through a vehicle
  StateManager.getInstance().reset();
  StateManager.setAxleConfiguration({ expectedAxles: 2, plateNumber: 'TEST' });
  replay(EMPTY);
  replay([frameHex('+000080013')]);
  capture();
  replay(EMPTY);
  assert(StateManager.getCurrentMobileWeight() === 0, 'Clear mid-vehicle reads 0 kg');
  replay([frameHex('+00004001F')]);
  assert(StateManager.getCurrentMobileWeight() === 40, `Clear mid-vehicle: next axle reads its own weight (got ${StateManager.getCurrentMobileWeight()})`);

  // ── Frames interrupted: restart or Bluetooth outage ─────────────────────────

  const sm = StateManager.getInstance();
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const wait = (ms) => { clock += ms; };
  const reading = () => StateManager.getCurrentMobileWeight();

  // TruConnect restarted while the console holds a total
  sm.reset();
  sm.lastRawCumulativeWeight = 0;
  sm.cumulativeBaseOffset = 0;
  sm.lastScaleFrameAt = null;
  replay([frameHex('+00022001B')]);
  assert(reading() === 220, `restart with no axles captured: the real total is shown (got ${reading()})`);
  assert(sm.scaleResyncRequired === false, 'restart with no axles captured: no notice');
  capture();
  wait(1000);
  replay([frameHex('+00032001A')]);
  assert(reading() === 100, `restart: next axle reads its own weight after a capture (got ${reading()})`);

  // Clear and a new axle during an outage, with the new total above the old base
  sm.reset();
  replay(EMPTY);
  wait(1000);
  replay([frameHex('+000080013')]);
  capture();
  wait(30000);
  replay([frameHex('+00010001A')]);
  assert(reading() === 20, `pause, total rose: reads as the next axle (got ${reading()})`);
  assert(sm.scaleResyncRequired === true, 'pause, total rose: operator is asked to check the console');
  wait(1000);
  replay([frameHex('+00022001B')]);
  assert(sm.scaleResyncRequired === false, 'pause: notice clears on the next new total');

  // Outage with nothing changed on the console keeps the uncaptured axle
  sm.reset();
  replay(EMPTY);
  wait(1000);
  replay([frameHex('+000080013')]);
  wait(30000);
  replay([frameHex('+000080013')]);
  assert(reading() === 80, `outage, total unchanged: axle is kept (got ${reading()})`);
  assert(sm.scaleResyncRequired === false, 'outage, total unchanged: no notice');

  // Clear during an outage leaves nothing to redo
  wait(30000);
  replay(EMPTY);
  assert(reading() === 0 && sm.scaleResyncRequired === false, 'outage, console cleared: reads 0 kg with no notice');

  // Normal frame spacing never triggers the notice
  sm.reset();
  replay(EMPTY);
  wait(2000);
  replay([frameHex('+000080013')]);
  assert(reading() === 80 && sm.scaleResyncRequired === false, 'normal frame spacing reads normally');
  Date.now = realNow;

  // ── Minimum capture weight ──────────────────────────────────────────────────

  const BackendMod = require('../src/backend/BackendClient');
  const BackendClient = BackendMod.BackendClient && BackendMod.BackendClient.isAutoweighSent ? BackendMod.BackendClient : BackendMod;
  BackendClient.isAutoweighSent = () => false;
  BackendClient.hasSyncedTransaction = () => true;
  const wsModule = require('../src/output/WebSocketOutput');
  const WebSocketOutput = wsModule.WebSocketOutput || wsModule;
  const ws = Object.create(WebSocketOutput.prototype || Object.getPrototypeOf(WebSocketOutput));
  const sentToClient = [];
  ws.clients = new Map([['c1', { registered: true, stationCode: 'T', bound: 'A' }]]);
  ws.sendToClient = (id, type, data) => sentToClient.push({ type, data });
  ws.broadcastToRegistered = () => {};

  const previousMode = sm.mode;
  sm.mode = 'mobile';
  assert(StateManager.getMinCaptureWeight() === 50, `minimum capture weight defaults to 50 kg (got ${StateManager.getMinCaptureWeight()})`);

  sm.reset();
  replay(EMPTY);
  replay([frameHex('+00004001F')]);
  ws.handleAxleCaptured('c1', { axleNumber: 1 });
  assert(StateManager.getMobileState().axles.length === 0, 'WebSocket capture below the minimum stores nothing');
  const rejected = sentToClient.find((m) => m.type === 'axle-captured-ack');
  assert(rejected && rejected.data.success === false, 'WebSocket client is told the capture was rejected');

  replay([frameHex('+000080013')]);
  ws.handleAxleCaptured('c1', { axleNumber: 1 });
  assert(StateManager.getMobileState().axles.length === 1, 'WebSocket capture at or above the minimum is stored');

  const getWithMinimum = ConfigManager.get;
  ConfigManager.get = function (key, defaultValue) {
    if (key === 'thresholds.mobile.minCaptureWeight') return 100;
    return getWithMinimum.call(this, key, defaultValue);
  };
  assert(StateManager.getMinCaptureWeight() === 100, 'minimum capture weight follows the setting');
  ConfigManager.get = getWithMinimum;

  sm.mode = 'multideck';
  assert(StateManager.getMinCaptureWeight() === 0, 'minimum capture weight does not apply to multideck');
  sm.mode = previousMode;

  ConfigManager.get = originalGet;
  console.log('\nAll WD2 workflow tests complete.');
  process.exit();
}, 100); // wait for ParserFactory deferred registration (setImmediate)
