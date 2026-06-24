import { z } from "zod";

export const jobStatuses = [
  "uploaded",
  "queued",
  "extracting",
  "needs_review",
  "reviewed",
  "ready_for_qoyod",
  "qoyod_filling",
  "ready_for_robot",
  "robot_running",
  "posting",
  "posted",
  "posting_error",
  "draft_saved",
  "rejected",
  "error"
] as const;

export const batchStatuses = [
  "open",
  "processing",
  "needs_review",
  "reviewed",
  "ready_for_qoyod",
  "qoyod_filling",
  "posting",
  "posted",
  "posting_error",
  "draft_saved",
  "mixed",
  "error",
  "closed"
] as const;

export const caseStages = [
  "Capture Intake",
  "Extraction And Reconciliation",
  "Finance Review And Mapping",
  "Destination Posting",
  "Qoyod Drafting",
  "Exception Resolution",
  "Closed"
] as const;

export const caseStatuses = [
  "not_started",
  "starting",
  "active",
  "fallback",
  "blocked",
  "exception",
  "closed"
] as const;

export const extractionProviderSchema = z.enum(["openai", "deepseek", "external", "mock", "manual"]);
export const caseStageSchema = z.enum(caseStages);
export const caseStatusSchema = z.enum(caseStatuses);
export const destinationPlatformSchema = z.enum(["qoyod", "erpnext"]);
export const destinationStatusSchema = z.enum(["ready", "posting", "draft_created", "submitted", "error", "cancelled"]);

export const extractionMetadataSchema = z.object({
  provider: extractionProviderSchema,
  model: z.string().optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  warnings: z.array(z.string()).default([])
});

export const fillMetadataSchema = z.object({
  method: z.literal("chrome_extension"),
  status: z.enum(["ready", "claimed", "filling", "draft_saved", "error", "cancelled"]),
  errorCode: z.string().optional(),
  qoyodDraftReference: z.string().optional(),
  claimedAt: z.string().optional(),
  updatedAt: z.string().optional()
});

export const destinationStateSchema = z.object({
  platform: destinationPlatformSchema,
  status: destinationStatusSchema,
  externalReference: z.string().optional(),
  externalUrl: z.string().optional(),
  attachmentName: z.string().optional(),
  attachmentUrl: z.string().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  requestedAt: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  updatedAt: z.string()
});

export const mappingSchema = z.object({
  type: z.enum(["item", "expense"]),
  id: z.string().min(1),
  label: z.string().min(1)
});

export const mappingRuleSchema = z.object({
  ruleId: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  active: z.boolean().default(true),
  type: z.enum(["item", "expense"]),
  qoyodId: z.string().min(1),
  label: z.string().min(1),
  supplierName: z.string().optional(),
  supplierTaxId: z.string().optional(),
  matchText: z.string().min(1),
  matchMode: z.enum(["contains", "exact"]).default("contains"),
  taxRate: z.coerce.number().nonnegative().optional()
});

export const lineItemSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  quantity: z.coerce.number().nonnegative(),
  unitPrice: z.coerce.number().nonnegative(),
  discount: z.coerce.number().nonnegative().default(0),
  taxRate: z.coerce.number().nonnegative().default(15),
  taxAmount: z.coerce.number().nonnegative().default(0),
  total: z.coerce.number().nonnegative(),
  selectedQoyodMapping: mappingSchema.optional()
});

export const attachmentRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().nonnegative(),
  localPath: z.string().optional(),
  bucketKey: z.string().optional(),
  bucketPath: z.string().optional()
});

export const qrTlvSchema = z.object({
  sellerName: z.string().optional(),
  vatRegistrationNumber: z.string().optional(),
  timestamp: z.string().optional(),
  totalWithVat: z.number().optional(),
  vatTotal: z.number().optional(),
  rawPayload: z.string(),
  rawTags: z.record(z.string())
});

export const invoiceDraftSchema = z.object({
  supplierName: z.string().default(""),
  supplierTaxId: z.string().default(""),
  invoiceNumber: z.string().default(""),
  issueDate: z.string().default(""),
  dueDate: z.string().default(""),
  currency: z.string().default("SAR"),
  subtotal: z.coerce.number().nonnegative().default(0),
  discount: z.coerce.number().nonnegative().default(0),
  vatTotal: z.coerce.number().nonnegative().default(0),
  grandTotal: z.coerce.number().nonnegative().default(0),
  attachmentRefs: z.array(attachmentRefSchema).default([]),
  qrTlv: qrTlvSchema.optional(),
  lineItems: z.array(lineItemSchema).default([])
});

