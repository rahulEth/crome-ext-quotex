// content/inject.js - MAIN World WebSocket Interceptor & EIO v3 Playback Delay Engine

(function () {
  if (window.__LDPD_INJECTED__) return;
  window.__LDPD_INJECTED__ = true;

  console.log("[LDPD Inject] Initializing Engine.IO v3 Playback Delay Shim...");

  // State Configuration
  const state = {
    rate: 1.0,                       // 0.1x to 1.0x
    allowlist: new Set(),            // Set of event names to delay
    overflowPolicy: "catch-up",       // "catch-up" | "drop-oldest"
    enabled: true,                   // Master toggle
    panic: false,                    // Panic mode active
    
    // Safety & Metrics
    disconnectHistory: [],           // Timestamps of disconnects
    watchdogTriggered: false,
    lastPumpTime: performance.now(),
    droppedFrames: 0,
    
    // Frame Inspector FPS Tracking
    eventStats: new Map()            // eventName -> { count, lastSeen, sample, isBinary }
  };

  // Create UI Banner Container
  let bannerElement = null;
  function updateBanner(lagSeconds) {
    if (lagSeconds > 1.0 && !state.panic && state.enabled && state.allowlist.size > 0) {
      if (!bannerElement) {
        bannerElement = document.createElement("div");
        bannerElement.id = "ldpd-delay-banner";
        bannerElement.className = "ldpd-banner-visible";
        document.body ? document.body.appendChild(bannerElement) : document.documentElement.appendChild(bannerElement);
      }
      bannerElement.textContent = `⚠️ Playback Delayed by ${lagSeconds.toFixed(1)}s — Data is Not Live`;
    } else if (bannerElement) {
      bannerElement.remove();
      bannerElement = null;
    }
  }

  // Panic Key Handler (Alt + Shift + 0)
  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && e.code === "Digit0") {
      e.preventDefault();
      triggerPanic();
    }
  });

  function triggerPanic() {
    console.warn("[LDPD Panic] Panic key triggered! Flushing queue & restoring 1.0x native pass-through.");
    state.panic = true;
    state.rate = 1.0;
    updateBanner(0);
    // Flush all socket queues
    for (const ws of activeSockets) {
      ws.__ldpd_flushQueue();
    }
  }

  // Event Statistics Collector (for Frame Inspector)
  function recordEventStat(eventName, samplePayload, isBinary = false) {
    const now = performance.now();
    let stat = state.eventStats.get(eventName);
    if (!stat) {
      stat = { count: 0, firstSeen: now, lastSeen: now, sample: "", isBinary };
      state.eventStats.set(eventName, stat);
    }
    stat.count++;
    stat.lastSeen = now;
    if (samplePayload) {
      stat.sample = typeof samplePayload === "string" ? samplePayload.substring(0, 80) : "[Binary Data]";
    }
  }

  // Broadcast Metrics to ISOLATED Bridge
  setInterval(() => {
    const now = performance.now();
    const inspectorData = [];
    
    for (const [name, stat] of state.eventStats.entries()) {
      // Calculate FPS over active window
      const timeSpan = (now - stat.firstSeen) / 1000;
      const fps = timeSpan > 0 ? (stat.count / Math.max(1, timeSpan)).toFixed(1) : "0.0";
      inspectorData.push({
        name,
        fps: parseFloat(fps),
        sample: stat.sample,
        isBinary: stat.isBinary
      });
    }

    // Reset counts periodically for rolling FPS
    for (const stat of state.eventStats.values()) {
      stat.count = 0;
      stat.firstSeen = now;
    }

    window.dispatchEvent(new CustomEvent("__ldpd_metrics_response__", {
      detail: {
        inspectorData,
        droppedFrames: state.droppedFrames,
        rate: state.rate,
        panic: state.panic,
        allowlist: Array.from(state.allowlist)
      }
    }));
  }, 1000);

  // Profile Update Listener from ISOLATED Bridge
  window.addEventListener("__ldpd_config_update__", (e) => {
    const { rate, allowlist, overflowPolicy, enabled } = e.detail;
    if (typeof rate === "number") state.rate = Math.max(0.1, Math.min(1.0, rate));
    if (Array.isArray(allowlist)) state.allowlist = new Set(allowlist);
    if (overflowPolicy) state.overflowPolicy = overflowPolicy;
    if (typeof enabled === "boolean") state.enabled = enabled;
    if (state.panic && rate === 1.0) state.panic = false;
    console.log("[LDPD Inject] Profile updated:", { rate: state.rate, allowlist: Array.from(state.allowlist), policy: state.overflowPolicy });
  });

  // Track active WebSockets
  const activeSockets = new Set();
  const NativeWebSocket = window.WebSocket;

  // Proxy WebSocket Constructor
  function LDPDWebSocket(url, protocols) {
    const ws = protocols ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
    activeSockets.add(ws);

    // Queue & Engine.IO v3 State per WebSocket
    const queue = [];
    let isPendingBinaryAttachment = false;
    let pendingBinaryHeader = null; // Stored placeholder text frame
    let lastNativeArrivalTime = 0;
    let lastScheduledEmitTime = 0;

    // Custom Message Handlers Storage
    let customOnMessage = null;
    const messageListeners = new Set();

    // Hook onmessage property
    Object.defineProperty(ws, "onmessage", {
      get() { return customOnMessage; },
      set(fn) { customOnMessage = fn; }
    });

    // Hook addEventListener
    const nativeAddEventListener = ws.addEventListener.bind(ws);
    const nativeRemoveEventListener = ws.removeEventListener.bind(ws);

    ws.addEventListener = function (type, listener, options) {
      if (type === "message" && typeof listener === "function") {
        messageListeners.add(listener);
      }
      return nativeAddEventListener(type, listener, options);
    };

    ws.removeEventListener = function (type, listener, options) {
      if (type === "message") {
        messageListeners.delete(listener);
      }
      return nativeRemoveEventListener(type, listener, options);
    };

    // Dispatcher function to application code
    function emitMessageToApp(event) {
      if (typeof customOnMessage === "function") {
        try { customOnMessage.call(ws, event); } catch (err) { console.error("[LDPD] Error in application onmessage handler:", err); }
      }
      for (const listener of messageListeners) {
        try { listener.call(ws, event); } catch (err) { console.error("[LDPD] Error in application message listener:", err); }
      }
    }

    // Flush pending queue helper
    ws.__ldpd_flushQueue = function () {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item.type === "compound") {
          for (const ev of item.events) emitMessageToApp(ev);
        } else {
          emitMessageToApp(item.event);
        }
      }
    };

    // Queue Pacing Pump (rAF)
    function pumpQueue() {
      const now = performance.now();
      state.lastPumpTime = now;

      // Dead-man check: flush if pump stalled > 2000ms
      if (now - state.lastPumpTime > 2000 && queue.length > 0) {
        console.warn("[LDPD Dead-man] Pump stalled > 2000ms. Flushing queue.");
        ws.__ldpd_flushQueue();
      }

      // Check current lag duration
      if (queue.length > 0) {
        const oldestItem = queue[0];
        const lagMs = now - oldestItem.nativeTime;
        updateBanner(lagMs / 1000);

        // Check Hard Queue Ceiling (10,000 items or 60s max lag)
        if (queue.length > 10000 || lagMs > 60000) {
          if (state.overflowPolicy === "drop-oldest") {
            const dropped = queue.shift();
            state.droppedFrames += (dropped.type === "compound" ? dropped.events.length : 1);
          } else {
            // Catch-up policy: rescale pending due times to drain over 5 seconds
            const drainDuration = 5000;
            const step = drainDuration / queue.length;
            for (let i = 0; i < queue.length; i++) {
              queue[i].scheduledTime = now + (i * step);
            }
          }
        }
      } else {
        updateBanner(0);
      }

      // Process due items
      while (queue.length > 0 && queue[0].scheduledTime <= now) {
        const item = queue.shift();
        if (item.type === "compound") {
          for (const ev of item.events) emitMessageToApp(ev);
        } else {
          emitMessageToApp(item.event);
        }
      }

      if (ws.readyState === NativeWebSocket.OPEN || queue.length > 0) {
        requestAnimationFrame(pumpQueue);
      }
    }

    // Tab visibility handling
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && queue.length > 0) {
        // Drain queue when tab is backgrounded to prevent infinite buildup
        ws.__ldpd_flushQueue();
      }
    });

    // Native Message Interceptor
    nativeAddEventListener("message", (nativeEvent) => {
      const now = performance.now();

      // If panic mode or disabled or rate === 1.0x, pass through directly
      if (state.panic || !state.enabled || state.rate >= 0.99) {
        emitMessageToApp(nativeEvent);
        return;
      }

      const data = nativeEvent.data;

      // -------------------------------------------------------------
      // 1. BINARY ATTACHMENT FRAME CHECK (EIO v3 binary payload byte 0x04)
      // -------------------------------------------------------------
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data) || data instanceof Blob) {
        if (isPendingBinaryAttachment && pendingBinaryHeader) {
          // Compound pair complete!
          const headerEv = pendingBinaryHeader.event;
          const eventName = pendingBinaryHeader.eventName;

          recordEventStat(eventName, "[Binary Attachment]", true);

          if (state.allowlist.has(eventName)) {
            // Queue atomic compound pair
            const nativeGap = lastNativeArrivalTime ? (now - lastNativeArrivalTime) : 0;
            lastNativeArrivalTime = now;
            const stretchedGap = nativeGap * (1 / state.rate);
            const scheduledTime = Math.max(now, lastScheduledEmitTime + stretchedGap);
            lastScheduledEmitTime = scheduledTime;

            queue.push({
              type: "compound",
              events: [headerEv, nativeEvent],
              nativeTime: now,
              scheduledTime
            });
          } else {
            // Event not in allowlist -> Pass both through immediately
            emitMessageToApp(headerEv);
            emitMessageToApp(nativeEvent);
          }

          // Reset pending state
          isPendingBinaryAttachment = false;
          pendingBinaryHeader = null;
          return;
        }

        // If unexpected binary frame, pass through immediately (fail-open)
        emitMessageToApp(nativeEvent);
        return;
      }

      // -------------------------------------------------------------
      // 2. TEXT FRAME PARSING (Engine.IO v3 & Socket.IO v2)
      // -------------------------------------------------------------
      if (typeof data === "string") {
        // Engine.IO Control Packets: 0 (open), 1 (close), 2 (ping), 3 (pong), 5 (upgrade), 6 (noop)
        const eioType = data.charAt(0);
        if (["0", "1", "2", "3", "5", "6"].includes(eioType)) {
          // Pass control packets through IMMEDIATELY (prevents keepalive pingTimeout disconnects)
          emitMessageToApp(nativeEvent);
          return;
        }

        // Engine.IO Message Packet (Type 4)
        if (eioType === "4") {
          const eioBody = data.substring(1);

          // Socket.IO Text Event: 42["<event>", ...]
          if (eioBody.startsWith("2[")) {
            try {
              const parsed = JSON.parse(eioBody.substring(1));
              const eventName = parsed[0];
              recordEventStat(eventName, eioBody, false);

              if (state.allowlist.has(eventName)) {
                // Calculate stretched target time
                const nativeGap = lastNativeArrivalTime ? (now - lastNativeArrivalTime) : 0;
                lastNativeArrivalTime = now;
                const stretchedGap = nativeGap * (1 / state.rate);
                const scheduledTime = Math.max(now, lastScheduledEmitTime + stretchedGap);
                lastScheduledEmitTime = scheduledTime;

                queue.push({
                  type: "single",
                  event: nativeEvent,
                  nativeTime: now,
                  scheduledTime
                });
                return;
              }
            } catch (e) {
              // Fail-open on parse error
            }
          }

          // Socket.IO Binary Event Placeholder: 45<count>-["<event>", {_placeholder: true}] or 51-["<event>", ...]
          if (eioBody.startsWith("5") || /^5\d+-/.test(eioBody)) {
            try {
              const dashIdx = eioBody.indexOf("-");
              if (dashIdx !== -1) {
                const jsonPart = eioBody.substring(dashIdx + 1);
                const parsed = JSON.parse(jsonPart);
                const eventName = parsed[0];
                recordEventStat(eventName, jsonPart, true);

                // Hold header frame, wait for binary attachment frame in next WS message
                isPendingBinaryAttachment = true;
                pendingBinaryHeader = { event: nativeEvent, eventName };
                return;
              }
            } catch (e) {
              // Fail-open on parse error
            }
          }
        }
      }

      // Fail-open: pass through any unknown string frame immediately
      emitMessageToApp(nativeEvent);
    });

    // Monitor socket close for Watchdog
    ws.addEventListener("close", () => {
      activeSockets.delete(ws);
      const now = performance.now();
      state.disconnectHistory.push(now);

      // Clean history > 60s
      state.disconnectHistory = state.disconnectHistory.filter((t) => now - t <= 60000);

      if (state.disconnectHistory.length >= 2 && state.enabled && !state.watchdogTriggered) {
        state.watchdogTriggered = true;
        state.enabled = false;
        console.warn("[LDPD Watchdog] 2 disconnects within 60s detected while active. Disabling playback delay for safety.");
        alert("⚠️ Live Data Playback Delay Watchdog: Connection drops detected. Throttling has been auto-disabled for this origin.");
      }
    });

    // Start rAF pump
    requestAnimationFrame(pumpQueue);

    return ws;
  }

  // Copy static properties & prototype chain
  LDPDWebSocket.prototype = NativeWebSocket.prototype;
  LDPDWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  LDPDWebSocket.OPEN = NativeWebSocket.OPEN;
  LDPDWebSocket.CLOSING = NativeWebSocket.CLOSING;
  LDPDWebSocket.CLOSED = NativeWebSocket.CLOSED;

  // Replace native WebSocket constructor
  window.WebSocket = LDPDWebSocket;

  console.log("[LDPD Inject] WebSocket shim successfully hooked in MAIN world.");
})();
