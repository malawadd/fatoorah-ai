# Multi-Platform Invoice Intake User Guide

This guide walks through the no-IXP/no-RPA pilot from invoice capture to destination drafts in Qoyod and ERPNext.

## What You Need

- The local app running with `npm run dev`.
- API available at `http://localhost:8787`.
- PWA available at `http://localhost:5173`.
- OpenAI key configured for extraction.
- Optional DeepSeek key for second-pass normalization.
- Qoyod Filler Chrome extension loaded as an unpacked extension.
- A Chrome browser session already logged into Qoyod.
- Optional ERPNext sandbox API token and master data for Purchase Invoice draft creation.

## Moving Parts

- Phone/PWA capture: scans FATOORA QR payloads when available and uploads one or many invoice photos/PDFs.
- Express API: stores batches, intake jobs, source files, extracted drafts, mapping rules, review status, and fill status.
- LLM extraction: reads the uploaded image/PDF and produces a normalized invoice draft.
- UiPath Maestro Case artifact: defines one dynamic Case per uploaded batch. In live mode, API Workflow tasks call the public backend to start extraction, poll review/post/fill progress, and record Case stage callbacks.
- Local Maestro Case cockpit: shows the active stage, runtime mode, Case identifiers, and exceptions while staging runtime is unavailable.
- Orchestrator bucket/queue: stores source files and queue signals for the UiPath-facing pilot surface.
- Finance review: confirms fields, totals, line items, duplicate warnings, and destination item/expense mappings before any platform is touched.
- Chrome side panel extension: claims a reviewed job, optionally from a selected batch, and fills Qoyod in the logged-in browser.
- Qoyod browser tab: remains under the user’s control; the output is a draft only.
- ERPNext adapter: creates Purchase Invoice drafts through the ERPNext/Frappe API and attaches the original invoice picture/PDF.

## 1. Start The App

From the project folder:

```powershell
npm install
npm run dev
```

Open `http://localhost:5173`.

Make sure the backend environment includes:

```powershell
$env:PUBLIC_API_BASE_URL="http://localhost:8787"
$env:PUBLIC_WEB_APP_URL="http://localhost:5173"
$env:EXTRACTION_MODE="local"
$env:OPENAI_API_KEY="<openai-key>"
$env:FILLER_API_TOKEN="<shared-extension-token>"
$env:INVOICE_DESTINATIONS="qoyod,erpnext"
```

## 1A. Optional Phone And Maestro HTTPS Tunnels

For local desktop-only testing, use `http://localhost:5173`.

For phone testing or live Maestro callbacks, keep `npm run dev` running and start temporary Cloudflare tunnels:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-tunnels.ps1 start
```

The script prints two URLs:

- Web tunnel: open this URL on the phone. It points to the PWA on local port `5173`.
- API tunnel: use this URL for Maestro callbacks. The script writes it to ignored local `.env` as `PUBLIC_API_BASE_URL`.
- Web tunnel: use this URL on the phone and for Action Center review links. The script writes it to ignored local `.env` as `PUBLIC_WEB_APP_URL`.

Check tunnel status:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-tunnels.ps1 status
```

Stop both tunnels when testing is done:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-tunnels.ps1 stop
```

This closes public access. To stop the local web/API listeners too, stop `npm run dev` with `Ctrl+C` in its terminal.

After starting tunnels, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\maestro-preflight.ps1
```

Expected results:

- `PUBLIC_API_BASE_URL reachability shape - public HTTPS URL available for Maestro callbacks`
- `PUBLIC_WEB_APP_URL reachability shape - public HTTPS URL available for Action Center review links`

If the Maestro case reads the backend URL from the Orchestrator asset `InvoiceIntakeApiBaseUrl`, update that asset whenever the API tunnel URL changes:

```powershell
uip or assets update <asset-id> "<api-tunnel-url>" --folder-path "Finance/InvoiceIntake" --output json
```

## 2. Capture Invoices

1. Open the PWA on a phone or desktop browser.
2. Enter a batch name.
3. Click Scan QR for Saudi FATOORA invoices, or paste QR payloads manually.
4. If uploading multiple files, put QR payloads one per line in the same order as the selected files.
5. Choose one or many invoice photos/PDFs.
6. Click Upload batch.

The backend creates a batch, creates one job per file, uploads files, starts extraction per invoice, and records the batch in the Maestro Case cockpit. If live Case startup is enabled, it starts one Maestro Case for the batch; otherwise the cockpit runs as the local fallback.

## 3. Wait For Extraction

Each invoice status moves to Extracting while the backend worker runs.

- With `OPENAI_API_KEY`, the worker extracts invoice headers and line items from the photo/PDF.
- With `DEEPSEEK_API_KEY`, DeepSeek can normalize the extracted JSON.
- Without an extraction key, the job falls back to manual review with the QR-seeded draft.

Refresh or wait for the batch table to show invoices ready for review.

The Maestro Case cockpit at the top of the batch workspace moves through Capture Intake, Extraction And Reconciliation, Finance Review And Mapping, Destination Posting, Qoyod Drafting, Exception Resolution, and Closed. In live mode Maestro owns the stage updates by running API Workflow tasks against `PUBLIC_API_BASE_URL`. In local fallback mode the backend mirrors stage progress from invoice statuses so the desktop demo still has a visible cockpit.

