import { readFile } from "node:fs/promises";
import type { AttachmentRef, DestinationState, IntakeJob, InvoiceDraft, InvoiceLineItem } from "../shared/invoice";
import { money } from "../shared/invoice";

type ErpNextConfig = {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  company: string;
  defaultExpenseAccount: string;
  defaultCostCenter: string;
  defaultItemCode?: string;
  purchaseTaxesAndChargesTemplate?: string;
  vatAccountHead?: string;
  submitAfterPost: boolean;
};

type FrappeResponse<T> = {
  data?: T;
  message?: T;
  exception?: string;
  exc_type?: string;
  _server_messages?: string;
};

export type ErpNextPurchaseInvoiceResult = {
  invoiceName: string;
  invoiceUrl: string;
  attachmentName?: string;
  attachmentUrl?: string;
  rawInvoice: unknown;
  rawAttachment?: unknown;
};

export type ErpNextPreflightResult = {
  ok: boolean;
  checks: Array<{
    name: string;
    ok: boolean;
    message: string;
    data?: unknown;
  }>;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for ERPNext integration.`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function readErpNextConfig(): ErpNextConfig {
  return {
    baseUrl: requiredEnv("ERPNEXT_BASE_URL").replace(/\/$/, ""),
    apiKey: requiredEnv("ERPNEXT_API_KEY"),
    apiSecret: requiredEnv("ERPNEXT_API_SECRET"),
    company: requiredEnv("ERPNEXT_COMPANY"),
    defaultExpenseAccount: requiredEnv("ERPNEXT_DEFAULT_EXPENSE_ACCOUNT"),
    defaultCostCenter: requiredEnv("ERPNEXT_DEFAULT_COST_CENTER"),
    defaultItemCode: optionalEnv("ERPNEXT_DEFAULT_ITEM_CODE"),
    purchaseTaxesAndChargesTemplate: optionalEnv("ERPNEXT_PURCHASE_TAXES_AND_CHARGES_TEMPLATE"),
    vatAccountHead: optionalEnv("ERPNEXT_VAT_ACCOUNT_HEAD"),
    submitAfterPost: process.env.ERPNEXT_SUBMIT_AFTER_POST === "true"
  };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function authHeader(config: ErpNextConfig): string {
  return `token ${config.apiKey}:${config.apiSecret}`;
}

function doctypePath(doctype: string, name?: string): string {
  const base = `/api/resource/${encodeURIComponent(doctype)}`;
  return name ? `${base}/${encodeURIComponent(name)}` : base;
}

function serverMessages(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const messages = JSON.parse(value) as unknown;
    if (!Array.isArray(messages)) return [value];
    return messages.map((message) => {
      if (typeof message !== "string") return String(message);
      try {
        const parsed = JSON.parse(message) as { message?: unknown };
        return typeof parsed.message === "string" ? parsed.message : message;
      } catch {
        return message;
      }
    });
  } catch {
    return [value];
  }
}

function errorMessage(status: number, body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const payload = body as FrappeResponse<unknown> & { error?: unknown; exc?: unknown };
    return [
      typeof payload.error === "string" ? payload.error : undefined,
      typeof payload.exc_type === "string" ? payload.exc_type : undefined,
      typeof payload.exception === "string" ? payload.exception : undefined,
      ...serverMessages(payload._server_messages),
      typeof payload.message === "string" ? payload.message : undefined
    ].filter(Boolean).join(" ") || `${fallback} (${status})`;
  }
  return `${fallback} (${status})`;
}

async function parseFrappeResponse<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    body = { message: text };
  }
  if (!response.ok) {
    throw new Error(errorMessage(response.status, body, fallback));
  }
  const payload = body as FrappeResponse<T>;
  const data = payload.data ?? payload.message;
  if (data === undefined) {
    return body as T;
  }
  return data;
}

async function erpNextFetch<T>(
  config: ErpNextConfig,
  pathName: string,
  init: RequestInit = {},
  fallback = "ERPNext request failed"
): Promise<T> {
  const response = await fetch(`${config.baseUrl}${pathName}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: authHeader(config),
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init.headers
    }
  });
  return parseFrappeResponse<T>(response, fallback);
}

async function getLoggedUser(config: ErpNextConfig): Promise<string> {
  const result = await erpNextFetch<string>(config, "/api/method/frappe.auth.get_logged_user", {}, "ERPNext auth check failed");
  return typeof result === "string" ? result : JSON.stringify(result);
}

