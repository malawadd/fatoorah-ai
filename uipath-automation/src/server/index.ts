import "./env";
import cors from "cors";
import express, { type Request, type Response } from "express";
import multer from "multer";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { ZodError } from "zod";
import type { AttachmentRef, CaseStage, CaseStatus, DestinationPlatform, IntakeJob, InvoiceBatch, InvoiceDraft, JobEvent, ValidationResult } from "../shared/invoice";
import { caseStages, caseStatuses, destinationLabel, invoiceDraftSchema, jobStatuses, normalizeInvoiceDraft, upsertDestinationState } from "../shared/invoice";
import { decodeZatcaTlv } from "../shared/zatca";
import {
  destinationPlatformsFromBody,
  destinationReadyStates,
  erpNextReviewPostAction,
  mergeDestinationStates,
  readyDestinationMessage,
  releasedJobStatus,
  statusAfterDestinationPosting
} from "./destinations";
import { buildCaseBatchProgress } from "./caseProgress";
import { createErpNextPurchaseInvoiceDraft, erpNextDestinationState, preflightErpNext } from "./erpnext";
import { buildExtractionJobInput, extractInvoiceDraft, startExternalExtraction } from "./extraction";
import { reconcileDraft } from "./reconciliation";
import { jobStore, UPLOAD_DIR } from "./store";
import { createInvoiceQueueItem, maybeStartBatchCase, maybeStartInvoiceCase, uploadAttachmentToBucket, type UiPathCommandResult } from "./uipathCli";

const PORT = Number(process.env.PORT ?? 8787);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, UPLOAD_DIR),
    filename: (_request, file, callback) => {
      const extension = path.extname(file.originalname) || ".upload";
      callback(null, `${Date.now()}-${uuid()}${extension}`);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_request, file, callback) => {
    callback(null, allowedMimeTypes.has(file.mimetype));
  }
});
const batchUpload = upload.array("documents", 50);

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const fillWritableStatuses = new Set(["ready_for_qoyod", "qoyod_filling", "draft_saved", "error"]);
const deprecatedRobotStatusMap: Record<string, IntakeJob["status"]> = {
  ready_for_robot: "ready_for_qoyod",
  robot_running: "qoyod_filling"
};

function asyncHandler(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response) => {
    handler(request, response).catch((error) => {
      console.error(error);
      if (error instanceof ZodError) {
        response.status(400).json({
          error: "Invalid invoice draft payload.",
          issues: error.issues
        });
        return;
      }

      response.status(500).json({
        error: error instanceof Error ? error.message : "Unexpected server error."
      });
    });
  };
}

function draftFromCapture(attachment: AttachmentRef, qrPayload?: string): InvoiceDraft {
  const qrTlv = qrPayload ? decodeZatcaTlv(qrPayload) ?? undefined : undefined;
  const grandTotal = qrTlv?.totalWithVat ?? 0;
  const vatTotal = qrTlv?.vatTotal ?? 0;
  const issueDate = qrTlv?.timestamp ? qrTlv.timestamp.slice(0, 10) : "";

  return {
    supplierName: qrTlv?.sellerName ?? "",
    supplierTaxId: qrTlv?.vatRegistrationNumber ?? "",
    invoiceNumber: "",
    issueDate,
    dueDate: "",
    currency: "SAR",
    subtotal: grandTotal && vatTotal ? Math.round((grandTotal - vatTotal) * 100) / 100 : 0,
    discount: 0,
    vatTotal,
    grandTotal,
    attachmentRefs: [attachment],
    qrTlv,
    lineItems: []
  };
}

function requestFiles(request: Request): Express.Multer.File[] {
  if (Array.isArray(request.files)) return request.files;
  if (request.file) return [request.file];
  return [];
}

function parseQrPayloads(body: Record<string, unknown>): Array<string | undefined> | Record<string, string> {
  const raw = typeof body.qrPayloads === "string" ? body.qrPayloads.trim() : "";
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((item) => typeof item === "string" && item.trim() ? item.trim() : undefined);
      }
      if (parsed && typeof parsed === "object") {
        return Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
            .map(([key, value]) => [key, value.trim()])
        );
      }
    } catch {
      return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }
  }

  const single = typeof body.qrPayload === "string" && body.qrPayload.trim() ? body.qrPayload.trim() : undefined;
  return single ? [single] : [];
}

function qrPayloadForFile(payloads: Array<string | undefined> | Record<string, string>, file: Express.Multer.File, index: number): string | undefined {
  if (Array.isArray(payloads)) return payloads[index];
  return payloads[file.originalname] ?? payloads[String(index)] ?? payloads[String(index + 1)];
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

function verifyRobotToken(request: Request, response: Response): boolean {
  const token = process.env.ROBOT_API_TOKEN;
  if (token && request.header("x-robot-token") !== token) {
    response.status(401).json({ error: "Invalid robot token." });
    return false;
  }
  return true;
}

function verifyFillToken(request: Request, response: Response): boolean {
  const token = process.env.FILLER_API_TOKEN || process.env.ROBOT_API_TOKEN;
  if (token && request.header("x-fill-token") !== token && request.header("x-robot-token") !== token) {
    response.status(401).json({ error: "Invalid Qoyod fill token." });
    return false;
  }
  return true;
}

function verifyCaseToken(request: Request, response: Response): boolean {
  const token = process.env.CASE_CALLBACK_TOKEN;
  if (token && request.header("x-case-token") !== token) {
    response.status(401).json({ error: "Invalid case callback token." });
    return false;
  }
  return true;
}

function verifyDestinationToken(request: Request, response: Response): boolean {
  const accepted = [
    process.env.DESTINATION_POST_TOKEN,
    process.env.CASE_CALLBACK_TOKEN,
    process.env.INTAKE_WEBHOOK_TOKEN
  ].filter((token): token is string => Boolean(token));
  const provided = request.header("x-destination-token") ?? request.header("x-case-token") ?? request.header("x-intake-token");

  if (accepted.length > 0 && (!provided || !accepted.includes(provided))) {
    response.status(401).json({ error: "Invalid destination post token." });
    return false;
  }
  return true;
}

function verifyExtractionToken(request: Request, response: Response): boolean {
  const extractionToken = process.env.EXTRACTION_CALLBACK_TOKEN;
  const caseToken = process.env.CASE_CALLBACK_TOKEN;
  const fillToken = process.env.FILLER_API_TOKEN || process.env.ROBOT_API_TOKEN;
  const provided = request.header("x-extraction-token") ?? request.header("x-case-token") ?? request.header("x-fill-token");
  const accepted = [extractionToken, caseToken, fillToken].filter((token): token is string => Boolean(token));

  if (accepted.length > 0 && (!provided || !accepted.includes(provided))) {
    response.status(401).json({ error: "Invalid extraction token." });
    return false;
  }
  return true;
}

function requestBaseUrl(request: Request): string {
  return (process.env.PUBLIC_API_BASE_URL || process.env.INVOICE_INTAKE_API_BASE_URL || `${request.protocol}://${request.get("host")}`).replace(/\/$/, "");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalCaseStage(value: unknown): CaseStage | undefined {
  return caseStages.includes(value as CaseStage) ? value as CaseStage : undefined;
}

function optionalCaseStatus(value: unknown): CaseStatus | undefined {
  return caseStatuses.includes(value as CaseStatus) ? value as CaseStatus : undefined;
}

function commandDetails(result: UiPathCommandResult, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    mode: result.mode,
    command: result.command,
    data: result.data,
    error: result.error,
    message: result.message
  };
}

function caseEventDetails(request: Request, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    workflowName: optionalString(request.body.workflowName),
    taskName: optionalString(request.body.taskName),
    taskStatus: optionalString(request.body.taskStatus),
    caseStage: optionalString(request.body.caseStage),
    caseStatus: optionalString(request.body.caseStatus),
    caseJobKey: optionalString(request.body.caseJobKey),
    caseInstanceId: optionalString(request.body.caseInstanceId)
  };
}

