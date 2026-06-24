import { describe, expect, it } from "vitest";
import type { InvoiceDraft } from "../shared/invoice";
import { reconcileDraft } from "./reconciliation";

const validDraft: InvoiceDraft = {
  supplierName: "Demo Supplier",
  supplierTaxId: "300000000000003",
  invoiceNumber: "INV-001",
  issueDate: "2026-06-17",
  dueDate: "",
  currency: "SAR",
  subtotal: 100,
  discount: 0,
  vatTotal: 15,
  grandTotal: 115,
  attachmentRefs: [
    {
      id: "att_1",
      name: "invoice.pdf",
      mimeType: "application/pdf",
      size: 1024
    }
  ],
  lineItems: [
    {
      id: "line_1",
      description: "Consulting",
      quantity: 1,
      unitPrice: 100,
      discount: 0,
      taxRate: 15,
      taxAmount: 15,
      total: 115,
      selectedQoyodMapping: {
        type: "expense",
        id: "exp_consulting",
        label: "Consulting expense"
      }
    }
  ]
};

describe("reconcileDraft", () => {
  it("allows reviewed drafts that reconcile and have mappings", () => {
    const result = reconcileDraft(validDraft);
    expect(result.canSubmitToRobot).toBe(true);
    expect(result.blocking).toEqual([]);
  });

  it("blocks grand-total mismatches and missing mappings", () => {
    const result = reconcileDraft({
      ...validDraft,
      grandTotal: 120,
      lineItems: [{ ...validDraft.lineItems[0], selectedQoyodMapping: undefined }]
    });

    expect(result.canSubmitToRobot).toBe(false);
    expect(result.blocking).toContain("Header grand total does not reconcile with line items.");
    expect(result.blocking).toContain("Line 1: destination item or expense mapping is required.");
  });
});
