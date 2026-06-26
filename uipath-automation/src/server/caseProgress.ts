import type { BatchDetails, CaseStage, DestinationPlatform, DestinationState, IntakeJob } from "../shared/invoice";
import { caseStageFromBatchStatus } from "../shared/invoice";

const extractionPendingStatuses = new Set(["uploaded", "queued", "extracting"]);
const reviewedStatuses = new Set(["reviewed", "ready_for_qoyod", "qoyod_filling", "posting", "posted", "draft_saved", "rejected"]);
const terminalStatuses = new Set(["posted", "draft_saved", "rejected"]);
const doneDestinationStatuses = new Set(["draft_created", "submitted"]);

export type CaseBatchProgress = {
  batchId: string;
  batchName: string;
  batchStatus: string;
  caseStage: CaseStage;
  nextStage: CaseStage;
  caseStatus: "active" | "exception" | "closed";
  reviewUrl?: string;
  counts: Record<string, number>;
  selectedDestinations: DestinationPlatform[];
  flags: {
    extractionComplete: boolean;
    reviewComplete: boolean;
    destinationPostingComplete: boolean;
    qoyodDraftComplete: boolean;
    closed: boolean;
    hasErrors: boolean;
    hasQoyod: boolean;
    hasErpNext: boolean;
  };
  firstJob?: {
    jobId: string;
    draft: IntakeJob["draft"];
    validation?: IntakeJob["validation"];
  };
  jobs: Array<{
    jobId: string;
    status: IntakeJob["status"];
    destinations: IntakeJob["destinations"];
    draftSummary: {
      supplierName: string;
      invoiceNumber: string;
      grandTotal: number;
      currency: string;
    };
  }>;
  references: {
    qoyodDraftReferences: string[];
    erpnextDraftReferences: string[];
  };
  errorCode?: string;
  errorMessage?: string;
};

function destination(job: IntakeJob, platform: DestinationPlatform): DestinationState | undefined {
  return job.destinations?.find((item) => item.platform === platform);
}

function hasDestination(job: IntakeJob, platform: DestinationPlatform): boolean {
  return Boolean(destination(job, platform));
}

function destinationDone(item: DestinationState | undefined): boolean {
  return Boolean(item && doneDestinationStatuses.has(item.status));
}

function destinationFailed(item: DestinationState | undefined): boolean {
  return item?.status === "error";
}

function jobHasError(job: IntakeJob): boolean {
  return job.status === "error" || job.status === "posting_error" || job.destinations?.some(destinationFailed) === true;
}

function selectedDestinations(jobs: IntakeJob[]): DestinationPlatform[] {
  const selected = new Set<DestinationPlatform>();
  for (const job of jobs) {
    for (const item of job.destinations ?? []) {
      selected.add(item.platform);
    }
  }
  return Array.from(selected);
}

function referenceList(jobs: IntakeJob[], platform: DestinationPlatform): string[] {
  return jobs
    .map((job) => destination(job, platform)?.externalReference)
    .filter((value): value is string => Boolean(value));
}

function reviewUrlForBatch(publicWebAppUrl: string | undefined, batchId: string): string | undefined {
  if (!publicWebAppUrl) return undefined;
  const base = publicWebAppUrl.replace(/\/$/, "");
  return `${base}/?batchId=${encodeURIComponent(batchId)}`;
}

export function buildCaseBatchProgress(details: BatchDetails, publicWebAppUrl?: string): CaseBatchProgress {
  const jobs = details.jobs;
  const selected = selectedDestinations(jobs);
  const hasQoyod = selected.includes("qoyod");
  const hasErpNext = selected.includes("erpnext");
  const hasErrors = jobs.some(jobHasError);
  const extractionComplete = jobs.length > 0 && jobs.every((job) => !extractionPendingStatuses.has(job.status));
  const reviewComplete = jobs.length > 0 && jobs.every((job) => reviewedStatuses.has(job.status));
  const destinationPostingComplete = !hasErpNext || jobs
    .filter((job) => hasDestination(job, "erpnext"))
    .every((job) => destinationDone(destination(job, "erpnext")));
  const qoyodDraftComplete = !hasQoyod || jobs
    .filter((job) => hasDestination(job, "qoyod"))
    .every((job) => destinationDone(destination(job, "qoyod")));
  const closed = jobs.length > 0 && jobs.every((job) => terminalStatuses.has(job.status)) && destinationPostingComplete && qoyodDraftComplete;

  const nextStage: CaseStage = hasErrors
    ? "Exception Resolution"
    : closed
      ? "Closed"
      : !extractionComplete
        ? "Extraction And Reconciliation"
        : !reviewComplete
          ? "Finance Review And Mapping"
          : hasErpNext && !destinationPostingComplete
            ? "Destination Posting"
            : hasQoyod && !qoyodDraftComplete
              ? "Qoyod Drafting"
              : caseStageFromBatchStatus(details.batch.status);

  const firstErrorDestination = jobs.flatMap((job) => job.destinations ?? []).find(destinationFailed);
  const firstErrorJob = jobs.find(jobHasError);
  const firstJob = jobs[0];

  return {
    batchId: details.batch.batchId,
    batchName: details.batch.name,
    batchStatus: details.batch.status,
    caseStage: details.batch.caseStage ?? "Capture Intake",
    nextStage,
    caseStatus: hasErrors ? "exception" : closed ? "closed" : "active",
    reviewUrl: reviewUrlForBatch(publicWebAppUrl, details.batch.batchId),
    counts: details.summary.counts,
    selectedDestinations: selected,
    flags: {
      extractionComplete,
      reviewComplete,
      destinationPostingComplete,
      qoyodDraftComplete,
      closed,
      hasErrors,
      hasQoyod,
      hasErpNext
    },
    firstJob: firstJob ? {
      jobId: firstJob.jobId,
      draft: firstJob.draft,
      validation: firstJob.validation
    } : undefined,
    jobs: jobs.map((job) => ({
      jobId: job.jobId,
      status: job.status,
      destinations: job.destinations ?? [],
      draftSummary: {
        supplierName: job.draft.supplierName,
        invoiceNumber: job.draft.invoiceNumber,
        grandTotal: job.draft.grandTotal,
        currency: job.draft.currency
      }
    })),
    references: {
      qoyodDraftReferences: referenceList(jobs, "qoyod"),
      erpnextDraftReferences: referenceList(jobs, "erpnext")
    },
    errorCode: firstErrorDestination?.errorCode ?? firstErrorJob?.fill?.errorCode ?? details.batch.exceptionCode,
    errorMessage: firstErrorDestination?.errorMessage ?? details.batch.exceptionMessage
  };
}
