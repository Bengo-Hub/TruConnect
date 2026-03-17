## MCGS Mobile Scale - Sample Weight Frames

This document captures real serial frames observed from an MCGS mobile scale console.
These samples are used to validate parsing behavior in `MobileScaleParser` (`mode: 'mcgs'`).

### Frame Format

Each frame has the general structure:

```text
=SG+0000000kR   or   =SG+0000060kX
```

Where:
- `=`: Optional start-of-frame marker
- `SG`: Status/weight prefix
- `+0000000`: Signed numeric weight value (zero-padded)
- `kR` / `kX`: Unit/terminator suffix (kilograms; R/X = status/variant)
- Frames may be sent with or without `\r\n`; the middleware extracts frames by regex when no newline is present.

### Observed Zero-Weight Frames

The following are typical zero-weight frames captured from the serial connection:

```text
=SG+0000000kR
=SG+0000000kR
=SG+0000000kR
=SG+0000000kR
=SG+0000000kR
=SG+0000000kR
=SG+0000000kR
=SG+0000000kR
=SG+0000000kR
=SG+0000000kR
```

Noise characters (e.g. STX/ETX or occasional binary bytes) may appear before or between frames on the wire,
but the parser normalizes by:
- Trimming whitespace
- Stripping a leading `=`
- Extracting the numeric portion between `SG+` and the trailing `k`/`kR`/`kX`

### Parsing Expectations

For a non-zero frame like `=SG+0000123kR` or `=SG+0000060kX`:

`MobileScaleParser` in `mcgs` mode will:
- Extract the numeric value as the current axle weight (kg)
- Treat the frame as **live current weight** (A+B combined); axle capture is done by the frontend when the user clicks Capture
- Update `currentMobileWeight` for API/WebSocket; do not auto-push to captured axles

### MCGS Console Commands (optional)

The middleware can send commands to the console to request weight or control the session:

| Command | Bytes (hex) | Description |
|--------|-------------|-------------|
| Weigh | STX 'A' ETX (02 41 03) | Request current axle GVW; console responds with weight frame |
| Zero  | STX 'D' ETX (02 44 03) | Zero/tare |
| Stop  | STOP\r\n               | Cancel current session (if supported) |

Configured in Settings → Input sources → MCGS (Weigh/Zero/Stop command fields). Default Weigh command is sent when the client sends `query-weight` or after each axle capture to request the next reading.
