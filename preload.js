const { contextBridge, ipcRenderer } = require('electron');

console.log('TruConnect Preload script loaded');

// Whitelist of valid invoke channels
const validInvokeChannels = [
  'get-initial-data',
  'open-settings',
  'save-settings',
  'get-settings',
  'reset-settings',
  'test-backend-connection',
  // Authentication
  'auth:login',
  'auth:logout',
  'auth:check-session',
  'auth:get-saved-credentials',
  // Mobile scale actions
  'mobile:capture-axle',
  'mobile:reset-session',
  'mobile:vehicle-complete',
  'mobile:cancel-weighing',
  'mobile:set-axle-config',
  'mobile:get-axle-config',
  'mobile:is-complete',
  // Station sync
  'station:sync',
  'station:get',
  'station:set-bound',
  // Scale status
  'scale:get-status',
  'scale:update-status',
  'scale:simulate-connection',
  // Connection pool
  'pool:get-clients',
  // System
  'app:get-version',
  'app:restart'
];

// Whitelist of valid receive channels
const validReceiveChannels = [
  'weights-updated',
  'connection-status',
  'axle-captured',
  'axle:next-ready',
  'axle:vehicle-moving',
  'stability-changed',
  'session-reset',
  'auth-required',
  'settings-updated',
  // Backend/autoweigh events
  'autoweigh:sent',
  'weighing:complete',
  'weighing:cancelled',
  // Station events
  'station:updated',
  'station:bound-changed',
  // Scale events
  'scale:status-changed',
  // Connection pool events
  'pool:client-joined',
  'pool:client-left',
  'pool:client-registered',
  'pool:updated'
];

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Generic invoke method
  invoke: (channel, data) => {
    if (validInvokeChannels.includes(channel)) {
      console.log(`IPC invoke: ${channel}`);
      return ipcRenderer.invoke(channel, data);
    }
    console.error(`Invalid invoke channel: ${channel}`);
    return Promise.reject(new Error(`Invalid channel: ${channel}`));
  },

  // Generic listener
  on: (channel, callback) => {
    if (validReceiveChannels.includes(channel)) {
      const subscription = (event, ...args) => callback(...args);
      ipcRenderer.on(channel, subscription);
      return () => ipcRenderer.removeListener(channel, subscription);
    }
    console.error(`Invalid receive channel: ${channel}`);
    return () => {};
  },

  // =====================
  // Weight & Status APIs
  // =====================

  onWeightsUpdated: (callback) => {
    console.log('Setting up weights listener');
    const subscription = (event, data) => {
      console.log('Weights updated:', data);
      callback(data);
    };
    ipcRenderer.on('weights-updated', subscription);
    return () => ipcRenderer.removeListener('weights-updated', subscription);
  },

  onConnectionStatus: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('connection-status', subscription);
    return () => ipcRenderer.removeListener('connection-status', subscription);
  },

  onStabilityChanged: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('stability-changed', subscription);
    return () => ipcRenderer.removeListener('stability-changed', subscription);
  },

  getInitialData: () => {
    console.log('Getting initial data');
    return ipcRenderer.invoke('get-initial-data')
      .then(data => {
        console.log('Initial data received:', data);
        return data;
      })
      .catch(error => {
        console.error('Error getting initial data:', error);
        // Return default data if fetch fails
        return {
          deck1: 0,
          deck2: 0,
          deck3: 0,
          deck4: 0,
          gvw: 0,
          connected: [false, false, false, false],
          stationName: 'TruConnect Station',
          captureMode: 'mobile',
          vehicleOnDeck: false
        };
      });
  },

  // =====================
  // Settings APIs
  // =====================

  openSettings: () => {
    console.log('Opening settings');
    return ipcRenderer.invoke('open-settings');
  },

  saveSettings: (settings) => {
    console.log('Saving settings:', settings);
    return ipcRenderer.invoke('save-settings', settings);
  },

  getSettings: () => {
    console.log('Getting settings');
    return ipcRenderer.invoke('get-settings');
  },

  resetSettings: () => {
    console.log('Resetting settings');
    return ipcRenderer.invoke('reset-settings');
  },

  testBackendConnection: (config) => {
    console.log('Testing backend connection:', config.baseUrl);
    return ipcRenderer.invoke('test-backend-connection', config);
  },

  onSettingsUpdated: (callback) => {
    const subscription = (event, data) => {
      console.log('Settings updated:', data);
      callback(data);
    };
    ipcRenderer.on('settings-updated', subscription);
    return () => ipcRenderer.removeListener('settings-updated', subscription);
  },

  // =====================
  // Authentication APIs
  // =====================

  login: async (credentials) => {
    console.log('Login attempt:', credentials.email);
    try {
      const result = await ipcRenderer.invoke('auth:login', credentials);
      return result;
    } catch (error) {
      console.error('Login error:', error);
      return { success: false, error: error.message };
    }
  },

  logout: () => {
    console.log('Logging out');
    return ipcRenderer.invoke('auth:logout');
  },

  checkSession: () => {
    return ipcRenderer.invoke('auth:check-session');
  },

  getSavedCredentials: () => {
    return ipcRenderer.invoke('auth:get-saved-credentials');
  },

  onAuthRequired: (callback) => {
    const subscription = (event) => callback();
    ipcRenderer.on('auth-required', subscription);
    return () => ipcRenderer.removeListener('auth-required', subscription);
  },

  // =====================
  // Mobile Scale APIs
  // =====================

  sendAxleCaptured: (data) => {
    console.log('Axle captured:', data);
    return ipcRenderer.invoke('mobile:capture-axle', data);
  },

  sendResetSession: () => {
    console.log('Resetting session');
    return ipcRenderer.invoke('mobile:reset-session');
  },

  sendVehicleComplete: (data) => {
    console.log('Vehicle complete:', data);
    return ipcRenderer.invoke('mobile:vehicle-complete', data);
  },

  onAxleCaptured: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('axle-captured', subscription);
    return () => ipcRenderer.removeListener('axle-captured', subscription);
  },

  onSessionReset: (callback) => {
    const subscription = (event) => callback();
    ipcRenderer.on('session-reset', subscription);
    return () => ipcRenderer.removeListener('session-reset', subscription);
  },

  // Axle configuration
  setAxleConfig: (config) => {
    console.log('Setting axle config:', config);
    return ipcRenderer.invoke('mobile:set-axle-config', config);
  },

  getAxleConfig: () => {
    return ipcRenderer.invoke('mobile:get-axle-config');
  },

  isWeighingComplete: () => {
    return ipcRenderer.invoke('mobile:is-complete');
  },

  // Auto-detection events
  onNextAxleReady: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('axle:next-ready', subscription);
    return () => ipcRenderer.removeListener('axle:next-ready', subscription);
  },

  onVehicleMoving: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('axle:vehicle-moving', subscription);
    return () => ipcRenderer.removeListener('axle:vehicle-moving', subscription);
  },

  // Cancel weighing session
  cancelWeighing: (reason) => {
    console.log('Cancelling weighing:', reason);
    return ipcRenderer.invoke('mobile:cancel-weighing', reason);
  },

  // =====================
  // Backend Events
  // =====================

  // Auto-weigh sent to backend
  onAutoweighSent: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('autoweigh:sent', subscription);
    return () => ipcRenderer.removeListener('autoweigh:sent', subscription);
  },

  // Weighing complete (backend confirmed)
  onWeighingComplete: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('weighing:complete', subscription);
    return () => ipcRenderer.removeListener('weighing:complete', subscription);
  },

  // Weighing cancelled
  onWeighingCancelled: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('weighing:cancelled', subscription);
    return () => ipcRenderer.removeListener('weighing:cancelled', subscription);
  },

  // =====================
  // Station Sync APIs
  // =====================

  // Sync station configuration from frontend
  syncStation: (stationData) => {
    console.log('Syncing station to middleware:', stationData?.name);
    return ipcRenderer.invoke('station:sync', stationData);
  },

  // Get current station configuration
  getStation: () => {
    return ipcRenderer.invoke('station:get');
  },

  // Set current bound (for bidirectional stations)
  setStationBound: (bound) => {
    console.log('Setting station bound:', bound);
    return ipcRenderer.invoke('station:set-bound', bound);
  },

  // Station updated event
  onStationUpdated: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('station:updated', subscription);
    return () => ipcRenderer.removeListener('station:updated', subscription);
  },

  // Bound changed event
  onBoundChanged: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('station:bound-changed', subscription);
    return () => ipcRenderer.removeListener('station:bound-changed', subscription);
  },

  // =====================
  // Scale Status APIs
  // =====================

  // Get scale connection status
  getScaleStatus: (scaleId) => {
    return ipcRenderer.invoke('scale:get-status', scaleId);
  },

  // Update scale status
  updateScaleStatus: (scaleId, status) => {
    return ipcRenderer.invoke('scale:update-status', { scaleId, status });
  },

  // Simulate scale connection (for testing)
  simulateScaleConnection: (scaleId, connected) => {
    console.log(`Simulating ${scaleId} ${connected ? 'connection' : 'disconnection'}`);
    return ipcRenderer.invoke('scale:simulate-connection', { scaleId, connected });
  },

  // Scale status changed event
  onScaleStatusChanged: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('scale:status-changed', subscription);
    return () => ipcRenderer.removeListener('scale:status-changed', subscription);
  },

  // =====================
  // Connection Pool APIs
  // =====================

  // Get all connected clients
  getConnectedClients: () => {
    return ipcRenderer.invoke('pool:get-clients');
  },

  // Listen for client joined
  onClientJoined: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('pool:client-joined', subscription);
    return () => ipcRenderer.removeListener('pool:client-joined', subscription);
  },

  // Listen for client left
  onClientLeft: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('pool:client-left', subscription);
    return () => ipcRenderer.removeListener('pool:client-left', subscription);
  },

  // Listen for client registered
  onClientRegistered: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('pool:client-registered', subscription);
    return () => ipcRenderer.removeListener('pool:client-registered', subscription);
  },

  // Listen for pool updated (any change)
  onPoolUpdated: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('pool:updated', subscription);
    return () => ipcRenderer.removeListener('pool:updated', subscription);
  },

  // =====================
  // System APIs
  // =====================

  getVersion: () => {
    return ipcRenderer.invoke('app:get-version');
  },

  restart: () => {
    return ipcRenderer.invoke('app:restart');
  }
});

console.log('electronAPI exposed to renderer');
