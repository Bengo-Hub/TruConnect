// tests/serial_test.js
import { SerialPort } from 'serialport';

const port = new SerialPort({
  path: 'COM7',
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  rtscts: false,
  xon: false,
  xoff: false,
  autoOpen: false,
});

port.open((err) => {
  if (err) {
    console.error('❌ OPEN ERROR:', err.message);
    return;
  }
  console.log('✅ PORT OPENED');
});

port.on('data', (data) => {
  console.log('⬅️ DATA:', data.toString());
});

port.on('error', (err) => {
  console.error('❌ SERIAL ERROR:', err.message);
});
