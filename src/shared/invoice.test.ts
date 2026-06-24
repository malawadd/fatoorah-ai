import { describe, expect, it } from "vitest";
import type { InvoiceDraft } from "./invoice";
import { caseStageFromBatchStatus, deriveHeaderTotalsFromLines, normalizeInvoiceDraft } from "./invoice";

const draft: InvoiceDraft = {
  supplierName: "Demo",
  supplierTaxId: "300000000000003",
  invoiceNumber: "INV-1",
  issueDate: "2026-06-18",
  dueDate: "",
  currency: "SAR",
  subtotal: 200,
  discount: 0,
  vatTotal: 30,
  grandTotal: 230,
  attachmentRefs: [{ id: "att", name: "invoice.png", mimeType: "image/png", size: 10 }],
  lineItems: [
    {
      id: "line-1",
      description: "Goods",
      quantity: 50,
      unitPrice: 4,
      discount: 0,
      taxRate: 15,
      taxAmount: 0,
      total: 200
    }
  ]
};

describe("invoice draft normalization", () => {
  it("normalizes stale extracted line totals as VAT-inclusive totals", () => {
    const normalized = normalizeInvoiceDraft(draft);

    expect(normalized.lineItems[0].taxAmount).toBe(30);
    expect(normalized.lineItems[0].total).toBe(230);
    expect(normalized.grandTotal).toBe(230);
  });

  it("can derive header totals from normalized lines", () => {
    const normalized = deriveHeaderTotalsFromLines({ ...draft, grandTotal: 0 });

    expect(normalized.subtotal).toBe(200);
    expect(normalized.vatTotal).toBe(30);
    expect(normalized.grandTotal).toBe(230);
  });

  it("maps batch status to the local Maestro Case cockpit stage", () => {
    expect(caseStageFromBatchStatus("processing")).toBe("Extraction And Reconciliation");
    expect(caseStageFromBatchStatus("needs_review")).toBe("Finance Review And Mapping");
    expect(caseStageFromBatchStatus("reviewed")).toBe("Destination Posting");
    expect(caseStageFromBatchStatus("ready_for_qoyod")).toBe("Qoyod Drafting");
    expect(caseStageFromBatchStatus("error")).toBe("Exception Resolution");
    expect(caseStageFromBatchStatus("posting_error")).toBe("Exception Resolution");
    expect(caseStageFromBatchStatus("draft_saved")).toBe("Closed");
    expect(caseStageFromBatchStatus("posted")).toBe("Closed");
  });
});