function destinationsForDecision(body: unknown): DestinationPlatform[] {
  const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const decision = String(payload.reviewDecision ?? "").toLowerCase();
  if (["approve_for_erpnext", "ready_for_erpnext"].includes(decision)) return ["erpnext"];
  if (["approve_for_qoyod", "ready_for_robot"].includes(decision)) return ["qoyod"];
  if (["approve_for_all", "ready_for_all"].includes(decision)) return ["qoyod", "erpnext"];
  return destinationPlatformsFromBody(body);
}

function reviewPatch(
  current: IntakeJob,
  draft: InvoiceDraft,
  validation: ValidationResult,
  platforms: DestinationPlatform[],
  messagePrefix?: string
): Partial<IntakeJob> {
  const now = new Date().toISOString();
  const canRelease = validation.canSubmitToRobot;
  const destinations = canRelease
    ? mergeDestinationStates(current.destinations, destinationReadyStates(platforms, now))
    : current.destinations;

  return {
    status: releasedJobStatus(validation, platforms),
    fill: canRelease && platforms.includes("qoyod") ? {
      method: "chrome_extension",
      status: "ready",
      updatedAt: now
    } : current.fill,
    destinations,
    draft,
    validation,
    events: [
      ...current.events,
      {
        at: now,
        level: canRelease ? "info" : "warning",
        message: canRelease
          ? `${messagePrefix ? `${messagePrefix} ` : ""}${readyDestinationMessage(platforms)}`
          : `${messagePrefix ? `${messagePrefix} ` : ""}Review saved with blocking checks.`
      }
    ]
  };
}

async function postDestinationForJob(jobId: string, platform: DestinationPlatform, source: "api" | "case" | "review" | "batch-review"): Promise<{ job: IntakeJob; ok: boolean; skipped?: boolean }> {
  if (platform !== "erpnext") {
    throw new Error(`Destination ${platform} does not support backend API posting.`);
  }

  const current = await jobStore.get(jobId);
  if (!current) {
    throw new Error(`Job ${jobId} was not found.`);
  }

  const existingDestination = current.destinations?.find((destination) => destination.platform === platform);
  if (existingDestination?.status === "draft_created") {
    const nextStatus = statusAfterDestinationPosting(current, platform, "success");
    if (current.status === nextStatus) {
      return { job: current, ok: true, skipped: true };
    }
    const job = await jobStore.update(current.jobId, {
      status: nextStatus,
      events: [
        ...current.events,
        {
          at: new Date().toISOString(),
          level: "info",
          message: "ERPNext Purchase Invoice draft already exists; posting skipped."
        }
      ]
    });
    return { job, ok: true, skipped: true };
  }

  const validation = current.validation ?? reconcileDraft(current.draft);
  if (!validation.canSubmitToRobot) {
    const job = await jobStore.update(current.jobId, {
      status: "needs_review",
      validation,
      events: [
        ...current.events,
        {
          at: new Date().toISOString(),
          level: "warning",
          message: `ERPNext posting blocked by review checks: ${validation.blocking.join(" ")}`
        }
      ]
    });
    return { job, ok: false };
  }

  const startedAt = new Date().toISOString();
  const startedJob = await jobStore.update(current.jobId, {
    status: statusAfterDestinationPosting(current, platform, "started"),
    validation,
    destinations: upsertDestinationState(current.destinations, {
      platform,
      status: "posting",
      requestedAt: current.destinations?.find((destination) => destination.platform === platform)?.requestedAt ?? startedAt,
      startedAt,
      updatedAt: startedAt
    }),
    events: [
      ...current.events,
      {
        at: startedAt,
        level: "info",
        message: `${destinationLabel(platform)} posting started by ${source}.`
      }
    ]
  });

  try {
    const result = await createErpNextPurchaseInvoiceDraft(startedJob);
    const state = erpNextDestinationState(result);
    const destinations = upsertDestinationState(startedJob.destinations, state);
    const jobForStatus = { ...startedJob, destinations };
    const job = await jobStore.update(startedJob.jobId, {
      status: statusAfterDestinationPosting(jobForStatus, platform, "success"),
      destinations,
      events: [
        ...startedJob.events,
        {
          at: new Date().toISOString(),
          level: "info",
          message: `ERPNext Purchase Invoice draft created: ${result.invoiceName}.`,
          details: {
            platform,
            externalReference: result.invoiceName,
            externalUrl: result.invoiceUrl,
            attachmentName: result.attachmentName,
            attachmentUrl: result.attachmentUrl
          }
        }
      ]
    });
    return { job, ok: true };
  } catch (error) {
    const now = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const destinations = upsertDestinationState(startedJob.destinations, {
      platform,
      status: "error",
      errorCode: "erpnext_post_failed",
      errorMessage: message,
      requestedAt: startedJob.destinations?.find((destination) => destination.platform === platform)?.requestedAt,
      startedAt,
      updatedAt: now
    });
    const jobForStatus = { ...startedJob, destinations };
    const job = await jobStore.update(startedJob.jobId, {
      status: statusAfterDestinationPosting(jobForStatus, platform, "error"),
      destinations,
      events: [
        ...startedJob.events,
        {
          at: now,
          level: "error",
          message: `ERPNext posting failed: ${message}`,
          details: { platform, errorCode: "erpnext_post_failed", errorMessage: message }
        }
      ]
    });
    return { job, ok: false };
  }
}

