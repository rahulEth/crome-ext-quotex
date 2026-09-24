# PRD — Live Data Playback Delay (Chrome Extension) — Engine.IO v3 (Socket.IO)

---

## 1. Executive Summary

This document specifies the Product Requirements and Technical Architecture for the Chrome Extension **Live Data Playback Delay**, scoped exclusively to **Engine.IO v3 (Socket.IO v2.x)** WebSocket connections (e.g., `wss://ws2.qxbroker.com/socket.io/?EIO=3&transport=websocket`).

The extension allows users to slow down live streaming chart ticks, quote updates, and market depth changes by delaying selected WebSocket frames in the browser before delivering them to page event listeners.

---

## 2. Scope

### In-Scope
- **Protocol**: Engine.IO v3 (EIO=3) / Socket.IO v2.x over WebSocket (`transport=websocket`).
- **Frame Types**:
  - Standard JSON text events (`42["<event>", ...]`).
  - Binary attachment placeholder events (e.g., `451-["<event>", {_placeholder: true, num: 0}]` followed by binary frame starting with byte `0x04`).
- **Features**:
  - Playback slowdown (0.1x to 1.0x rate).
  - Selective event allowlisting (fail-open by default).
  - In-page live Frame Inspector.
  - Per-origin persisted profiles.
  - Safety & recovery mechanisms (Panic key, Watchdog, Tab Visibility flushing).

### Out-of-Scope
- Engine.IO v4 / Socket.IO v3+ or v4+.
- Raw non-Socket.IO WebSockets.
- XHR / Long-polling HTTP transports.
- Fast-forward or reverse playback beyond live data.
- Payload contents modification.

---

## 3. Architecture & Protocol Engineering (Engine.IO v3)

### 3.1 Extension Context & Dynamic Script Injection
- **Manifest V3**: Uses `activeTab`, `scripting`, `storage`, and `optional_host_permissions`.
- **Dynamic MAIN-World Injection**: Scripts (`inject.js`) are dynamically registered into the target page's `MAIN` world at `document_start` upon explicit user permission grant for the origin.
- **Reload Requirement**: A tab reload is prompted after enabling so the WebSocket proxy constructor intercepts native `WebSocket` calls prior to application startup.

```json
{
  "manifest_version": 3,
  "name": "Live Data Playback Delay",
  "version": "2.0.0",
  "minimum_chrome_version": "120",
  "permissions": ["storage", "scripting", "activeTab"],
  "optional_host_permissions": ["*://*/*"],
  "action": { "default_popup": "popup.html" },
  "background": { "service_worker": "sw.js" }
}
```

### 3.2 Engine.IO v3 Protocol Analysis & Frame Classification

#### 3.2.1 Handshake & Heartbeat Mechanics (Client-Driven)
In Engine.IO v3 (`EIO=3`):
- Connection URL: `wss://ws2.qxbroker.com/socket.io/?EIO=3&transport=websocket`
- **Client-Driven Ping/Pong**:
  - The **client** periodically sends Ping (`2`).
  - The **server** responds immediately with Pong (`3`).
- **Critical Bypass Requirement**: Engine.IO control frames (packets starting with `0`, `1`, `2`, `3`, `5`, `6`) MUST pass through immediately without queuing or delay. Buffering a server Pong (`3`) or delaying client Ping (`2`) will cause Engine.IO client keepalive timeouts (`pingTimeout`) and force disconnects.

#### 3.2.2 Frame Format & Parsing Specifications (Based on Live QXBroker Stream)

1. **Engine.IO Control & Non-Event Frames (Pass-Through Immediately)**:
   - Packet prefix `0` (Open handshake: `0{"sid":..., "pingInterval":25000, "pingTimeout":60000}`).
   - Packet prefix `1` (Close).
   - Packet prefix `2` (Ping).
   - Packet prefix `3` (Pong).
   - Packet prefix `5` (Upgrade).
   - Packet prefix `6` (Noop).

2. **Standard Socket.IO Text Events (`42...`)**:
   - Format: `42["<event_name>", payload_data]`
   - Example: `42["quote", {"asset":"EURUSD_otc","bid":1.08452}]`
   - Classification: Extracted event name `"quote"` is checked against user allowlist.

