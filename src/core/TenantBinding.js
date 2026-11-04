/**
 * TenantBinding - Which TruLoad tenant and station this TruConnect belongs to
 *
 * The first TruLoad client to connect sets the binding. Later connections are
 * compared against it by org slug, so one tenant's weighing cannot silently land
 * in another's records. A station change within the same org follows TruLoad.
 */

const ConfigManager = require('../config/ConfigManager');
const EventBus = require('./EventBus');
const StateManager = require('./StateManager');

const normalize = (value) => String(value || '').trim().toLowerCase();

// Hooks in TruLoad register with these before the station has loaded
const isRealStation = (code) => Boolean(code) && code !== 'DEFAULT';

function applyStation(stationCode, stationName) {
  ConfigManager.set('station.code', stationCode);
  if (stationName) ConfigManager.set('station.name', stationName);
  ConfigManager.set('tenantBinding.stationCode', stationCode);

  const station = StateManager.getStationConfig ? StateManager.getStationConfig() : null;
  if (station && StateManager.getInstance().setStationConfig) {
    // The old station's id no longer applies; config sync resolves the new one
    StateManager.getInstance().setStationConfig({
      ...station,
      id: null,
      stationId: null,
      code: stationCode,
      name: stationName || station.name
    });
  }
}

function bind(orgSlug, stationCode, stationName) {
  ConfigManager.set('tenantBinding.orgSlug', normalize(orgSlug));
  if (isRealStation(stationCode)) applyStation(stationCode, stationName);
}

/**
 * Compare a TruLoad client against the stored binding, applying it where allowed.
 * @returns {{status: string, message?: string, storedOrg?: string, previousStation?: string}}
 */
function check({ orgSlug, stationCode, stationName } = {}) {
  // Clients that do not identify an org (older TruLoad builds, other tools) stay as they were
  if (!orgSlug) return { status: 'unverified' };

  const storedOrg = ConfigManager.get('tenantBinding.orgSlug', null);

  if (!storedOrg) {
    bind(orgSlug, stationCode, stationName);
    return { status: 'bound' };
  }

  if (normalize(storedOrg) !== normalize(orgSlug)) {
    return {
      status: 'org-mismatch',
      storedOrg,
      message: `This TruConnect belongs to "${storedOrg}", not "${orgSlug}". Waiting for the operator to confirm on the TruConnect screen.`
    };
  }

  const currentStation = ConfigManager.get('tenantBinding.stationCode', null) || ConfigManager.get('station.code', '');
  if (!isRealStation(stationCode) || stationCode === currentStation) {
    return { status: 'confirmed' };
  }

  applyStation(stationCode, stationName);
  EventBus.emit('tenant:station-changed', { previousStation: currentStation, stationCode });
  return {
    status: 'station-changed',
    previousStation: currentStation,
    message: `Station changed from ${currentStation || 'none'} to ${stationCode} to match TruLoad.`
  };
}

function clear() {
  ConfigManager.set('tenantBinding.orgSlug', null);
  ConfigManager.set('tenantBinding.stationCode', null);
}

module.exports = { check, bind, clear };
