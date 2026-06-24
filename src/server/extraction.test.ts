import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntakeJob, InvoiceDraft } from "../shared/invoice";
import { buildExtractionJobInput, extractInvoiceDraft } from "./extraction";

const originalEnv = { ...process.env };
let tempDir = "";

const baseDraft: InvoiceDraft = {
  supplierName: "QR Supplier",
  supplierTaxId: "300000000000003",
  invoiceNumber: "",
  issueDate: "2026-06-18",
  dueDate: "",
  currency: "SAR",
  subtotal: 100,
  discount: 0,
  vatTotal: 15,
  grandTotal: 115,
  attachmentRefs: [],
  qrTlv: {
    sellerName: "QR Supplier",
    vatRegistrationNumber: "300000000000003",
    timestamp: "2026-06-18T10:00:00Z",
    totalWithVat: 115,
    vatTotal: 15,
    rawPayload: "qr",
    rawTags: {}
  },
  lineItems: []
};

describe("extraction provider seam", () => {
  beforeEach(async () => {
    process.env = { ...originalEnv };
    tempDir = await mkdtemp(path.join(os.tmpdir(), "qoyod-extraction-"));
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("builds external extraction input without exposing local file paths or secrets", async () => {
    const job = await jobFixture();
    const input = buildExtractionJobInput(job, "https://example.test");

    expect(input.jobId).toBe(job.jobId);
    expect(input.callbackUrl).toBe("https://example.test/api/extraction/jobs/job-1/result");
    expect(input.sourceUrl).toBe("https://example.test/api/extraction/jobs/job-1/source");
    expect(JSON.stringify(input)).not.toContain(job.draft.attachmentRefs[0].localPath);
    expect(JSON.stringify(input)).not.toContain("OPENAI_API_KEY");
  });

  it("falls back to manual review when OpenAI is not configured", async () => {
    delete process.env.OPENAI_API_KEY;

    const result = await extractInvoiceDraft(await jobFixture());

    expect(result.extraction.provider).toBe("manual");
    expect(result.extraction.confidence).toBe(0);
    expect(result.draft.supplierName).toBe("QR Supplier");
  });

  it("parses mocked OpenAI structured output and removes model-created mappings", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(openAiEnvelope(invoiceDraftCandidate()))));

    const result = await extractInvoiceDraft(await jobFixture());

    expect(result.extraction.provider).toBe("openai");
    expect(result.extraction.confidence).toBeGreaterThan(0.8);
    expect(result.draft.invoiceNumber).toBe("INV-100");
    expect(result.draft.lineItems).toHaveLength(1);
    expect(result.draft.lineItems[0].selectedQoyodMapping).toBeUndefined();
    expect(result.draft.attachmentRefs[0].name).toBe("invoice.png");
  });

  it("surfaces malformed model JSON as an extraction failure", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(openAiEnvelope("not json"))));

    await expect(extractInvoiceDraft(await jobFixture())).rejects.toThrow("valid JSON");
  });

  it("marks missing line items as lower confidence", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    const candidate = { ...invoiceDraftCandidate(), lineItems: [] };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(openAiEnvelope(candidate))));

    const result = await extractInvoiceDraft(await jobFixture());

    expect(result.extraction.confidence).toBeLessThan(1);
    expect(result.draft.lineItems).toEqual([]);
  });

  it("uses DeepSeek normalization when configured while preserving attachment and mapping boundaries", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const normalized = {
      ...invoiceDraftCandidate(),
      invoiceNumber: "INV-100-NORMALIZED",
      attachmentRefs: [],
      lineItems: [
        {
          ...invoiceDraftCandidate().lineItems[0],
          selectedQoyodMapping: { type: "expense", id: "invented", label: "Invented" }
        }
      ]
    };

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse(openAiEnvelope(invoiceDraftCandidate())))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: JSON.stringify(normalized) } }]
      })));

    const result = await extractInvoiceDraft(await jobFixture());

    expect(result.extraction.provider).toBe("deepseek");
    expect(result.draft.invoiceNumber).toBe("INV-100-NORMALIZED");
    expect(result.draft.attachmentRefs[0].name).toBe("invoice.png");
    expect(result.draft.lineItems[0].selectedQoyodMapping).toBeUndefined();
  });
});

async function jobFixture(): Promise<IntakeJob> {
  const localPath = path.join(tempDir, "invoice.png");
  await writeFile(localPath, Buffer.from("fake-image"));
  return {
    jobId: "job-1",
    status: "uploaded",
    createdAt: "2026-06-18T10:00:00.000Z",
    updatedAt: "2026-06-18T10:00:00.000Z",
    draft: {
      ...baseDraft,
      attachmentRefs: [
        {
          id: "att-1",
          name: "invoice.png",
          mimeType: "image/png",
          size: 10,
          localPath
        }
      ]
    },
    destinations: [],
    events: []
  };
}

function invoiceDraftCandidate(): InvoiceDraft {
  return {
    ...baseDraft,
    supplierName: "Extracted Supplier",
    invoiceNumber: "INV-100",
    lineItems: [
      {
        id: "line-1",
        description: "Consulting",
        quantity: 1,
        unitPrice: 100,
        discount: 0,
        taxRate: 15,
        taxAmount: 15,
        total: 115,
        selectedQoyodMapping: {
          type: "expense",
          id: "model-made-up",
          label: "Model made up"
        }
      }
    ]
  };
}

function openAiEnvelope(value: unknown): unknown {
  return {
    output: [
      {
        content: [
          {
            type: "output_text",
            text: typeof value === "string" ? value : JSON.stringify(value)
          }
        ]
      }
    ]
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response;
}
