# TruConnect - Advanced Weight Monitoring System

**Version:** 2.0.0 | **Status:** 95% Complete (Production-Ready) | **Last Updated:** February 4, 2026

TruConnect is a modern, feature-rich Electron application serving as weighbridge middleware for the TruLoad intelligent weighing system. It bridges multiple weight indicator protocols with the TruLoad backend/frontend, supporting both multideck static weighing and mobile axle-by-axle weighing.

## 🌟 Features

### Core Capabilities (100% Implemented)
- **8 Weight Indicator Protocol Parsers** - ZM (Avery), Cardinal, Cardinal2, 1310, PAW, Haenni, UDP Binary, Custom
- **Multiple Input Sources** - Serial (RS-232/USB), TCP, UDP, HTTP API
- **Multiple Output Channels** - WebSocket (port 3030), Serial RDU, Network RDU, REST API
- **Mobile & Multideck Modes** - Sequential axle capture and simultaneous 4-deck weighing
- **Cloud Relay** - LOCAL and LIVE operation modes with offline queueing
- **Event-Driven Architecture** - StateManager + EventBus pattern

### Modern UI (100% Implemented)
- Clean, dark-themed interface with smooth animations
- Real-time weight visualization for all decks
- Responsive design for various screen sizes
- System tray integration with quick access menu
- Settings management with device configuration
- Activity logging and transaction history

### Communication (100% Implemented)
- Serial, TCP, UDP, and API input support
- Automatic device reconnection
- Connection status monitoring
- Configurable timeouts and retries
- RDU display output (KELI, Yaohua, XK3190, Cardinal, Generic)

### Data Management (100% Implemented)
- SQLite database for settings and history
- Backend API integration with retry logic
- Idempotent submissions via ClientLocalId
- Offline message queueing

## Prerequisites

- Node.js (v14 or later)
- npm (v6 or later)
- Electron (v28.1.0 or later)
- Windows OS (for production deployment)

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd TruConnect
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## ⚙️ Configuration

### Settings Management
Access the Settings window from the system tray menu to configure:

- **General Settings**
  - Station name and identification
  - API endpoint for data submission
  - Polling interval configuration

- **RDU Configuration** (Single Device, Multi-Panel)
  - Configure one RDU device with up to 5 panels
  - Select RDU model (KELI, Yaohua, Generic) with auto-format
  - Assign panels to Deck 1-4 or GVW
  - Choose connection type: Serial (COM ports) or USR-TCP232 (network)
  - Configure panel-specific baud rates and ports
  - Real-time connection status indicators

- **Appearance**
  - Light/Dark/System theme selection
  - UI scaling options
  - Display preferences

### Database
Settings are stored in an SQLite database located at:
```
%APPDATA%/TruConnect/truconnect.db
```

### Environment Variables
- `NODE_ENV`: Set to 'development' for debug mode
- `ELECTRON_IS_DEV`: Set to '1' to enable developer tools

## 🚀 Running the Application

### Development Mode

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the application:
   ```bash
   npm start
   ```

### Production Build

#### Windows
```bash
npx electron-packager . TruConnect \
  --overwrite \
  --asar=true \
  --platform=win32 \
  --arch=x64 \
  --icon=assets/logo.ico \
  --prune=true \
  --out=release-builds \
  --version-string.CompanyName=KeNHA \
  --version-string.FileDescription="TruConnect Weight Monitor" \
  --version-string.ProductName="TruConnect"
```