## 4. Review, Map, And Release

In the PWA batch workspace:

1. Select the batch from the left panel.
2. Filter invoices by All, Review, Ready, or Drafts.
3. Select an invoice row.
4. Check supplier, tax ID, invoice number, dates, currency, totals, and every line.
5. For each line, set the destination mapping label and type.
6. Click the wand button on a line to save a reusable mapping rule for similar future lines.
7. Click Apply mappings to apply existing rules across the batch.
8. Choose the destinations: Qoyod, ERPNext, or both.
9. Click Save invoice review for one invoice, or Save batch review to release every valid invoice.

Each invoice becomes ready for selected destinations only when totals reconcile and required mappings are present. Other invoices in the same batch can remain in review.

## 4A. ERPNext Draft Posting

ERPNext is API-based, so no browser extension is needed when API tokens are configured.

Required sandbox configuration:

```powershell
$env:ERPNEXT_BASE_URL="https://your-sandbox.example"
$env:ERPNEXT_API_KEY="<api-key>"
$env:ERPNEXT_API_SECRET="<api-secret>"
$env:ERPNEXT_COMPANY="<company>"
$env:ERPNEXT_DEFAULT_EXPENSE_ACCOUNT="<expense-account>"
$env:ERPNEXT_DEFAULT_COST_CENTER="<cost-center>"
$env:ERPNEXT_SUBMIT_AFTER_POST="false"
```

When ERPNext is selected and review validation passes, Save invoice review creates an ERPNext Purchase Invoice draft immediately. The manual posting endpoint remains available for Case/API retries, but the browser flow does not require a separate click.

The backend uploads the source image/PDF as a private attachment and stores the ERPNext reference on the job destination state. It does not submit the invoice.

For live sandbox validation:

```powershell
$env:LIVE_ERPNEXT_TEST="true"
$env:ERPNEXT_TEST_SUPPLIER="<existing-sandbox-supplier>"
npm run smoke:live
```

The smoke test creates a `UIPATH-TEST-<timestamp>` draft and leaves it in ERPNext for inspection.

## 5. Load The Chrome Side Panel

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select Load unpacked.
4. Choose `extension/qoyod-filler`.
5. Click the extension toolbar icon to open the Qoyod Filler side panel.
6. Pin the extension if you want the toolbar icon to stay visible.

In the side panel, set:

- API base URL: `http://localhost:8787`
- Fill token: same value as `FILLER_API_TOKEN`
- Qoyod base URL: `https://www.qoyod.com`
- Batch scope: choose a batch if you want the side panel to claim from that batch only

Click Save.

## 6. Calibrate Qoyod Fields

Calibration teaches the extension which Qoyod fields to use.

1. In Chrome, log into Qoyod.
2. Open the Qoyod purchase/simple bill draft form.
3. In the side panel, click Calibrate selectors.
4. Follow the banner prompts on the Qoyod page.
5. Click each requested field or button.
6. Press Escape to skip optional controls, such as attachment upload, if needed.

Recalibrate if Qoyod changes the page layout or fields stop filling correctly.

## 7. Fill Qoyod

1. Keep the Qoyod draft form open in the active tab.
2. In the side panel, optionally select the batch scope.
3. Click Claim next reviewed invoice.
4. Confirm the current job details shown in the side panel.
5. Click Fill current Qoyod page.
6. Review all filled fields inside Qoyod.
7. If attachment upload did not work automatically, upload the source invoice manually.
8. Click Save draft only.
9. Confirm the save prompt.

The extension reports `draft_saved` back to the backend. It does not approve or submit the invoice. Claim the next invoice to continue through the batch.

## Troubleshooting

- No extraction happens: confirm `OPENAI_API_KEY` is set, or review the QR-seeded draft manually.
- No reviewed invoice is ready: finish review in the PWA, make sure every line has a mapping, and confirm the side panel is not scoped to the wrong batch.
- Mapping rules did not apply: confirm the line description contains the rule match text and supplier-scoped rules match the selected invoice supplier.
- Duplicate warning: another invoice has the same supplier tax ID and invoice number; resolve it before filling Qoyod.
- ERPNext posting failed: open the job timeline details and check the ERPNext destination error. Common causes are missing Supplier, Account, Cost Center, Item, or tax configuration in the sandbox.
- Qoyod is not logged in: log into Qoyod in the same Chrome profile, then retry.
- Missing calibration: open the Qoyod draft form and run Calibrate selectors.
- Selector failure: recalibrate; Qoyod likely changed markup or the wrong form is open.
- Attachment needs manual upload: upload the invoice file in Qoyod by hand, then save draft.
- Cloud Maestro cannot call localhost: use a public HTTPS API URL when CaseManagement runtime is available.
- Maestro Case shows blocked: run `powershell -ExecutionPolicy Bypass -File scripts\maestro-preflight.ps1` and check the missing runtime, folder, process key, or public URL.
- Side panel does not open: use Chrome 114 or newer and reload the unpacked extension.
