import {
  Activity,
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileText,
  FolderOpen,
  Layers3,
  Plus,
  RefreshCw,
  Save,
  ScanLine,
  Trash2,
  Upload,
  Wand2
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BatchDetails, BatchSummary, CaseStage, DestinationPlatform, IntakeJob, InvoiceDraft, InvoiceLineItem, JobStatus, QoyodMapping, QoyodMappingRule } from "../shared/invoice";
import { caseStages, deriveHeaderTotalsFromLines, destinationLabel, normalizeInvoiceDraft, recalculateLineTotals } from "../shared/invoice";
import { decodeZatcaTlv } from "../shared/zatca";
import {
  applyBatchMappings,
  bulkReviewBatch,
  deleteMappingRule,
  getBatch,
  getJob,
  listBatches,
  listMappings,
  saveMappingRule,
  saveReview,
  uploadBatch
} from "./api";

const statusLabels: Record<JobStatus, string> = {
  uploaded: "Uploaded",
  queued: "Queued",
  extracting: "Extracting",
  needs_review: "Needs review",
  reviewed: "Reviewed",
  ready_for_qoyod: "Ready for Qoyod",
  qoyod_filling: "Filling Qoyod",
  ready_for_robot: "Ready for Qoyod",
  robot_running: "Filling Qoyod",
  posting: "Posting",
  posted: "Posted",
  posting_error: "Posting error",
  draft_saved: "Draft saved",
  rejected: "Rejected",
  error: "Error"
};

const destinationOptions: DestinationPlatform[] = ["qoyod", "erpnext"];

const emptyMapping: QoyodMapping = {
  type: "expense",
  id: "",
  label: ""
};

const emptyRule = {
  type: "expense" as QoyodMapping["type"],
  label: "",
  matchText: "",
  supplierScoped: true,
  matchMode: "contains" as QoyodMappingRule["matchMode"]
};

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function newLineItem(): InvoiceLineItem {
  return {
    id: crypto.randomUUID(),
    description: "",
    quantity: 1,
    unitPrice: 0,
    discount: 0,
    taxRate: 15,
    taxAmount: 0,
    total: 0,
    selectedQoyodMapping: { ...emptyMapping }
  };
}

function statusClass(status: string | undefined): string {
  return `status-${status ?? "uploaded"}`;
}

function count(summary: BatchSummary | undefined, status: JobStatus): number {
  return summary?.counts[status] ?? 0;
}

function qrLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function mergeBatchJob(batch: BatchDetails | null, updated: IntakeJob): BatchDetails | null {
  if (!batch) return batch;
  return {
    ...batch,
    jobs: batch.jobs.map((job) => job.jobId === updated.jobId ? updated : job)
  };
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function destinationsForJob(job: IntakeJob | null): DestinationPlatform[] {
  const platforms = job?.destinations?.map((destination) => destination.platform) ?? [];
  return platforms.length ? Array.from(new Set(platforms)) : ["qoyod"];
}

function destinationSummary(job: IntakeJob): string {
  if (!job.destinations?.length) return "Qoyod";
  return job.destinations
    .map((destination) => `${destinationLabel(destination.platform)}: ${destination.status.replace(/_/g, " ")}`)
    .join(" | ");
}

function compactJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item === undefined ? undefined : item, 2);
}

function maestroTimeline(batch: BatchDetails): Array<{ at: string; level: string; scope: string; message: string; details?: unknown }> {
  const batchEvents = batch.batch.events.map((event) => ({
    at: event.at,
    level: event.level,
    scope: "Batch",
    message: event.message,
    details: event.details
  }));
  const jobEvents = batch.jobs.flatMap((job) => job.events.map((event) => ({
    at: event.at,
    level: event.level,
    scope: `Invoice ${job.batchSequence ?? job.jobId.slice(0, 8)}`,
    message: event.message,
    details: event.details
  })));

  return [...batchEvents, ...jobEvents].sort((left, right) => left.at.localeCompare(right.at));
}

