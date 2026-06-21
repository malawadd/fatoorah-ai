# Qoyod Invoice Intake Case SDD

## Objective
Build Track 1 as a UiPath Maestro Case named `QoyodInvoiceIntakeCase` with identifier prefix `QII`.

## Trigger
Manual/API start after the phone PWA uploads a batch and creates backend jobs. Primary inputs are `batchId`, `batchName`, `invoiceCount`, `jobIds`, attachment metadata, and QR TLV values. The existing single-job inputs `jobId`, `bucketKey`, `bucketPath`, `attachmentName`, `attachmentMimeType`, and `qrTlv` remain for compatibility.

## Stages
- Capture Intake: register batch source files, QR TLV payloads, bucket paths, and job IDs.
- Extraction And Reconciliation: extract invoice data for each job and validate QR/OCR totals, required fields, duplicates, and confidence.
- Finance Review And Mapping: human review/correction plus batch-level supplier/item/expense mapping and approve-to-draft decisions.
- Qoyod Drafting: Chrome extension claims reviewed jobs from the batch, fills the Qoyod draft form in the logged-in browser, and saves draft only after explicit user confirmation.
- Exception Resolution: handle invalid QR, mismatches, missing mappings, duplicate invoice, missing Qoyod login, selector failure, and attachment failure.
- Closed: complete after draft saved, rejected, or manually resolved exception.

## Resources
- Queue: `InvoiceIntake`
- Bucket: `qoyod-invoice-intake-files`
- Folder: `Finance/InvoiceIntake`
- Review app: `QoyodInvoiceReviewAction` Coded Action App
- Qoyod fill method: desktop Chrome extension under `extension/qoyod-filler`

## Current Staging Blockers
- IXP and RPA are not used in this pilot; extraction is backend LLM-backed and Qoyod fill is extension-assisted.
- Case tasks are placeholders until CaseManagement runtime is allocated and API workflows can call the backend endpoints.
- Current implementation starts one local/backend Case cockpit per uploaded batch. When live Case runtime is configured, the backend starts one Maestro Case per batch with the same batch inputs.