3. **Socket.IO v2 Binary Placeholder Events (QXBroker / QXBroker Format)**:
   - **Text Placeholder Frame Format**: `45<attachments_count>-["<event_name>", {_placeholder: true, num: <index>}]` or `51-["<event_name>", ...]`.
     - Example text frames from QXBroker stream:
       - `451-["quotes/stream", {_placeholder: true, num: 0}]`
       - `451-["depth/change", {_placeholder: true, num: 0}]`
   - **Binary Attachment Frame Format**:
     - ArrayBuffer / Blob message starting with byte `0x04` (EIO v3 binary payload marker `4`).
     - UTF-8 payload embedded inside the binary message:
       - Raw Hex: `04 5b 5b 22 45 55 52 43 48 46 22 2c 31 37 39 30 32 36 35 39 37 39 2e 32 31 34 2c 30 2e 39 34 32 32 32 2c 31 5d 5d`
       - Decoded String: `\x04[["EURCHF",1790265979.214,0.94222,1]]`
   - **Classification & Pairing**:
     - Placeholder text frame specifies the event name (e.g. `"quotes/stream"`, `"depth/change"`) and count of expected binary attachments (e.g. `1`).
     - If the event is in the user allowlist, the placeholder text frame AND the subsequent binary attachment frame(s) are grouped together as a **Compound Event Pair** and queued as a single entity.

---

### 3.3 Compound Queueing & Pacing Engine

```
       Incoming WebSocket Frames
                  │
   ┌──────────────┴──────────────┐
   │ Is EIO v3 Control Frame?    ├─ YES ──> Pass Through Immediately (Fail-Open)
   │ (Types 0, 1, 2, 3, 5, 6)    │
   └──────────────┬──────────────┘
                  │ NO
   ┌──────────────┴──────────────┐
   │ Is Event in Allowlist?      ├─ NO  ──> Pass Through Immediately
   │ (String 42.. / Binary 45..) │
   └──────────────┬──────────────┘
                  │ YES
   ┌──────────────┴──────────────┐
   │  Enqueue Compound Packet    │
   │ (Text frame + Binary attachment)
   └──────────────┬──────────────┘
                  │
   ┌──────────────┴──────────────┐
   │  rAF Pacing Release Engine  │
   │ (Inter-arrival gap × 1/rate)│
   └──────────────┬──────────────┘
                  │
   Emit sequentially to Application Handlers
```

1. **Atomic Grouping**: A binary event (placeholder text packet + binary frame `0x04...`) is treated atomically in the queue to maintain strict Socket.IO attachment state sequencing.
2. **Time Stretching**: Pending queue items are assigned target delivery timestamps:
   $$T_{\text{scheduled\_due}} = T_{\text{last\_emitted}} + \Delta t_{\text{arrival}} \times \left(\frac{1}{\text{rate}}\right)$$
3. **Queue Limits & Overflow Policy**:
   - Maximum lag duration: **60 seconds**.
   - Maximum queue depth: **10,000 frames**.
   - Overflow modes:
     - **Catch-up** (rescale pending due-times to drain smoothly).
     - **Drop-oldest** (discard oldest non-control queued frames).

---

## 4. Safety & Recovery Mechanisms

| Mechanism | Trigger / Condition | Action |
|---|---|---|
| **Panic Key** | User presses `Alt+Shift+0` | Instantly flushes pending queue, resets rate to `1.0x`, and passes frames natively. |
| **Disconnect Watchdog** | 2 socket disconnects within 60 seconds while active | Auto-disables extension on origin, displays warning toast: *"Connection unstable; playback delay disabled."* |
| **Dead-man Switch** | Queue pump inactive for > 2000ms | Immediately flushes queued items to avoid massive backlog spikes after freeze. |
| **Tab Visibility Guard** | Tab state changes to `hidden` (`visibilitychange`) | Switches pump to background timer or flushes queue; prevents memory leakage and infinite backlog buildup in hidden tabs. |

---

## 5. User Experience & Interface Design

### 5.1 Extension Popup UI
- **Origin Enabling**: Opt-in toggle with origin display and "Reload Required" warning badge.
- **Frame Inspector Table**:
  - Columns: Event Name, FPS (frames/sec), Payload Sample / Type (`String` vs `Binary`), Allowlist Checkbox.
  - Detected events (e.g. `quote`, `quotes/stream`, `depth/change`, `live-deal`).
