# Multi-Platform Invoice Intake as Backend-First UiPath Maestro Case

Track 1 pilot for invoice intake into Qoyod and ERPNext without IXP or RPA runtime dependency.

- Phone PWA captures QR plus one or many invoice photos/PDFs as a batch.
- Express API stores job state, uploads files to Orchestrator Storage, creates `InvoiceIntake` queue items, and can start one Maestro Case per uploaded batch once CaseManagement runtime is available.
- Extraction runs through a modular backend worker: OpenAI vision/PDF first, DeepSeek JSON normalization second when configured.
- Finance review remains human-controlled in the PWA with batch filtering, reusable local mapping rules, and per-invoice release to one or more destinations.
- Qoyod fill is handled by a desktop Chrome extension using the user's logged-in Qoyod browser session. It saves draft only after explicit confirmation.
- ERPNext posting is handled through Frappe REST APIs. It creates Purchase Invoice drafts and attaches the source invoice image/PDF; v1 never submits accounting entries.

## Run Locally

```powershell
npm install
npm run dev
```

Open `http://localhost:5173`. The API runs on `http://localhost:8787`.

For the complete operator walkthrough, see `docs/USER_GUIDE.md`.

## Temporary HTTPS Tunnels

Use this when Maestro needs to call the local API or when testing the PWA from a phone without publishing the app.

Start the local app first:

```powershell
npm run dev
```

Then start both HTTPS tunnels:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-tunnels.ps1 start
```

The script creates:

- API tunnel for `http://localhost:8787`, used by Maestro callbacks and `PUBLIC_API_BASE_URL`.
- Web tunnel for `http://localhost:5173`, opened on the phone for capture/review testing.

Check current tunnel URLs:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-tunnels.ps1 status
```

Stop both tunnels:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-tunnels.ps1 stop
```

This closes the public HTTPS tunnels. To stop the local web/API listeners too, stop `npm run dev` with `Ctrl+C` in its terminal.

The script updates ignored local `.env` with the current API tunnel URL. Tunnel URLs are temporary; restart tunnels and rerun preflight before each live Maestro demo.

If Maestro reads `InvoiceIntakeApiBaseUrl` from Orchestrator assets, update that asset after the API tunnel changes:

```powershell
uip or assets update <asset-id> "<api-tunnel-url>" --folder-path "Finance/InvoiceIntake" --output json
```

## Local Env

Copy `.env.example` and set the local secrets you have:

```powershell
$env:PUBLIC_API_BASE_URL="http://localhost:8787"
$env:EXTRACTION_MODE="local"
$env:OPENAI_API_KEY="<openai-key>"
$env:OPENAI_EXTRACTION_MODEL="gpt-4.1"
$env:DEEPSEEK_API_KEY="<deepseek-key>"
$env:DEEPSEEK_MODEL="deepseek-v4-flash"
$env:FILLER_API_TOKEN="<shared-extension-token>"
$env:INVOICE_DESTINATIONS="qoyod,erpnext"
$env:ERPNEXT_BASE_URL="https://your-sandbox.example"
$env:ERPNEXT_API_KEY="<api-key>"
$env:ERPNEXT_API_SECRET="<api-secret>"
$env:ERPNEXT_COMPANY="<company>"
$env:ERPNEXT_DEFAULT_EXPENSE_ACCOUNT="<expense-account>"
$env:ERPNEXT_DEFAULT_COST_CENTER="<cost-center>"
```

Use `EXTRACTION_MODE=external` plus `EXTRACTION_START_URL` when extraction moves to a separate backend. Cloud Maestro cannot call localhost, so Case-driven execution needs `PUBLIC_API_BASE_URL` to be a public HTTPS URL.

## UiPath Resources

Configure these per tenant in your local `.env`; no connected environment values are committed.

- Base URL: your UiPath Automation Cloud URL
- Organization: your organization name
- Tenant: your tenant name
- Folder: your target folder path
- Folder key: your target folder key
- Queue: `InvoiceIntake`
- Storage bucket: your invoice-intake storage bucket
- Case solution: `uipath/QoyodInvoiceIntakeSolution`
- Case file: `uipath/QoyodInvoiceIntakeSolution/QoyodInvoiceIntakeCase/caseplan.json`

The Case remains the visible Maestro design. If CaseManagement runtime is not available in your tenant, the PWA shows a local Maestro Case cockpit that mirrors the same stages. Once runtime exists, a Case/API Workflow can call the same extraction and callback endpoints.

