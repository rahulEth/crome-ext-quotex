// content/bridge.js - ISOLATED World Bridge between MAIN world and Chrome Extension Runtime

(function () {
  if (window.__LDPD_BRIDGE_LOADED__) return;
  window.__LDPD_BRIDGE_LOADED__ = true;

  console.log("[LDPD Bridge] Initializing ISOLATED world bridge...");

  const currentOrigin = window.location.origin;

  // 1. Send initial profile configuration to MAIN world script
  async function syncProfileToMainWorld() {
    try {
      const { profiles = {} } = await chrome.storage.local.get("profiles");
      const profile = profiles[currentOrigin] || {
        rate: 1.0,
        allowlist: [],
        overflowPolicy: "catch-up",
        enabled: true
      };

      window.dispatchEvent(new CustomEvent("__ldpd_config_update__", {
        detail: profile
      }));
    } catch (err) {
      console.error("[LDPD Bridge] Failed to sync profile to MAIN world:", err);
    }
  }

  // Initial sync once DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", syncProfileToMainWorld);
  } else {
    syncProfileToMainWorld();
  }

  // 2. Listen to metrics response from MAIN world inject.js and store/relay
  let latestMetrics = null;
  window.addEventListener("__ldpd_metrics_response__", (e) => {
    latestMetrics = e.detail;
  });

  // 3. Listen to extension runtime messages (from Popup / Service Worker)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "UPDATE_CONFIG") {
      // Forward new configuration to MAIN world script
      window.dispatchEvent(new CustomEvent("__ldpd_config_update__", {
        detail: message.config
      }));
      // Save profile to local storage
      chrome.storage.local.get("profiles", ({ profiles = {} }) => {
        profiles[currentOrigin] = message.config;
        chrome.storage.local.set({ profiles });
      });
      sendResponse({ success: true });
      return true;
    }

    if (message.type === "GET_METRICS") {
      sendResponse({ metrics: latestMetrics, origin: currentOrigin });
      return true;
    }

    if (message.type === "PANIC_FLUSH") {
      window.dispatchEvent(new CustomEvent("__ldpd_config_update__", {
        detail: { rate: 1.0, panic: true }
      }));
      sendResponse({ success: true });
      return true;
    }
  });

  console.log("[LDPD Bridge] ISOLATED world bridge ready.");
})();
