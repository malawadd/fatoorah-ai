# QoyodInvoiceIntakeCase Tasks

## T01: Root Case
- name: QoyodInvoiceIntakeCase
- identifier-prefix: QII
- trigger: manual/API start, one case per uploaded invoice batch

## T02: Input Variables
- batchId: string
- batchName: string
- invoiceCount: number
- jobIds: jsonSchema array<string>
- jobId: string
- bucketKey: string
- bucketPath: string
- attachmentName: string
- attachmentMimeType: string
- qrTlv: jsonSchema

## T03: Case Variables
- invoiceDraft: jsonSchema
- validationResult: jsonSchema
- reviewDecision: string
- mappingStatus: string
- qoyodDraftStatus: string
- qoyodDraftReference: string
- errorCode: string
- caseStatus: string

## T04: Stage Capture Intake
- task: Register Capture Payload
- type: api-workflow
- resource: <UNRESOLVED: publish API workflow or replace with supported Case task>
- callback: `POST /api/case/batches/{batchId}/stage`

## T05: Stage Extraction And Reconciliation
- task: Extract Batch Invoice Drafts
- type: api-workflow
- resource: <UNRESOLVED: Case runtime unavailable; backend starts `/api/extraction/jobs/{jobId}/start` for each uploaded job until enabled>
- task: Validate QR OCR Totals Duplicates And Batch Exceptions
- type: agent
- resource: <UNRESOLVED: validation agent/process not published>
- callback: `POST /api/case/batches/{batchId}/task`

## T06: Stage Finance Review And Mapping
- task: Review Correct And Map Batch
- type: action
- resource: <UNRESOLVED: publish QoyodInvoiceReviewAction and resolve action app>
- callback: `POST /api/case/batches/{batchId}/stage`

## T07: Stage Qoyod Drafting
- task: Wait For Qoyod Extension Draft Save
- type: api-workflow
- resource: <UNRESOLVED: Case runtime unavailable; backend /api/fill status drives the extension handoff until enabled>
- callback: `POST /api/case/batches/{batchId}/task`

## T08: Stage Exception Resolution
- task: Resolve Batch Invoice Intake Exception
- type: action
- resource: <UNRESOLVED: publish exception action app or reuse review app>
- callback: `POST /api/case/batches/{batchId}/exception`

## T09: Stage Closed
- task: Record Case Closure
- type: api-workflow
- resource: <UNRESOLVED: publish API workflow or replace with supported Case task>
- callback: `POST /api/case/batches/{batchId}/close`

## T10: Routing Conditions
- Capture Intake enters on case-entered.
- Extraction And Reconciliation enters after Capture Intake completes.
- Finance Review And Mapping enters after Extraction And Reconciliation completes and errorCode is empty.
- Qoyod Drafting enters when user routes from review after approve_for_qoyod or mappingStatus ready, then waits for extension fill status.
- Exception Resolution enters by user selection or extraction/review/drafting error.
- Closed enters after draft_saved or resolved/rejected exception.
- Case completes when the required Closed stage completes.
