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

  // Single frame → single axle
  const frame1 = '=SG+0000123kR';
  const result1 = parser.parse(frame1);

  assert(result1, 'Result for first MCGS frame should not be null');
  assertEqual(result1.weight, 123, 'First frame weight should be 123 kg');
  assertEqual(result1.axleNumber, 1, 'First frame axleNumber should be 1');
  assertEqual(result1.runningTotal, 123, 'Running total after first frame should be 123');
  assertEqual(result1.scaleWeightMode, 'combined', 'scaleWeightMode should be combined for MCGS');

  // Second frame → second axle, accumulated running total
  const frame2 = '=SG+0000456kR';
  const result2 = parser.parse(frame2);

  assert(result2, 'Result for second MCGS frame should not be null');
  assertEqual(result2.weight, 456, 'Second frame weight should be 456 kg');
  assertEqual(result2.axleNumber, 2, 'Second frame axleNumber should be 2');
  assertEqual(result2.runningTotal, 579, 'Running total after second frame should be 579');

  // Ensure axleWeights array tracks both axles
  assert(Array.isArray(result2.axleWeights), 'axleWeights should be an array');
  assertEqual(result2.axleWeights.length, 2, 'axleWeights should contain two entries');
  assertEqual(result2.axleWeights[0], 123, 'First axle weight should be 123');
  assertEqual(result2.axleWeights[1], 456, 'Second axle weight should be 456');

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