#### Creating an Installer
Use [electron-builder](https://www.electron.build/) to create an installer:
```bash
npm install --save-dev electron-builder
electron-builder build --win
```

## 📁 Project Structure

```
TruConnect/
├── assets/                  # Static assets (images, icons, fonts)
├── drivers/                 # USB driver installer (CH34x)
├── pages/                   # Application windows
│   ├── index.html          # Main dashboard (66KB)
│   ├── settings.html       # Device configuration (63KB)
│   ├── login.html          # Authentication (17KB)
│   ├── devices.html        # Device status (8KB)
│   ├── activity-log.html   # Transaction history (11KB)
│   └── profile.html        # User profile (11KB)
├── src/                     # Modular architecture (~10,500 lines)
│   ├── auth/               # Authentication system
│   │   ├── AuthManager.js
│   │   ├── AuthMiddleware.js
│   │   └── PasswordUtils.js
│   ├── backend/            # TruLoad API integration
│   │   └── BackendClient.js
│   ├── cloud/              # Cloud relay management
│   │   └── CloudConnectionManager.js
│   ├── config/             # Configuration management
│   │   ├── ConfigManager.js
│   │   └── defaults.js
│   ├── core/               # Core services
│   │   ├── ConnectionPool.js
│   │   ├── EventBus.js
│   │   └── StateManager.js
│   ├── database/           # SQLite persistence
│   │   ├── Database.js
│   │   └── Seed.js
│   ├── input/              # Weight input sources
│   │   ├── InputManager.js
│   │   ├── SerialInput.js
│   │   ├── TcpInput.js
│   │   ├── UdpInput.js
│   │   └── ApiInput.js
│   ├── output/             # Weight output channels
│   │   ├── OutputManager.js
│   │   ├── WebSocketOutput.js (port 3030)
│   │   ├── SerialRduOutput.js
│   │   ├── NetworkRduOutput.js
│   │   └── ApiOutput.js
│   ├── parsers/            # Protocol parsers (8 types)
│   │   ├── ParserFactory.js
│   │   ├── ZmParser.js
│   │   ├── CardinalParser.js
│   │   ├── Cardinal2Parser.js
│   │   ├── I1310Parser.js
│   │   ├── MobileScaleParser.js
│   │   └── CustomParser.js
│   └── simulation/         # Testing/development
│       ├── SimulationEngine.js
│       └── WeightGenerator.js
├── docs/                    # Documentation (200KB+)
│   ├── architecture.md
│   ├── integrations.md
│   ├── frontend-integration.md
│   └── sprints/            # 10 sprint docs
├── main.js                  # Electron main process (506 lines)
├── preload.js              # Secure IPC bridge (104 lines)
├── renderer.js             # Renderer process (75 lines)
└── serialout.js            # Legacy RDU handler (189 lines)
```

## Communication Protocol

### RDU Output

TruConnect sends weight data to RDU (Remote Display Unit) devices using model-specific formats:

| RDU Model | Format | Type | Example (200 kg) |
|-----------|--------|------|------------------|
| KELI | `$={WEIGHT}=` | Reversed | `$=00200000=` |
| Yaohua YHL | `$={WEIGHT}=` | Reversed | `$=00200000=` |
| XK3190 | `={WEIGHT}=` | Reversed | `=00200000=` |
| Cardinal | `{WEIGHT}` | Leading | `00000200` |
| Generic | `{WEIGHT}` | Leading | `00000200` |

**Format Types:**
- **Reversed** (KELI/Yaohua): Digits reversed, trailing zeros (200 → 002 → 00200000)
- **Leading** (Cardinal/Generic): Leading zeros only (200 → 00000200)

### WebSocket Output

Real-time weight streaming via WebSocket (default port: 3030). Clients receive JSON messages with current deck weights and GVW.

## 🔧 Troubleshooting

### Common Issues

1. **Device Connection**
   - Verify physical connections and power to all RDU devices
   - Check COM port assignments in Device Manager
   - Ensure no other application is using the required ports

2. **Network Communication**
   - Verify network connectivity between devices
   - Check firewall settings for blocked ports
   - Ensure correct IP addresses and port numbers in settings

3. **Application Errors**
   - Check logs in the application data directory
   - Reset settings to default if configuration becomes corrupted
   - Verify database file permissions

### Logs
Application logs are stored in:
```
%APPDATA%/TruConnect/logs/
```

### Recovery
To reset the application:
1. Close the application
2. Delete the configuration database
3. Restart the application (a new configuration will be created)

## 📝 License

This is proprietary software developed for Kenya National Highways Authority (KeNHA).
Unauthorized distribution, modification, or reverse engineering is strictly prohibited.

## 📞 Support

For technical support or inquiries, please contact:
- **Email**: support@codevertexitsolutions.com
- **Phone**: +254 743 793901
- **Location**: Oginga Road, Pioneer House, Second Floor, Kisumu

## 🔄 Version History

### v2.0.0 (February 2026) - Current
- **Modular Architecture** - Clean input/parser/output/core separation (~10,500 lines)
- **8 Protocol Parsers** - ZM, Cardinal, Cardinal2, 1310, PAW, Haenni, UDP Binary, Custom
- **Mobile Weighing Mode** - PAW & Haenni scale support with axle-by-axle capture
- **Multideck Mode** - Simultaneous 4-deck weight capture with GVW
- **Cloud Relay** - CloudConnectionManager for LOCAL/LIVE modes
- **Backend Integration** - BackendClient with autoweigh submissions
- **WebSocket Server** - Real-time weight streaming on port 3030
- **Authentication System** - AuthManager with password hashing
- **Event Architecture** - StateManager + EventBus pub/sub pattern
- **Simulation Engine** - Testing mode with realistic weight generation
- **10 Sprint Development** - Comprehensive documentation

### v1.5.0 (October 2024)
- Complete UI redesign with modern interface
- Added configuration management system
- Implemented SQLite database for settings
- Added theme support (Light/Dark/System)
- Improved error handling and logging
- Enhanced device management
- Added system tray functionality

### v1.0.0 (Initial)
- Initial release with basic serial functionality

## 🔗 Integration Status

### Backend Integration (Implemented)
- `POST /api/v1/weighing-transactions/autoweigh` - Auto-weigh submission endpoint (implemented)
- Backend WebSocket relay removed (Sprint 22.1) — frontend always connects to local TruConnect directly

### Frontend Integration (Ready)
- `useMiddleware.ts` hook connects directly to local TruConnect WebSocket (ws://localhost:3030)
- No backend WebSocket relay — all weight streaming is local-only
- Weighing UI components integrated with real-time weight updates
- WebSocket message protocol documented in `docs/frontend-integration.md`