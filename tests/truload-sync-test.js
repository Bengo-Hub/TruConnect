/**
 * truload-sync-test.js - What TruLoad shares with TruConnect
 *
 * Drives the real WebSocketOutput handlers with a stubbed socket: tenant and
 * station binding, the setup values sent to the Weighing Setup section, and
 * driver instructions. Also covers the double-press scale notice.
 */

const EventBus = require('../src/core/EventBus');
const StateManager = require('../src/core/StateManager');
const ConfigManager = require('../src/config/ConfigManager');
const TenantBinding = require('../src/core/TenantBinding');
const wsModule = require('../src/output/WebSocketOutput');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

const WebSocketOutput = wsModule.WebSocketOutput || wsModule;
const sent = [];
const ws = Object.create(WebSocketOutput.prototype || Object.getPrototypeOf(WebSocketOutput));
ws.clients = new Map();
ws.sendToClient = (id, type, data) => sent.push({ id, type, data });
ws.broadcastToRegistered = () => {};
ws.getRegisteredClientCount = () => ws.clients.size;

const lastSent = (type) => [...sent].reverse().find((m) => m.type === type);
const events = {};
['truload:setup', 'tenant:mismatch', 'driver:instruction'].forEach((name) => {
  events[name] = [];
  EventBus.on(name, (data) => events[name].push(data));
});

function connect(id) {
  ws.clients.set(id, { registered: false });
}

const register = (id, data) => ws.handleRegister(id, { bound: 'A', mode: 'mobile', clientType: 'truload-frontend', ...data });

// ── Tenant binding ────────────────────────────────────────────────────────────

TenantBinding.clear();
connect('c1');
register('c1', { orgSlug: 'kura', stationCode: 'ROMIA', stationName: 'Rongo Mia', workflow: 'enforcement' });
assert(ws.clients.get('c1').registered === true, 'first connection registers');
assert(lastSent('register-ack').data.binding.status === 'bound', 'first connection stores the binding');
assert(ConfigManager.get('tenantBinding.orgSlug') === 'kura', 'org slug is stored');
assert(ConfigManager.get('station.code') === 'ROMIA', 'station code comes from TruLoad on first connection');
assert(ConfigManager.get('station.name') === 'Rongo Mia', 'station name comes from TruLoad on first connection');

connect('c2');
register('c2', { orgSlug: 'kura', stationCode: 'ROMIA' });
assert(lastSent('register-ack').data.binding.status === 'confirmed', 'reconnect with the same org and station is confirmed');

connect('c3');
register('c3', { orgSlug: 'KURA', stationCode: 'ROMIA' });
assert(lastSent('register-ack').data.binding.status === 'confirmed', 'org slug comparison ignores case');

connect('c4');
register('c4', { orgSlug: 'kura', stationCode: 'MARIAKANI', stationName: 'Mariakani' });
const moved = lastSent('register-ack').data.binding;
assert(moved.status === 'station-changed' && moved.previousStation === 'ROMIA', 'same org at a new station reports the change');
assert(ConfigManager.get('station.code') === 'MARIAKANI', "TruLoad's station wins");
assert(typeof moved.message === 'string' && moved.message.includes('MARIAKANI'), 'station change has a message to show');

connect('c5');
register('c5', { orgSlug: 'kura', stationCode: 'DEFAULT' });
assert(ConfigManager.get('station.code') === 'MARIAKANI', 'placeholder station is ignored');
connect('c6');
register('c6', { orgSlug: 'kura', stationCode: '' });
assert(ConfigManager.get('station.code') === 'MARIAKANI', 'empty station is ignored');

connect('c7');
register('c7', { stationCode: 'OTHER' });
assert(ws.clients.get('c7').registered === true, 'client with no org slug still registers');
assert(ConfigManager.get('station.code') === 'MARIAKANI', 'client with no org slug cannot change the station');

