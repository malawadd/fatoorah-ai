const CALIBRATION_FIELDS = [
  ["invoiceNumber", "Reference text input"],
  ["billDescription", "Bill Description text input"],
  ["supplier", "Vendor searchable dropdown"],
  ["issueDate", "Issue Date text input"],
  ["paymentTerms", "Payment Terms dropdown/select"],
  ["dueDate", "Due Date text input"],
  ["supplyDate", "Supply Date text input"],
  ["lineMapping", "first line mapping dropdown/select"],
  ["lineDescription", "First line description"],
  ["lineQuantity", "First line quantity"],
  ["lineUnit", "First line Unit dropdown/select"],
  ["lineUnitPrice", "First line unit price"],
  ["lineInclusive", "First line Inclusive checkbox"],
  ["lineDiscount", "First line discount"],
  ["lineDiscountType", "First line discount type dropdown/select"],
  ["lineTax", "First line VAT percent dropdown/select"],
  ["addLine", "Add More button"],
  ["attachmentsAccordion", "Attachments accordion button"],
  ["attachmentInput", "Attachment file input or upload control"],
  ["saveDraftButton", "Save draft button"]
];

const LOCAL_QOYOD_HOSTS = new Set(["localhost:5174", "127.0.0.1:5174"]);
const QOYOD_HOST_PATTERN = /(^|\.)qoyod\.com$/i;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: error?.errorCode || "qoyod_content_script_error"
    });
  });
  return true;
});

async function handleMessage(message) {
  if (message.type === "QOYOD_PING") {
    assertQoyodPage(message.qoyodBaseUrl);
    return { ok: true, message: "Qoyod page connected.", href: window.location.href };
  }
  if (message.type === "QOYOD_START_CALIBRATION") {
    return startCalibration(message.qoyodBaseUrl);
  }
  if (message.type === "QOYOD_FILL_JOB") {
    return fillJob(message.job, message.config);
  }
  if (message.type === "QOYOD_SAVE_DRAFT") {
    return saveDraft();
  }
  return { ok: false, error: "Unknown Qoyod filler message." };
}

async function startCalibration(qoyodBaseUrl) {
  assertQoyodPage(qoyodBaseUrl);
  const profile = {};

  showTransientBanner("Qoyod calibration started. Follow each prompt on this page.");
  for (let index = 0; index < CALIBRATION_FIELDS.length; index += 1) {
    const [key, label] = CALIBRATION_FIELDS[index];
    const element = await captureElement(`Calibration ${index + 1}/${CALIBRATION_FIELDS.length}: click the Qoyod ${label}. Press Escape to skip optional fields.`);
    if (element) {
      profile[key] = selectorFor(element);
      flash(element);
    }
  }

  await chrome.storage.local.set({ qoyodSelectorProfile: profile });
  return { ok: true, message: `Calibration saved ${Object.keys(profile).length} selectors.` };
}

async function fillJob(job, config) {
  assertQoyodPage(config.qoyodBaseUrl);
  const { qoyodSelectorProfile } = await chrome.storage.local.get({ qoyodSelectorProfile: null });
  const profile = qoyodSelectorProfile || {};
  const required = ["supplier", "invoiceNumber", "issueDate", "dueDate", "supplyDate", "lineMapping", "lineDescription", "lineQuantity", "lineUnitPrice", "lineTax", "saveDraftButton"];
  const missing = required.filter((key) => !profile[key]);
  if (missing.length) {
    return { ok: false, error: `Missing calibration: ${missing.join(", ")}`, errorCode: "selector_profile_missing" };
  }

  const draft = job.draft;
  const issueDate = formatQoyodDate(draft.issueDate);
  const dueDate = formatQoyodDate(draft.dueDate || draft.issueDate);
  await setCustomSearchableDropdown(profile.supplier, [draft.supplierName, draft.supplierTaxId]);
  setValue(profile.invoiceNumber, draft.invoiceNumber);
  if (profile.billDescription) setValue(profile.billDescription, buildBillDescription(draft));
  setValue(profile.issueDate, issueDate);
  setValue(profile.dueDate, dueDate);
  setValue(profile.supplyDate, issueDate);

  const lines = draft.lineItems || [];
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0 && profile.addLine) {
      click(profile.addLine);
      await wait(250);
    }
    await fillLine(profile, lines[index], index);
  }

  const attachmentResult = await attachSourceIfPossible(profile, job, config);
  const suffix = attachmentResult ? ` ${attachmentResult}` : "";
  return { ok: true, message: `Filled ${lines.length} line(s).${suffix}` };
}

