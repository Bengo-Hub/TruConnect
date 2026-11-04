## Portable Axle Scale 255-D (WD2) - Weight Frames and Cumulation

This document records serial frames captured from the "Portable axle scale 255-D" console
(firmware WD2-88888-5.0) over Bluetooth, and how the console reports weight during a multi-axle
weighing. The samples back `tests/wd2-parser-test.js` and `tests/wd2-workflow-test.js`.

No manufacturer protocol document was found for this console. Everything below comes from captures
compared against the console screen, plus a published description of the same 12-byte frame for a
related indicator family.

### Console Settings

Serial port settings on the console:

| Setting | Value |
|---------|-------|
| Data output mode | RS 232 485 continuous automatic output |
| Data output protocol | Yaohua Protocol 1 |
| Data output baud rate | 19200 |
| Data output interval | 1 second |

General settings: unit kg, division value 20, channels 1 and 2. The console also offers "output after
weighing", Toledo Protocol and Yaohua Protocol 2. Those options have not been tested.

The PC connects through the paired "Serial Adaptor" Bluetooth module using its **outgoing** COM port.
The link accepts one client at a time.

### Frame Format

Each frame is 12 bytes with no line terminator:

```text
STX  +  000220  0  1B  ETX
02   2B 303030323230 30 3142 03
```

| Bytes | Field | Notes |
|-------|-------|-------|
| 1 | STX (0x02) | Frame start |
| 2 | Sign | `+` in every capture |
| 3-8 | Weight digits | Highest digit first |
| 9 | Decimal position | `0` in every capture |
| 10-11 | Checksum | XOR of bytes 2-9, as two uppercase hex characters |
| 12 | ETX (0x03) | Frame end |

The last two characters are the checksum and not part of the weight. `+00000001B` is therefore 0 kg.
Frames often arrive split across serial chunks, so `InputManager` extracts them from its buffer.

### How the Console Reports Weight

The frame carries the **running vehicle total**, not the current axle and not the live pad load.

- Load on the pads does not change the frame.
- The **Weighing** button adds the axle to the total and updates the frame.
- The console repeats that total once per second until the next Weighing press.
- The **Clear** button resets the total to 0.
- Individual pad weights appear on the screen only. They are not in the frame.

### Captured Runs

Each row compares the frame with the axle list on the console screen.

**2 axles**

| Axle | Pad 1 | Pad 2 | Console axle | Frame | Total | Total minus previous |
|------|-------|-------|--------------|-------|-------|----------------------|
| 1 | 40 | 40 | 80 | `+000080013` | 80 | 80 |
| 2 | 80 | 60 | 140 | `+00022001B` | 220 | 140 |

**3 axles**

| Axle | Pad 1 | Pad 2 | Console axle | Frame | Total | Total minus previous |
|------|-------|-------|--------------|-------|-------|----------------------|
| 1 | 20 | 20 | 40 | `+00004001F` | 40 | 40 |
| 2 | 40 | 80 | 120 | `+00016001C` | 160 | 120 |
| 3 | 60 | 100 | 160 | `+00032001A` | 320 | 160 |

**4 axles**

| Axle | Pad 1 | Pad 2 | Console axle | Frame | Total | Total minus previous |
|------|-------|-------|--------------|-------|-------|----------------------|
| 1 | 40 | 40 | 80 | `+000080013` | 80 | 80 |
| 2 | 60 | 80 | 140 | `+00022001B` | 220 | 140 |
| 3 | 40 | 60 | 100 | `+00032001A` | 320 | 100 |
| 4 | 60 | 100 | 160 | `+000480017` | 480 | 160 |

Every total matched the console's main display and every difference matched its axle list.

### TruConnect Handling

Source `wd2`, protocol `WD2`, parser `MobileScaleParser` in `wd2` mode.

- `useCumulativeWeight: true` makes each reading the total minus the total at the last capture.
- `holdsCumulativeTotal: true` covers the console repeating its total:
  - A session reset keeps the held total as the subtraction base, so it cannot read as the next
    vehicle's first axle.
  - A total below the base means the console was cleared, so the base returns to 0.
  - A captured axle reads 0 immediately, so a second click before the next frame cannot store it twice.
- A frame with a bad checksum is rejected and the last reading stays in place.

MCGS also has `holdsCumulativeTotal`, with `liveCumulativeTotal` because its reading can move with the load and may only be sent on request. There, the only effect is that the exact total repeated after a session reset reads 0 until it changes. This has not been tested on MCGS hardware. If an MCGS console is not cleared between vehicles, the next vehicle's first axle still reads the running total.

- Frames sometimes stop while the port stays open. After 10 seconds with no data, TruConnect reopens
  the port and keeps trying, and both apps show the scale as disconnected until data returns.
- Frames more than `heldTotalGapMs` apart (5 seconds by default) count as an interruption. A total that
  rose during an interruption mid-vehicle reads normally, with a notice to check the console's axle
  list, because a Clear during the pause would make that reading low. A total that fell means the
  console was cleared.
- With no axles captured yet, the reading is the console's real total, including right after a start.
  Press Clear on the console before weighing a new vehicle, so that total starts from 0.
- Axle captures below `thresholds.mobile.minCaptureWeight` are rejected on the capture screen, WebSocket
  and API paths. The default is 50 kg, set under Settings, Thresholds. Multideck readings are exempt.

### Operator Workflow

1. Press **Clear** on the console and select the vehicle's axle type.
2. Position the axle and press **Weighing** on the console.
3. Press Capture in TruConnect.
4. Repeat for each axle. After the last axle, complete the weighing.
5. Press **Clear** on the console before the next vehicle.

### Known Limits

- **Weighing pressed twice without a capture:** the next capture holds both axles as one weight. The
  total rises once per press, even for two axles of equal weight, so TruConnect and TruLoad show a
  warning. Capture stays allowed because the frames cannot show whether the presses were two axles or
  one axle weighed twice.
- **Pad weights:** `scaleA` and `scaleB` are an even split of the axle weight, not the real pad values.
- **XOR checksum:** two corrupted bytes with the same error cancel out and pass. For example, a frame
  corrupted to `+00099001B` would read as 990 kg.

### Test Commands

```bash
node tests/wd2-parser-test.js
node tests/wd2-workflow-test.js
node tests/wd2-live-test.js COM5 19200 --seconds=5
```

The live test only listens. It never writes to the port.