// Different org: refused until the operator answers
connect('c8');
register('c8', { orgSlug: 'acme', stationCode: 'ACME-1' });
assert(ws.clients.get('c8').registered === false, 'different org is not registered');
const refused = lastSent('register-ack').data;
assert(refused.success === false && refused.code === 'ORG_MISMATCH', 'different org is told why');
assert(events['tenant:mismatch'].length === 1, 'operator prompt is requested');
assert(events['tenant:mismatch'][0].storedOrg === 'kura' && events['tenant:mismatch'][0].orgSlug === 'acme', 'prompt names both orgs');
assert(ConfigManager.get('tenantBinding.orgSlug') === 'kura', 'binding is unchanged until the operator answers');

connect('c9');
register('c9', { orgSlug: 'acme', stationCode: 'ACME-1' });
assert(events['tenant:mismatch'].length === 1, 'a reconnect does not prompt again while one is open');

ws.resolveTenantMismatch('acme', false);
assert(ws.clients.get('c8').registered === false, 'operator keeping the org leaves the client refused');
assert(lastSent('error').data.code === 'ORG_MISMATCH', 'refused client gets an error');

connect('c10');
register('c10', { orgSlug: 'acme', stationCode: 'ACME-1' });
assert(events['tenant:mismatch'].length === 2, 'a later attempt prompts again');
ws.resolveTenantMismatch('acme', true);
assert(ConfigManager.get('tenantBinding.orgSlug') === 'acme', 'operator accepting rebinds the org');
assert(ConfigManager.get('station.code') === 'ACME-1', 'operator accepting takes the new station');
assert(ws.clients.get('c10').registered === true, 'waiting client registers after accepting');
assert(lastSent('register-ack').data.success === true, 'waiting client gets a successful ack');

// ── Setup values for the Weighing Setup section ───────────────────────────────

const lastSetup = () => events['truload:setup'][events['truload:setup'].length - 1];

connect('s1');
register('s1', { orgSlug: 'acme', stationCode: 'ACME-1', workflow: 'commercial', mode: 'mobile' });
assert(lastSetup().workflow === 'commercial' && lastSetup().mode === 'mobile', 'registration shares the mode');

ws.handlePlate('s1', { plateNumber: 'KDA 123X' });
assert(lastSetup().plateNumber === 'KDA 123X', 'plate is shared');

ws.handleUpdateConfig('s1', { totalAxles: 3, axleConfigurationCode: '3A' });
assert(lastSetup().axleConfigurationCode === '3A' && lastSetup().totalAxles === 3, 'axle config is shared');
assert(StateManager.getAxleConfiguration().expectedAxles === 3, 'expected axles are updated');

const BackendMod = require('../src/backend/BackendClient');
const BackendClient = BackendMod.BackendClient && BackendMod.BackendClient.startSession ? BackendMod.BackendClient : BackendMod;
BackendClient.syncFromTransaction = () => {};
BackendClient.startSession = () => {};
BackendClient.resetSession = () => {};
ws.handleTransactionSync('s1', {
  transactionId: 'txn-1',
  vehicleRegNumber: 'KDA 123X',
  axleConfigCode: '2A',
  axleConfigurationId: 'cfg-2a',
  totalAxles: 2,
  stationId: 'st-1',
  weighingMode: 'mobile'
});
assert(lastSetup().plateNumber === 'KDA 123X' && lastSetup().axleConfigurationCode === '2A', 'transaction sync shares plate and axle config');
assert(StateManager.getAxleConfiguration().axleConfigurationId === 'cfg-2a', 'transaction sync keeps the axle config id');

BackendClient.isAutoweighSent = () => true;
BackendClient.shouldSendAutoweigh = () => false;
BackendClient.hasSyncedTransaction = () => true;
ws.handleVehicleComplete('s1', { totalAxles: 2, axleWeights: [80, 140], gvw: 220 });
assert(lastSent('vehicle-complete-ack').data.success === true, 'vehicle complete from TruLoad is acknowledged');

ws.handleResetSession('s1');
assert(lastSetup().reset === true, 'session reset clears the mirrored setup');

// ── Auto record first for a TruLoad transaction ──────────────────────────────

const backend = BackendClient.getInstance();
const setupOf = (workflow, { enabled = true, backendOn = true, online = true, sent = false, transactionId = 'txn-9' } = {}) => {
  ConfigManager.set('autoWeigh.enabled', enabled, false);
  backend.config.enabled = backendOn;
  backend._lastKnownOnline = online;
  backend.currentSession.weighingTransactionId = transactionId;
  backend.currentSession.workflow = workflow;
  backend.currentSession.isAutoweighSent = sent;
};