function CaseCockpit({ batch }: { batch: BatchDetails }) {
  const [devLogOpen, setDevLogOpen] = useState(false);
  const currentStage: CaseStage = batch.batch.caseStage ?? batch.summary.caseStage ?? "Capture Intake";
  const currentIndex = Math.max(0, caseStages.indexOf(currentStage));
  const runtime = batch.batch.caseRuntimeMode ?? batch.summary.caseRuntimeMode ?? "fallback";
  const status = batch.batch.caseStatus ?? batch.summary.caseStatus ?? "fallback";
  const identifier = batch.batch.caseInstanceId ?? batch.summary.caseInstanceId ?? batch.batch.caseExternalId ?? batch.summary.caseExternalId;
  const runtimeLabel = runtime === "live" ? "Live Maestro" : runtime === "blocked" ? "Maestro blocked" : "Local cockpit fallback";
  const timeline = maestroTimeline(batch);
  const caseSnapshot = {
    batchId: batch.batch.batchId,
    batchName: batch.batch.name,
    batchStatus: batch.batch.status,
    caseRuntimeMode: runtime,
    caseStatus: status,
    caseStage: currentStage,
    caseInstanceId: batch.batch.caseInstanceId,
    caseJobKey: batch.batch.caseJobKey,
    caseExternalId: batch.batch.caseExternalId,
    caseStartedAt: batch.batch.caseStartedAt,
    caseUpdatedAt: batch.batch.caseUpdatedAt,
    exceptionCode: batch.batch.exceptionCode ?? batch.summary.exceptionCode,
    exceptionMessage: batch.batch.exceptionMessage ?? batch.summary.exceptionMessage,
    counts: batch.summary.counts
  };

  return (
    <div className={`case-cockpit case-${status}`}>
      <div className="case-cockpit-header">
        <div>
          <span>Maestro Case</span>
          <strong>{currentStage}</strong>
        </div>
        <div className="case-runtime">
          <span>{runtimeLabel}</span>
          <code>{identifier ? identifier.slice(0, 12) : batch.batch.batchId.slice(0, 8)}</code>
        </div>
      </div>

      <div className="case-stage-strip" aria-label="Maestro Case stages">
        {caseStages.map((stage, index) => {
          const stageClass = stage === currentStage
            ? "active"
            : index < currentIndex || currentStage === "Closed"
              ? "done"
              : "pending";
          return (
            <span className={`case-stage ${stageClass}`} key={stage}>
              {stage}
            </span>
          );
        })}
      </div>

      {(batch.batch.exceptionCode || batch.summary.exceptionCode) && (
        <div className="case-exception">
          <AlertTriangle size={16} />
          <span>{batch.batch.exceptionCode ?? batch.summary.exceptionCode}</span>
          {(batch.batch.exceptionMessage || batch.summary.exceptionMessage) && <small>{batch.batch.exceptionMessage ?? batch.summary.exceptionMessage}</small>}
        </div>
      )}

      <div className="case-dev-log">
        <button
          type="button"
          className="case-dev-log-toggle"
          aria-expanded={devLogOpen}
          onClick={() => setDevLogOpen((open) => !open)}
        >
          <span>
            <Activity size={16} />
            Maestro dev log
          </span>
          <small>{timeline.length} events · {runtimeLabel}</small>
          {devLogOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>

        {devLogOpen && (
          <div className="case-dev-log-body">
            <div className="case-debug-grid">
              <div>
                <span>Stage</span>
                <strong>{currentStage}</strong>
              </div>
              <div>
                <span>Runtime</span>
                <strong>{runtimeLabel}</strong>
              </div>
              <div>
                <span>Status</span>
                <strong>{status}</strong>
              </div>
              <div>
                <span>Case job</span>
                <code>{batch.batch.caseJobKey ?? "-"}</code>
              </div>
              <div>
                <span>External id</span>
                <code>{batch.batch.caseExternalId ?? "-"}</code>
              </div>
              <div>
                <span>Started</span>
                <code>{formatTimestamp(batch.batch.caseStartedAt)}</code>
              </div>
            </div>

            <div className="case-log-section">
              <h3>Timeline</h3>
              <div className="case-log-timeline">
                {timeline.length === 0 ? (
                  <div className="case-log-empty">No events recorded yet.</div>
                ) : timeline.map((event, index) => (
                  <div className={`case-log-entry log-${event.level}`} key={`${event.at}-${event.scope}-${index}`}>
                    <time>{formatTimestamp(event.at)}</time>
                    <span>{event.scope}</span>
                    <div>
                      <p>{event.message}</p>
                      {event.details !== undefined && (
                        <details className="case-log-details">
                          <summary>Details</summary>
                          <pre>{compactJson(event.details)}</pre>
                        </details>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="case-log-section">
              <h3>Invoice Signals</h3>
              <div className="case-job-log-list">
                {batch.jobs.map((job) => (
                  <div className="case-job-log" key={job.jobId}>
                    <div>
                      <strong>{job.batchSequence ?? "-"} · {job.draft.supplierName || job.sourceFileName || job.jobId.slice(0, 8)}</strong>
                      <small>{job.status} · updated {formatTimestamp(job.updatedAt)}</small>
                    </div>
                    <dl>
                      <div>
                        <dt>Job</dt>
                        <dd>{job.jobId}</dd>
                      </div>
                      <div>
                        <dt>Queue</dt>
                        <dd>{job.queueItemKey ?? "-"}</dd>
                      </div>
                      <div>
                        <dt>Case job</dt>
                        <dd>{job.caseJobKey ?? "-"}</dd>
                      </div>
                      <div>
                        <dt>Bucket</dt>
                        <dd>{job.draft.attachmentRefs[0]?.bucketPath ?? "-"}</dd>
                      </div>
                      <div>
                        <dt>Extraction</dt>
                        <dd>{job.extraction ? `${job.extraction.provider}${job.extraction.model ? ` · ${job.extraction.model}` : ""}` : "-"}</dd>
                      </div>
                      <div>
                        <dt>Blocking</dt>
                        <dd>{job.validation?.blocking.length ? job.validation.blocking.join(" | ") : "-"}</dd>
                      </div>
                    </dl>
                  </div>
                ))}
              </div>
            </div>

            <div className="case-log-section">
              <h3>Raw Case Snapshot</h3>
              <pre>{compactJson(caseSnapshot)}</pre>
            </div>

            <div className="case-log-section">
              <h3>Raw Batch Details</h3>
              <pre>{compactJson(batch)}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [batchName, setBatchName] = useState("");
  const [qrPayloadText, setQrPayloadText] = useState("");
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [currentBatch, setCurrentBatch] = useState<BatchDetails | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string>("");
  const [draft, setDraft] = useState<InvoiceDraft | null>(null);
  const [mappings, setMappings] = useState<QoyodMappingRule[]>([]);
  const [ruleForm, setRuleForm] = useState(emptyRule);
  const [selectedDestinations, setSelectedDestinations] = useState<DestinationPlatform[]>(["qoyod"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [statusFilter, setStatusFilter] = useState<JobStatus | "all">("all");
  const [cameraActive, setCameraActive] = useState(false);
  const [scanMessage, setScanMessage] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanTimerRef = useRef<number | null>(null);

  const selectedJob = useMemo(
    () => currentBatch?.jobs.find((job) => job.jobId === selectedJobId) ?? null,
    [currentBatch, selectedJobId]
  );
  const decodedQr = useMemo(() => decodeZatcaTlv(qrLines(qrPayloadText)[0] ?? ""), [qrPayloadText]);
  const visibleJobs = useMemo(() => {
    const jobs = currentBatch?.jobs ?? [];
    return statusFilter === "all" ? jobs : jobs.filter((job) => job.status === statusFilter);
  }, [currentBatch, statusFilter]);

  useEffect(() => {
    refreshAll().catch((requestError) => setError(requestError instanceof Error ? requestError.message : String(requestError)));
    return () => stopCamera();
  }, []);

  useEffect(() => {
    if (!currentBatch || !currentBatch.jobs.some((job) => ["queued", "extracting", "qoyod_filling", "robot_running", "posting"].includes(job.status))) {
      return;
    }

    const timer = window.setInterval(() => {
      refreshBatch(currentBatch.batch.batchId).catch((requestError) => setError(requestError instanceof Error ? requestError.message : String(requestError)));
    }, 2500);

    return () => window.clearInterval(timer);
  }, [currentBatch]);

  useEffect(() => {
    const nextJob = currentBatch?.jobs.find((job) => job.jobId === selectedJobId) ?? currentBatch?.jobs[0] ?? null;
    setSelectedJobId(nextJob?.jobId ?? "");
    setDraft(nextJob ? normalizeInvoiceDraft(nextJob.draft) : null);
    setSelectedDestinations(destinationsForJob(nextJob));
  }, [currentBatch?.batch.batchId]);

  async function refreshAll() {
    const [batchList, mappingList] = await Promise.all([listBatches(), listMappings()]);
    setBatches(batchList);
    setMappings(mappingList);
    if (!currentBatch && batchList[0]) {
      await refreshBatch(batchList[0].batchId);
    }
  }

  async function refreshBatch(batchId: string) {
    const [details, batchList] = await Promise.all([getBatch(batchId), listBatches()]);
    setCurrentBatch(details);
    setBatches(batchList);
    const nextJob = details.jobs.find((job) => job.jobId === selectedJobId) ?? details.jobs[0] ?? null;
    setSelectedJobId(nextJob?.jobId ?? "");
    setDraft(nextJob ? normalizeInvoiceDraft(nextJob.draft) : null);
  }

  async function startCamera() {
    setError("");
    setScanMessage("");

    const barcodeDetector = "BarcodeDetector" in window
      ? new (window as unknown as { BarcodeDetector: new (options: { formats: string[] }) => { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector({ formats: ["qr_code"] })
      : null;

    if (!barcodeDetector) {
      setScanMessage("QR scanner unavailable on this browser. Paste QR payloads or upload the invoice images.");
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
    streamRef.current = stream;
    setCameraActive(true);

    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    }

    scanTimerRef.current = window.setInterval(async () => {
      if (!videoRef.current) return;
      const codes = await barcodeDetector.detect(videoRef.current).catch(() => []);
      const qr = codes[0]?.rawValue;
      if (qr) {
        setQrPayloadText((current) => current ? `${current.trim()}\n${qr}` : qr);
        setScanMessage("QR captured. Scan another or upload the batch.");
        stopCamera();
      }
    }, 600);
  }

  function stopCamera() {
    if (scanTimerRef.current) {
      window.clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraActive(false);
  }

  async function submitBatch() {
    if (!files.length) {
      setError("Choose at least one invoice photo or PDF first.");
      return;
    }

    setBusy(true);
    setError("");
    setNotice("");
    try {
      const details = await uploadBatch(files, batchName, qrLines(qrPayloadText));
      setCurrentBatch(details);
      setBatches(await listBatches());
      const firstJob = details.jobs[0] ?? null;
      setSelectedJobId(firstJob?.jobId ?? "");
      setDraft(firstJob ? normalizeInvoiceDraft(firstJob.draft) : null);
      setFiles([]);
      setBatchName("");
      setQrPayloadText("");
      setNotice(`Created ${details.jobs.length} invoice job(s).`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  }

  function selectJob(job: IntakeJob) {
    setSelectedJobId(job.jobId);
    setDraft(normalizeInvoiceDraft(job.draft));
    setSelectedDestinations(destinationsForJob(job));
    setError("");
    setNotice("");
  }

  function updateDraft(patch: Partial<InvoiceDraft>) {
    if (!draft) return;
    setDraft({ ...draft, ...patch });
  }

  function updateLine(lineId: string, patch: Partial<InvoiceLineItem>) {
    if (!draft) return;
    const nextLines = draft.lineItems.map((line) => (line.id === lineId ? recalculateLineTotals({ ...line, ...patch }) : line));
    setDraft(deriveHeaderTotalsFromLines({ ...draft, lineItems: nextLines }));
  }

  function updateLineMapping(lineId: string, patch: Partial<QoyodMapping>) {
    if (!draft) return;
    const nextLines = draft.lineItems.map((line) => {
      if (line.id !== lineId) return line;
      return {
        ...line,
        selectedQoyodMapping: {
          ...(line.selectedQoyodMapping ?? emptyMapping),
          ...patch
        }
      };
    });
    setDraft({ ...draft, lineItems: nextLines });
  }

  function addLine() {
    if (!draft) return;
    setDraft({ ...draft, lineItems: [...draft.lineItems, newLineItem()] });
  }

  function removeLine(lineId: string) {
    if (!draft) return;
    setDraft(deriveHeaderTotalsFromLines({ ...draft, lineItems: draft.lineItems.filter((line) => line.id !== lineId) }));
  }

  async function submitReview() {
    if (!selectedJob || !draft) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const updated = await saveReview(selectedJob.jobId, draft, selectedDestinations);
      setCurrentBatch((batch) => mergeBatchJob(batch, updated));
      setDraft(normalizeInvoiceDraft(updated.draft));
      setSelectedDestinations(destinationsForJob(updated));
      setNotice(updated.validation?.canSubmitToRobot ? `Invoice is ready for ${selectedDestinations.map(destinationLabel).join(", ")}.` : "Review saved with blocking checks.");
      if (updated.batchId) await refreshBatch(updated.batchId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function applyMappings() {
    if (!currentBatch || currentBatch.batch.batchId === "unbatched") return;
    setBusy(true);
    setError("");
    try {
      const updated = await applyBatchMappings(currentBatch.batch.batchId);
      setCurrentBatch(updated);
      const nextJob = updated.jobs.find((job) => job.jobId === selectedJobId) ?? updated.jobs[0] ?? null;
      setDraft(nextJob ? normalizeInvoiceDraft(nextJob.draft) : null);
      setNotice(`Applied ${updated.appliedCount} mapping rule(s).`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function saveAllReviewed() {
    if (!currentBatch || currentBatch.batch.batchId === "unbatched") return;
    const reviews = currentBatch.jobs.map((job) => ({
      jobId: job.jobId,
      draft: job.jobId === selectedJobId && draft ? draft : job.draft,
      destinations: selectedDestinations
    }));
    setBusy(true);
    setError("");
    try {
      const updated = await bulkReviewBatch(currentBatch.batch.batchId, reviews);
      setCurrentBatch(updated);
      const nextJob = updated.jobs.find((job) => job.jobId === selectedJobId) ?? updated.jobs[0] ?? null;
      setDraft(nextJob ? normalizeInvoiceDraft(nextJob.draft) : null);
      setSelectedDestinations(destinationsForJob(nextJob));
      setNotice(`Batch review saved. Valid invoices are ready for ${selectedDestinations.map(destinationLabel).join(", ")}.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function createRuleFromLine(line: InvoiceLineItem) {
    if (!draft || !line.selectedQoyodMapping?.label) {
      setError("Type a line mapping before saving a rule.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await saveMappingRule({
        type: line.selectedQoyodMapping.type,
        qoyodId: line.selectedQoyodMapping.id,
        label: line.selectedQoyodMapping.label,
        supplierName: draft.supplierName,
        supplierTaxId: draft.supplierTaxId,
        matchText: line.description,
        matchMode: "contains",
        taxRate: line.taxRate,
        active: true
      });
      setMappings(await listMappings());
      setNotice("Mapping rule saved from this line.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function saveRuleFromForm() {
    if (!ruleForm.label.trim() || !ruleForm.matchText.trim()) {
      setError("Mapping label and match text are required.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await saveMappingRule({
        type: ruleForm.type,
        qoyodId: ruleForm.label.trim(),
        label: ruleForm.label.trim(),
        matchText: ruleForm.matchText.trim(),
        matchMode: ruleForm.matchMode,
        supplierName: ruleForm.supplierScoped ? draft?.supplierName : undefined,
        supplierTaxId: ruleForm.supplierScoped ? draft?.supplierTaxId : undefined,
        active: true
      });
      setRuleForm(emptyRule);
      setMappings(await listMappings());
      setNotice("Mapping rule saved.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function removeRule(ruleId: string) {
    setBusy(true);
    try {
      await deleteMappingRule(ruleId);
      setMappings(await listMappings());
      setNotice("Mapping rule removed.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  }

  function toggleDestination(platform: DestinationPlatform, active: boolean) {
    setSelectedDestinations((current) => {
      const next = new Set(current);
      if (active) next.add(platform);
      else next.delete(platform);
      return next.size ? Array.from(next) : ["qoyod"];
    });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <Layers3 size={24} aria-hidden="true" />
          <div>
            <strong>Invoice Intake</strong>
            <span>Batch invoice review and platform handoff</span>
          </div>
        </div>
        <div className={`status-pill ${statusClass(currentBatch?.summary.status)}`}>
          {currentBatch ? `${currentBatch.summary.totalJobs} invoices` : "No batch"}
        </div>
      </header>

      <main className="workspace batch-workspace">
        <section className="panel capture-panel">
          <div className="panel-heading">
            <h1>Capture Batch</h1>
            <button className="icon-button" title="Refresh" disabled={busy} onClick={() => refreshAll()}>
              <RefreshCw size={18} />
            </button>
          </div>

          <label className="field">
            <span>Batch name</span>
            <input value={batchName} onChange={(event) => setBatchName(event.target.value)} placeholder="June supplier invoices" />
          </label>

          <div className="scan-box">
            <video ref={videoRef} className={cameraActive ? "scanner active" : "scanner"} muted playsInline />
            <div className="scan-actions">
              {!cameraActive ? (
                <button className="secondary-button" type="button" onClick={startCamera}>
                  <ScanLine size={18} />
                  Scan QR
                </button>
              ) : (
                <button className="secondary-button danger" type="button" onClick={stopCamera}>
                  <Camera size={18} />
                  Stop camera
                </button>
              )}
            </div>
          </div>

          <label className="field">
            <span>QR payloads, one per line in file order</span>
            <textarea value={qrPayloadText} onChange={(event) => setQrPayloadText(event.target.value)} rows={4} />
          </label>

          {decodedQr && (
            <div className="qr-grid">
              <span>{decodedQr.sellerName || "Seller pending"}</span>
              <span>{decodedQr.vatRegistrationNumber || "VAT pending"}</span>
              <span>{decodedQr.totalWithVat ? `${decodedQr.totalWithVat.toFixed(2)} SAR` : "Total pending"}</span>
            </div>
          )}

          <label className="file-drop">
            <Upload size={22} aria-hidden="true" />
            <span>{files.length ? `${files.length} file(s) selected` : "Choose invoice photos or PDFs"}</span>
            <input
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,application/pdf"
              capture="environment"
              onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
            />
          </label>

          <button className="primary-button" type="button" disabled={busy || !files.length} onClick={submitBatch}>
            <Upload size={18} />
            Upload batch
          </button>

          <div className="batch-list">
            <h2>Batches</h2>
            {batches.length === 0 ? (
              <div className="notice">No batches yet.</div>
            ) : batches.map((batch) => (
              <button
                key={batch.batchId}
                className={`batch-row ${currentBatch?.batch.batchId === batch.batchId ? "active" : ""}`}
                type="button"
                onClick={() => refreshBatch(batch.batchId)}
              >
                <FolderOpen size={16} />
                <span>
                  <strong>{batch.name}</strong>
                  <small>{batch.totalJobs} invoices · {batch.status.replace(/_/g, " ")}</small>
                </span>
              </button>
            ))}
          </div>

          {scanMessage && <div className="notice">{scanMessage}</div>}
          {notice && <div className="notice success">{notice}</div>}
          {error && <div className="notice error">{error}</div>}
        </section>

        <section className="panel batch-panel">
          {!currentBatch ? (
            <div className="empty-state">
              <FileText size={36} />
              <span>Upload or select a batch</span>
            </div>
          ) : (
            <>
              <div className="panel-heading">
                <div>
                  <h2>{currentBatch.batch.name}</h2>
                  <code>{currentBatch.batch.batchId.slice(0, 8)}</code>
                </div>
                <div className="actions">
                  <button className="secondary-button" type="button" disabled={busy || currentBatch.batch.batchId === "unbatched"} onClick={applyMappings}>
                    <Wand2 size={18} />
                    Apply mappings
                  </button>
                  <button className="secondary-button" type="button" disabled={busy || currentBatch.batch.batchId === "unbatched"} onClick={saveAllReviewed}>
                    <Save size={18} />
                    Save batch review
                  </button>
                </div>
              </div>

              <CaseCockpit batch={currentBatch} />

              <div className="metrics-strip">
                <button type="button" className={statusFilter === "all" ? "metric active" : "metric"} onClick={() => setStatusFilter("all")}>
                  <strong>{currentBatch.summary.totalJobs}</strong>
                  <span>All</span>
                </button>
                <button type="button" className={statusFilter === "needs_review" ? "metric active" : "metric"} onClick={() => setStatusFilter("needs_review")}>
                  <strong>{count(currentBatch.summary, "needs_review")}</strong>
                  <span>Review</span>
                </button>
                <button type="button" className={statusFilter === "ready_for_qoyod" ? "metric active" : "metric"} onClick={() => setStatusFilter("ready_for_qoyod")}>
                  <strong>{count(currentBatch.summary, "ready_for_qoyod")}</strong>
                  <span>Ready</span>
                </button>
                <button type="button" className={statusFilter === "draft_saved" ? "metric active" : "metric"} onClick={() => setStatusFilter("draft_saved")}>
                  <strong>{count(currentBatch.summary, "draft_saved")}</strong>
                  <span>Drafts</span>
                </button>
              </div>

              <div className="batch-table">
                {visibleJobs.map((job) => (
                  <button
                    key={job.jobId}
                    type="button"
                    className={`invoice-row ${selectedJobId === job.jobId ? "active" : ""}`}
                    onClick={() => selectJob(job)}
                  >
                    <span>{job.batchSequence ?? "-"}</span>
                    <strong>{job.draft.supplierName || "Unknown supplier"}</strong>
                    <span>{job.draft.invoiceNumber || job.jobId.slice(0, 8)}</span>
                    <span>{job.draft.grandTotal.toFixed(2)} {job.draft.currency}</span>
                    <span className={`row-status ${statusClass(job.status)}`}>{statusLabels[job.status]}</span>
                    <span>{job.reviewFlags?.includes("duplicate_invoice") ? "Duplicate" : destinationSummary(job)}</span>
                  </button>
                ))}
              </div>

              {selectedJob && draft && (
                <div className="review-layout">
                  <section className="review-editor">
                    <div className="panel-heading">
                      <h3>Review Invoice</h3>
                      <code>{selectedJob.jobId.slice(0, 8)}</code>
                    </div>

                    <div className="form-grid">
                      <label className="field">
                        <span>Supplier</span>
                        <input value={draft.supplierName} onChange={(event) => updateDraft({ supplierName: event.target.value })} />
                      </label>
                      <label className="field">
                        <span>Tax ID</span>
                        <input value={draft.supplierTaxId} onChange={(event) => updateDraft({ supplierTaxId: event.target.value })} />
                      </label>
                      <label className="field">
                        <span>Invoice no.</span>
                        <input value={draft.invoiceNumber} onChange={(event) => updateDraft({ invoiceNumber: event.target.value })} />
                      </label>
                      <label className="field">
                        <span>Issue date</span>
                        <input type="date" value={draft.issueDate} onChange={(event) => updateDraft({ issueDate: event.target.value })} />
                      </label>
                      <label className="field">
                        <span>Due date</span>
                        <input type="date" value={draft.dueDate} onChange={(event) => updateDraft({ dueDate: event.target.value })} />
                      </label>
                      <label className="field">
                        <span>Currency</span>
                        <input value={draft.currency} onChange={(event) => updateDraft({ currency: event.target.value.toUpperCase() })} />
                      </label>
                    </div>

                    <div className="totals-strip">
                      <label className="field">
                        <span>Subtotal</span>
                        <input type="number" value={draft.subtotal} onChange={(event) => updateDraft({ subtotal: numberValue(event.target.value) })} />
                      </label>
                      <label className="field">
                        <span>VAT</span>
                        <input type="number" value={draft.vatTotal} onChange={(event) => updateDraft({ vatTotal: numberValue(event.target.value) })} />
                      </label>
                      <label className="field">
                        <span>Grand total</span>
                        <input type="number" value={draft.grandTotal} onChange={(event) => updateDraft({ grandTotal: numberValue(event.target.value) })} />
                      </label>
                    </div>

                    <div className="line-header">
                      <h3>Line items</h3>
                      <button className="secondary-button" type="button" onClick={addLine}>
                        <Plus size={18} />
                        Add line
                      </button>
                    </div>

                    <div className="destination-selector">
                      <h3>Destinations</h3>
                      <div>
                        {destinationOptions.map((platform) => (
                          <label className="checkbox-field" key={platform}>
                            <input
                              type="checkbox"
                              checked={selectedDestinations.includes(platform)}
                              onChange={(event) => toggleDestination(platform, event.target.checked)}
                            />
                            <span>{destinationLabel(platform)}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="line-table">
                      {draft.lineItems.map((line) => (
                        <div className="line-row" key={line.id}>
                          <label className="field span-2">
                            <span>Description</span>
                            <input value={line.description} onChange={(event) => updateLine(line.id, { description: event.target.value })} />
                          </label>
                          <label className="field">
                            <span>Qty</span>
                            <input type="number" value={line.quantity} onChange={(event) => updateLine(line.id, { quantity: numberValue(event.target.value) })} />
                          </label>
                          <label className="field">
                            <span>Unit</span>
                            <input type="number" value={line.unitPrice} onChange={(event) => updateLine(line.id, { unitPrice: numberValue(event.target.value) })} />
                          </label>
                          <label className="field">
                            <span>Disc.</span>
                            <input type="number" value={line.discount} onChange={(event) => updateLine(line.id, { discount: numberValue(event.target.value) })} />
                          </label>
                          <label className="field">
                            <span>Tax %</span>
                            <input type="number" value={line.taxRate} onChange={(event) => updateLine(line.id, { taxRate: numberValue(event.target.value) })} />
                          </label>
                          <label className="field">
                            <span>Mapping</span>
                            <input
                              value={line.selectedQoyodMapping?.label ?? ""}
                              onChange={(event) => updateLineMapping(line.id, { label: event.target.value, id: event.target.value.trim() })}
                            />
                          </label>
                          <label className="field">
                            <span>Type</span>
                            <select
                              value={line.selectedQoyodMapping?.type ?? "expense"}
                              onChange={(event) => updateLineMapping(line.id, { type: event.target.value as QoyodMapping["type"] })}
                            >
                              <option value="expense">Expense</option>
                              <option value="item">Item</option>
                            </select>
                          </label>
                          <div className="line-total">
                            <small>Incl. VAT</small>
                            {line.total.toFixed(2)}
                          </div>
                          <button className="icon-button" type="button" title="Save mapping rule" onClick={() => createRuleFromLine(line)}>
                            <Wand2 size={18} />
                          </button>
                          <button className="icon-button danger" type="button" title="Remove line" onClick={() => removeLine(line.id)}>
                            <Trash2 size={18} />
                          </button>
                        </div>
                      ))}
                    </div>

                    {selectedJob.validation && (
                      <div className={selectedJob.validation.canSubmitToRobot ? "validation ok" : "validation"}>
                        <div className="validation-title">
                          {selectedJob.validation.canSubmitToRobot ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
                          <span>{selectedJob.validation.canSubmitToRobot ? "Ready" : "Blocked"}</span>
                        </div>
                        {selectedJob.reviewFlags?.includes("duplicate_invoice") && <p>Duplicate supplier tax ID and invoice number found.</p>}
                        {selectedJob.validation.blocking.map((item) => <p key={item}>{item}</p>)}
                        {selectedJob.validation.warnings.map((item) => <p key={item}>{item}</p>)}
                      </div>
                    )}

                    <button className="primary-button" type="button" disabled={busy} onClick={submitReview}>
                      <Save size={18} />
                      Save invoice review
                    </button>
                  </section>

                  <aside className="mapping-panel">
                    <h3>Mapping Library</h3>
                    <div className="mapping-form">
                      <label className="field">
                        <span>Destination mapping label</span>
                        <input value={ruleForm.label} onChange={(event) => setRuleForm({ ...ruleForm, label: event.target.value })} />
                      </label>
                      <label className="field">
                        <span>Match text</span>
                        <input value={ruleForm.matchText} onChange={(event) => setRuleForm({ ...ruleForm, matchText: event.target.value })} />
                      </label>
                      <label className="field">
                        <span>Type</span>
                        <select value={ruleForm.type} onChange={(event) => setRuleForm({ ...ruleForm, type: event.target.value as QoyodMapping["type"] })}>
                          <option value="expense">Expense</option>
                          <option value="item">Item</option>
                        </select>
                      </label>
                      <label className="checkbox-field">
                        <input type="checkbox" checked={ruleForm.supplierScoped} onChange={(event) => setRuleForm({ ...ruleForm, supplierScoped: event.target.checked })} />
                        <span>Limit to current supplier</span>
                      </label>
                      <button className="secondary-button" type="button" disabled={busy} onClick={saveRuleFromForm}>
                        <Wand2 size={18} />
                        Save rule
                      </button>
                    </div>

                    <div className="mapping-list">
                      {mappings.length === 0 ? (
                        <div className="notice">No mapping rules yet.</div>
                      ) : mappings.slice(0, 12).map((rule) => (
                        <div className="mapping-row" key={rule.ruleId}>
                          <span>
                            <strong>{rule.label}</strong>
                            <small>{rule.matchText} · {rule.type}</small>
                          </span>
                          <button className="icon-button danger" type="button" title="Delete rule" onClick={() => removeRule(rule.ruleId)}>
                            <Trash2 size={16} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </aside>
                </div>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
