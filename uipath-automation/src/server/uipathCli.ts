import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { IntakeJob, InvoiceBatch } from "../shared/invoice";

const execFileAsync = promisify(execFile);

export type UiPathCommandResult = {
  mode: "dry-run" | "uip";
  command: string[];
  data?: unknown;
  error?: string;
  message?: string;
};

export type UiPathLivePreflightResult = {
  ok: boolean;
  checks: Array<{
    name: string;
    ok: boolean;
    message: string;
    command?: string[];
    data?: unknown;
  }>;
};

type UiPathConfig = {
  enabled: boolean;
  folderPath: string;
  bucketKey: string;
  queueName: string;
  caseProcessKey: string;
  caseFolderKey: string;
  caseReleaseKey: string;
  caseFeedId: string;
  caseValidateInputs: boolean;
  startCase: boolean;
};

const RESERVED_BUCKET_PATH_CHARS = /[&+%?]/g;
const ORCHESTRATOR_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOWS_UIPATH_CLI_CANDIDATES = [
  path.join(path.dirname(process.execPath), "node_modules", "@uipath", "cli", "dist", "index.js"),
  process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "@uipath", "cli", "dist", "index.js") : ""
].filter(Boolean);

type UiPathEnvelope = {
  Result?: string;
  Data?: unknown;
  Message?: string;
  Instructions?: string;
};

function failedDataMessage(data: unknown): string | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }

  const value = data as {
    success?: unknown;
    errorMessage?: unknown;
    ErrorMessage?: unknown;
    message?: unknown;
    Message?: unknown;
  };

  if (value.success !== false) {
    return undefined;
  }

  return [value.errorMessage, value.ErrorMessage, value.message, value.Message]
    .filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
    .join(" ");
}

function joinErrorParts(...parts: Array<string | undefined>): string | undefined {
  const message = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" ");
  return message || undefined;
}

export function parseUipOutput(command: string[], stdout: string, stderr = ""): UiPathCommandResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { mode: "uip", command, message: stderr.trim() || undefined };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      mode: "uip",
      command,
      data: trimmed,
      error: stderr.trim() || undefined
    };
  }

  if (parsed && typeof parsed === "object" && "Result" in parsed) {
    const envelope = parsed as UiPathEnvelope;
    const dataError = failedDataMessage(envelope.Data);
    if (envelope.Result !== "Success" || dataError) {
      return {
        mode: "uip",
        command,
        data: envelope.Data,
        error: joinErrorParts(dataError, envelope.Message, envelope.Instructions, stderr),
        message: envelope.Message
      };
    }

    return {
      mode: "uip",
      command,
      data: envelope.Data,
      message: envelope.Message
    };
  }

  return {
    mode: "uip",
    command,
    data: parsed
  };
}

function resolveUipInvocation(args: string[]): { executable: string; args: string[] } {
  const explicitPath = process.env.UIPATH_CLI_PATH;
  if (explicitPath) {
    return explicitPath.endsWith(".js")
      ? { executable: process.execPath, args: [explicitPath, ...args] }
      : { executable: explicitPath, args };
  }

  if (process.platform === "win32") {
    const cliScript = WINDOWS_UIPATH_CLI_CANDIDATES.find((candidate) => fs.existsSync(candidate));
    if (cliScript) {
      return { executable: process.execPath, args: [cliScript, ...args] };
    }
  }

  return { executable: "uip", args };
}

function readConfig(): UiPathConfig {
  return {
    enabled: process.env.UIPATH_ENABLED === "true",
    folderPath: process.env.UIPATH_FOLDER_PATH ?? "",
    bucketKey: process.env.UIPATH_BUCKET_KEY ?? "",
    queueName: process.env.UIPATH_QUEUE_NAME ?? "InvoiceIntake",
    caseProcessKey: process.env.UIPATH_CASE_PROCESS_KEY ?? "",
    caseFolderKey: process.env.UIPATH_CASE_FOLDER_KEY ?? "",
    caseReleaseKey: process.env.UIPATH_CASE_RELEASE_KEY ?? "",
    caseFeedId: process.env.UIPATH_CASE_FEED_ID ?? "",
    caseValidateInputs: process.env.UIPATH_CASE_VALIDATE_INPUTS === "true",
    startCase: process.env.UIPATH_START_CASE === "true"
  };
}

function safeBucketPath(...parts: string[]): string {
  return parts
    .map((part) => path.basename(part).replace(RESERVED_BUCKET_PATH_CHARS, "_").replace(/\s+/g, "-"))
    .filter(Boolean)
    .join("/");
}