async function getResource(config: ErpNextConfig, doctype: string, name: string): Promise<unknown> {
  return erpNextFetch<unknown>(config, doctypePath(doctype, name), {}, `${doctype} ${name} was not reachable`);
}

async function listResources(
  config: ErpNextConfig,
  doctype: string,
  params: Record<string, string>
): Promise<unknown[]> {
  const search = new URLSearchParams(params);
  const result = await erpNextFetch<unknown>(config, `${doctypePath(doctype)}?${search.toString()}`, {}, `${doctype} list failed`);
  return result && typeof result === "object" && Array.isArray((result as { data?: unknown }).data)
    ? (result as { data: unknown[] }).data
    : Array.isArray(result)
      ? result
      : [];
}

async function findExistingPurchaseInvoice(config: ErpNextConfig, draft: InvoiceDraft): Promise<unknown | undefined> {
  if (!draft.supplierName.trim() || !draft.invoiceNumber.trim()) return undefined;
  const rows = await listResources(config, "Purchase Invoice", {
    fields: JSON.stringify(["name", "docstatus", "bill_no", "supplier"]),
    filters: JSON.stringify([
      ["supplier", "=", draft.supplierName],
      ["bill_no", "=", draft.invoiceNumber],
      ["docstatus", "<", 2]
    ]),
    limit_page_length: "1"
  });
  return rows[0];
}

function netLineAmount(line: InvoiceLineItem): number {
  return money(line.quantity * line.unitPrice - line.discount);
}

function itemCodeForLine(config: ErpNextConfig, line: InvoiceLineItem): string | undefined {
  if (line.selectedQoyodMapping?.type === "item" && line.selectedQoyodMapping.id.trim()) {
    return line.selectedQoyodMapping.id.trim();
  }
  return config.defaultItemCode;
}

function erpNextItemRow(config: ErpNextConfig, line: InvoiceLineItem): Record<string, unknown> {
  const itemCode = itemCodeForLine(config, line);
  const itemName = line.selectedQoyodMapping?.label || line.description;
  const row: Record<string, unknown> = {
    item_name: itemName,
    description: line.description,
    qty: line.quantity,
    rate: line.unitPrice,
    amount: netLineAmount(line),
    expense_account: config.defaultExpenseAccount,
    cost_center: config.defaultCostCenter
  };

  if (itemCode) row.item_code = itemCode;
  if (line.discount > 0) row.discount_amount = line.discount;
  return row;
}

function erpNextTaxes(config: ErpNextConfig, draft: InvoiceDraft): Record<string, unknown> {
  if (config.purchaseTaxesAndChargesTemplate) {
    return { taxes_and_charges: config.purchaseTaxesAndChargesTemplate };
  }

  if (!config.vatAccountHead || draft.vatTotal <= 0) {
    return {};
  }

  return {
    taxes: [
      {
        charge_type: "Actual",
        account_head: config.vatAccountHead,
        description: "VAT",
        tax_amount: money(draft.vatTotal),
        cost_center: config.defaultCostCenter
      }
    ]
  };
}

export function buildPurchaseInvoicePayload(
  job: Pick<IntakeJob, "jobId" | "batchId" | "batchSequence" | "draft">,
  config: ErpNextConfig,
  options: { testMode?: boolean } = {}
): Record<string, unknown> {
  const draft = job.draft;
  const issueDate = draft.issueDate || todayIso();
  const remarks = [
    options.testMode ? "UiPath invoice intake live connectivity test." : "Created by UiPath invoice intake.",
    `Intake job: ${job.jobId}`,
    job.batchId ? `Batch: ${job.batchId}` : "",
    job.batchSequence ? `Batch sequence: ${job.batchSequence}` : ""
  ].filter(Boolean).join("\n");

  return {
    doctype: "Purchase Invoice",
    company: config.company,
    supplier: draft.supplierName,
    bill_no: draft.invoiceNumber,
    bill_date: issueDate,
    posting_date: issueDate,
    due_date: draft.dueDate || issueDate,
    currency: draft.currency || "SAR",
    set_posting_time: 1,
    remarks,
    items: draft.lineItems.map((line) => erpNextItemRow(config, line)),
    ...erpNextTaxes(config, draft),
    docstatus: 0
  };
}

