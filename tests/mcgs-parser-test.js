const MobileScaleParser = require('../src/parsers/MobileScaleParser');

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} (expected=${expected}, actual=${actual})`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function run() {
  console.log('Running MCGS MobileScaleParser tests...');

  const parser = new MobileScaleParser({ mode: 'mcgs' });

  // MCGS frames are a live reading: axles are captured by the operator, never by the parser
  const frame1 = '=SG+0000123kR';
  const result1 = parser.parse(frame1);

  assert(result1, 'Result for first MCGS frame should not be null');
  assertEqual(result1.weight, 123, 'First frame weight should be 123 kg');
  assertEqual(result1.scaleWeightMode, 'combined', 'scaleWeightMode should be combined for MCGS');

  const frame2 = '=SG+0000456kR';
  const result2 = parser.parse(frame2);

  assert(result2, 'Result for second MCGS frame should not be null');
  assertEqual(result2.weight, 456, 'Second frame weight should be 456 kg');

  assert(Array.isArray(result2.axleWeights), 'axleWeights should be an array');
  assertEqual(result2.axleWeights.length, 0, 'Parser should not capture axles from a live reading');
  assertEqual(result2.runningTotal, 0, 'Running total should stay 0 until axles are captured');

  console.log('✅ All MCGS MobileScaleParser tests passed.');
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error('❌ MCGS MobileScaleParser tests failed:', err.message);
    process.exitCode = 1;
  }
}