async function runUip(args: string[], config: UiPathConfig): Promise<UiPathCommandResult> {
  if (!config.enabled) {
    return { mode: "dry-run", command: ["uip", ...args] };
  }

  const command = ["uip", ...args];
  try {
    const invocation = resolveUipInvocation(args);
    const { stdout, stderr } = await execFileAsync(invocation.executable, invocation.args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 5
    });
    return parseUipOutput(command, stdout, stderr);
  } catch (error) {
    const commandError = error as Error & { stderr?: string; stdout?: string };
    let message = commandError.message;
    if (commandError.stdout?.trim()) {
      const parsedResult = parseUipOutput(command, commandError.stdout, commandError.stderr);
      message = parsedResult.error ?? parsedResult.message ?? message;
    } else if (commandError.stderr?.trim()) {
      message = commandError.stderr.trim();
    }

    return {
      mode: "uip",
      command,
      error: message
    };
  }
}

function requireFolder(config: UiPathConfig): string | undefined {
  return config.folderPath ? undefined : "UIPATH_FOLDER_PATH is required when UIPATH_ENABLED=true.";
}

export function processKeyFromProcessData(data: unknown): string | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }

  const process = data as { ProcessKey?: unknown };
  return typeof process.ProcessKey === "string" && process.ProcessKey.trim().length > 0
    ? process.ProcessKey.trim()
    : undefined;
}

type CaseRunTarget = {
  processKey: string;
  releaseKey?: string;
  error?: string;
};

function processVersionFromProcessData(data: unknown): string | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }

  const process = data as { ProcessVersion?: unknown };
  return typeof process.ProcessVersion === "string" && process.ProcessVersion.trim().length > 0
    ? process.ProcessVersion.trim()
    : undefined;
}

function releaseKeyFromProcessData(data: unknown): string | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }

  const process = data as { Key?: unknown };
  return typeof process.Key === "string" && process.Key.trim().length > 0
    ? process.Key.trim()
    : undefined;
}

function versionedProcessKey(processKey: string, processVersion?: string): string {
  return processVersion && !processKey.includes(":") ? `${processKey}:${processVersion}` : processKey;
}

function findProcessListMatch(data: unknown, configuredKey: string): unknown | undefined {
  const rows = data && typeof data === "object" && Array.isArray((data as { Data?: unknown }).Data)
    ? (data as { Data: unknown[] }).Data
    : Array.isArray(data)
      ? data
      : [];

  return rows.find((row) => {
    const processKey = processKeyFromProcessData(row);
    const processVersion = processVersionFromProcessData(row);
    const releaseKey = releaseKeyFromProcessData(row);
    return configuredKey === processKey ||
      configuredKey === versionedProcessKey(processKey ?? "", processVersion) ||
      configuredKey.toLowerCase() === releaseKey?.toLowerCase();
  });
}

async function resolveCaseRunTarget(config: UiPathConfig): Promise<CaseRunTarget> {
  if (ORCHESTRATOR_UUID_PATTERN.test(config.caseProcessKey)) {
    const lookup = await runUip(["or", "processes", "get", config.caseProcessKey, "--output", "json"], config);
    if (lookup.error) {
      return {
        processKey: config.caseProcessKey,
        releaseKey: config.caseReleaseKey,
        error: `UIPATH_CASE_PROCESS_KEY is an Orchestrator release UUID, but its Maestro ProcessKey could not be resolved: ${lookup.error}`
      };
    }

    const processKey = processKeyFromProcessData(lookup.data);
    if (!processKey) {
      return {
        processKey: config.caseProcessKey,
        releaseKey: config.caseReleaseKey,
        error: "UIPATH_CASE_PROCESS_KEY must be the Maestro ProcessKey string, or a resolvable Orchestrator release UUID."
      };
    }

    return {
      processKey,
      releaseKey: config.caseReleaseKey || releaseKeyFromProcessData(lookup.data) || config.caseProcessKey
    };
  }

  if (config.caseReleaseKey || !config.folderPath) {
    return { processKey: config.caseProcessKey, releaseKey: config.caseReleaseKey || undefined };
  }

  const list = await runUip(["or", "processes", "list", "--folder-path", config.folderPath, "--output", "json"], config);
  if (list.error) {
    return { processKey: config.caseProcessKey, error: `Could not resolve UIPATH_CASE_RELEASE_KEY from folder processes: ${list.error}` };
  }

  const match = findProcessListMatch(list.data, config.caseProcessKey);
  return {
    processKey: config.caseProcessKey,
    releaseKey: match ? releaseKeyFromProcessData(match) : undefined
  };
}

