const { SerialPort } = require('serialport');
const express = require('express');

const BAUD_RATE = 9600;
const HTTP_PORT = 3031;

let port = null;
let connected = false;
let latestWeights = {
    scaleA: 0,
    scaleB: 0,
    total: 0,
    status: "disconnected"
};

// ---------- SERIAL CONNECTION ----------
async function connectSerial() {
    try {
        const ports = await SerialPort.list();

        if (!ports.length) {
            console.log("❌ No COM ports found. Retrying in 5 seconds...");
            setTimeout(connectSerial, 5000);
            return;
        }

        console.log("Available ports:");
        ports.forEach(p => console.log(` - ${p.path}`));

        const targetPort = ports[0].path; // or choose by VID/PID if known
        console.log(`Attempting to connect to ${targetPort}...`);

        port = new SerialPort({
            path: targetPort,
            baudRate: BAUD_RATE,
            autoOpen: false
        });

        port.open(err => {
            if (err) {
                console.log("❌ Failed to open port:", err.message);
                setTimeout(connectSerial, 5000);
                return;
            }

            console.log("✅ Serial connected:", targetPort);
            connected = true;
            latestWeights.status = "connected";

            // MCGS may send frames without newlines; use raw data and extract frames by regex
            let buf = '';
            port.on('data', (chunk) => {
                buf += chunk.toString();
                const re = /(=?SG\+?-?\d+[kK][A-Za-z]?)/g;
                let m;
                while ((m = re.exec(buf)) !== null) {
                    handleSerialData(m[1]);
                }
                const lastMatch = buf.match(re);
                if (lastMatch) {
                    const last = lastMatch[lastMatch.length - 1];
                    buf = buf.slice(buf.lastIndexOf(last) + last.length);
                }
                if (buf.length > 4096) buf = '';
            });
        });

        port.on('error', err => {
            console.log("⚠ Serial error:", err.message);
            connected = false;
            latestWeights.status = "error";
        });

        port.on('close', () => {
            console.log("🔌 Serial disconnected. Reconnecting...");
            connected = false;
            latestWeights.status = "disconnected";
            setTimeout(connectSerial, 5000);
        });

    } catch (err) {
        console.log("❌ Serial init error:", err.message);
        setTimeout(connectSerial, 5000);
    }
}

// ---------- PARSER ----------
// MCGS sends one combined axle weight per frame (=SG+0000060kX or =SG+0000060kR).
// Each frame is A+B combined; we report scaleA/scaleB as half each for compatibility.
function handleSerialData(line) {
    try {
        line = line.trim();
        if (!line.includes("SG")) return;

        const cleaned = line.replace(/^=/, '');
        const match = cleaned.match(/SG\+?(-?\d+)[kK]/i);
        const value = match ? parseFloat(match[1]) : parseFloat(cleaned.replace(/[^0-9\-.]/g, ''));
        if (isNaN(value)) return;

        latestWeights.total = value;
        latestWeights.scaleA = Math.round(value / 2);
        latestWeights.scaleB = value - latestWeights.scaleA;
        latestWeights.status = "connected";
    } catch (err) {
        console.log("Parse error:", err.message);
    }
}

// ---------- COMMAND SENDER ----------
function sendCommand(command) {
    if (!connected || !port) {
        console.log("Cannot send command — not connected");
        return;
    }

    port.write(command, err => {
        if (err) {
            console.log("Write error:", err.message);
        }
    });
}

// Example command helpers (adjust if needed)
function zero() {
    sendCommand(Buffer.from([0x02, 0x44, 0x03])); // STX 'D' ETX
}

function weigh() {
    sendCommand(Buffer.from([0x02, 0x41, 0x03])); // STX 'A' ETX
}

function stop() {
    sendCommand("STOP\r\n"); // if ASCII command supported
}

// ---------- HTTP SERVER ----------
const app = express();

app.get('/weights', (req, res) => {
    res.json(latestWeights);
});

app.get('/zero', (req, res) => {
    zero();
    res.json({ message: "Zero command sent" });
});

app.get('/weigh', (req, res) => {
    weigh();
    res.json({ message: "Weigh command sent" });
});

app.listen(HTTP_PORT, () => {
    console.log(`🌍 API running on http://localhost:${HTTP_PORT}/api/v1`);
});

// Start connection
connectSerial();