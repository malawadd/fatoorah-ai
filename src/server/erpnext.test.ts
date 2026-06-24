import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntakeJob, InvoiceDraft } from "../shared/invoice";
import { buildPurchaseInvoicePayload, createErpNextPurchaseInvoiceDraft } from "./erpnext";

const config = {
  baseUrl: "https://erpnext.example.test",
  apiKey: "key",
  apiSecret: "secret",
  company: "Demo Company",
  defaultExpenseAccount: "Expenses - DC",
  defaultCostCenter: "Main - DC",
  defaultItemCode: undefined,
  purchaseTaxesAndChargesTemplate: undefined,
  vatAccountHead: "VAT Input - DC",
  submitAfterPost: false
};

const draft: InvoiceDraft = {
  supplierName: "Demo Supplier",
  supplierTaxId: "300000000000003",
  invoiceNumber: "INV-ERP-1",
  issueDate: "2026-06-24",
  dueDate: "2026-07-24",
  currency: "SAR",
  subtotal: 100,
  discount: 0,
  vatTotal: 15,
  grandTotal: 115,
  attachmentRefs: [
    {
      id: "att-1",
      name: "invoice.pdf",
      mimeType: "application/pdf",
      size: 8
    }
  ],
  lineItems: [
    {
      id: "line-1",
      description: "Consulting services",
      quantity: 1,
      unitPrice: 100,
      discount: 0,
      taxRate: 15,
      taxAmount: 15,
      total: 115,
      selectedQoyodMapping: {
        type: "expense",
        id: "consulting-expense",
        label: "Consulting expense"
      }
    }
  ]
};

function jobFixture(localPath?: string): IntakeJob {
  return {
    jobId: "job-1",
    status: "reviewed",
    createdAt: "2026-06-24T10:00:00.000Z",
    updatedAt: "2026-06-24T10:00:00.000Z",
    draft: {
      ...draft,
      attachmentRefs: draft.attachmentRefs.map((attachment) => ({ ...attachment, localPath }))
    },
    destinations: [{ platform: "erpnext", status: "ready", updatedAt: "2026-06-24T10:00:00.000Z" }],
    events: []
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function stubErpNextEnv() {
  vi.stubEnv("ERPNEXT_BASE_URL", config.baseUrl);
  vi.stubEnv("ERPNEXT_API_KEY", config.apiKey);
  vi.stubEnv("ERPNEXT_API_SECRET", config.apiSecret);
  vi.stubEnv("ERPNEXT_COMPANY", config.company);
  vi.stubEnv("ERPNEXT_DEFAULT_EXPENSE_ACCOUNT", config.defaultExpenseAccount);
  vi.stubEnv("ERPNEXT_DEFAULT_COST_CENTER", config.defaultCostCenter);
  vi.stubEnv("ERPNEXT_VAT_ACCOUNT_HEAD", config.vatAccountHead ?? "");
  vi.stubEnv("ERPNEXT_SUBMIT_AFTER_POST", "false");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("ERPNext adapter", () => {
  it("builds Purchase Invoice draft payloads with expense-account rows and VAT attachment-safe remarks", () => {
    const payload = buildPurchaseInvoicePayload(jobFixture(), config);

    expect(payload.doctype).toBe("Purchase Invoice");
    expect(payload.supplier).toBe("Demo Supplier");
    expect(payload.docstatus).toBe(0);
    expect(payload.items).toEqual([
      expect.objectContaining({
        item_name: "Consulting expense",
        description: "Consulting services",
        qty: 1,
        rate: 100,
        amount: 100,
        expense_account: "Expenses - DC",
        cost_center: "Main - DC"
      })
    ]);
    expect(payload.taxes).toEqual([
      expect.objectContaining({
        charge_type: "Actual",
        account_head: "VAT Input - DC",
        tax_amount: 15
      })
    ]);
    expect(String(payload.remarks)).toContain("Intake job: job-1");
  });

  it("creates a draft Purchase Invoice and attaches the source document", async () => {
    stubErpNextEnv();
    const dir = await mkdtemp(path.join(os.tmpdir(), "erpnext-test-"));
    const filePath = path.join(dir, "invoice.pdf");
    await writeFile(filePath, Buffer.from("pdf-data"));

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/resource/Purchase%20Invoice?")) {
        return jsonResponse({ data: [] });
      }
      if (url.endsWith("/api/resource/Purchase%20Invoice") && init?.method === "POST") {
        expect(init.headers).toMatchObject({
          Authorization: "token key:secret"
        });
        return jsonResponse({ data: { name: "PINV-0001" } });
      }
      if (url.endsWith("/api/method/upload_file") && init?.method === "POST") {
        expect(init.body).toBeInstanceOf(FormData);
        return jsonResponse({ message: { file_name: "invoice.pdf", file_url: "/private/files/invoice.pdf" } });
      }
      return jsonResponse({ error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createErpNextPurchaseInvoiceDraft(jobFixture(filePath));

    expect(result.invoiceName).toBe("PINV-0001");
    expect(result.invoiceUrl).toBe("https://erpnext.example.test/app/purchase-invoice/PINV-0001");
    expect(result.attachmentUrl).toBe("https://erpnext.example.test/private/files/invoice.pdf");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("blocks duplicate supplier bill numbers before creating a new draft", async () => {
    stubErpNextEnv();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [{ name: "PINV-DUP" }] })));

    await expect(createErpNextPurchaseInvoiceDraft(jobFixture())).rejects.toThrow("duplicate Purchase Invoice");
  });
});