async function resolveCaseProcessRunKey(config: UiPathConfig): Promise<CaseRunTarget> {
  if (!config.enabled) {
    return {
      processKey: config.caseProcessKey || "<case-process-key>",
      releaseKey: config.caseReleaseKey || undefined
    };
  }

  const target = await resolveCaseRunTarget(config);
  if (!target.releaseKey) {
    return {
      ...target,
      error: "UIPATH_CASE_RELEASE_KEY is required for live Maestro Case start. Use 'uip or processes list --folder-path <folder>' and copy the process Key UUID."
    };
  }

  return target;
}

export async function uploadAttachmentToBucket(job: IntakeJob, localPath: string, mimeType: string): Promise<UiPathCommandResult & { bucketPath?: string }> {
  const config = readConfig();
  const bucketPath = safeBucketPath(job.jobId, path.basename(localPath));

  if (config.enabled) {
    const missing = requireFolder(config) ?? (!config.bucketKey ? "UIPATH_BUCKET_KEY is required when UIPATH_ENABLED=true." : undefined);
    if (missing) {
      return { mode: "uip", command: [], bucketPath, error: missing };
    }
  }

  const result = await runUip(
    [
      "or",
      "bucket-files",
      "upload",
      config.bucketKey || "<bucket-key>",
      bucketPath,
      "--folder-path",
      config.folderPath || "<folder-path>",
      "--file",
      localPath,
      "--content-type",
      mimeType,
      "--output",
      "json"
    ],
    config
  );

  return { ...result, bucketPath };
}

export async function createInvoiceQueueItem(job: IntakeJob): Promise<UiPathCommandResult> {
  const config = readConfig();
  const missing = config.enabled ? requireFolder(config) : undefined;
  if (missing) {
    return { mode: "uip", command: [], error: missing };
  }

  const firstAttachment = job.draft.attachmentRefs[0];
  const content = {
    jobId: job.jobId,
    batchId: job.batchId ?? "",
    batchSequence: job.batchSequence ?? "",
    source: "phone-pwa",
    attachmentName: firstAttachment?.name ?? "",
    attachmentBucketPath: firstAttachment?.bucketPath ?? "",
    qrSellerName: job.draft.qrTlv?.sellerName ?? "",
    qrVatNumber: job.draft.qrTlv?.vatRegistrationNumber ?? "",
    qrTimestamp: job.draft.qrTlv?.timestamp ?? "",
    qrTotalWithVat: job.draft.qrTlv?.totalWithVat ?? "",
    qrVatTotal: job.draft.qrTlv?.vatTotal ?? ""
  };

  return runUip(
    [
      "or",
      "queue-items",
      "add",
      config.queueName,
      "--folder-path",
      config.folderPath || "<folder-path>",
      "--specific-content",
      JSON.stringify(content),
      "--priority",
      "High",
      "--reference",
      job.jobId,
      "--output",
      "json"
    ],
    config
  );
}

export async function maybeStartInvoiceCase(job: IntakeJob): Promise<UiPathCommandResult | undefined> {
  const config = readConfig();
  if (!config.startCase) {
    return undefined;
  }

  if (config.enabled) {
    const missing = !config.caseProcessKey
      ? "UIPATH_CASE_PROCESS_KEY is required when UIPATH_START_CASE=true."
      : !config.caseFolderKey
        ? "UIPATH_CASE_FOLDER_KEY is required when UIPATH_START_CASE=true."
        : undefined;
    if (missing) {
      return { mode: "uip", command: [], error: missing };
    }
  }

  const firstAttachment = job.draft.attachmentRefs[0];
  const caseProcess = await resolveCaseProcessRunKey(config);
  if (caseProcess.error) {
    return { mode: "uip", command: [], error: caseProcess.error };
  }

  const inputs = {
    jobId: job.jobId,
    batchId: job.batchId ?? "",
    batchSequence: job.batchSequence ?? "",
    bucketKey: firstAttachment?.bucketKey ?? config.bucketKey,
    bucketPath: firstAttachment?.bucketPath ?? "",
    attachmentName: firstAttachment?.name ?? "",
    attachmentMimeType: firstAttachment?.mimeType ?? "",
    qrTlv: job.draft.qrTlv ?? null
  };
  const args = [
    "maestro",
    "case",
    "process",
    "run",
    caseProcess.processKey,
    config.caseFolderKey || "<folder-key>",
    "--inputs",
    JSON.stringify(inputs)
  ];

  if (caseProcess.releaseKey) {
    args.push("--release-key", caseProcess.releaseKey);
  }

  if (config.caseFeedId) {
    args.push("--feed-id", config.caseFeedId);
  }

  if (config.caseValidateInputs) {
    args.push("--validate");
  }

  args.push("--output", "json");

  return runUip(args, config);
}