async function postErpNextAfterReview(job: IntakeJob, platforms: DestinationPlatform[], source: "review" | "batch-review"): Promise<IntakeJob> {
  const action = erpNextReviewPostAction(job, platforms);
  if (action === "post") {
    const result = await postDestinationForJob(job.jobId, "erpnext", source);
    return result.job;
  }

  if (action === "skip_created") {
    const nextStatus = statusAfterDestinationPosting(job, "erpnext", "success");
    if (job.status !== nextStatus) {
      return jobStore.update(job.jobId, {
        status: nextStatus,
        events: [
          ...job.events,
          {
            at: new Date().toISOString(),
            level: "info",
            message: "ERPNext Purchase Invoice draft already exists; review saved without reposting."
          }
        ]
      });
    }
  }

  return job;
}

function casePatchFromBody(body: unknown): Pick<IntakeJob, "caseInstanceId" | "caseJobKey" | "caseExternalId" | "caseStage"> {
  const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
  return {
    caseInstanceId: optionalString(payload.caseInstanceId),
    caseJobKey: optionalString(payload.caseJobKey),
    caseExternalId: optionalString(payload.caseExternalId),
    caseStage: optionalString(payload.caseStage)
  };
}

function caseStartPatch(data: unknown): Pick<IntakeJob, "caseInstanceId" | "caseJobKey" | "caseExternalId" | "caseStage"> {
  const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
  return {
    caseInstanceId: optionalString(payload.CaseInstanceId) ?? optionalString(payload.caseInstanceId) ?? optionalString(payload.ProcessInstanceKey),
    caseJobKey: optionalString(payload.JobKey) ?? optionalString(payload.jobKey),
    caseExternalId: optionalString(payload.ExternalId) ?? optionalString(payload.externalId),
    caseStage: "Capture Intake"
  };
}

function batchCasePatchFromBody(body: unknown): Partial<Pick<
  InvoiceBatch,
  "caseInstanceId" | "caseJobKey" | "caseExternalId" | "caseStage" | "caseStatus" | "caseRuntimeMode" | "exceptionCode" | "exceptionMessage"
>> {
  const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const runtimeMode = optionalString(payload.caseRuntimeMode);
  const patch = {
    caseInstanceId: optionalString(payload.caseInstanceId),
    caseJobKey: optionalString(payload.caseJobKey),
    caseExternalId: optionalString(payload.caseExternalId),
    caseStage: optionalCaseStage(payload.caseStage),
    caseStatus: optionalCaseStatus(payload.caseStatus),
    caseRuntimeMode: runtimeMode === "live" || runtimeMode === "fallback" || runtimeMode === "blocked" ? runtimeMode : undefined,
    exceptionCode: optionalString(payload.exceptionCode) ?? optionalString(payload.errorCode),
    exceptionMessage: optionalString(payload.exceptionMessage) ?? optionalString(payload.message)
  };
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<Pick<
    InvoiceBatch,
    "caseInstanceId" | "caseJobKey" | "caseExternalId" | "caseStage" | "caseStatus" | "caseRuntimeMode" | "exceptionCode" | "exceptionMessage"
  >>;
}

function batchCaseStartPatch(data: unknown, mode: "dry-run" | "uip"): Partial<Pick<
  InvoiceBatch,
  "caseInstanceId" | "caseJobKey" | "caseExternalId" | "caseStage" | "caseStatus" | "caseRuntimeMode" | "caseStartedAt"
>> {
  const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
  return {
    caseInstanceId: optionalString(payload.CaseInstanceId) ?? optionalString(payload.caseInstanceId) ?? optionalString(payload.ProcessInstanceKey),
    caseJobKey: optionalString(payload.JobKey) ?? optionalString(payload.jobKey),
    caseExternalId: optionalString(payload.ExternalId) ?? optionalString(payload.externalId),
    caseStage: "Capture Intake",
    caseStatus: mode === "dry-run" ? "fallback" : "active",
    caseRuntimeMode: mode === "dry-run" ? "fallback" : "live",
    caseStartedAt: new Date().toISOString()
  };
}

async function dispatchToUiPath(
  job: IntakeJob,
  uploadedFile: Express.Multer.File,
  options: { startInvoiceCase?: boolean } = {}
): Promise<IntakeJob> {
  const startInvoiceCase = options.startInvoiceCase ?? true;
  const uploadResult = await uploadAttachmentToBucket(job, uploadedFile.path, uploadedFile.mimetype);
  let workingJob = job;

  if (uploadResult.error) {
    workingJob = await jobStore.appendEvent(job.jobId, {
      level: "warning",
      message: `UiPath bucket upload skipped or failed: ${uploadResult.error}`,
      details: commandDetails(uploadResult, {
        operation: "or.bucket-files.upload",
        bucketPath: uploadResult.bucketPath
      })
    });
  } else {
    const attachmentRefs = workingJob.draft.attachmentRefs.map((attachment) =>
      attachment.id === workingJob.draft.attachmentRefs[0]?.id
        ? { ...attachment, bucketPath: uploadResult.bucketPath }
        : attachment
    );
    workingJob = await jobStore.update(job.jobId, {
      draft: { ...workingJob.draft, attachmentRefs },
      events: [
        ...workingJob.events,
        {
          at: new Date().toISOString(),
          level: "info",
          message: uploadResult.mode === "dry-run" ? "UiPath bucket upload recorded in dry-run mode." : "Attachment uploaded to Orchestrator bucket.",
          details: commandDetails(uploadResult, {
            operation: "or.bucket-files.upload",
            bucketPath: uploadResult.bucketPath
          })
        }
      ]
    });
  }

  const queueResult = await createInvoiceQueueItem(workingJob);
  if (queueResult.error) {
    workingJob = await jobStore.appendEvent(workingJob.jobId, {
      level: "warning",
      message: `UiPath queue item skipped or failed: ${queueResult.error}`,
      details: commandDetails(queueResult, {
        operation: "or.queue-items.add"
      })
    });
  } else {
    const queueData = queueResult.data as { UniqueKey?: string; uniqueKey?: string } | undefined;
    const queueKey = queueData?.UniqueKey ?? queueData?.uniqueKey;
    workingJob = await jobStore.update(workingJob.jobId, {
      queueItemKey: queueKey,
      caseStage: "Capture Intake",
      events: [
        ...workingJob.events,
        {
          at: new Date().toISOString(),
          level: "info",
          message: queueResult.mode === "dry-run" ? "InvoiceIntake queue item recorded in dry-run mode." : "InvoiceIntake queue item created.",
          details: commandDetails(queueResult, {
            operation: "or.queue-items.add",
            queueItemKey: queueKey
          })
        }
      ]
    });
  }

  if (startInvoiceCase) {
    const caseResult = await maybeStartInvoiceCase(workingJob);
    if (caseResult?.error) {
      workingJob = await jobStore.appendEvent(workingJob.jobId, {
        level: "warning",
        message: `Maestro Case start skipped or failed: ${caseResult.error}`,
        details: commandDetails(caseResult, {
          operation: "maestro.case.process.run",
          scope: "invoice"
        })
      });
    } else if (caseResult) {
      workingJob = await jobStore.update(workingJob.jobId, {
        ...caseStartPatch(caseResult.data),
        events: [
          ...workingJob.events,
          {
            at: new Date().toISOString(),
            level: "info",
            message: caseResult.mode === "dry-run" ? "Maestro Case start recorded in dry-run mode." : "Maestro Case started.",
            details: commandDetails(caseResult, {
              operation: "maestro.case.process.run",
              scope: "invoice"
            })
          }
        ]
      });
    }
  }

  return workingJob;
}

