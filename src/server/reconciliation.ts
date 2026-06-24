import type { InvoiceDraft, ValidationResult } from "../shared/invoice";

const MONEY_TOLERANCE = 0.02;

function money(value: number | undefined): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(money(left) - money(right)) <= MONEY_TOLERANCE;
}

export function reconcileDraft(draft: InvoiceDraft): ValidationResult {
  const blocking: string[] = [];
  const warnings: string[] = [];

  if (!draft.supplierName.trim()) blocking.push("Supplier name is required.");
  if (!draft.supplierTaxId.trim()) blocking.push("Supplier tax ID is required.");
  if (!draft.invoiceNumber.trim()) blocking.push("Invoice number is required.");
  if (!draft.issueDate.trim()) blocking.push("Issue date is required.");
  if (!draft.currency.trim()) blocking.push("Currency is required.");
  if (!draft.attachmentRefs.length) blocking.push("At least one invoice attachment is required.");
  if (!draft.lineItems.length) blocking.push("At least one line item is required.");

  let lineSubtotal = 0;
  let lineVat = 0;
  let lineGrandTotal = 0;

  for (const [index, item] of draft.lineItems.entries()) {
    const lineNumber = index + 1;
    const net = money(item.quantity * item.unitPrice - item.discount);
    const expectedVat = money(net * (item.taxRate / 100));
    const expectedTotal = money(net + expectedVat);

    lineSubtotal += net;
    lineVat += item.taxAmount || expectedVat;
    lineGrandTotal += item.total || expectedTotal;

    if (!item.description.trim()) blocking.push(`Line ${lineNumber}: description is required.`);
    if (item.quantity <= 0) blocking.push(`Line ${lineNumber}: quantity must be greater than zero.`);
    if (!item.selectedQoyodMapping?.id) blocking.push(`Line ${lineNumber}: destination item or expense mapping is required.`);
    if (item.taxAmount && !closeEnough(item.taxAmount, expectedVat)) {
      warnings.push(`Line ${lineNumber}: tax amount differs from quantity x unit price x tax rate.`);
    }
    if (item.total && !closeEnough(item.total, expectedTotal)) {
      warnings.push(`Line ${lineNumber}: line total differs from calculated total.`);
    }
  }

  lineSubtotal = money(lineSubtotal);
  lineVat = money(lineVat);
  lineGrandTotal = money(lineGrandTotal);

  if (draft.subtotal > 0 && !closeEnough(draft.subtotal, lineSubtotal)) {
    blocking.push("Header subtotal does not reconcile with line items.");
  }
  if (draft.vatTotal > 0 && !closeEnough(draft.vatTotal, lineVat)) {
    blocking.push("Header VAT total does not reconcile with line items.");
  }
  if (draft.grandTotal > 0 && !closeEnough(draft.grandTotal, lineGrandTotal)) {
    blocking.push("Header grand total does not reconcile with line items.");
  }

  if (draft.qrTlv?.vatRegistrationNumber && draft.supplierTaxId && draft.qrTlv.vatRegistrationNumber !== draft.supplierTaxId) {
    blocking.push("QR VAT number does not match supplier tax ID.");
  }
  if (draft.qrTlv?.totalWithVat !== undefined && draft.grandTotal > 0 && !closeEnough(draft.qrTlv.totalWithVat, draft.grandTotal)) {
    blocking.push("QR grand total does not match OCR/reviewed grand total.");
  }
  if (draft.qrTlv?.vatTotal !== undefined && draft.vatTotal > 0 && !closeEnough(draft.qrTlv.vatTotal, draft.vatTotal)) {
    blocking.push("QR VAT total does not match OCR/reviewed VAT total.");
  }

  return {
    canSubmitToRobot: blocking.length === 0,
    blocking,
    warnings,
    totals: {
      lineSubtotal,
      lineVat,
      lineGrandTotal,
      headerGrandTotal: money(draft.grandTotal),
      headerVatTotal: money(draft.vatTotal)
    }
  };
}