async function saveDraft() {
  const { qoyodSelectorProfile } = await chrome.storage.local.get({ qoyodSelectorProfile: null });
  const selector = qoyodSelectorProfile?.saveDraftButton;
  if (!selector) {
    return { ok: false, error: "Missing save draft calibration.", errorCode: "selector_profile_missing" };
  }
  if (!window.confirm("Save this Qoyod document as a draft only?")) {
    return { ok: false, error: "User cancelled draft save.", errorCode: "save_cancelled" };
  }

  click(selector);
  await wait(1000);
  return { ok: true, reference: inferDraftReference() };
}

async function fillLine(profile, line, index) {
  const mapping = line.selectedQoyodMapping;
  if (!mapping?.label && !mapping?.id) {
    throw codedError(`Line ${index + 1} is missing a Qoyod mapping.`, "missing_mapping");
  }
  await setRepeatedSelectOrDropdown(profile.lineMapping, index, [mapping?.label, mapping?.id]);
  setRepeatedValue(profile.lineDescription, index, line.description);
  setRepeatedValue(profile.lineQuantity, index, String(line.quantity ?? ""));
  if (profile.lineUnit && line.unit) setRepeatedSelect(profile.lineUnit, index, line.unit);
  setRepeatedValue(profile.lineUnitPrice, index, String(line.unitPrice ?? ""));
  if (profile.lineInclusive) setRepeatedCheckbox(profile.lineInclusive, index, false);
  if (profile.lineDiscount) setRepeatedValue(profile.lineDiscount, index, String(line.discount ?? 0));
  if (profile.lineDiscountType && Number(line.discount || 0) > 0) setRepeatedSelect(profile.lineDiscountType, index, ["﷼", "SAR", "ريال"]);
  if (profile.lineTax) setRepeatedSelect(profile.lineTax, index, String(line.taxRate ?? 15));
}

async function attachSourceIfPossible(profile, job, config) {
  if (!profile.attachmentInput) return "";
  if (profile.attachmentsAccordion) {
    click(profile.attachmentsAccordion);
    await wait(200);
  }
  const input = document.querySelector(profile.attachmentInput);
  if (!(input instanceof HTMLInputElement) || input.type !== "file") {
    return "Attachment control needs manual upload.";
  }

  try {
    const response = await fetch(`${config.apiBaseUrl}/api/fill/jobs/${job.jobId}/source`, {
      headers: config.fillToken ? { "x-fill-token": config.fillToken } : {}
    });
    if (!response.ok) return "Attachment fetch failed; upload manually.";

    const blob = await response.blob();
    const attachment = job.draft.attachmentRefs?.[0];
    const file = new File([blob], attachment?.name || "invoice-upload", { type: attachment?.mimeType || blob.type });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return "Attachment staged.";
  } catch {
    return "Attachment upload needs manual handling.";
  }
}

function assertQoyodPage(qoyodBaseUrl) {
  const current = new URL(window.location.href);
  const configured = parseConfiguredUrl(qoyodBaseUrl);
  const currentHost = current.host.toLowerCase();
  const currentHostname = current.hostname.toLowerCase().replace(/^www\./, "");
  const configuredHost = configured?.host.toLowerCase();
  const configuredHostname = configured?.hostname.toLowerCase().replace(/^www\./, "");
  const matchesConfigured = configuredHostname
    ? currentHost === configuredHost || currentHostname === configuredHostname || currentHostname.endsWith(`.${configuredHostname}`)
    : false;
  const matchesKnownQoyod = current.protocol === "https:" && QOYOD_HOST_PATTERN.test(current.hostname);
  const matchesLocalDev = current.protocol === "http:" && LOCAL_QOYOD_HOSTS.has(currentHost);

  if (!matchesConfigured && !matchesKnownQoyod && !matchesLocalDev) {
    throw codedError("Open a supported Qoyod bill page first: Qoyod HTTPS, localhost:5174, or 127.0.0.1:5174.", "qoyod_page_unsupported");
  }
  if (/login|sign_in|users\/sign_in/i.test(window.location.href)) {
    throw codedError("Qoyod is showing a login page. Log in first, then retry.", "qoyod_not_logged_in");
  }
}

function parseConfiguredUrl(qoyodBaseUrl) {
  try {
    return new URL(qoyodBaseUrl || "https://www.qoyod.com");
  } catch {
    return null;
  }
}

function codedError(message, errorCode) {
  const error = new Error(message);
  error.errorCode = errorCode;
  return error;
}

function setRepeatedValue(selector, index, value) {
  const element = repeatedElement(selector, index);
  setElementValue(element, value);
}

function setRepeatedSelect(selector, index, value) {
  const element = repeatedElement(selector, index);
  setSelectOrValue(element, value);
}

async function setRepeatedSelectOrDropdown(selector, index, value) {
  const element = repeatedElement(selector, index);
  if (element instanceof HTMLSelectElement || element.querySelector?.("select")) {
    setSelectOrValue(element, value);
    return;
  }
  await chooseFromDropdown(element, value);
}