async function startExtraction(job: IntakeJob, apiBaseUrl: string, trigger: "capture" | "case" | "manual"): Promise<IntakeJob> {
  const mode = process.env.EXTRACTION_MODE === "external" ? "external" : "local";
  const startingJob = await jobStore.update(job.jobId, {
    status: "extracting",
    caseStage: "Extraction And Reconciliation",
    events: [
      ...job.events,
      {
        at: new Date().toISOString(),
        level: "info",
        message: mode === "external"
          ? `External extraction requested by ${trigger}.`
          : `Local LLM extraction started by ${trigger}.`
      }
    ]
  });

  const input = buildExtractionJobInput(startingJob, apiBaseUrl);
  if (mode === "external") {
    try {
      await startExternalExtraction(startingJob, input);
      return jobStore.appendEvent(startingJob.jobId, {
        level: "info",
        message: "External extraction service accepted the job."
      });
    } catch (error) {
      return jobStore.setStatus(
        startingJob.jobId,
        "error",
        error instanceof Error ? error.message : String(error),
        "error"
      );
    }
  }

  void runLocalExtraction(startingJob);
  return startingJob;
}

async function createCapturedJob(
  uploadedFile: Express.Multer.File,
  qrPayload: string | undefined,
  apiBaseUrl: string,
  options: { batchId?: string; batchSequence?: number } = {}
): Promise<IntakeJob> {
  const attachment: AttachmentRef = {
    id: uuid(),
    name: uploadedFile.originalname,
    mimeType: uploadedFile.mimetype,
    size: uploadedFile.size,
    localPath: uploadedFile.path
  };
  const draft = draftFromCapture(attachment, qrPayload);
  const created = await jobStore.create(draft, {
    ...options,
    sourceFileName: uploadedFile.originalname
  });
  const dispatched = await dispatchToUiPath(created, uploadedFile, {
    startInvoiceCase: !options.batchId
  });
  return startExtraction(dispatched, apiBaseUrl, "capture");
}

async function startMaestroBatchCase(batchId: string) {
  const details = await jobStore.getBatchDetails(batchId);
  if (!details) {
    throw new Error(`Batch ${batchId} was not found.`);
  }

  const caseResult = await maybeStartBatchCase(details.batch, details.jobs);
  if (!caseResult) {
    await jobStore.appendBatchEvent(batchId, {
      level: "info",
      message: "Local Case cockpit fallback is active. Enable UIPATH_START_CASE to start a live Maestro Case.",
      details: {
        operation: "maestro.case.process.run",
        scope: "batch",
        mode: "fallback"
      }
    });
    return jobStore.getBatchDetails(batchId);
  }

  if (caseResult.error) {
    await jobStore.updateBatchCase(batchId, {
      caseStage: "Exception Resolution",
      caseStatus: "blocked",
      caseRuntimeMode: "blocked",
      exceptionCode: "maestro_case_start_failed",
      exceptionMessage: caseResult.error
    }, {
      level: "warning",
      message: `Maestro Case batch start skipped or failed: ${caseResult.error}`,
      details: commandDetails(caseResult, {
        operation: "maestro.case.process.run",
        scope: "batch"
      })
    });
    return jobStore.getBatchDetails(batchId);
  }

  await jobStore.updateBatchCase(batchId, batchCaseStartPatch(caseResult.data, caseResult.mode), {
    level: "info",
    message: caseResult.mode === "dry-run" ? "Maestro Case batch start recorded in dry-run mode." : "Maestro Case started for this batch.",
    details: commandDetails(caseResult, {
      operation: "maestro.case.process.run",
      scope: "batch"
    })
  });
  return jobStore.getBatchDetails(batchId);
}

async function runLocalExtraction(job: IntakeJob): Promise<void> {
  try {
    const result = await extractInvoiceDraft(job);
    const current = await jobStore.get(job.jobId);
    if (!current) return;

    const validation = reconcileDraft(result.draft);
    await jobStore.update(job.jobId, {
      status: "needs_review",
      draft: result.draft,
      validation,
      extraction: result.extraction,
      events: [
        ...current.events,
        {
          at: new Date().toISOString(),
          level: result.extraction.provider === "manual" ? "warning" : "info",
          message: result.extraction.provider === "manual"
            ? result.extraction.warnings[0] ?? "Extraction requires manual review."
            : `LLM extraction completed with ${result.extraction.provider}.`
        }
      ]
    });
  } catch (error) {
    const current = await jobStore.get(job.jobId);
    if (!current) return;

    await jobStore.update(job.jobId, {
      status: "error",
      extraction: {
        provider: "manual",
        confidence: 0,
        warnings: [error instanceof Error ? error.message : String(error)]
      },
      events: [
        ...current.events,
        {
          at: new Date().toISOString(),
          level: "error",
          message: `Local LLM extraction failed: ${error instanceof Error ? error.message : String(error)}`
        }
      ]
    });
  }
}

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    service: "qoyod-invoice-intake-api",
    time: new Date().toISOString()
  });
});

app.get("/api/jobs", asyncHandler(async (_request, response) => {
  response.json({ jobs: await jobStore.list() });
}));

app.get("/api/jobs/:jobId", asyncHandler(async (request, response) => {
  const job = await jobStore.get(routeParam(request.params.jobId));
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }
  response.json({ job });
}));

app.get("/api/batches", asyncHandler(async (_request, response) => {
  response.json({ batches: await jobStore.listBatchSummaries() });
}));

