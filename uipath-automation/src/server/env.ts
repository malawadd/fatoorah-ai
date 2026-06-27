import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, parse } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "..", ".env"),
  path.resolve(here, "..", "..", ".env"),
  path.resolve(here, "..", "..", "..", ".env")
];

const envFiles = Array.from(new Set(candidates));

export const runtimeEnvKeys = [
  "PUBLIC_API_BASE_URL",
  "INVOICE_INTAKE_API_BASE_URL",
  "PUBLIC_WEB_APP_URL",
  "CASE_CALLBACK_TOKEN",
  "CASE_WORKFLOW_MAX_ATTEMPTS",
  "CASE_WORKFLOW_WAIT_SECONDS",
  "UIPATH_ENABLED",
  "UIPATH_FOLDER_PATH",
  "UIPATH_BUCKET_KEY",
  "UIPATH_QUEUE_NAME",
  "UIPATH_CASE_PROCESS_KEY",
  "UIPATH_CASE_FOLDER_KEY",
  "UIPATH_CASE_RELEASE_KEY",
  "UIPATH_CASE_FEED_ID",
  "UIPATH_CASE_VALIDATE_INPUTS",
  "UIPATH_START_CASE"
] as const;

export function loadEnvFiles(options: { override?: boolean } = {}): void {
  for (const filePath of envFiles) {
    if (existsSync(filePath)) {
      config({ path: filePath, override: options.override ?? false, quiet: true });
    }
  }
}

export function refreshEnvKeys(keys: readonly string[]): void {
  const refreshed = new Set<string>();

  for (const filePath of envFiles) {
    if (!existsSync(filePath)) {
      continue;
    }

    const parsed = parse(readFileSync(filePath));
    for (const key of keys) {
      if (!refreshed.has(key) && parsed[key] !== undefined) {
        process.env[key] = parsed[key];
        refreshed.add(key);
      }
    }
  }
}

export function refreshRuntimeEnv(): void {
  refreshEnvKeys(runtimeEnvKeys);
}

loadEnvFiles();