Run the read-only preflight before a demo:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\maestro-preflight.ps1
```

## ERPNext Destination

Configure ERPNext against a sandbox/staging site first. Required values:

- `ERPNEXT_BASE_URL`
- `ERPNEXT_API_KEY`
- `ERPNEXT_API_SECRET`
- `ERPNEXT_COMPANY`
- `ERPNEXT_DEFAULT_EXPENSE_ACCOUNT`
- `ERPNEXT_DEFAULT_COST_CENTER`

Optional values:

- `ERPNEXT_DEFAULT_ITEM_CODE` for sites that require an item code on every Purchase Invoice row.
- `ERPNEXT_PURCHASE_TAXES_AND_CHARGES_TEMPLATE` or `ERPNEXT_VAT_ACCOUNT_HEAD` for tax handling.
- `ERPNEXT_TEST_SUPPLIER` for live smoke tests.

`ERPNEXT_SUBMIT_AFTER_POST` must stay `false` in v1. ERPNext output is a draft Purchase Invoice plus the uploaded source attachment.

Run live sandbox validation explicitly:

```powershell
$env:LIVE_ERPNEXT_TEST="true"
$env:LIVE_UIPATH_TEST="true"
$env:ERPNEXT_TEST_SUPPLIER="<existing-sandbox-supplier>"
npm run smoke:live
```

The ERPNext smoke test creates a uniquely numbered `UIPATH-TEST-<timestamp>` draft and leaves it in the sandbox for manual inspection.

## API Endpoints

Capture and review:

```http
POST /api/captures
POST /api/batches
GET /api/batches
GET /api/batches/{batchId}
POST /api/batches/{batchId}/apply-mappings
POST /api/batches/{batchId}/bulk-review
GET /api/jobs/{jobId}
POST /api/jobs/{jobId}/review
GET /api/mappings
POST /api/mappings
DELETE /api/mappings/{ruleId}
```

Extraction:

```http
POST /api/extraction/jobs/{jobId}/start
GET /api/extraction/jobs/{jobId}/input
GET /api/extraction/jobs/{jobId}/source
POST /api/extraction/jobs/{jobId}/result
```

Qoyod extension fill:

```http
POST /api/fill/jobs/claim-next
GET /api/fill/jobs/{jobId}
GET /api/fill/jobs/{jobId}/source
POST /api/fill/jobs/{jobId}/status
```

Destinations:

```http
GET /api/destinations
GET /api/destinations/erpnext/preflight
POST /api/jobs/{jobId}/destinations/erpnext/post
POST /api/case/jobs/{jobId}/destinations/erpnext/post
```

Maestro Case callbacks:

```http
GET /api/case/batches/{batchId}
POST /api/case/batches/{batchId}/stage
POST /api/case/batches/{batchId}/task
POST /api/case/batches/{batchId}/exception
POST /api/case/batches/{batchId}/close
POST /api/case/jobs/{jobId}/extraction
POST /api/case/jobs/{jobId}/review
POST /api/case/jobs/{jobId}/exception
```

Deprecated `/api/robot/...` aliases remain for compatibility, but new work should use `/api/fill/...`.

## Chrome Extension

Load `extension/qoyod-filler` as an unpacked Chrome extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Load unpacked and select `extension/qoyod-filler`.
4. Log into Qoyod in Chrome and open the draft form.
5. Click the extension toolbar icon to open the side panel.
6. Configure API base URL and fill token in the side panel.
7. Optionally select a batch scope, then claim, fill, review, and save draft sequentially.

The extension never stores Qoyod credentials and never clicks approve/submit.

## Current Blockers

- No IXP access: extraction is LLM-backed.
- No RPA license/runtime: Qoyod fill is extension-assisted.
- No Qoyod API access: the extension uses the logged-in browser session.
- No CaseManagement runtime in staging: backend-first execution is active until runtime is allocated.
- ERPNext requires existing sandbox master data: Supplier, Company, Account, Cost Center, and tax/item setup as configured.

## Verify

```powershell
npm test
npm run build
npm run smoke:live
npm audit --audit-level=low
powershell -ExecutionPolicy Bypass -File scripts\maestro-preflight.ps1
uip maestro case validate uipath/QoyodInvoiceIntakeSolution/QoyodInvoiceIntakeCase/caseplan.json --output json
```