app.post("/api/batches", batchUpload, asyncHandler(async (request, response) => {
  const files = requestFiles(request);
  if (!files.length) {
    response.status(400).json({ error: "At least one invoice upload is required in the documents field." });
    return;
  }

  const batchName = optionalString(request.body.batchName) ?? optionalString(request.body.name);
  const batch = await jobStore.createBatch(batchName);
  const qrPayloads = parseQrPayloads(request.body as Record<string, unknown>);
  const jobs: IntakeJob[] = [];

  for (const [index, file] of files.entries()) {
    const job = await createCapturedJob(file, qrPayloadForFile(qrPayloads, file, index), requestBaseUrl(request), {
      batchId: batch.batchId,
      batchSequence: index + 1
    });
    jobs.push(job);
  }

  const details = await startMaestroBatchCase(batch.batchId) ?? await jobStore.getBatchDetails(batch.batchId);
  response.status(201).json({ batch: details?.batch ?? batch, summary: details?.summary, jobs: details?.jobs ?? jobs });
}));

app.get("/api/batches/:batchId", asyncHandler(async (request, response) => {
  const batch = await jobStore.getBatchDetails(routeParam(request.params.batchId));
  if (!batch) {
    response.status(404).json({ error: "Batch not found." });
    return;
  }
  response.json(batch);
}));

app.get("/api/case/batches/:batchId", asyncHandler(async (request, response) => {
  if (!verifyCaseToken(request, response)) return;

  const batch = await jobStore.getBatchDetails(routeParam(request.params.batchId));
  if (!batch) {
    response.status(404).json({ error: "Batch not found." });
    return;
  }
  response.json(batch);
}));

app.post("/api/case/batches/:batchId/extraction/start", asyncHandler(async (request, response) => {
  if (!verifyCaseToken(request, response)) return;

  const batchId = routeParam(request.params.batchId);
  const current = await jobStore.getBatchDetails(batchId);
  if (!current) {
    response.status(404).json({ error: "Batch not found." });
    return;
  }

  let startedCount = 0;
  let skippedCount = 0;
  for (const job of current.jobs) {
    if (job.status === "uploaded" || job.status === "queued") {
      await startExtraction(job, requestBaseUrl(request), "case");
      startedCount += 1;
    } else {
      skippedCount += 1;
    }
  }

  await jobStore.updateBatchCase(batchId, {
    ...batchCasePatchFromBody(request.body),
    caseStage: "Extraction And Reconciliation",
    caseStatus: "active",
    caseRuntimeMode: "live"
  }, {
    level: "info",
    message: optionalString(request.body.message) ?? `Maestro extraction workflow checked ${current.jobs.length} invoice(s); started ${startedCount}.`,
    details: caseEventDetails(request, {
      operation: "case.batch.extraction.start",
      startedCount,
      skippedCount
    })
  });

  const updated = await jobStore.getBatchDetails(batchId);
  if (!updated) {
    response.status(404).json({ error: "Batch not found after extraction start." });
    return;
  }

  response.status(202).json({
    batch: updated,
    startedCount,
    skippedCount,
    progress: buildCaseBatchProgress(updated, process.env.PUBLIC_WEB_APP_URL)
  });
}));

app.get("/api/case/batches/:batchId/progress", asyncHandler(async (request, response) => {
  if (!verifyCaseToken(request, response)) return;

  const batch = await jobStore.getBatchDetails(routeParam(request.params.batchId));
  if (!batch) {
    response.status(404).json({ error: "Batch not found." });
    return;
  }

  response.json({ progress: buildCaseBatchProgress(batch, process.env.PUBLIC_WEB_APP_URL) });
}));

app.post("/api/case/batches/:batchId/stage", asyncHandler(async (request, response) => {
  if (!verifyCaseToken(request, response)) return;

  const batchId = routeParam(request.params.batchId);
  const current = await jobStore.getBatchDetails(batchId);
  if (!current) {
    response.status(404).json({ error: "Batch not found." });
    return;
  }

  const stage = optionalCaseStage(request.body.caseStage) ?? current.batch.caseStage ?? "Capture Intake";
  await jobStore.updateBatchCase(batchId, {
    ...batchCasePatchFromBody(request.body),
    caseStage: stage,
    caseStatus: optionalCaseStatus(request.body.caseStatus) ?? "active",
    caseRuntimeMode: "live"
  }, {
    level: "info",
    message: optionalString(request.body.message) ?? `Maestro Case stage changed to ${stage}.`,
    details: caseEventDetails(request, { operation: "case.batch.stage" })
  });

  response.json(await jobStore.getBatchDetails(batchId));
}));

app.post("/api/case/batches/:batchId/task", asyncHandler(async (request, response) => {
  if (!verifyCaseToken(request, response)) return;

  const batchId = routeParam(request.params.batchId);
  const current = await jobStore.getBatchDetails(batchId);
  if (!current) {
    response.status(404).json({ error: "Batch not found." });
    return;
  }

  const taskName = optionalString(request.body.taskName) ?? "Maestro task";
  const taskStatus = optionalString(request.body.taskStatus) ?? "updated";
  const stage = optionalCaseStage(request.body.caseStage) ?? current.batch.caseStage ?? "Capture Intake";
  await jobStore.updateBatchCase(batchId, {
    ...batchCasePatchFromBody(request.body),
    caseStage: stage,
    caseStatus: optionalCaseStatus(request.body.caseStatus) ?? "active",
    caseRuntimeMode: "live"
  }, {
    level: taskStatus === "failed" ? "error" : "info",
    message: optionalString(request.body.message) ?? `${taskName} ${taskStatus}.`,
    details: caseEventDetails(request, { operation: "case.batch.task" })
  });

  response.json(await jobStore.getBatchDetails(batchId));
}));

app.post("/api/case/batches/:batchId/exception", asyncHandler(async (request, response) => {
  if (!verifyCaseToken(request, response)) return;

  const batchId = routeParam(request.params.batchId);
  const current = await jobStore.getBatchDetails(batchId);
  if (!current) {
    response.status(404).json({ error: "Batch not found." });
    return;
  }

  const errorCode = optionalString(request.body.errorCode) ?? optionalString(request.body.exceptionCode) ?? "case_exception";
  const message = optionalString(request.body.message) ?? `Maestro Case exception: ${errorCode}`;
  await jobStore.updateBatchCase(batchId, {
    ...batchCasePatchFromBody(request.body),
    caseStage: "Exception Resolution",
    caseStatus: "exception",
    caseRuntimeMode: "live",
    exceptionCode: errorCode,
    exceptionMessage: message
  }, {
    level: "error",
    message,
    details: caseEventDetails(request, { operation: "case.batch.exception" })
  });

  response.json(await jobStore.getBatchDetails(batchId));
}));

