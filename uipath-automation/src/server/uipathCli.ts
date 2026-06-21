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

type UiPathConfig = {
  enabled: boolean;
  folderPath: string;
  bucketKey: string;
  queueName: string;
  caseProcessKey: string;
  caseFolderKey: string;
  caseFeedId: string;
  startCase: boolean;
};

const RESERVED_BUCKET_PATH_CHARS = /[&+%?]/g;
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
    caseFeedId: process.env.UIPATH_CASE_FEED_ID ?? "",
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
    config.caseProcessKey || "<case-process-key>",
    config.caseFolderKey || "<folder-key>",
    "--inputs",
    JSON.stringify(inputs),
    "--validate"
  ];

  if (config.caseFeedId) {
    args.push("--feed-id", config.caseFeedId);
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

  const args = [
    "maestro",
    "case",
    "process",
    "run",
    config.caseProcessKey || "<case-process-key>",
    config.caseFolderKey || "<folder-key>",
    "--inputs",
    JSON.stringify(inputs),
    "--validate"
  ];

  if (config.caseFeedId) {
    args.push("--feed-id", config.caseFeedId);
  }

  args.push("--output", "json");

  return runUip(args, config);
}
