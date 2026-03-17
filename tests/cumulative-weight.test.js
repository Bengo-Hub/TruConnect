const path = require('path');

// --- Mocking ConfigManager ---
const configMock = {
    'input.activeSource': 'mcgs',
    'input.mcgs.useCumulativeWeight': true
};

const configManagerPath = path.resolve(__dirname, '../src/config/ConfigManager');
const configManagerPathJs = configManagerPath + '.js';

const mockExports = {
    get: (key, defaultValue) => {
        const val = configMock[key] !== undefined ? configMock[key] : defaultValue;
        // console.log(`[Mock Config] get ${key} -> ${val}`);
        return val;
    },
    initialize: () => {}
};

require.cache[configManagerPath] = { id: configManagerPath, exports: mockExports };
require.cache[configManagerPathJs] = { id: configManagerPathJs, exports: mockExports };

// --- Mocking EventBus ---
const eventBusPath = path.resolve(__dirname, '../src/core/EventBus');
const eventBusPathJs = eventBusPath + '.js';
const eventBusMock = {
    getInstance: () => ({
        emitEvent: (ev, data) => {
            // console.log(`[Mock EventBus] emit ${ev}`);
        },
        on: () => {}
    }),
    EVENTS: {
        SIMULATION_STATE: 'sim_state',
        CONNECTION_STATUS: 'conn_status'
    }
};
require.cache[eventBusPath] = { id: eventBusPath, exports: eventBusMock };
require.cache[eventBusPathJs] = { id: eventBusPathJs, exports: eventBusMock };

// --- Now import StateManager ---
const StateManager = require('../src/core/StateManager');

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message} (expected=${expected}, actual=${actual})`);
    }
}

async function runTest() {
    console.log('Running Cumulative Weight Logic Test...');

    const sm = StateManager.getInstance();
    sm.reset(); // Ensure clean state
    sm.simulation = false; 

    // Verification of mock
    /** @type {any} */
    const ConfigManager = require('../src/config/ConfigManager');
    console.log('Active Source from mock:', ConfigManager.get('input.activeSource'));

    // Step 1: Simulate Axle 1 - 6000 kg
    StateManager.setCurrentMobileWeight(6000);
    assertEqual(sm.currentMobileWeight, 6000, 'Initial weight should be 6000');

    // User captures Axle 1
    sm.addAxleWeight(6000);
    assertEqual(sm.getMobileState().gvw, 6000, 'GVW should be 6000 after 1st axle capture');

    // Step 2: Simulate Axle 2 - Scale reports 14200 (cumulative)
    StateManager.setCurrentMobileWeight(14200);
    assertEqual(sm.currentMobileWeight, 8200, 'Weight should be 8200 after subtraction (14200 - 6000)');

    // User captures Axle 2
    sm.addAxleWeight(8200);
    assertEqual(sm.getMobileState().gvw, 14200, 'GVW should be 14200 after 2nd axle capture');

    console.log('✅ Cumulative weight logic tests passed.');
}

runTest().catch(err => {
    console.error('❌ Test failed:', err.message);
    process.exit(1);
});