app.post("/api/case/batches/:batchId/close", asyncHandler(async (request, response) => {
  if (!verifyCaseToken(request, response)) return;

  const batchId = routeParam(request.params.batchId);
  const current = await jobStore.getBatchDetails(batchId);
  if (!current) {
    response.status(404).json({ error: "Batch not found." });
    return;
  }

  await jobStore.updateBatchCase(batchId, {
    ...batchCasePatchFromBody(request.body),
    caseStage: "Closed",
    caseStatus: "closed",
    caseRuntimeMode: "live",
    exceptionCode: undefined,
    exceptionMessage: undefined
  }, {
    level: "info",
    message: optionalString(request.body.message) ?? "Maestro Case closed.",
    details: caseEventDetails(request, { operation: "case.batch.close" })
  });

  response.json(await jobStore.getBatchDetails(batchId));
}));

app.post("/api/batches/:batchId/apply-mappings", asyncHandler(async (request, response) => {
  const result = await jobStore.applyMappingRulesToBatch(routeParam(request.params.batchId));
  response.json({ ...result.batch, appliedCount: result.appliedCount });
}));

app.post("/api/batches/:batchId/bulk-review", asyncHandler(async (request, response) => {
  const batchId = routeParam(request.params.batchId);
  const batch = await jobStore.getBatchDetails(batchId);
  if (!batch) {
    response.status(404).json({ error: "Batch not found." });
    return;
  }

  const reviews = Array.isArray(request.body.reviews) ? request.body.reviews : [];
  const batchJobIds = new Set(batch.jobs.map((job) => job.jobId));
  for (const item of reviews) {
    const payload = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const jobId = optionalString(payload.jobId);
    if (!jobId || !batchJobIds.has(jobId)) continue;

    const draft = normalizeInvoiceDraft(invoiceDraftSchema.parse(payload.draft));
    const validation = reconcileDraft(draft);
    const current = await jobStore.get(jobId);
    if (!current) continue;
    const platforms = "destinations" in payload || "destinationPlatforms" in payload
      ? destinationPlatformsFromBody(payload)
      : destinationPlatformsFromBody(request.body);
    const reviewed = await jobStore.update(jobId, reviewPatch(current, draft, validation, platforms, "Batch review saved."));
    await postErpNextAfterReview(reviewed, platforms, "batch-review");
  }

  const updated = await jobStore.getBatchDetails(batchId);
  response.json(updated);
}));

app.get("/api/destinations", (_request, response) => {
  response.json({
    destinations: [
      { platform: "qoyod", label: "Qoyod", method: "chrome_extension" },
      { platform: "erpnext", label: "ERPNext", method: "api" }
    ],
    defaults: destinationPlatformsFromBody({})
  });
});

app.get("/api/destinations/erpnext/preflight", asyncHandler(async (request, response) => {
  if (!verifyDestinationToken(request, response)) return;

  const result = await preflightErpNext({
    supplierName: optionalString(request.query.supplierName),
    itemCode: optionalString(request.query.itemCode)
  });
  response.status(result.ok ? 200 : 424).json(result);
}));

app.post("/api/jobs/:jobId/destinations/:platform/post", asyncHandler(async (request, response) => {
  if (!verifyDestinationToken(request, response)) return;

  const platform = String(routeParam(request.params.platform)).toLowerCase();
  if (platform !== "erpnext") {
    response.status(400).json({ error: `Unsupported posting destination: ${platform}` });
    return;
  }

  const jobId = routeParam(request.params.jobId);
  if (!await jobStore.get(jobId)) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const result = await postDestinationForJob(jobId, platform, "api");
  response.status(result.ok ? 200 : 424).json({ job: result.job });
}));

app.post("/api/case/jobs/:jobId/destinations/:platform/post", asyncHandler(async (request, response) => {
  if (!verifyCaseToken(request, response)) return;

  const platform = String(routeParam(request.params.platform)).toLowerCase();
  if (platform !== "erpnext") {
    response.status(400).json({ error: `Unsupported posting destination: ${platform}` });
    return;
  }

  const jobId = routeParam(request.params.jobId);
  if (!await jobStore.get(jobId)) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const result = await postDestinationForJob(jobId, platform, "case");
  response.status(result.ok ? 200 : 424).json({ job: result.job });
}));

app.get("/api/mappings", asyncHandler(async (_request, response) => {
  response.json({ rules: await jobStore.listMappingRules() });
}));

app.post("/api/mappings", asyncHandler(async (request, response) => {
  const rule = await jobStore.upsertMappingRule({
    ruleId: optionalString(request.body.ruleId),
    active: request.body.active === undefined ? true : request.body.active === true,
    type: request.body.type === "item" ? "item" : "expense",
    qoyodId: optionalString(request.body.qoyodId) ?? optionalString(request.body.id) ?? optionalString(request.body.label),
    label: optionalString(request.body.label),
    supplierName: optionalString(request.body.supplierName),
    supplierTaxId: optionalString(request.body.supplierTaxId),
    matchText: optionalString(request.body.matchText),
    matchMode: request.body.matchMode === "exact" ? "exact" : "contains",
    taxRate: typeof request.body.taxRate === "number" || typeof request.body.taxRate === "string" ? Number(request.body.taxRate) : undefined
  });
  response.status(201).json({ rule });
}));

app.delete("/api/mappings/:ruleId", asyncHandler(async (request, response) => {
  const deleted = await jobStore.deleteMappingRule(routeParam(request.params.ruleId));
  response.json({ deleted });
}));

app.post("/api/extraction/jobs/:jobId/start", asyncHandler(async (request, response) => {
  if (!verifyExtractionToken(request, response)) return;

  const job = await jobStore.get(routeParam(request.params.jobId));
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const updated = await startExtraction(job, requestBaseUrl(request), request.header("x-case-token") ? "case" : "manual");
  response.status(202).json({ job: updated, input: buildExtractionJobInput(updated, requestBaseUrl(request)) });
}));

app.get("/api/extraction/jobs/:jobId/input", asyncHandler(async (request, response) => {
  if (!verifyExtractionToken(request, response)) return;

  const job = await jobStore.get(routeParam(request.params.jobId));
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }
  response.json({ input: buildExtractionJobInput(job, requestBaseUrl(request)) });
}));