function setRepeatedCheckbox(selector, index, checked) {
  const element = repeatedElement(selector, index);
  setCheckboxValue(element, checked);
}

function setValue(selector, value) {
  const element = requireElement(selector);
  setElementValue(element, value);
}

function setElementValue(element, value) {
  const control = editableControl(element);
  if (control instanceof HTMLSelectElement) {
    setNativeSelectValue(control, value);
    return;
  }
  if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")) {
    setCheckboxValue(control, Boolean(value));
    return;
  }
  if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
    focusForEdit(control);
    setNativeProperty(control, "value", value ?? "");
    dispatchValueEvents(control);
    control.blur();
    return;
  }

  if (control instanceof HTMLElement && control.isContentEditable) {
    focusForEdit(control);
    control.textContent = value ?? "";
    dispatchValueEvents(control);
    control.blur();
  }
}

async function setCustomSearchableDropdown(selector, value) {
  await chooseFromDropdown(requireElement(selector), value);
}

async function chooseFromDropdown(trigger, value) {
  const candidates = candidateList(value);
  if (!candidates.length) return;
  clickElement(trigger);
  await wait(250);

  const searchInput = findDropdownSearchInput(trigger);
  if (searchInput) {
    setElementValue(searchInput, candidates[0]);
    await wait(350);
  }

  const option = await findDropdownOption(candidates, 1800);
  if (option) {
    clickElement(option);
    await wait(250);
    return;
  }

  if (searchInput) {
    pressKey(searchInput, "Enter");
    await wait(250);
    return;
  }

  throw codedError(`Could not find dropdown option for ${candidates[0]}.`, "selector_failure");
}

function click(selector) {
  clickElement(requireElement(selector));
}

function repeatedElement(selector, index) {
  const exact = Array.from(document.querySelectorAll(selector));
  if (exact[index]) return exact[index];

  const rowSelector = selector.replace(/tr:nth-of-type\(\d+\)/g, `tr:nth-of-type(${index + 1})`);
  if (rowSelector !== selector) {
    const rowElement = document.querySelector(rowSelector);
    if (rowElement) return rowElement;
  }

  if (exact.length) return exact[exact.length - 1];
  throw new Error(`Selector not found: ${selector}`);
}

