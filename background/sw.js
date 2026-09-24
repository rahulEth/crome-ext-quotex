// background/sw.js - Service Worker for Live Data Playback Delay

const SCRIPT_MAIN_PREFIX = "ldpd_main_";
const SCRIPT_ISOLATED_PREFIX = "ldpd_iso_";

// Helper: sanitize origin string to valid content script ID
function originToId(origin) {
  return origin.replace(/[^a-zA-Z0-9_]/g, "_");
}

// Register dynamic content scripts for a granted origin
async function registerOriginScripts(origin) {
  const matchPattern = `${origin}/*`;
  const mainId = SCRIPT_MAIN_PREFIX + originToId(origin);
  const isoId = SCRIPT_ISOLATED_PREFIX + originToId(origin);

  // Unregister any pre-existing scripts for this origin first
  await unregisterOriginScripts(origin);

  try {
    await chrome.scripting.registerContentScripts([
      {
        id: mainId,
        matches: [matchPattern],
        js: ["content/inject.js"],
        world: "MAIN",
        runAt: "document_start",
        allFrames: true,
        persistAcrossSessions: true
      },
      {
        id: isoId,
        matches: [matchPattern],
        js: ["content/bridge.js"],
        world: "ISOLATED",
        runAt: "document_start",
        allFrames: true,
        persistAcrossSessions: true
      }
    ]);
    console.log(`[LDPD SW] Dynamic scripts registered for ${origin}`);
    return true;
  } catch (err) {
    console.error(`[LDPD SW] Registration failed for ${origin}:`, err);
    throw err;
  }
}

// Unregister dynamic content scripts for an origin
async function unregisterOriginScripts(origin) {
  const mainId = SCRIPT_MAIN_PREFIX + originToId(origin);
  const isoId = SCRIPT_ISOLATED_PREFIX + originToId(origin);

  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const idsToRemove = existing
      .filter((s) => s.id === mainId || s.id === isoId)
      .map((s) => s.id);

    if (idsToRemove.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: idsToRemove });
      console.log(`[LDPD SW] Dynamic scripts unregistered for ${origin}`);
    }
  } catch (err) {
    console.warn(`[LDPD SW] Error unregistering scripts for ${origin}:`, err);
  }
}

// Check if an origin currently has registered scripts
async function isOriginEnabled(origin) {
  const mainId = SCRIPT_MAIN_PREFIX + originToId(origin);
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    return existing.some((s) => s.id === mainId);
  } catch (err) {
    return false;
  }
}

// Handle runtime messages from popup and bridge
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handleAsync = async () => {
    switch (message.type) {
      case "ENABLE_ORIGIN": {
        const origin = message.origin;
        await registerOriginScripts(origin);
        // Save to active origins storage
        const { activeOrigins = {} } = await chrome.storage.local.get("activeOrigins");
        activeOrigins[origin] = true;
        await chrome.storage.local.set({ activeOrigins });
        return { success: true };
      }

      case "DISABLE_ORIGIN": {
        const origin = message.origin;
        await unregisterOriginScripts(origin);
        const { activeOrigins = {} } = await chrome.storage.local.get("activeOrigins");
        delete activeOrigins[origin];
        await chrome.storage.local.set({ activeOrigins });
        return { success: true };
      }

      case "GET_SITE_STATUS": {
        const origin = message.origin;
        const enabled = await isOriginEnabled(origin);
        const { profiles = {} } = await chrome.storage.local.get("profiles");
        const profile = profiles[origin] || {
          rate: 1.0,
          allowlist: [],
          overflowPolicy: "catch-up"
        };
        return { enabled, profile };
      }

      case "SAVE_PROFILE": {
        const { origin, profile } = message;
        const { profiles = {} } = await chrome.storage.local.get("profiles");
        profiles[origin] = profile;
        await chrome.storage.local.set({ profiles });
        return { success: true };
      }

      case "GET_PROFILES": {
        const { profiles = {} } = await chrome.storage.local.get("profiles");
        return { profiles };
      }

      default:
        return { error: "Unknown message type" };
    }
  };

  handleAsync().then(sendResponse).catch((err) => sendResponse({ error: err.message }));
  return true; // Keep channel open for async response
});

console.log("[LDPD SW] Background service worker initialized.");