export const validationResultSchema = z.object({
  canSubmitToRobot: z.boolean(),
  blocking: z.array(z.string()),
  warnings: z.array(z.string()),
  totals: z.object({
    lineSubtotal: z.number(),
    lineVat: z.number(),
    lineGrandTotal: z.number(),
    headerGrandTotal: z.number(),
    headerVatTotal: z.number()
  })
});

export const jobEventSchema = z.object({
  at: z.string(),
  level: z.enum(["info", "warning", "error"]),
  message: z.string(),
  details: z.unknown().optional()
});

export const batchOptionsSchema = z.object({
  readyPolicy: z.literal("per_invoice").default("per_invoice"),
  autoApplyMappings: z.boolean().default(true)
});

export const intakeJobSchema = z.object({
  jobId: z.string().min(1),
  status: z.enum(jobStatuses),
  createdAt: z.string(),
  updatedAt: z.string(),
  draft: invoiceDraftSchema,
  validation: validationResultSchema.optional(),
  events: z.array(jobEventSchema).default([]),
  queueItemKey: z.string().optional(),
  robotJobKey: z.string().optional(),
  caseInstanceId: z.string().optional(),
  caseJobKey: z.string().optional(),
  caseExternalId: z.string().optional(),
  caseStage: z.string().optional(),
  extraction: extractionMetadataSchema.optional(),
  fill: fillMetadataSchema.optional(),
  destinations: z.array(destinationStateSchema).default([]),
  batchId: z.string().optional(),
  batchSequence: z.number().int().nonnegative().optional(),
  sourceFileName: z.string().optional(),
  duplicateKey: z.string().optional(),
  reviewFlags: z.array(z.string()).optional()
});

export const batchSchema = z.object({
  batchId: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(batchStatuses),
  createdAt: z.string(),
  updatedAt: z.string(),
  options: batchOptionsSchema,
  jobIds: z.array(z.string()).default([]),
  events: z.array(jobEventSchema).default([]),
  caseInstanceId: z.string().optional(),
  caseJobKey: z.string().optional(),
  caseExternalId: z.string().optional(),
  caseStage: caseStageSchema.optional(),
  caseStatus: caseStatusSchema.optional(),
  caseRuntimeMode: z.enum(["live", "fallback", "blocked"]).optional(),
  caseStartedAt: z.string().optional(),
  caseUpdatedAt: z.string().optional(),
  exceptionCode: z.string().optional(),
  exceptionMessage: z.string().optional()
});

export const batchSummarySchema = z.object({
  batchId: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(batchStatuses),
  createdAt: z.string(),
  updatedAt: z.string(),
  totalJobs: z.number().int().nonnegative(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  caseStage: caseStageSchema.optional(),
  caseStatus: caseStatusSchema.optional(),
  caseRuntimeMode: z.enum(["live", "fallback", "blocked"]).optional(),
  caseInstanceId: z.string().optional(),
  caseExternalId: z.string().optional(),
  exceptionCode: z.string().optional(),
  exceptionMessage: z.string().optional()
});

export type JobStatus = (typeof jobStatuses)[number];
export type BatchStatus = (typeof batchStatuses)[number];
export type CaseStage = (typeof caseStages)[number];
export type CaseStatus = (typeof caseStatuses)[number];
export type DestinationPlatform = z.infer<typeof destinationPlatformSchema>;
export type DestinationStatus = z.infer<typeof destinationStatusSchema>;
export type ExtractionMetadata = z.infer<typeof extractionMetadataSchema>;
export type FillMetadata = z.infer<typeof fillMetadataSchema>;
export type DestinationState = z.infer<typeof destinationStateSchema>;
export type QoyodMapping = z.infer<typeof mappingSchema>;
export type QoyodMappingRule = z.infer<typeof mappingRuleSchema>;
export type InvoiceLineItem = z.infer<typeof lineItemSchema>;
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
export type ZatcaQr = z.infer<typeof qrTlvSchema>;
export type InvoiceDraft = z.infer<typeof invoiceDraftSchema>;
export type ValidationResult = z.infer<typeof validationResultSchema>;
export type JobEvent = z.infer<typeof jobEventSchema>;
export type IntakeJob = z.infer<typeof intakeJobSchema>;
export type BatchOptions = z.infer<typeof batchOptionsSchema>;
export type InvoiceBatch = z.infer<typeof batchSchema>;
export type BatchSummary = z.infer<typeof batchSummarySchema>;

export type BatchDetails = {
  batch: InvoiceBatch;
  jobs: IntakeJob[];
  summary: BatchSummary;
};

export function emptyDraft(): InvoiceDraft {
  return {
    supplierName: "",
    supplierTaxId: "",
    invoiceNumber: "",
    issueDate: "",
    dueDate: "",
    currency: "SAR",
    subtotal: 0,
    discount: 0,
    vatTotal: 0,
    grandTotal: 0,
    attachmentRefs: [],
    lineItems: []
  };
}

export function money(value: number | undefined): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function normalizedText(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[ـ]/g, "")
    .replace(/\s+/g, " ");
}

