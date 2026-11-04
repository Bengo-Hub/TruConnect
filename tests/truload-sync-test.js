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
BackendClient.hasSyncedTransaction = () => true;
ws.handleVehicleComplete('s1', { totalAxles: 2, axleWeights: [80, 140], gvw: 220 });
assert(lastSent('vehicle-complete-ack').data.success === true, 'vehicle complete from TruLoad is acknowledged');

ws.handleResetSession('s1');
assert(lastSetup().reset === true, 'session reset clears the mirrored setup');

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
