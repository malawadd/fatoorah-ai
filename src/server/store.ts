import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { v4 as uuid } from "uuid";
import type {
  BatchDetails,
  BatchOptions,
  BatchSummary,
  CaseStage,
  CaseStatus,
  IntakeJob,
  InvoiceBatch,
  InvoiceDraft,
  JobEvent,
  JobStatus,
  QoyodMappingRule
} from "../shared/invoice";
import {
  batchOptionsSchema,
  batchSchema,
  caseStageFromBatchStatus,
  batchStatusFromJobs,
  duplicateKeyForDraft,
  emptyDraft,
  intakeJobSchema,
  mappingRuleSchema,
  normalizeInvoiceDraft,
  upsertDestinationState
} from "../shared/invoice";
import { applyMappingRulesToDraft } from "./mapping";
import { reconcileDraft } from "./reconciliation";

const DATA_DIR = path.resolve(process.cwd(), ".data");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const BATCHES_FILE = path.join(DATA_DIR, "batches.json");
const MAPPINGS_FILE = path.join(DATA_DIR, "mapping-rules.json");

type JobPatch = Partial<Omit<IntakeJob, "jobId" | "createdAt">>;
type BatchPatch = Partial<Omit<InvoiceBatch, "batchId" | "createdAt" | "jobIds" | "events">>;
type CreateJobOptions = {
  batchId?: string;
  batchSequence?: number;
  sourceFileName?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function statusCounts(jobs: IntakeJob[]): Record<string, number> {
  return jobs.reduce<Record<string, number>>((counts, job) => {
    counts[job.status] = (counts[job.status] ?? 0) + 1;
    return counts;
  }, {});
}

function appendFlag(flags: string[] | undefined, flag: string, active: boolean): string[] {
  const current = new Set(flags ?? []);
  if (active) {
    current.add(flag);
  } else {
    current.delete(flag);
  }
  return Array.from(current);
}

async function readJsonArray<T>(filePath: string): Promise<T[]> {
  try {
    const file = await readFile(filePath, "utf-8");
    return JSON.parse(file) as T[];
  } catch {
    return [];
  }
}

export class JobStore {
  private jobs = new Map<string, IntakeJob>();
  private batches = new Map<string, InvoiceBatch>();
  private mappingRules = new Map<string, QoyodMappingRule>();
  private loaded = false;

  async init(): Promise<void> {
    await mkdir(UPLOAD_DIR, { recursive: true });
    if (this.loaded) return;

    const parsedJobs = await readJsonArray<unknown>(JOBS_FILE);
    this.jobs = new Map(parsedJobs.map((job) => {
      const parsed = intakeJobSchema.parse(job);
      return [parsed.jobId, parsed];
    }));

    const parsedBatches = await readJsonArray<unknown>(BATCHES_FILE);
    this.batches = new Map(parsedBatches.map((batch) => {
      const parsed = batchSchema.parse(batch);
      return [parsed.batchId, parsed];
    }));

    const parsedRules = await readJsonArray<unknown>(MAPPINGS_FILE);
    this.mappingRules = new Map(parsedRules.map((rule) => {
      const parsed = mappingRuleSchema.parse(rule);
      return [parsed.ruleId, parsed];
    }));

    this.loaded = true;
    await this.persist();
  }

  async create(draft: InvoiceDraft = emptyDraft(), options: CreateJobOptions = {}): Promise<IntakeJob> {
    await this.init();
    const now = nowIso();
    const normalizedDraft = normalizeInvoiceDraft(draft);
    const job: IntakeJob = {
      jobId: uuid(),
      status: "uploaded",
      createdAt: now,
      updatedAt: now,
      draft: normalizedDraft,
      batchId: options.batchId,
      batchSequence: options.batchSequence,
      sourceFileName: options.sourceFileName ?? draft.attachmentRefs[0]?.name,
      duplicateKey: duplicateKeyForDraft(normalizedDraft),
      reviewFlags: [],
      destinations: [],
      events: [{ at: now, level: "info", message: "Capture received." }]
    };
    this.jobs.set(job.jobId, job);

    if (options.batchId) {
      const batch = this.batches.get(options.batchId);
      if (batch && !batch.jobIds.includes(job.jobId)) {
        this.batches.set(batch.batchId, {
          ...batch,
          jobIds: [...batch.jobIds, job.jobId],
          updatedAt: now
        });
      }
    }

    await this.persist();
    return this.jobs.get(job.jobId) ?? job;
  }

  async list(): Promise<IntakeJob[]> {
    await this.init();
    return Array.from(this.jobs.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(jobId: string): Promise<IntakeJob | undefined> {
    await this.init();
    return this.jobs.get(jobId);
  }

  async update(jobId: string, patch: JobPatch): Promise<IntakeJob> {
    await this.init();
    const current = this.jobs.get(jobId);
    if (!current) {
      throw new Error(`Job ${jobId} was not found.`);
    }

    const draft = patch.draft ? normalizeInvoiceDraft(patch.draft) : current.draft;
    const updated: IntakeJob = {
      ...current,
      ...patch,
      draft,
      duplicateKey: duplicateKeyForDraft(draft),
      updatedAt: nowIso()
    };
    this.jobs.set(jobId, updated);
    await this.persist();
    return this.jobs.get(jobId) ?? updated;
  }

  async setStatus(jobId: string, status: JobStatus, message?: string, level: JobEvent["level"] = "info"): Promise<IntakeJob> {
    const current = await this.get(jobId);
    if (!current) throw new Error(`Job ${jobId} was not found.`);

    const events = message
      ? [...current.events, { at: nowIso(), level, message }]
      : current.events;

    return this.update(jobId, { status, events });
  }

  async appendEvent(jobId: string, event: Omit<JobEvent, "at">): Promise<IntakeJob> {
    const current = await this.get(jobId);
    if (!current) throw new Error(`Job ${jobId} was not found.`);

    return this.update(jobId, {
      events: [...current.events, { at: nowIso(), ...event }]
    });
  }

  async createBatch(name?: string, options: Partial<BatchOptions> = {}): Promise<InvoiceBatch> {
    await this.init();
    const now = nowIso();
    const batch: InvoiceBatch = {
      batchId: uuid(),
      name: name?.trim() || `Batch ${new Date().toLocaleString()}`,
      status: "open",
      createdAt: now,
      updatedAt: now,
      options: batchOptionsSchema.parse(options),
      jobIds: [],
      caseStage: "Capture Intake",
      caseStatus: "fallback",
      caseRuntimeMode: "fallback",
      events: [{ at: now, level: "info", message: "Batch created." }]
    };
    this.batches.set(batch.batchId, batch);
    await this.persist();
    return batch;
  }

  async listBatchSummaries(): Promise<BatchSummary[]> {
    await this.init();
    return Array.from(this.batches.values())
      .map((batch) => this.summarizeBatch(batch))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getBatchDetails(batchId: string): Promise<BatchDetails | undefined> {
    await this.init();
    const batch = this.batches.get(batchId);
    if (!batch) return undefined;
    const jobs = this.jobsForBatch(batch);
    return {
      batch,
      jobs,
      summary: this.summarizeBatch(batch)
    };
  }

  async listMappingRules(): Promise<QoyodMappingRule[]> {
    await this.init();
    return Array.from(this.mappingRules.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async upsertMappingRule(input: Partial<QoyodMappingRule>): Promise<QoyodMappingRule> {
    await this.init();
    const now = nowIso();
    const existing = input.ruleId ? this.mappingRules.get(input.ruleId) : undefined;
    const rule = mappingRuleSchema.parse({
      ...existing,
      ...input,
      ruleId: input.ruleId || uuid(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      active: input.active ?? existing?.active ?? true,
      matchMode: input.matchMode ?? existing?.matchMode ?? "contains"
    });
    this.mappingRules.set(rule.ruleId, rule);
    await this.persist();
    return rule;
  }

  async deleteMappingRule(ruleId: string): Promise<boolean> {
    await this.init();
    const deleted = this.mappingRules.delete(ruleId);
    if (deleted) await this.persist();
    return deleted;
  }

  async applyMappingRulesToJob(jobId: string): Promise<{ job: IntakeJob; appliedCount: number }> {
    const current = await this.get(jobId);
    if (!current) throw new Error(`Job ${jobId} was not found.`);
    const { draft, appliedCount } = applyMappingRulesToDraft(current.draft, await this.listMappingRules());
    const validation = reconcileDraft(draft);
    const job = await this.update(jobId, {
      draft,
      validation,
      events: appliedCount
        ? [...current.events, { at: nowIso(), level: "info", message: `Applied ${appliedCount} mapping rule(s).` }]
        : current.events
    });
    return { job, appliedCount };
  }

  async applyMappingRulesToBatch(batchId: string): Promise<{ batch: BatchDetails; appliedCount: number }> {
    await this.init();
    const batch = this.batches.get(batchId);
    if (!batch) throw new Error(`Batch ${batchId} was not found.`);

    let appliedCount = 0;
    for (const job of this.jobsForBatch(batch)) {
      if (job.status === "draft_saved" || job.status === "rejected") continue;
      const result = applyMappingRulesToDraft(job.draft, await this.listMappingRules());
      appliedCount += result.appliedCount;
      if (result.appliedCount) {
        this.jobs.set(job.jobId, {
          ...job,
          draft: result.draft,
          validation: reconcileDraft(result.draft),
          updatedAt: nowIso(),
          events: [...job.events, { at: nowIso(), level: "info", message: `Applied ${result.appliedCount} mapping rule(s).` }]
        });
      }
    }

    await this.persist();
    const details = await this.getBatchDetails(batchId);
    if (!details) throw new Error(`Batch ${batchId} was not found.`);
    return { batch: details, appliedCount };
  }

  async updateBatchCase(
    batchId: string,
    patch: BatchPatch,
    event?: Omit<JobEvent, "at">
  ): Promise<InvoiceBatch> {
    await this.init();
    const current = this.batches.get(batchId);
    if (!current) {
      throw new Error(`Batch ${batchId} was not found.`);
    }

    const now = nowIso();
    const updated: InvoiceBatch = {
      ...current,
      ...patch,
      updatedAt: now,
      caseUpdatedAt: now,
      events: event ? [...current.events, { at: now, ...event }] : current.events
    };
    this.batches.set(batchId, updated);
    await this.persist();
    return this.batches.get(batchId) ?? updated;
  }

  async appendBatchEvent(batchId: string, event: Omit<JobEvent, "at">): Promise<InvoiceBatch> {
    return this.updateBatchCase(batchId, {}, event);
  }

  async claimNextForFill(batchId?: string): Promise<IntakeJob | undefined> {
    await this.init();
    const current = Array.from(this.jobs.values())
      .filter((job) => job.status === "ready_for_qoyod" || job.status === "ready_for_robot")
      .filter((job) => !batchId || job.batchId === batchId)
      .sort((left, right) => {
        const sequence = (left.batchSequence ?? 0) - (right.batchSequence ?? 0);
        return sequence || left.createdAt.localeCompare(right.createdAt);
      })[0];

    if (!current) {
      return undefined;
    }

    const now = nowIso();
    const updated: IntakeJob = {
      ...current,
      status: "qoyod_filling",
      updatedAt: now,
      fill: {
        method: "chrome_extension",
        status: "claimed",
        claimedAt: now,
        updatedAt: now
      },
      destinations: upsertDestinationState(current.destinations, {
        platform: "qoyod",
        status: "posting",
        requestedAt: current.destinations?.find((destination) => destination.platform === "qoyod")?.requestedAt ?? now,
        startedAt: now,
        updatedAt: now
      }),
      events: [
        ...current.events,
        {
          at: now,
          level: "info",
          message: "Qoyod Chrome extension claimed this job for draft filling."
        }
      ]
    };

    this.jobs.set(current.jobId, updated);
    await this.persist();
    return this.jobs.get(current.jobId) ?? updated;
  }

  private jobsForBatch(batch: InvoiceBatch): IntakeJob[] {
    return batch.jobIds
      .map((jobId) => this.jobs.get(jobId))
      .filter((job): job is IntakeJob => Boolean(job))
      .sort((left, right) => (left.batchSequence ?? 0) - (right.batchSequence ?? 0));
  }

  private summarizeBatch(batch: InvoiceBatch): BatchSummary {
    const jobs = this.jobsForBatch(batch);
    return {
      batchId: batch.batchId,
      name: batch.name,
      status: batch.status,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      totalJobs: jobs.length,
      counts: statusCounts(jobs),
      caseStage: batch.caseStage,
      caseStatus: batch.caseStatus,
      caseRuntimeMode: batch.caseRuntimeMode,
      caseInstanceId: batch.caseInstanceId,
      caseExternalId: batch.caseExternalId,
      exceptionCode: batch.exceptionCode,
      exceptionMessage: batch.exceptionMessage
    };
  }

  private refreshDerivedState(): void {
    const duplicateCounts = new Map<string, number>();
    for (const job of this.jobs.values()) {
      const duplicateKey = duplicateKeyForDraft(job.draft);
      if (duplicateKey) duplicateCounts.set(duplicateKey, (duplicateCounts.get(duplicateKey) ?? 0) + 1);
    }

    for (const [jobId, job] of this.jobs.entries()) {
      const duplicateKey = duplicateKeyForDraft(job.draft);
      const isDuplicate = Boolean(duplicateKey && (duplicateCounts.get(duplicateKey) ?? 0) > 1);
      this.jobs.set(jobId, {
        ...job,
        duplicateKey,
        reviewFlags: appendFlag(job.reviewFlags, "duplicate_invoice", isDuplicate)
      });
    }

    for (const [batchId, batch] of this.batches.entries()) {
      const jobs = this.jobsForBatch(batch);
      const status = batchStatusFromJobs(jobs);
      const mirrorCase = batch.caseRuntimeMode === "fallback" || !batch.caseStage;
      const derivedStage: CaseStage = jobs.length ? caseStageFromBatchStatus(status) : "Capture Intake";
      const derivedCaseStatus: CaseStatus = status === "error"
        ? "exception"
        : status === "draft_saved" || status === "closed"
          ? "closed"
          : batch.caseStatus ?? "fallback";
      this.batches.set(batchId, {
        ...batch,
        status,
        caseStage: mirrorCase ? derivedStage : batch.caseStage,
        caseStatus: mirrorCase ? derivedCaseStatus : batch.caseStatus,
        caseRuntimeMode: batch.caseRuntimeMode ?? "fallback",
        updatedAt: jobs.reduce((latest, job) => job.updatedAt > latest ? job.updatedAt : latest, batch.updatedAt)
      });
    }
  }

  private async persist(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    this.refreshDerivedState();
    await Promise.all([
      writeFile(JOBS_FILE, JSON.stringify(Array.from(this.jobs.values()), null, 2)),
      writeFile(BATCHES_FILE, JSON.stringify(Array.from(this.batches.values()), null, 2)),
      writeFile(MAPPINGS_FILE, JSON.stringify(Array.from(this.mappingRules.values()), null, 2))
    ]);
  }
}

export const jobStore = new JobStore();
