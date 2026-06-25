const DEFAULT_CONFIG = {
  apiBaseUrl: "http://localhost:8787",
  fillToken: "",
  qoyodBaseUrl: "https://www.qoyod.com",
  selectedBatchId: "",
  currentJob: null
};

const LOCAL_QOYOD_HOSTS = new Set(["localhost:5174", "127.0.0.1:5174"]);
const QOYOD_HOST_PATTERN = /(^|\.)qoyod\.com$/i;
const RECEIVER_ERROR_PATTERN = /Could not establish connection|Receiving end does not exist/i;

const fields = {
  status: document.getElementById("status"),
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  fillToken: document.getElementById("fillToken"),
  qoyodBaseUrl: document.getElementById("qoyodBaseUrl"),
  saveConfig: document.getElementById("saveConfig"),
  calibrate: document.getElementById("calibrate"),
  refreshBatches: document.getElementById("refreshBatches"),
  batchScope: document.getElementById("batchScope"),
  claim: document.getElementById("claim"),
  fill: document.getElementById("fill"),
  saveDraft: document.getElementById("saveDraft"),
  cancel: document.getElementById("cancel"),
  clearLog: document.getElementById("clearLog"),
  job: document.getElementById("job"),
  jobTitle: document.getElementById("jobTitle"),
  jobMeta: document.getElementById("jobMeta"),
  log: document.getElementById("log")
};

let state = { ...DEFAULT_CONFIG };

init();

async function init() {
  state = { ...DEFAULT_CONFIG, ...(await chrome.storage.local.get(DEFAULT_CONFIG)) };
  fields.apiBaseUrl.value = state.apiBaseUrl;
  fields.fillToken.value = state.fillToken;
  fields.qoyodBaseUrl.value = state.qoyodBaseUrl;
  await loadBatches();
  renderJob(state.currentJob);
  bind();
  note("Side panel ready.");
}

function bind() {
  fields.saveConfig.addEventListener("click", saveConfig);
  fields.refreshBatches.addEventListener("click", loadBatches);
  fields.batchScope.addEventListener("change", async () => {
    state.selectedBatchId = fields.batchScope.value;
    await chrome.storage.local.set({ selectedBatchId: state.selectedBatchId });
  });
  fields.calibrate.addEventListener("click", calibrate);
  fields.claim.addEventListener("click", claimNext);
  fields.fill.addEventListener("click", fillCurrentPage);
  fields.saveDraft.addEventListener("click", saveDraft);
  fields.cancel.addEventListener("click", cancelJob);
  fields.clearLog.addEventListener("click", () => {
    fields.log.textContent = "";
    fields.status.textContent = "Idle";
  });
}

async function saveConfig() {
  state = {
    ...state,
    apiBaseUrl: fields.apiBaseUrl.value.trim().replace(/\/$/, "") || DEFAULT_CONFIG.apiBaseUrl,
    fillToken: fields.fillToken.value,
    qoyodBaseUrl: fields.qoyodBaseUrl.value.trim().replace(/\/$/, "") || DEFAULT_CONFIG.qoyodBaseUrl,
    selectedBatchId: fields.batchScope.value
  };
  await chrome.storage.local.set(state);
  note("Configuration saved.");
}

async function loadBatches() {
  try {
    const body = await api("/api/batches");
    const current = state.selectedBatchId;
    fields.batchScope.innerHTML = '<option value="">Any ready invoice</option>';
    for (const batch of body.batches || []) {
      const option = document.createElement("option");
      option.value = batch.batchId;
      option.textContent = `${batch.name} (${batch.totalJobs})`;
      fields.batchScope.appendChild(option);
    }
    fields.batchScope.value = current || "";
  } catch (error) {
    note(`Batch list unavailable: ${error.message}`);
  }
}