export function recalculateLineTotals(line: InvoiceLineItem): InvoiceLineItem {
  const net = Math.max(0, money(line.quantity * line.unitPrice - line.discount));
  const taxAmount = money(net * (line.taxRate / 100));
  const total = money(net + taxAmount);
  return { ...line, taxAmount, total };
}

export function deriveHeaderTotalsFromLines(draft: InvoiceDraft): InvoiceDraft {
  const normalizedLines = draft.lineItems.map(recalculateLineTotals);
  return {
    ...draft,
    lineItems: normalizedLines,
    subtotal: money(normalizedLines.reduce((sum, line) => sum + Math.max(0, line.quantity * line.unitPrice - line.discount), 0)),
    vatTotal: money(normalizedLines.reduce((sum, line) => sum + line.taxAmount, 0)),
    grandTotal: money(normalizedLines.reduce((sum, line) => sum + line.total, 0))
  };
}

export function normalizeInvoiceDraft(draft: InvoiceDraft, options: { deriveHeaderTotals?: boolean } = {}): InvoiceDraft {
  const normalized = {
    ...draft,
    lineItems: draft.lineItems.map(recalculateLineTotals)
  };
  return options.deriveHeaderTotals ? deriveHeaderTotalsFromLines(normalized) : normalized;
}

export function duplicateKeyForDraft(draft: InvoiceDraft): string | undefined {
  const taxId = normalizedText(draft.supplierTaxId);
  const invoiceNumber = normalizedText(draft.invoiceNumber);
  if (!taxId || !invoiceNumber) return undefined;
  return `${taxId}:${invoiceNumber}`;
}

export function destinationLabel(platform: DestinationPlatform): string {
  return platform === "erpnext" ? "ERPNext" : "Qoyod";
}

export function upsertDestinationState(
  destinations: DestinationState[] | undefined,
  next: DestinationState
): DestinationState[] {
  const current = destinations ?? [];
  const index = current.findIndex((destination) => destination.platform === next.platform);
  if (index === -1) return [...current, next];
  return current.map((destination, currentIndex) => currentIndex === index ? { ...destination, ...next } : destination);
}

export function normalizeDestinationPlatforms(
  platforms: unknown,
  fallback: DestinationPlatform[] = ["qoyod"]
): DestinationPlatform[] {
  const raw = Array.isArray(platforms)
    ? platforms
    : typeof platforms === "string"
      ? platforms.split(",")
      : fallback;
  const unique = new Set<DestinationPlatform>();
  for (const platform of raw) {
    const normalized = String(platform).trim().toLowerCase();
    if (destinationPlatformSchema.safeParse(normalized).success) {
      unique.add(normalized as DestinationPlatform);
    }
  }
  return unique.size ? Array.from(unique) : fallback;
}

export function batchStatusFromJobs(jobs: IntakeJob[]): BatchStatus {
  if (!jobs.length) return "open";
  if (jobs.every((job) => job.status === "posted")) return "posted";
  if (jobs.every((job) => job.status === "draft_saved")) return "draft_saved";
  if (jobs.every((job) => job.status === "posted" || job.status === "draft_saved")) return "posted";
  if (jobs.some((job) => job.status === "posting_error")) return "posting_error";
  if (jobs.some((job) => job.status === "error")) return "error";
  if (jobs.some((job) => job.status === "posting")) return "posting";
  if (jobs.some((job) => job.status === "qoyod_filling" || job.status === "robot_running")) return "qoyod_filling";
  if (jobs.some((job) => job.status === "extracting" || job.status === "queued" || job.status === "uploaded")) return "processing";
  if (jobs.every((job) => job.status === "ready_for_qoyod" || job.status === "ready_for_robot")) return "ready_for_qoyod";
  if (jobs.every((job) => job.status === "reviewed")) return "reviewed";
  if (jobs.some((job) => job.status === "needs_review")) return "needs_review";
  return "mixed";
}

export function caseStageFromBatchStatus(status: BatchStatus): CaseStage {
  if (status === "open" || status === "processing") return "Extraction And Reconciliation";
  if (status === "needs_review" || status === "mixed") return "Finance Review And Mapping";
  if (status === "reviewed" || status === "posting") return "Destination Posting";
  if (status === "ready_for_qoyod" || status === "qoyod_filling") return "Qoyod Drafting";
  if (status === "error" || status === "posting_error") return "Exception Resolution";
  return "Closed";
}