setupOf('enforcement');
assert(backend.shouldSendAutoweigh() === true, 'enforcement with auto-weigh on and backend online sends the auto record');
setupOf('enforcement', { enabled: false });
assert(backend.shouldSendAutoweigh() === false, 'auto-weigh off sends nothing for a TruLoad transaction');
setupOf('enforcement', { backendOn: false });
assert(backend.shouldSendAutoweigh() === false, 'backend integration off sends nothing for a TruLoad transaction');
setupOf('enforcement', { online: false });
assert(backend.shouldSendAutoweigh() === false, 'backend offline sends nothing for a TruLoad transaction');
setupOf('commercial');
assert(backend.shouldSendAutoweigh() === false, 'commercial never sends an auto record');
setupOf(undefined);
assert(backend.shouldSendAutoweigh() === false, 'older TruLoad with no workflow sends nothing');
setupOf('enforcement', { sent: true });
assert(backend.shouldSendAutoweigh() === false, 'the auto record is only sent once');
setupOf(undefined, { enabled: false, backendOn: false, online: false, transactionId: null });
assert(backend.shouldSendAutoweigh() === true, 'with no TruLoad transaction TruConnect still sends, queued if offline');

// Auto record goes out on the last axle, and TruLoad's axles survive for its final submit
let autoweighSends = 0;
BackendClient.sendAutoweigh = async () => { autoweighSends++; return { ticketNumber: 'TKT-1', weighingId: 'txn-9', gvwMeasuredKg: 220, captureStatus: 'auto' }; };
BackendClient.shouldSendAutoweigh = () => backend.shouldSendAutoweigh();
BackendClient.hasSyncedTransaction = () => backend.hasSyncedTransaction();
BackendClient.isAutoweighSent = () => backend.isAutoweighSent();
const previousGet = ConfigManager.get;
ConfigManager.get = function (key, defaultValue) {
  if (key === 'input.activeSource') return 'wd2';
  return previousGet.call(this, key, defaultValue);
};
const session = StateManager.getInstance();
session.reset();
session.mode = 'mobile';
session.lastScaleFrameAt = Date.now();
StateManager.setAxleConfiguration({ expectedAxles: 2, plateNumber: 'KDA 123X' });
setupOf('enforcement');
StateManager.setCurrentMobileWeight(100, true);
ws.handleAxleCaptured('s1', { axleNumber: 1 });
assert(autoweighSends === 0, 'no auto record before the last axle');
StateManager.setCurrentMobileWeight(250, true);
ws.handleAxleCaptured('s1', { axleNumber: 2 });
assert(autoweighSends === 1, 'auto record is sent on the last axle');

