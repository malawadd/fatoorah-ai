import { describe, expect, it } from "vitest";
import type { InvoiceDraft, QoyodMappingRule } from "../shared/invoice";
import { applyMappingRulesToDraft } from "./mapping";

const draft: InvoiceDraft = {
  supplierName: "Jory Spring Trading Co.",
  supplierTaxId: "310221951800003",
  invoiceNumber: "7364",
  issueDate: "2026-02-07",
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
      description: "48 مخدة جبس برد شد",
      quantity: 50,
      unitPrice: 4,
      discount: 0,
      taxRate: 15,
      taxAmount: 30,
      total: 230
    }
  ]
};

const baseRule: QoyodMappingRule = {
  ruleId: "global",
  createdAt: "2026-06-18T10:00:00.000Z",
  updatedAt: "2026-06-18T10:00:00.000Z",
  active: true,
  type: "expense",
  qoyodId: "general-purchases",
  label: "General purchases",
  matchText: "مخدة",
  matchMode: "contains"
};

describe("mapping rules", () => {
  it("applies matching rules to unmapped lines", () => {
    const result = applyMappingRulesToDraft(draft, [baseRule]);

    expect(result.appliedCount).toBe(1);
    expect(result.draft.lineItems[0].selectedQoyodMapping).toEqual({
      type: "expense",
      id: "general-purchases",
      label: "General purchases"
    });
  });

  it("prefers supplier-specific rules over global rules", () => {
    const supplierRule: QoyodMappingRule = {
      ...baseRule,
      ruleId: "supplier",
      supplierTaxId: "310221951800003",
      qoyodId: "jory-merchandise",
      label: "Jory merchandise",
      updatedAt: "2026-06-18T11:00:00.000Z"
    };

    const result = applyMappingRulesToDraft(draft, [baseRule, supplierRule]);

    expect(result.draft.lineItems[0].selectedQoyodMapping?.id).toBe("jory-merchandise");
  });

  it("does not overwrite manual line mappings", () => {
    const result = applyMappingRulesToDraft({
      ...draft,
      lineItems: [{
        ...draft.lineItems[0],
        selectedQoyodMapping: { type: "expense", id: "manual", label: "Manual" }
      }]
    }, [baseRule]);

    expect(result.appliedCount).toBe(0);
    expect(result.draft.lineItems[0].selectedQoyodMapping?.id).toBe("manual");
  });
});
