┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   API Endpoint  │───▶│  Main Process    │───▶│  RDU Displays   │
│  192.168.4.151  │    │  (main.js)       │    │  (Serial/TCP)   │
│   :3031/weights │    │                  │    │                 │
└─────────────────┘    │  - Fetches API   │    └─────────────────┘
                       │  - Processes     │
                       │  - Sends to RDUs │
                       │  - Sends to UI   │
                       └──────────────────┘
                                  │
                                  ▼
┌─────────────────┐    ┌──────────────────┐
│   Renderer      │◀───│  HTML/JavaScript │
│   Process       │    │  (index.html)    │
│                 │    │                  │
│ - Displays UI   │    │ - Event listener │
│ - Updates DOM   │    │ - Updates display│
└─────────────────┘    └──────────────────┘