export async function maybeStartBatchCase(batch: InvoiceBatch, jobs: IntakeJob[]): Promise<UiPathCommandResult | undefined> {
  const config = readConfig();
  if (!config.startCase) {
    return undefined;
  }

  if (config.enabled) {
    const missing = !config.caseProcessKey
      ? "UIPATH_CASE_PROCESS_KEY is required when UIPATH_START_CASE=true."
      : !config.caseFolderKey
        ? "UIPATH_CASE_FOLDER_KEY is required when UIPATH_START_CASE=true."
        : undefined;
    if (missing) {
      return { mode: "uip", command: [], error: missing };
    }
  }

  const inputs = {
    batchId: batch.batchId,
    batchName: batch.name,
    invoiceCount: jobs.length,
    jobIds: jobs.map((job) => job.jobId),
    firstJobId: jobs[0]?.jobId ?? "",
    apiBaseUrl: process.env.PUBLIC_API_BASE_URL ?? process.env.INVOICE_INTAKE_API_BASE_URL ?? "",
    webAppUrl: process.env.PUBLIC_WEB_APP_URL ?? "",
    caseCallbackToken: process.env.CASE_CALLBACK_TOKEN ?? "",
    maxAttempts: Number(process.env.CASE_WORKFLOW_MAX_ATTEMPTS ?? 60),
    waitSeconds: Number(process.env.CASE_WORKFLOW_WAIT_SECONDS ?? 10),
    bucketKey: config.bucketKey,
    attachments: jobs.map((job) => {
      const attachment = job.draft.attachmentRefs[0];
      return {
        jobId: job.jobId,
        batchSequence: job.batchSequence ?? "",
        attachmentName: attachment?.name ?? "",
        attachmentMimeType: attachment?.mimeType ?? "",
        bucketPath: attachment?.bucketPath ?? ""
      };
    }),
    qrTlvByJob: Object.fromEntries(jobs.map((job) => [job.jobId, job.draft.qrTlv ?? null]))
  };
  const caseProcess = await resolveCaseProcessRunKey(config);
  if (caseProcess.error) {
    return { mode: "uip", command: [], error: caseProcess.error };
  }

  const args = [
    "maestro",
    "case",
    "process",
    "run",
    caseProcess.processKey,
    config.caseFolderKey || "<folder-key>",
    "--inputs",
    JSON.stringify(inputs)
  ];

  if (caseProcess.releaseKey) {
    args.push("--release-key", caseProcess.releaseKey);
  }

  if (config.caseFeedId) {
    args.push("--feed-id", config.caseFeedId);
  }

  if (config.caseValidateInputs) {
    args.push("--validate");
  }

  args.push("--output", "json");

  return runUip(args, config);
}

async function preflightCheck(
  checks: UiPathLivePreflightResult["checks"],
  name: string,
  args: string[] | undefined,
  missing: string | undefined,
  config: UiPathConfig
): Promise<void> {
  if (missing) {
    checks.push({ name, ok: false, message: missing, command: args ? ["uip", ...args] : undefined });
    return;
  }

  if (!args) {
    checks.push({ name, ok: true, message: "OK" });
    return;
  }

  const result = await runUip(args, config);
  checks.push({
    name,
    ok: !result.error && result.mode === "uip",
    message: result.error ?? result.message ?? "OK",
    command: result.command,
    data: result.data
  });
}

export async function runUiPathLivePreflight(): Promise<UiPathLivePreflightResult> {
  const config = readConfig();
  const checks: UiPathLivePreflightResult["checks"] = [];

  await preflightCheck(
    checks,
    "uipath_enabled",
    undefined,
    config.enabled ? undefined : "UIPATH_ENABLED=true is required for live UiPath validation.",
    config
  );

  await preflightCheck(checks, "login_status", ["login", "status", "--output", "json"], undefined, config);
  await preflightCheck(
    checks,
    "folder",
    ["or", "folders", "list", "--output", "json"],
    requireFolder(config),
    config
  );
  await preflightCheck(
    checks,
    "queue",
    ["or", "queues", "list", "--folder-path", config.folderPath, "--name", config.queueName, "--output", "json"],
    requireFolder(config) ?? (!config.queueName ? "UIPATH_QUEUE_NAME is required for live UiPath validation." : undefined),
    config
  );
  await preflightCheck(
    checks,
    "bucket",
    ["or", "buckets", "get", config.bucketKey, "--folder-path", config.folderPath, "--output", "json"],
    requireFolder(config) ?? (!config.bucketKey ? "UIPATH_BUCKET_KEY is required for live UiPath validation." : undefined),
    config
  );

  if (config.caseProcessKey) {
    await preflightCheck(
      checks,
      "case_processes",
      ["or", "processes", "list", "--folder-path", config.folderPath, "--output", "json"],
      requireFolder(config),
      config
    );
  }

  return {
    ok: checks.every((check) => check.ok),
    checks
  };
}