(async () => {
await new Promise((resolve) => setTimeout(resolve, 20));
assert(StateManager.getMobileState().axles.length === 2, 'TruLoad transaction keeps its axles after the auto record');
assert(lastSent('autoweigh-submitted').data.ticketNumber === 'TKT-1', 'TruLoad is told the auto record ticket');
ConfigManager.get = previousGet;

// ── MCGS held total protection ────────────────────────────────────────────────

ConfigManager.get = function (key, defaultValue) {
  if (key === 'input.activeSource') return 'mcgs';
  return previousGet.call(this, key, defaultValue);
};
assert(previousGet.call(ConfigManager, 'input.mcgs.holdsCumulativeTotal') === true, 'MCGS has the held total protection on');
const mcgs = StateManager.getInstance();
mcgs.reset();
mcgs.lastRawCumulativeWeight = 0;
mcgs.cumulativeBaseOffset = 0;
const mcgsRead = (raw) => { StateManager.setCurrentMobileWeight(raw, true); return StateManager.getCurrentMobileWeight(); };
assert(mcgsRead(940) === 940, 'MCGS axle 1 reads its own weight');
StateManager.addAxleWeight(StateManager.getCurrentMobileWeight());
assert(mcgsRead(500) === 0, 'MCGS dip below the total mid-vehicle reads 0');
assert(mcgsRead(1580) === 640, 'MCGS axle 2 still subtracts axle 1 after a dip');
StateManager.addAxleWeight(StateManager.getCurrentMobileWeight());
StateManager.resetMobileSession();
assert(mcgsRead(1580) === 0, 'MCGS total repeated after a session reset reads 0');
assert(mcgsRead(0) === 0, 'MCGS console reset reads 0');
assert(mcgsRead(700) === 700, 'MCGS next vehicle reads its own weight after the console reset');
await new Promise((resolve) => setTimeout(resolve, 5));
ConfigManager.get = previousGet;
BackendClient.isAutoweighSent = () => true;
BackendClient.shouldSendAutoweigh = () => false;

// ── Further setup values ──────────────────────────────────────────────────────

ws.handleUpdateConfig('s1', { totalAxles: 3, axleConfigurationCode: '3A', weighingType: 'tare' });
assert(lastSetup().weighingType === 'tare', 'tare or gross choice is shared');
ws.handleVehicleDetails('s1', { driver: 'J. Doe', transporter: 'Acme', cargo: 'Sand', origin: 'Athi', destination: 'Thika' });
assert(lastSetup().vehicleDetails.driver === 'J. Doe' && lastSetup().vehicleDetails.destination === 'Thika', 'step 2 vehicle details are shared');

// ── Open port with nothing arriving ───────────────────────────────────────────

const SerialInput = require('../src/input/SerialInput');
const serial = new SerialInput({ port: 'COM4', silenceAfterMs: 10000 });
const serialEvents = [];
serial.on('silent', () => serialEvents.push('silent'));
serial.on('resumed', () => serialEvents.push('resumed'));
serial.isConnected = true;
serial.openedAt = 1000;
serial.checkSilence(5000);
assert(serialEvents.length === 0, 'no silence reported inside the window');
serial.checkSilence(12000);
assert(serialEvents.join() === 'silent', 'silence reported once past the window');
serial.checkSilence(20000);
assert(serialEvents.join() === 'silent', 'silence reported only once');
serial.noteDataReceived(Buffer.from([2, 3]));
assert(serialEvents.join() === 'silent,resumed', 'recovery is reported when data returns');
const polled = new SerialInput({ port: 'COM4' });
polled.isConnected = true;
polled.openedAt = 1000;
polled.on('silent', () => assert(false, 'query-driven devices are not watched'));
polled.checkSilence(60000);

// ── A capture from TruLoad reaches both screens without waiting for a frame ───

const captureMessages = [];
const sessionChanges = [];
EventBus.on('truload:session-changed', (data) => sessionChanges.push(data));
const broadcastBeforeCapture = ws.broadcastToRegistered;
ws.broadcastToRegistered = (type, data) => { if (type === 'weight') captureMessages.push(data); };
const captureState = StateManager.getInstance();
captureState.reset();
captureState.mode = 'mobile';
captureState.currentMobileWeight = 60;
ws.clients.get('s1').registered = true;
BackendClient.shouldSendAutoweigh = () => false;
BackendClient.hasSyncedTransaction = () => true;
ws.handleAxleCaptured('s1', { axleNumber: 1 });
assert(sessionChanges.length === 1 && sessionChanges[0].axleNumber === 1, 'TruConnect screen is told about a capture straight away');
assert(captureMessages.length === 1 && captureMessages[0].session.axles.length === 1, 'TruLoad gets the captured axle straight away');
ws.handleResetSession('s1');
assert(sessionChanges.length === 2 && sessionChanges[1].reset === true, 'TruConnect screen is told about a reset straight away');
ws.broadcastToRegistered = broadcastBeforeCapture;

// ── A client connecting while no frames are arriving ─────────────────────────

const statusMessages = [];
const previousBroadcast = ws.broadcastToRegistered;
ws.broadcastToRegistered = (type, data) => { if (type === 'weight') statusMessages.push(data); };
const stateForStatus = StateManager.getInstance();
stateForStatus.setInputSource({ name: 'wd2', protocol: 'WD2', connectionType: 'serial', connected: true });
stateForStatus.currentMobileWeight = 60;
connect('s2');
register('s2', { orgSlug: 'acme', stationCode: 'ACME-1', mode: 'mobile' });
const firstWeight = statusMessages[0];
assert(firstWeight && firstWeight.weight === 60, 'a new client gets the current weight straight away');
assert(firstWeight.connection && firstWeight.connection.connected === true, 'a new client gets the connection status');
assert(firstWeight.scaleAStatus && firstWeight.scaleBStatus, 'a new client gets both scale statuses');
stateForStatus.setScaleDataFlowing(false);
ws.broadcastWeight({ currentWeight: 60 }, 'mobile');
const silentWeight = statusMessages[statusMessages.length - 1];
assert(silentWeight.connection.connected === false, 'silence is reported as not connected');
assert(silentWeight.scaleAStatus.connected === false, 'silence is reported per scale');
stateForStatus.setScaleDataFlowing(true);
ws.broadcastToRegistered = previousBroadcast;

// ── Keepalive ─────────────────────────────────────────────────────────────────

ws.config = { pingInterval: 30000, pingTimeout: 5000 };
const pingedAt = 1000000;
assert(ws.isClientStale({ lastPong: pingedAt }, pingedAt + 30000) === false, 'client that answered the last ping is not dropped at the next one');
assert(ws.isClientStale({ lastPong: pingedAt }, pingedAt + 60000) === true, 'client that missed a ping is dropped');
assert(ws.isClientStale({}, pingedAt) === false, 'new client with no pong yet is not dropped');

// ── Driver instructions ───────────────────────────────────────────────────────

['enter', 'move-forward', 'move-back', 'stop'].forEach((instruction) => {
  ws.handleDriverInstruction('s1', instruction);
  assert(lastSent('driver-instruction-ack').data.instruction === instruction, `${instruction} is acknowledged`);
  assert(events['driver:instruction'].pop().instruction === instruction, `${instruction} reaches the app`);
});

// ── Double press notice and weight payload ────────────────────────────────────

const originalGet = ConfigManager.get;
ConfigManager.get = function (key, defaultValue) {
  if (key === 'input.activeSource') return 'wd2';
  return originalGet.call(this, key, defaultValue);
};
const sm = StateManager.getInstance();
sm.reset();
sm.lastRawCumulativeWeight = 0;
sm.cumulativeBaseOffset = 0;
sm.lastScaleFrameAt = Date.now();

StateManager.setCurrentMobileWeight(0, true);
StateManager.setCurrentMobileWeight(80, true);
assert(sm.getScaleNotice() === null, 'one Weighing press has no notice');
StateManager.setCurrentMobileWeight(80, true);
assert(sm.getScaleNotice() === null, 'a repeated total is not another press');
StateManager.setCurrentMobileWeight(160, true);
assert(/2 times/.test(sm.getScaleNotice() || ''), 'second press warns, even with equal axle weights');
assert(StateManager.getCurrentMobileWeight() === 160, 'double press still allows the reading');
StateManager.addAxleWeight(StateManager.getCurrentMobileWeight());
assert(sm.getScaleNotice() === null, 'capture clears the notice');
StateManager.setCurrentMobileWeight(240, true);
assert(sm.getScaleNotice() === null, 'next single press has no notice');
StateManager.setCurrentMobileWeight(320, true);
assert(/2 times/.test(sm.getScaleNotice() || ''), 'next double press warns');
StateManager.setCurrentMobileWeight(0, true);
assert(sm.getScaleNotice() === null, 'console Clear clears the notice');

const payloads = [];
ws.broadcastToRegistered = (type, data) => payloads.push({ type, data });
sm.mode = 'mobile';
ws.broadcastWeight({ weight: 0, currentWeight: 0 }, 'mobile');
const weightMessage = payloads.find((m) => m.type === 'weight');
assert(weightMessage.data.minCaptureWeight === 50, 'weight message shares the minimum capture weight');
assert(weightMessage.data.scaleNotice === null, 'weight message shares the scale notice');

ConfigManager.get = originalGet;
console.log('\nAll TruLoad sync tests complete.');
process.exit();
})();
