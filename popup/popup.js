// popup/popup.js - Popup Controller

document.addEventListener("DOMContentLoaded", async () => {
  const originToggle = document.getElementById("originToggle");
  const statusDot = document.getElementById("statusDot");
  const originUrlEl = document.getElementById("originUrl");
  const reloadNotice = document.getElementById("reloadNotice");
  const rateSlider = document.getElementById("rateSlider");
  const rateDisplay = document.getElementById("rateDisplay");
  const overflowSelect = document.getElementById("overflowSelect");
  const droppedCountEl = document.getElementById("droppedCount");
  const inspectorTableBody = document.getElementById("inspectorTableBody");
  const btnPanic = document.getElementById("btnPanic");
  const btnReloadTab = document.getElementById("btnReloadTab");
  const btnExport = document.getElementById("btnExport");
  const btnImport = document.getElementById("btnImport");
  const importFile = document.getElementById("importFile");
  const presetBtns = document.querySelectorAll(".btn-preset");

  let currentOrigin = null;
  let activeTabId = null;
  let currentProfile = {
    rate: 1.0,
    allowlist: [],
    overflowPolicy: "catch-up",
    enabled: false
  };

  // Get current tab origin
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && (tab.url.startsWith("http://") || tab.url.startsWith("https://"))) {
    activeTabId = tab.id;
    const urlObj = new URL(tab.url);
    currentOrigin = urlObj.origin;
    originUrlEl.textContent = currentOrigin;
  } else {
    originUrlEl.textContent = "Unsupported Page";
    originToggle.disabled = true;
    return;
  }

  // Load site status and profile from service worker
  const statusResponse = await chrome.runtime.sendMessage({
    type: "GET_SITE_STATUS",
    origin: currentOrigin
  });

  if (statusResponse) {
    currentProfile.enabled = !!statusResponse.enabled;
    if (statusResponse.profile) {
      currentProfile = { ...currentProfile, ...statusResponse.profile };
    }
  }

  // Update UI State
  updateUIState();

  function updateUIState() {
    originToggle.checked = currentProfile.enabled;
    if (currentProfile.enabled) {
      statusDot.classList.add("active");
    } else {
      statusDot.classList.remove("active");
    }

    rateSlider.value = currentProfile.rate;
    rateDisplay.textContent = parseFloat(currentProfile.rate).toFixed(2) + "x";
    overflowSelect.value = currentProfile.overflowPolicy || "catch-up";

    // Preset button active states
    presetBtns.forEach((btn) => {
      const btnRate = parseFloat(btn.dataset.rate);
      if (Math.abs(btnRate - currentProfile.rate) < 0.01) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });
  }

  // Handle Origin Enable Toggle
  originToggle.addEventListener("change", async () => {
    const isEnabling = originToggle.checked;

    if (isEnabling) {
      try {
        const granted = await chrome.permissions.request({
          origins: [`${currentOrigin}/*`]
        });

        if (!granted) {
          originToggle.checked = false;
          return;
        }

        await chrome.runtime.sendMessage({
          type: "ENABLE_ORIGIN",
          origin: currentOrigin
        });

        currentProfile.enabled = true;
        statusDot.classList.add("active");
        reloadNotice.classList.remove("hidden");
      } catch (err) {
        console.error("Permission request error:", err);
        originToggle.checked = false;
      }
    } else {
      await chrome.runtime.sendMessage({
        type: "DISABLE_ORIGIN",
        origin: currentOrigin
      });

      currentProfile.enabled = false;
      statusDot.classList.remove("active");
      reloadNotice.classList.add("hidden");
    }

    sendProfileToTab();
  });

  // Slider Input Handler
  rateSlider.addEventListener("input", (e) => {
    currentProfile.rate = parseFloat(e.target.value);
    rateDisplay.textContent = currentProfile.rate.toFixed(2) + "x";
    updateUIState();
    sendProfileToTab();
  });

  // Preset Buttons Click Handler
  presetBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      currentProfile.rate = parseFloat(btn.dataset.rate);
      updateUIState();
      sendProfileToTab();
    });
  });

  // Overflow Policy Change
  overflowSelect.addEventListener("change", (e) => {
    currentProfile.overflowPolicy = e.target.value;
    sendProfileToTab();
  });

  // Send Profile Config to Content Bridge
  async function sendProfileToTab() {
    if (!activeTabId) return;

    // Save to SW storage first
    await chrome.runtime.sendMessage({
      type: "SAVE_PROFILE",
      origin: currentOrigin,
      profile: currentProfile
    });

    // Send to Tab Content Bridge
    try {
      await chrome.tabs.sendMessage(activeTabId, {
        type: "UPDATE_CONFIG",
        config: currentProfile
      });
    } catch (e) {
      // Tab may not be injected yet
    }
  }

  // Reload Page Button Handler
  if (btnReloadTab) {
    btnReloadTab.addEventListener("click", () => {
      if (activeTabId) {
        chrome.tabs.reload(activeTabId);
        window.close();
      }
    });
  }

  // Panic Button Handler
  btnPanic.addEventListener("click", async () => {
    currentProfile.rate = 1.0;
    updateUIState();
    if (activeTabId) {
      try {
        await chrome.tabs.sendMessage(activeTabId, { type: "PANIC_FLUSH" });
      } catch (e) {}
    }
  });

  // Frame Inspector Live Poller
  async function pollMetrics() {
    if (!activeTabId || !currentProfile.enabled) return;

    try {
      const res = await chrome.tabs.sendMessage(activeTabId, { type: "GET_METRICS" });
      if (res && res.metrics) {
        // Proxy constructor confirmed active -> hide reload notice
        reloadNotice.classList.add("hidden");

        const { inspectorData = [], droppedFrames = 0, rate } = res.metrics;
        droppedCountEl.textContent = droppedFrames;

        if (typeof rate === "number" && Math.abs(rate - currentProfile.rate) > 0.01) {
          currentProfile.rate = rate;
          updateUIState();
        }

        renderInspectorTable(inspectorData);
      }
    } catch (e) {
      // Content script not loaded yet or tab refreshed
    }
  }

  function renderInspectorTable(events) {
    if (!events || events.length === 0) {
      inspectorTableBody.innerHTML = `<tr><td colspan="4" class="empty-state">Observing WebSocket events...</td></tr>`;
      return;
    }

    const allowSet = new Set(currentProfile.allowlist || []);
    let html = "";

    events.forEach((ev) => {
      const isChecked = allowSet.has(ev.name) ? "checked" : "";
      const typeBadge = ev.isBinary
        ? `<span class="type-tag binary">Binary</span>`
        : `<span class="type-tag string">String</span>`;

      html += `
        <tr>
          <td>
            <input type="checkbox" class="event-checkbox" data-event="${ev.name}" ${isChecked}>
          </td>
          <td title="${ev.sample || ''}">${ev.name}</td>
          <td>${typeBadge}</td>
          <td class="text-right font-mono">${ev.fps}</td>
        </tr>
      `;
    });

    inspectorTableBody.innerHTML = html;

    // Attach Checkbox Listeners
    const checkboxes = inspectorTableBody.querySelectorAll(".event-checkbox");
    checkboxes.forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const evName = e.target.dataset.event;
        const allowSet = new Set(currentProfile.allowlist || []);
        if (e.target.checked) {
          allowSet.add(evName);
        } else {
          allowSet.delete(evName);
        }
        currentProfile.allowlist = Array.from(allowSet);
        sendProfileToTab();
      });
    });
  }

  // Poll metrics every 800ms
  setInterval(pollMetrics, 800);
  pollMetrics();

  // Export Profile Handler
  btnExport.addEventListener("click", () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(currentProfile, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `ldpd_profile_${currentOrigin.replace(/[^a-z0-9]/gi, '_')}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  });

  // Import Profile Handler
  btnImport.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const imported = JSON.parse(evt.target.result);
        if (typeof imported.rate === "number" && Array.isArray(imported.allowlist)) {
          currentProfile = { ...currentProfile, ...imported };
          updateUIState();
          sendProfileToTab();
          alert("Profile successfully imported!");
        }
      } catch (err) {
        alert("Invalid profile JSON format.");
      }
    };
    reader.readAsText(file);
  });
});
