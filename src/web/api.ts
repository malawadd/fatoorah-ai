import type { BatchDetails, BatchSummary, DestinationPlatform, IntakeJob, InvoiceDraft, QoyodMappingRule } from "../shared/invoice";

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function uploadCapture(file: File, qrPayload: string): Promise<IntakeJob> {
  const formData = new FormData();
  formData.append("document", file);
  if (qrPayload.trim()) {
    formData.append("qrPayload", qrPayload.trim());
  }

  const response = await fetch("/api/captures", {
    method: "POST",
    body: formData
  });
  const body = await parseResponse<{ job: IntakeJob }>(response);
  return body.job;
}

export async function uploadBatch(files: File[], batchName: string, qrPayloads: string[]): Promise<BatchDetails> {
  const formData = new FormData();
  files.forEach((file) => formData.append("documents", file));
  if (batchName.trim()) formData.append("batchName", batchName.trim());
  if (qrPayloads.some(Boolean)) {
    formData.append("qrPayloads", JSON.stringify(qrPayloads.map((item) => item.trim())));
  }

  const response = await fetch("/api/batches", {
    method: "POST",
    body: formData
  });
  const body = await parseResponse<{ batch: BatchDetails["batch"]; summary: BatchSummary; jobs: IntakeJob[] }>(response);
  return { batch: body.batch, summary: body.summary, jobs: body.jobs };
}

export async function listBatches(): Promise<BatchSummary[]> {
  const response = await fetch("/api/batches");
  const body = await parseResponse<{ batches: BatchSummary[] }>(response);
  return body.batches;
}

export async function getBatch(batchId: string): Promise<BatchDetails> {
  const response = await fetch(`/api/batches/${batchId}`);
  return parseResponse<BatchDetails>(response);
}

export async function applyBatchMappings(batchId: string): Promise<BatchDetails & { appliedCount: number }> {
  const response = await fetch(`/api/batches/${batchId}/apply-mappings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  return parseResponse<BatchDetails & { appliedCount: number }>(response);
}

export async function bulkReviewBatch(batchId: string, reviews: Array<{ jobId: string; draft: InvoiceDraft; destinations?: DestinationPlatform[] }>): Promise<BatchDetails> {
  const response = await fetch(`/api/batches/${batchId}/bulk-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviews })
  });
  return parseResponse<BatchDetails>(response);
}

export async function getJob(jobId: string): Promise<IntakeJob> {
  const response = await fetch(`/api/jobs/${jobId}`);
  const body = await parseResponse<{ job: IntakeJob }>(response);
  return body.job;
}

export async function saveReview(jobId: string, draft: InvoiceDraft, destinations?: DestinationPlatform[]): Promise<IntakeJob> {
  const response = await fetch(`/api/jobs/${jobId}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft, destinations })
  });
  const body = await parseResponse<{ job: IntakeJob }>(response);
  return body.job;
}

export async function listMappings(): Promise<QoyodMappingRule[]> {
  const response = await fetch("/api/mappings");
  const body = await parseResponse<{ rules: QoyodMappingRule[] }>(response);
  return body.rules;
}

export async function saveMappingRule(rule: Partial<QoyodMappingRule>): Promise<QoyodMappingRule> {
  const response = await fetch("/api/mappings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rule)
  });
  const body = await parseResponse<{ rule: QoyodMappingRule }>(response);
  return body.rule;
}

export async function deleteMappingRule(ruleId: string): Promise<void> {
  await parseResponse<{ deleted: boolean }>(await fetch(`/api/mappings/${ruleId}`, { method: "DELETE" }));
}