async function claimNext() {
  await saveConfig();
  setBusy(true, "Claiming");
  try {
    const body = await api("/api/fill/jobs/claim-next", {
      method: "POST",
      body: JSON.stringify(state.selectedBatchId ? { batchId: state.selectedBatchId } : {})
    });
    if (!body.job) {
      state.currentJob = null;
      await chrome.storage.local.set({ currentJob: null });
      renderJob(null);
      note("No reviewed invoice is ready.");
      return;
    }

    state.currentJob = body.job;
    await chrome.storage.local.set({ currentJob: body.job });
    renderJob(body.job);
    note(`Claimed ${body.job.jobId}.`);
  } catch (error) {
    note(error.message);
  } finally {
    setBusy(false);
  }
}

async function calibrate() {
  await saveConfig();
  setBusy(true, "Connecting");
  try {
    const tab = await connectedQoyodTab();
    fields.status.textContent = "Calibrating";
    const response = await sendQoyodMessage(tab.id, {
      type: "QOYOD_START_CALIBRATION",
      qoyodBaseUrl: state.qoyodBaseUrl
    });
    if (!response?.ok) {
      throw codedError(response?.error || "Calibration failed.", response?.errorCode || "selector_calibration_failed");
    }
    note(response.message || "Calibration started.");
  } catch (error) {
    note(error.message);
  } finally {
    setBusy(false);
  }
}