app.get("/api/extraction/jobs/:jobId/source", asyncHandler(async (request, response) => {
  if (!verifyExtractionToken(request, response)) return;

  const job = await jobStore.get(routeParam(request.params.jobId));
  const attachment = job?.draft.attachmentRefs[0];
  if (!job || !attachment?.localPath) {
    response.status(404).json({ error: "Source attachment not found." });
    return;
  }

  response.type(attachment.mimeType);
  response.sendFile(attachment.localPath);
}));

app.post("/api/extraction/jobs/:jobId/result", asyncHandler(async (request, response) => {
  if (!verifyExtractionToken(request, response)) return;

  const current = await jobStore.get(routeParam(request.params.jobId));
  if (!current) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const draft = normalizeInvoiceDraft(invoiceDraftSchema.parse(request.body.draft));
  const validation = reconcileDraft(draft);
  const provider = String(request.body.provider ?? "external");
  const providerName = ["openai", "deepseek", "external", "mock", "manual"].includes(provider) ? provider as "openai" | "deepseek" | "external" | "mock" | "manual" : "external";
  const warnings = Array.isArray(request.body.warnings)
    ? request.body.warnings.filter((item: unknown): item is string => typeof item === "string")
    : [];
  const job = await jobStore.update(current.jobId, {
    status: "needs_review",
    caseStage: "Extraction And Reconciliation",
    draft,
    validation,
    extraction: {
      provider: providerName,
      model: optionalString(request.body.model),
      confidence: typeof request.body.confidence === "number" ? request.body.confidence : undefined,
      warnings
    },
    events: [
      ...current.events,
      {
        at: new Date().toISOString(),
        level: validation.canSubmitToRobot ? "info" : "warning",
        message: validation.canSubmitToRobot
          ? "Extraction result received and reconciled."
          : "Extraction result received with blocking review checks."
      }
    ]
  });

  response.json({ job });
}));

app.post("/api/fill/jobs/claim-next", asyncHandler(async (request, response) => {
  if (!verifyFillToken(request, response)) return;

  const job = await jobStore.claimNextForFill(optionalString(request.body.batchId));
  response.json({ job: job ?? null });
}));

app.get("/api/fill/jobs/:jobId", asyncHandler(async (request, response) => {
  if (!verifyFillToken(request, response)) return;

  const job = await jobStore.get(routeParam(request.params.jobId));
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }
  response.json({ job });
}));

app.get("/api/fill/jobs/:jobId/source", asyncHandler(async (request, response) => {
  if (!verifyFillToken(request, response)) return;

  const job = await jobStore.get(routeParam(request.params.jobId));
  const attachment = job?.draft.attachmentRefs[0];
  if (!job || !attachment?.localPath) {
    response.status(404).json({ error: "Source attachment not found." });
    return;
  }

  response.type(attachment.mimeType);
  response.sendFile(attachment.localPath);
}));

app.post("/api/fill/jobs/:jobId/status", asyncHandler(async (request, response) => {
  if (!verifyFillToken(request, response)) return;

  const current = await jobStore.get(routeParam(request.params.jobId));
  if (!current) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const rawStatus = String(request.body.status ?? "");
  const status = deprecatedRobotStatusMap[rawStatus] ?? rawStatus;
  if (!jobStatuses.includes(status as (typeof jobStatuses)[number]) || !fillWritableStatuses.has(status)) {
    response.status(400).json({ error: "Unsupported Qoyod fill status." });
    return;
  }

  const message = optionalString(request.body.message) ?? `Qoyod fill status changed to ${status}.`;
  const now = new Date().toISOString();
  const qoyodDraftReference = optionalString(request.body.qoyodDraftReference);
  const errorCode = optionalString(request.body.errorCode);
  const job = await jobStore.update(current.jobId, {
    status: status as IntakeJob["status"],
    fill: {
      method: "chrome_extension",
      status: status === "draft_saved" ? "draft_saved" : status === "error" ? "error" : status === "ready_for_qoyod" ? "cancelled" : "filling",
      errorCode,
      qoyodDraftReference,
      claimedAt: current.fill?.claimedAt,
      updatedAt: now
    },
    destinations: upsertDestinationState(current.destinations, {
      platform: "qoyod",
      status: status === "draft_saved" ? "draft_created" : status === "error" ? "error" : status === "ready_for_qoyod" ? "cancelled" : "posting",
      externalReference: qoyodDraftReference,
      errorCode: status === "error" ? errorCode ?? "qoyod_fill_failed" : undefined,
      errorMessage: status === "error" ? message : undefined,
      requestedAt: current.destinations?.find((destination) => destination.platform === "qoyod")?.requestedAt,
      startedAt: current.destinations?.find((destination) => destination.platform === "qoyod")?.startedAt,
      completedAt: status === "draft_saved" ? now : undefined,
      updatedAt: now
    }),
    events: [
      ...current.events,
      {
        at: now,
        level: status === "error" ? "error" : "info",
        message
      }
    ]
  });

  response.json({ job });
}));

app.get("/api/robot/jobs/next", asyncHandler(async (request, response) => {
  if (!verifyRobotToken(request, response)) return;

  const jobs = await jobStore.list();
  const job = jobs
    .filter((candidate) => candidate.status === "ready_for_qoyod" || candidate.status === "ready_for_robot")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];

  response.json({ job: job ?? null });
}));

app.get("/api/robot/jobs/:jobId", asyncHandler(async (request, response) => {
  if (!verifyRobotToken(request, response)) return;

  const job = await jobStore.get(routeParam(request.params.jobId));
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }
  response.json({ job });
}));

app.post("/api/robot/jobs/:jobId/status", asyncHandler(async (request, response) => {
  if (!verifyRobotToken(request, response)) return;

  const current = await jobStore.get(routeParam(request.params.jobId));
  if (!current) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const rawStatus = String(request.body.status ?? "");
  const status = deprecatedRobotStatusMap[rawStatus] ?? rawStatus;
  if (!jobStatuses.includes(status as (typeof jobStatuses)[number]) || !fillWritableStatuses.has(status)) {
    response.status(400).json({ error: "Unsupported robot status." });
    return;
  }

  const message = typeof request.body.message === "string" && request.body.message.trim()
    ? request.body.message.trim()
    : `Robot status changed to ${status}.`;
  const level: JobEvent["level"] = status === "error" ? "error" : "info";
  const robotJobKey = typeof request.body.robotJobKey === "string" ? request.body.robotJobKey : current.robotJobKey;
  const qoyodDraftReference = optionalString(request.body.qoyodDraftReference);
  const errorCode = optionalString(request.body.errorCode);
  const job = await jobStore.update(current.jobId, {
    status: status as IntakeJob["status"],
    robotJobKey,
    fill: {
      method: "chrome_extension",
      status: status === "draft_saved" ? "draft_saved" : status === "error" ? "error" : "filling",
      errorCode,
      qoyodDraftReference,
      claimedAt: current.fill?.claimedAt,
      updatedAt: new Date().toISOString()
    },
    destinations: upsertDestinationState(current.destinations, {
      platform: "qoyod",
      status: status === "draft_saved" ? "draft_created" : status === "error" ? "error" : "posting",
      externalReference: qoyodDraftReference,
      errorCode: status === "error" ? errorCode ?? "qoyod_fill_failed" : undefined,
      errorMessage: status === "error" ? message : undefined,
      requestedAt: current.destinations?.find((destination) => destination.platform === "qoyod")?.requestedAt,
      startedAt: current.destinations?.find((destination) => destination.platform === "qoyod")?.startedAt,
      completedAt: status === "draft_saved" ? new Date().toISOString() : undefined,
      updatedAt: new Date().toISOString()
    }),
    events: [
      ...current.events,
      {
        at: new Date().toISOString(),
        level,
        message
      }
    ]
  });

  response.json({ job });
}));

