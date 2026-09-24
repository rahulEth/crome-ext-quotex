# RDP — Live Data Playback Delay Development Plan (Chrome Extension v2.0)

This development plan details the phased execution of the Live Data Playback Delay Chrome Extension, scoped exclusively to **Engine.IO v3 (Socket.IO v2.x)** based on [PRD-playback-delay-v2-third-party.md](./PRD-playback-delay-v2-third-party.md).

---

## 1. System Architecture & File Structure

```
crome-extension/
├── manifest.json                  # Manifest V3 (Dynamic registration, runtime permissions)
├── background/
│   └── sw.js                      # Background service worker (permissions & dynamic script management)
├── content/
│   ├── inject.js                  # MAIN world WebSocket shim, compound queue engine, EIO v3 protocol parser
│   ├── bridge.js                  # ISOLATED world bridge between MAIN world and extension runtime
│   └── banner.css                 # In-page delay banner styling
├── popup/
│   ├── popup.html                 # Extension popup UI
│   ├── popup.css                  # Modern dark-mode UI styles
│   └── popup.js                   # Popup controller (inspector, slider, presets, export/import)
├── harness/                       # Test harness for local verification (PRD §7)
│   ├── server.js                  # Node server providing Engine.IO v3 string & binary placeholder endpoints
│   ├── index.html                 # Test harness UI with live charts/counters & automated tests
│   └── package.json               # Test harness dependencies
└── icons/                         # Extension icons (16, 32, 48, 128)
```

---

## 2. Core Architecture Specifications

### 2.1 Manifest & Permissions
- **Manifest Version**: 3
- **Permissions**: `storage`, `scripting`, `activeTab`
- **Optional Host Permissions**: `*://*/*` (Granted dynamically per site)
- **Zero Static Injections**: No content scripts are injected until the user grants permission for a specific origin.
- **Dynamic Registration**: On grant, `sw.js` registers:
  1. `content/inject.js` in `world: "MAIN"`, `runAt: "document_start"`, `allFrames: true`.
  2. `content/bridge.js` in `world: "ISOLATED"`, `runAt: "document_start"`, `allFrames: true`.

### 2.2 Engine.IO v3 Protocol Engine & Frame Classification (Fail-Open)
- **Engine.IO v3 Heartbeat Mechanics**:
  - Connection URL: `wss://ws2.qxbroker.com/socket.io/?EIO=3&transport=websocket`
  - Client sends ping (`2`), server responds with pong (`3`).
  - **Pass-through immediately**: Engine.IO control packets `0` (open), `1` (close), `2` (ping), `3` (pong), `5` (upgrade), `6` (noop). Buffer bypass guarantees no client keepalive timeout (`pingTimeout`) disconnects.
- **Supported Socket.IO v2 Event Types**:
  1. **Standard Text Events (`42...`)**:
     - Format: `42["<event_name>", payload_data]`
     - Checked against user allowlist.
  2. **Binary Placeholder Events (`451-...` / `51-...` + Binary Attachment `0x04...`)**:
     - Placeholder text frame format: `451-["<event_name>", {_placeholder: true, num: 0}]` (e.g. `"quotes/stream"`, `"depth/change"`).
     - Attachment binary frame format: ArrayBuffer message starting with byte `0x04` containing encoded payload string like `\x04[["EURCHF",1790265979.214,0.94222,1]]`.
     - **Compound Queueing**: Header text frame and binary attachment frame are paired and enqueued atomically as a single compound entry.
- **Pass-through immediately (Fail-Open)**:
  - Malformed or unparseable frames
  - Non-event Socket.IO packets (CONNECT, DISCONNECT, ACK, ERROR)
  - Events whose names are not in the profile's allowlist
- **Default Allowlist**: Empty. Zero delay out of the box until user selects events.

### 2.3 Queue, Timing & Overflow Policies
- **Time Dilation**: Original inter-arrival intervals stretched by `1/rate` (`0.1x` – `1.0x`).
- **Strict FIFO**: Strict ordering preserved, no duplication, no reordering.
- **Hard Caps**: 60s max lag, 10,000 items hard queue ceiling.
- **Overflow Policies**:
  - `catch-up`: Rescales pending timestamps to drain smoothly over ≥5s without burst dump.
  - `drop-oldest`: Drops oldest queued frames and increments dropped counter.
- **Pump**: Native `requestAnimationFrame` with fallback to `setTimeout` on tab visibility change or dead-man trigger.

### 2.4 Safety Mechanisms (PRD §4)
1. **Panic Key (`Alt+Shift+0`)**: In-page key handler that flushes queue instantly, resets rate to `1.0x`, and passes all frames immediately (<100ms response).
2. **Watchdog**: Detects if socket disconnects twice within 60s while throttled. Auto-disables throttling and alerts user.
3. **Dead-man Switch**: Flushes queue if pump fails to fire for 2000ms.
4. **Tab-Visibility Guard**: Switches to timer pump or flushes when tab is hidden (`document.visibilityState === 'hidden'`).
5. **Mandatory Delay Banner**: Floating non-dismissable banner when lag > 1s reading *"Delayed by N.Ns — not live"*.

---

## 3. Implementation Milestones

- [x] **M0: Planning & Specification**: PRD analysis and RDP documentation updated for Engine.IO v3.
- [ ] **M1: Manifest & Permissions Flow**: MV3 configuration, dynamic content script registration, permission grant/revoke workflow in `sw.js`.
- [ ] **M2: MAIN-World WebSocket Shim & EIO v3 Protocol Engine**: `window.WebSocket` hooking, EIO v3 detection, `42` text event parsing, `451-` + `0x04` binary attachment compound parser, fail-open paths.
- [ ] **M3: Virtual Clock Queue Engine**: Compound FIFO queue, rate stretching, catch-up/drop-oldest overflow policies, rAF pump.
- [ ] **M4: Safety Systems & In-Page Banner**: Panic key (`Alt+Shift+0`), watchdog, dead-man switch, visibility guard, delay banner (`banner.css`).
- [ ] **M5: Isolated Bridge & Communication**: Message passing between MAIN world, ISOLATED bridge, and extension popup.
- [ ] **M6: Extension Popup UI**: Dark-mode interface, active origin toggle, speed slider & presets, live metrics, frame inspector table, JSON profile export/import.
- [ ] **M7: Test Harness & Verification**: EIO v3 test server (supporting string and binary placeholder streams) and browser verification of T1–T5 test cases.