function requireElement(selector) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Selector not found: ${selector}`);
  return element;
}

function editableControl(element) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return element;
  }
  return element.querySelector?.("input, textarea, select, [contenteditable='true']") || element;
}

function setSelectOrValue(element, value) {
  const control = element instanceof HTMLSelectElement ? element : element.querySelector?.("select");
  if (control instanceof HTMLSelectElement) {
    setNativeSelectValue(control, value);
    return;
  }
  setElementValue(element, candidateList(value)[0] || "");
}

function setNativeSelectValue(select, value) {
  const candidates = candidateList(value);
  if (!candidates.length) return;
  const option = findNativeOption(select, candidates);
  if (!option) {
    throw codedError(`No matching select option for: ${candidates[0]}`, "selector_failure");
  }

  focusForEdit(select);
  setNativeProperty(select, "value", option.value);
  dispatchValueEvents(select);
  select.blur();
}

function findNativeOption(select, candidates) {
  const options = Array.from(select.options);
  const normalizedCandidates = candidates.map(normalizeComparable).filter(Boolean);
  const numericCandidates = candidates.map(numericValue).filter((value) => value !== null);

  return options.find((option) => {
    const value = normalizeComparable(option.value);
    const text = normalizeComparable(option.textContent || "");
    return normalizedCandidates.some((candidate) => value === candidate || text === candidate);
  }) || options.find((option) => {
    const text = normalizeComparable(option.textContent || "");
    return normalizedCandidates.some((candidate) => text.includes(candidate) || candidate.includes(text));
  }) || options.find((option) => {
    const optionNumber = numericValue(`${option.value} ${option.textContent || ""}`);
    return optionNumber !== null && numericCandidates.some((candidate) => Math.abs(candidate - optionNumber) < 0.001);
  });
}

function setCheckboxValue(element, checked) {
  const control = element instanceof HTMLInputElement ? element : element.querySelector?.("input[type='checkbox'], input[type='radio']");
  if (!(control instanceof HTMLInputElement)) throw new Error("Checkbox selector did not resolve to a checkbox input.");
  const next = Boolean(checked);
  if (control.checked !== next) {
    clickElement(control);
    return;
  }
  dispatchValueEvents(control);
}

function setNativeProperty(element, property, value) {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), property);
  if (descriptor?.set) {
    descriptor.set.call(element, value);
  } else {
    element[property] = value;
  }
}

function focusForEdit(element) {
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus();
}

function dispatchValueEvents(element) {
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function clickElement(element) {
  if (!(element instanceof HTMLElement)) throw new Error("Selector did not resolve to a clickable element.");
  element.scrollIntoView({ block: "center", inline: "center" });
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
  element.click();
}

function findDropdownSearchInput(trigger) {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement && isVisible(active)) return active;
  const scoped = Array.from(trigger.parentElement?.querySelectorAll("input[type='search'], input[role='combobox'], input[type='text'], input:not([type])") || []);
  const global = Array.from(document.querySelectorAll(".select2-search__field, input[type='search'], input[role='combobox'], [role='dialog'] input, .dropdown-menu input"));
  return [...scoped, ...global].find((element) => element instanceof HTMLInputElement && isVisible(element)) || null;
}

async function findDropdownOption(candidates, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const option = visibleDropdownOptions().find((element) => textMatchesCandidates(element.textContent || "", candidates));
    if (option) return option;
    await wait(150);
  }
  return null;
}

function visibleDropdownOptions() {
  return Array.from(document.querySelectorAll([
    "[role='option']",
    ".select2-results__option",
    ".dropdown-menu li",
    ".dropdown-item",
    "li[class*='option']",
    "div[class*='option']"
  ].join(","))).filter((element) => element instanceof HTMLElement && isVisible(element));
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function pressKey(element, key) {
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  element.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
}

function candidateList(value) {
  return (Array.isArray(value) ? value : [value])
    .map((candidate) => candidate == null ? "" : String(candidate).trim())
    .filter(Boolean);
}

function textMatchesCandidates(text, candidates) {
  const normalizedText = normalizeComparable(text);
  return candidateList(candidates).some((candidate) => {
    const normalizedCandidate = normalizeComparable(candidate);
    return normalizedText === normalizedCandidate || normalizedText.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedText);
  });
}

function normalizeComparable(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[ـ]/g, "")
    .replace(/[٪%]/g, "")
    .replace(/\s+/g, " ");
}

function numericValue(value) {
  const match = String(value ?? "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function formatQoyodDate(value) {
  const raw = String(value || "").trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  return raw;
}

function buildBillDescription(draft) {
  return [draft.supplierName, draft.invoiceNumber].filter(Boolean).join(" - ") || draft.lineItems?.[0]?.description || "";
}

function captureElement(message) {
  return new Promise((resolve) => {
    const banner = document.createElement("div");
    banner.textContent = message;
    banner.style.cssText = "position:fixed;z-index:2147483647;top:12px;left:12px;right:12px;background:#143c34;color:white;padding:12px 14px;border-radius:6px;font:14px system-ui;box-shadow:0 8px 24px rgba(0,0,0,.2);pointer-events:none";
    document.body.appendChild(banner);

    const cleanup = () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      banner.remove();
    };

    const onClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      cleanup();
      resolve(event.target);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup();
        resolve(null);
      }
    };

    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
  });
}

function showTransientBanner(message) {
  const banner = document.createElement("div");
  banner.textContent = message;
  banner.style.cssText = "position:fixed;z-index:2147483647;top:12px;left:12px;right:12px;background:#1b8f66;color:white;padding:12px 14px;border-radius:6px;font:14px system-ui;box-shadow:0 8px 24px rgba(0,0,0,.2);pointer-events:none";
  document.body.appendChild(banner);
  window.setTimeout(() => banner.remove(), 1400);
}

function selectorFor(element) {
  if (!(element instanceof Element)) throw new Error("Calibration target is not an element.");
  if (element.id) return `#${CSS.escape(element.id)}`;
  const testId = element.getAttribute("data-testid") || element.getAttribute("data-test") || element.getAttribute("name");
  if (testId) {
    const attr = element.getAttribute("data-testid") ? "data-testid" : element.getAttribute("data-test") ? "data-test" : "name";
    return `${element.tagName.toLowerCase()}[${attr}="${cssAttr(testId)}"]`;
  }

  const parts = [];
  let node = element;
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (!parent) break;
    const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
    const index = siblings.indexOf(node) + 1;
    parts.unshift(`${tag}:nth-of-type(${Math.max(index, 1)})`);
    node = parent;
  }
  return parts.join(" > ");
}

function cssAttr(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function flash(element) {
  if (!(element instanceof HTMLElement)) return;
  const previous = element.style.outline;
  element.style.outline = "3px solid #1b8f66";
  window.setTimeout(() => {
    element.style.outline = previous;
  }, 800);
}

function inferDraftReference() {
  const candidates = [
    document.querySelector("[data-testid*='reference' i]"),
    document.querySelector("[class*='reference' i]"),
    document.querySelector("[id*='reference' i]")
  ].filter(Boolean);
  const text = candidates.map((node) => node.textContent?.trim()).find(Boolean);
  return text || new URL(window.location.href).pathname.split("/").filter(Boolean).pop() || "";
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
