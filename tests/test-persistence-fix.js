
const ConfigManager = require('../src/config/ConfigManager').getInstance();
const EventBus = require('../src/core/EventBus');

// Mock Database
const mockDb = {
    settings: {},
    all: function(query) { return []; },
    get: function(query, params) { 
        console.log(`[DB GET] ${params[0]}`);
        return this.settings[params[0]]; 
    },
    run: function(query, params) {
        console.log(`[DB RUN] ${query} | Params: ${JSON.stringify(params)}`);
        if (query.includes('UPDATE')) {
            const value = params[0];
            const path = params[1];
            this.settings[path] = { key: path, value: value };
        } else if (query.includes('INSERT')) {
            const path = params[0];
            const value = params[1];
            this.settings[path] = { key: path, value: value };
        }
    }
};

ConfigManager.initialize(mockDb);

console.log('--- Starting Persistence Fix Test ---');

const testSettings = {
    input: {
        activeSource: 'mcgs',
        mcgs: {
            enabled: true,
            useCumulativeWeight: true, // This is what we want to persist
            serial: {
                port: 'COM99'
            }
        }
    }
};

console.log('\nImporting test settings...');
ConfigManager.import(testSettings);

console.log('\nVerifying DB records...');
const expectedKeys = [
    'input.activeSource',
    'input.mcgs.enabled',
    'input.mcgs.useCumulativeWeight',
    'input.mcgs.serial.port'
];

let allGood = true;
for (const key of expectedKeys) {
    if (mockDb.settings[key]) {
        console.log(`[OK] Found leaf node in DB: ${key} = ${mockDb.settings[key].value}`);
    } else {
        console.log(`[FAIL] Missing leaf node in DB: ${key}`);
        allGood = false;
    }
}

// Also check that it's NOT saving the intermediate object 'input.mcgs' if we want complete consistency
if (mockDb.settings['input.mcgs']) {
    console.log('[INFO] Intermediate node "input.mcgs" also persisted (this is fine but redundant if recursive)');
}

if (allGood) {
    console.log('\nSUCCESS: Deep persistence working correctly!');
} else {
    console.log('\nFAILURE: Deep persistence failed.');
}