- **Playback Rate Slider**: `0.1x` to `1.0x` (step `0.05`, quick presets `0.25x`, `0.5x`, `1.0x`).
- **Status Dashboard**: Current Lag (s), Queue Depth, Dropped Frame Count, Connection Status (`EIO=3 Active`).

### 5.2 Mandatory In-Page Delay Banner
Whenever active delay exceeds **1.0 second**, an overlay banner is rendered in the target tab:
> ⚠️ **Playback Delayed by N.N s — Data is Not Live**

---

## 6. Functional Requirements (FR)

| ID | Requirement | Priority |
|---|---|---|
| **FR-1** | Explicit host permission requirement per origin before injecting proxy code. | P0 |
| **FR-2** | EIO v3 control frames (`0`, `1`, `2`, `3`, `5`, `6`) pass through untouched without delay. | P0 |
| **FR-3** | Support standard text events (`42["<event>", ...]`) allowlisting & queuing. | P0 |
| **FR-4** | Support binary placeholder events (`451-["<event>", ...]` + binary `0x04...`) compound queueing. | P0 |
| **FR-5** | Empty allowlist by default (fail-open mode with 0ms added latency). | P0 |
| **FR-6** | Panic key (`Alt+Shift+0`) flushes queue in < 100ms and sets rate to 1.0x. | P0 |
| **FR-7** | Watchdog auto-disables delay upon detecting socket instability (2 drops / 60s). | P0 |
| **FR-8** | Mandatory in-page overlay banner visible whenever delay > 1.0s. | P0 |
| **FR-9** | Live Frame Inspector lists active EIO v3 string and binary events with real-time FPS. | P1 |
| **FR-10** | Tab backgrounding flushes/drains queue to prevent background memory growth. | P1 |

---

## 7. Test Plan

| Test Case | Environment | Protocol / Message Payload | Pass Criteria |
|---|---|---|---|
| **T1: EIO v3 Ping/Pong Stability** | Test Harness | `EIO=3` stream with `2` (ping) / `3` (pong) at 0.1x speed | Zero socket drops over 30 mins; ping/pong timing unaffected. |
| **T2: String Event Slowdown** | Test Harness | `42["quote", {"bid":1.0845}]` at 0.5x rate | Events delivered at exactly 2x inter-arrival interval; JSON intact. |
| **T3: Binary Event Slowdown** | Test Harness / QXBroker | `451-["quotes/stream", {_placeholder:true, num:0}]` + `0x04[["EURCHF",1790...]]` | Binary frame paired with header; emitted in correct sequence with delay. |
| **T4: Panic Flush** | Live Page | 30s accumulated queue, press `Alt+Shift+0` | Queue cleared, rate set to 1.0x, visual chart returns to live immediately. |
| **T5: Fail-Open Verification** | Live Page | Unallowed event `live-deal` alongside allowed `quote` | `live-deal` passes instantly; `quote` is delayed. |

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Desynchronization of binary attachment frames | High | Compound queueing: pair header placeholder text frame and binary attachment frame into a single atomic queue entry. |
| Engine.IO v3 ping timeout disconnects | High | Strict pass-through whitelist for EIO control frames (`2`, `3`). |
| Memory buildup in hidden tabs | High | Tab visibility listener auto-flushes on tab hide. |
| User confusion regarding stale chart data | High | Non-dismissable delay banner when delay > 1.0s. |

---

## 9. Milestones

| Milestone | Target Deliverable |
|---|---|
| **M1** | Dynamic script injection & MAIN world WebSocket interceptor for EIO v3 (`EIO=3`). |
| **M2** | Frame parser for EIO v3 string events (`42`) and binary placeholder events (`451-` + `0x04`). |
| **M3** | Compound queueing engine, rAF release scheduler, panic key (`Alt+Shift+0`). |
| **M4** | Frame Inspector UI & per-origin allowlist management. |
| **M5** | Safety mechanisms (Watchdog, Dead-man switch, Tab visibility guard, In-page banner). |
| **M6** | Test execution on EIO v3 test harness & QXBroker socket validation. |