async function createPurchaseInvoice(
  config: ErpNextConfig,
  payload: Record<string, unknown>
): Promise<{ name: string; [key: string]: unknown }> {
  return erpNextFetch<{ name: string; [key: string]: unknown }>(
    config,
    doctypePath("Purchase Invoice"),
    {
      method: "POST",
      body: JSON.stringify(payload)
    },
    "ERPNext Purchase Invoice draft creation failed"
  );
}

async function uploadAttachment(
  config: ErpNextConfig,
  invoiceName: string,
  attachment: AttachmentRef
): Promise<{ file_name?: string; file_url?: string; [key: string]: unknown } | undefined> {
  if (!attachment.localPath) return undefined;

  const bytes = await readFile(attachment.localPath);
  const formData = new FormData();
  formData.append("file", new Blob([bytes], { type: attachment.mimeType }), attachment.name);
  formData.append("doctype", "Purchase Invoice");
  formData.append("docname", invoiceName);
  formData.append("is_private", "1");

  return erpNextFetch<{ file_name?: string; file_url?: string; [key: string]: unknown }>(
    config,
    "/api/method/upload_file",
    {
      method: "POST",
      body: formData
    },
    "ERPNext attachment upload failed"
  );
}

export async function createErpNextPurchaseInvoiceDraft(
  job: IntakeJob,
  options: { testMode?: boolean } = {}
): Promise<ErpNextPurchaseInvoiceResult> {
  const config = readErpNextConfig();
  if (config.submitAfterPost) {
    throw new Error("ERPNEXT_SUBMIT_AFTER_POST=true is not supported in v1 live validation; only draft invoices are allowed.");
  }

  const existing = await findExistingPurchaseInvoice(config, job.draft);
  if (existing) {
    throw new Error(`ERPNext duplicate Purchase Invoice found for supplier ${job.draft.supplierName} and bill ${job.draft.invoiceNumber}.`);
  }

  const invoice = await createPurchaseInvoice(config, buildPurchaseInvoicePayload(job, config, options));
  const attachment = job.draft.attachmentRefs[0]
    ? await uploadAttachment(config, invoice.name, job.draft.attachmentRefs[0])
    : undefined;

  return {
    invoiceName: invoice.name,
    invoiceUrl: `${config.baseUrl}/app/purchase-invoice/${encodeURIComponent(invoice.name)}`,
    attachmentName: attachment?.file_name,
    attachmentUrl: attachment?.file_url ? `${config.baseUrl}${attachment.file_url}` : undefined,
    rawInvoice: invoice,
    rawAttachment: attachment
  };
}

export function erpNextDestinationState(
  result: ErpNextPurchaseInvoiceResult,
  now = new Date().toISOString()
): DestinationState {
  return {
    platform: "erpnext",
    status: "draft_created",
    externalReference: result.invoiceName,
    externalUrl: result.invoiceUrl,
    attachmentName: result.attachmentName,
    attachmentUrl: result.attachmentUrl,
    completedAt: now,
    updatedAt: now
  };
}

async function check(
  checks: ErpNextPreflightResult["checks"],
  name: string,
  action: () => Promise<unknown>
): Promise<void> {
  try {
    const data = await action();
    checks.push({ name, ok: true, message: "OK", data });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function preflightErpNext(options: { supplierName?: string; itemCode?: string } = {}): Promise<ErpNextPreflightResult> {
  const config = readErpNextConfig();
  const checks: ErpNextPreflightResult["checks"] = [];

  await check(checks, "auth", () => getLoggedUser(config));
  await check(checks, "company", () => getResource(config, "Company", config.company));
  await check(checks, "expense_account", () => getResource(config, "Account", config.defaultExpenseAccount));
  await check(checks, "cost_center", () => getResource(config, "Cost Center", config.defaultCostCenter));

  if (options.supplierName) {
    await check(checks, "supplier", () => getResource(config, "Supplier", options.supplierName ?? ""));
  }

  const itemCode = options.itemCode ?? config.defaultItemCode;
  if (itemCode) {
    await check(checks, "item", () => getResource(config, "Item", itemCode));
  }

  if (config.purchaseTaxesAndChargesTemplate) {
    await check(checks, "purchase_taxes_and_charges_template", () =>
      getResource(config, "Purchase Taxes and Charges Template", config.purchaseTaxesAndChargesTemplate ?? "")
    );
  }

  if (config.vatAccountHead) {
    await check(checks, "vat_account", () => getResource(config, "Account", config.vatAccountHead ?? ""));
  }

  return {
    ok: checks.every((item) => item.ok),
    checks
  };
}