async function fillCurrentPage() {
  if (!state.currentJob) return note("Claim a job first.");
  await saveConfig();

  setBusy(true, "Filling");
  try {
    const tab = await connectedQoyodTab();
    await api(`/api/fill/jobs/${state.currentJob.jobId}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "qoyod_filling", message: "Chrome extension side panel started filling Qoyod." })
    });

    const response = await sendQoyodMessage(tab.id, {
      type: "QOYOD_FILL_JOB",
      job: state.currentJob,
      config: {
        apiBaseUrl: state.apiBaseUrl,
        fillToken: state.fillToken,
        qoyodBaseUrl: state.qoyodBaseUrl
      }
    });

    if (!response?.ok) {
      throw codedError(response?.error || "Qoyod fill failed.", response?.errorCode || "selector_failure");
    }
    note(response.message || "Page filled. Review before saving draft.");
  } catch (error) {
    if (isConnectionOnlyError(error)) {
      note(error.message);
    } else {
      await reportError(error.message, error.errorCode || "selector_failure");
    }
  } finally {
    setBusy(false);
  }
}

async function saveDraft() {
  if (!state.currentJob) return note("Claim a job first.");
  setBusy(true, "Saving");
  try {
    const tab = await connectedQoyodTab();

    const response = await sendQoyodMessage(tab.id, { type: "QOYOD_SAVE_DRAFT" });
    if (!response?.ok) {
      await reportError(response?.error || "Draft save was cancelled.", response?.errorCode || "save_cancelled");
      return;
    }

    const body = await api(`/api/fill/jobs/${state.currentJob.jobId}/status`, {
      method: "POST",
      body: JSON.stringify({
        status: "draft_saved",
        qoyodDraftReference: response.reference || "",
        message: response.reference
          ? `Qoyod draft saved with reference ${response.reference}.`
          : "Qoyod draft save clicked; verify the draft in Qoyod."
      })
    });
    state.currentJob = null;
    await chrome.storage.local.set({ currentJob: null });
    renderJob(null);
    note(`Saved: ${body.job.status}.`);
  } catch (error) {
    if (isConnectionOnlyError(error)) {
      note(error.message);
    } else {
      await reportError(error.message, error.errorCode || "save_failed");
    }
  } finally {
    setBusy(false);
  }
}

async function cancelJob() {
  if (!state.currentJob) return;
  const body = await api(`/api/fill/jobs/${state.currentJob.jobId}/status`, {
    method: "POST",
    body: JSON.stringify({
      status: "ready_for_qoyod",
      message: "Chrome extension side panel fill was cancelled by the user."
    })
  });
  state.currentJob = null;
  await chrome.storage.local.set({ currentJob: null });
  renderJob(null);
  note(`Released ${body.job.jobId}.`);
}

async function reportError(message, errorCode) {
  note(message);
  if (!state.currentJob) return;
  await api(`/api/fill/jobs/${state.currentJob.jobId}/status`, {
    method: "POST",
    body: JSON.stringify({ status: "error", errorCode, message })
  }).catch((error) => note(error.message));
}

async function api(path, options = {}) {
  const response = await fetch(`${state.apiBaseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.fillToken ? { "x-fill-token": state.fillToken } : {}),
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed with ${response.status}`);
  }
  return response.json();
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function connectedQoyodTab() {
  const tab = await activeTab();
  if (!tab?.id) {
    throw codedError("Open a supported Qoyod bill page in the active tab first.", "qoyod_page_not_connected");
  }
  if (!isSupportedQoyodUrl(tab.url)) {
    throw codedError("Open a supported Qoyod bill page first: Qoyod HTTPS, localhost:5174, or 127.0.0.1:5174.", "qoyod_page_unsupported");
  }

  try {
    const response = await sendQoyodMessage(tab.id, { type: "QOYOD_PING", qoyodBaseUrl: state.qoyodBaseUrl });
    if (!response?.ok) {
      throw codedError(response?.error || "Qoyod page is not ready.", response?.errorCode || "qoyod_page_not_connected");
    }
    return tab;
  } catch (error) {
    if (!RECEIVER_ERROR_PATTERN.test(error.message)) throw error;
  }

  note(`Connecting to ${new URL(tab.url).host}...`);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  } catch (error) {
    throw codedError(`Could not connect to the Qoyod page: ${friendlyError(error)}`, "qoyod_page_not_connected");
  }

  await wait(100);
  const response = await sendQoyodMessage(tab.id, { type: "QOYOD_PING", qoyodBaseUrl: state.qoyodBaseUrl });
  if (!response?.ok) {
    throw codedError(response?.error || "Qoyod page is not ready.", response?.errorCode || "qoyod_page_not_connected");
  }
  return tab;
}

async function sendQoyodMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    throw codedError(`Qoyod page is not connected: ${friendlyError(error)}`, "qoyod_page_not_connected");
  }
}

function isSupportedQoyodUrl(urlValue) {
  if (!urlValue) return false;
  try {
    const url = new URL(urlValue);
    return (
      (url.protocol === "https:" && QOYOD_HOST_PATTERN.test(url.hostname)) ||
      (url.protocol === "http:" && LOCAL_QOYOD_HOSTS.has(url.host))
    );
  } catch {
    return false;
  }
}

function codedError(message, errorCode) {
  const error = new Error(message);
  error.errorCode = errorCode;
  return error;
}

function friendlyError(error) {
  return error instanceof Error ? error.message : String(error);
}

function isConnectionOnlyError(error) {
  return error?.errorCode === "qoyod_page_not_connected" || error?.errorCode === "qoyod_page_unsupported";
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function renderJob(job) {
  fields.job.hidden = !job;
  fields.fill.disabled = !job;
  fields.saveDraft.disabled = !job;
  fields.cancel.disabled = !job;
  if (!job) {
    fields.jobTitle.textContent = "";
    fields.jobMeta.textContent = "";
    return;
  }

  fields.jobTitle.textContent = `${job.draft?.supplierName || "Unknown supplier"} - ${job.draft?.invoiceNumber || job.jobId.slice(0, 8)}`;
  fields.jobMeta.textContent = `${job.draft?.grandTotal || 0} ${job.draft?.currency || "SAR"} · ${job.draft?.lineItems?.length || 0} lines`;
}

function setBusy(busy, label = "Working") {
  fields.status.textContent = busy ? label : "Idle";
  [fields.claim, fields.fill, fields.saveDraft, fields.cancel, fields.calibrate].forEach((button) => {
    button.disabled = busy || ((button === fields.fill || button === fields.saveDraft || button === fields.cancel) && !state.currentJob);
  });
}

function note(message) {
  fields.status.textContent = message.length > 24 ? "Check log" : message;
  fields.log.textContent = `${new Date().toLocaleTimeString()} ${message}\n${fields.log.textContent}`.slice(0, 5000);
}
