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
- firstJobId: string
- jobId: string
- bucketKey: string
- bucketPath: string
- attachmentName: string
- attachmentMimeType: string
- qrTlv: jsonSchema
- attachments: jsonSchema array<object>
- qrTlvByJob: jsonSchema object
- apiBaseUrl: string
- webAppUrl: string
- caseCallbackToken: string
- caseJobKey: string
- caseInstanceId: string
- maxAttempts: number
- waitSeconds: number

## T03: Case Variables
- invoiceDraft: jsonSchema
- validationResult: jsonSchema
- reviewUrl: string
- reviewDecision: string
- mappingStatus: string
- qoyodDraftStatus: string
- qoyodDraftReference: string
- errorCode: string
- caseStage: string
- caseStatus: string
- taskStatus: string

## T04: Stage Capture Intake
- task: Register Capture Payload
- type: api-workflow
- resource: QoyodCaseApiWorkflows
- callback: `POST /api/case/batches/{batchId}/stage`

## T05: Stage Extraction And Reconciliation
- task: Start And Wait Extraction
- type: api-workflow
- resource: QoyodCaseStartAndWaitExtraction
- callback: `POST /api/case/batches/{batchId}/extraction/start`, `GET /api/case/batches/{batchId}/progress`, and stage/exception callbacks

## T06: Stage Finance Review And Mapping
- task: Review Correct And Map Batch
- type: action
- resource: qoyodinvoicereviewaction
- callback: `POST /api/case/batches/{batchId}/stage`

## T07: Stage Destination Posting
- task: Persist Review And Wait Posting
- type: api-workflow
- resource: QoyodCasePersistReviewAndWaitPosting
- callback: `GET /api/case/batches/{batchId}/progress`, then stage/exception/close callback

## T08: Stage Qoyod Drafting
- task: Wait For Qoyod Extension Draft Save
- type: api-workflow
- resource: QoyodCaseWaitForQoyodExtensionDraft
- callback: `GET /api/case/batches/{batchId}/progress`, then stage/exception/close callback

## T09: Stage Exception Resolution
- task: Resolve Batch Invoice Intake Exception
- type: action
- resource: qoyodinvoicereviewaction
- callback: `POST /api/case/batches/{batchId}/exception`

## T10: Stage Closed
- task: Record Case Closure
- type: api-workflow
- resource: QoyodCaseRecordCaseClosure
- callback: `POST /api/case/batches/{batchId}/close`

## T11: Routing Conditions
- Capture Intake enters on case-entered.
- Extraction And Reconciliation enters after Capture Intake completes.
- Finance Review And Mapping enters after Extraction And Reconciliation completes and errorCode is empty.
- Destination Posting enters after Finance Review And Mapping completes without rejection or error.
- Qoyod Drafting enters after Destination Posting when backend progress says the next stage is Qoyod Drafting.
- Exception Resolution enters by user selection or extraction/review/posting/drafting error.
- Closed enters after ERPNext-only posting completes, Qoyod draft_saved, or resolved/rejected exception.
- Case completes when the required Closed stage completes.