app.post("/api/captures", upload.single("document"), asyncHandler(async (request, response) => {
  if (!request.file) {
    response.status(400).json({ error: "A photo or PDF upload is required in the document field." });
    return;
  }

  const qrPayload = typeof request.body.qrPayload === "string" ? request.body.qrPayload : undefined;
  const job = await createCapturedJob(request.file, qrPayload, requestBaseUrl(request));

  response.status(201).json({ jobId: job.jobId, job });
}));

app.post("/api/jobs/:jobId/extraction", asyncHandler(async (request, response) => {
  const token = process.env.INTAKE_WEBHOOK_TOKEN;
  if (token && request.header("x-intake-token") !== token) {
    response.status(401).json({ error: "Invalid intake webhook token." });
    return;
  }

  const current = await jobStore.get(routeParam(request.params.jobId));
  if (!current) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const draft = normalizeInvoiceDraft(invoiceDraftSchema.parse(request.body.draft));
  const validation = reconcileDraft(draft);
  const job = await jobStore.update(current.jobId, {
    status: "needs_review",
    draft,
    validation,
    events: [
      ...current.events,
      {
        at: new Date().toISOString(),
        level: "info",
        message: "Extraction result received."
      }
    ]
  });

  response.json({ job });
}));

app.post("/api/case/jobs/:jobId/extraction", asyncHandler(async (request, response) => {
  if (!verifyCaseToken(request, response)) return;

  const current = await jobStore.get(routeParam(request.params.jobId));
  if (!current) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const draft = normalizeInvoiceDraft(invoiceDraftSchema.parse(request.body.draft));
  const validation = reconcileDraft(draft);
  const job = await jobStore.update(current.jobId, {
    ...casePatchFromBody(request.body),
    caseStage: "Extraction And Reconciliation",
    status: "needs_review",
    draft,
    validation,
    events: [
      ...current.events,
      {
        at: new Date().toISOString(),
        level: validation.canSubmitToRobot ? "info" : "warning",
        message: validation.canSubmitToRobot
          ? "Maestro Case extraction and reconciliation result received."
          : "Maestro Case extraction needs review or correction."
      }
    ]
  });

  response.json({ job });
}));

app.post("/api/jobs/:jobId/review", asyncHandler(async (request, response) => {
  const current = await jobStore.get(routeParam(request.params.jobId));
  if (!current) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const draft = normalizeInvoiceDraft(invoiceDraftSchema.parse(request.body.draft));
  const validation = reconcileDraft(draft);
  const platforms = destinationPlatformsFromBody(request.body);
  const reviewed = await jobStore.update(current.jobId, {
    ...reviewPatch(current, draft, validation, platforms)
  });
  const job = await postErpNextAfterReview(reviewed, platforms, "review");

  response.json({ job });
}));

app.post("/api/case/jobs/:jobId/review", asyncHandler(async (request, response) => {
  if (!verifyCaseToken(request, response)) return;

  const current = await jobStore.get(routeParam(request.params.jobId));
  if (!current) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const draft = normalizeInvoiceDraft(invoiceDraftSchema.parse(request.body.draft));
  const validation = reconcileDraft(draft);
  const reviewDecision = String(request.body.reviewDecision ?? "save").toLowerCase();
  const rejected = ["reject", "rejected"].includes(reviewDecision);
  const approved = ["approve", "approve_for_qoyod", "ready_for_robot", "approve_for_erpnext", "ready_for_erpnext", "approve_for_all", "ready_for_all"].includes(reviewDecision);
  const patch = rejected
    ? {
      ...casePatchFromBody(request.body),
      caseStage: "Finance Review And Mapping",
      status: "rejected" as const,
      draft,
      validation,
      events: [
        ...current.events,
        {
          at: new Date().toISOString(),
          level: "warning" as const,
          message: "Maestro Case review rejected the invoice."
        }
      ]
    }
    : approved
      ? {
        ...casePatchFromBody(request.body),
        caseStage: "Finance Review And Mapping",
        ...reviewPatch(current, draft, validation, destinationsForDecision(request.body), "Maestro Case review approved.")
      }
      : {
        ...casePatchFromBody(request.body),
        caseStage: "Finance Review And Mapping",
        status: "needs_review" as const,
        draft,
        validation,
        events: [
          ...current.events,
          {
            at: new Date().toISOString(),
            level: "warning" as const,
            message: "Maestro Case review saved with blocking checks or incomplete mapping."
          }
        ]
      };
  const job = await jobStore.update(current.jobId, patch);

  response.json({ job });
}));

app.post("/api/case/jobs/:jobId/exception", asyncHandler(async (request, response) => {
  if (!verifyCaseToken(request, response)) return;

  const current = await jobStore.get(routeParam(request.params.jobId));
  if (!current) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const errorCode = optionalString(request.body.errorCode) ?? "case_exception";
  const message = optionalString(request.body.message) ?? `Maestro Case exception: ${errorCode}`;
  const resolved = request.body.resolved === true;
  const job = await jobStore.update(current.jobId, {
    ...casePatchFromBody(request.body),
    caseStage: optionalString(request.body.caseStage) ?? "Exception Resolution",
    status: resolved ? "needs_review" : "error",
    events: [
      ...current.events,
      {
        at: new Date().toISOString(),
        level: resolved ? "info" : "error",
        message
      }
    ]
  });

  response.json({ job });
}));

await jobStore.init();
app.listen(PORT, () => {
  console.log(`Qoyod invoice intake API listening on http://localhost:${PORT}`);
});
