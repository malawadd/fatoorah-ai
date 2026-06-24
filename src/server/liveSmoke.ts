import "./env";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IntakeJob, InvoiceDraft } from "../shared/invoice";
import { createErpNextPurchaseInvoiceDraft, preflightErpNext, readErpNextConfig } from "./erpnext";
import { runUiPathLivePreflight } from "./uipathCli";

const MINIMAL_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 44 >>
stream
BT /F1 12 Tf 30 120 Td (UiPath ERPNext test) Tj ET
endstream
endobj
xref
0 5
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000202 00000 n
trailer
<< /Root 1 0 R /Size 5 >>
startxref
296
%%EOF
`;

function requireTestEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for this live smoke test.`);
  return value;
}

function timestampId(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

async function createTestAttachment(): Promise<{ path: string; name: string; size: number }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "invoice-intake-live-"));
  const filePath = path.join(dir, "uipath-erpnext-live-test.pdf");
  const bytes = Buffer.from(MINIMAL_PDF, "utf-8");
  await writeFile(filePath, bytes);
  return {
    path: filePath,
    name: path.basename(filePath),
    size: bytes.length
  };
}

async function runErpNextLiveSmoke() {
  const config = readErpNextConfig();
  const supplier = requireTestEnv("ERPNEXT_TEST_SUPPLIER");
  const preflight = await preflightErpNext({
    supplierName: supplier,
    itemCode: config.defaultItemCode
  });

  if (!preflight.ok) {
    return { ok: false, preflight };
  }

  const attachment = await createTestAttachment();
  const invoiceNumber = `UIPATH-TEST-${timestampId()}`;
  const issueDate = new Date().toISOString().slice(0, 10);
  const draft: InvoiceDraft = {
    supplierName: supplier,
    supplierTaxId: process.env.ERPNEXT_TEST_SUPPLIER_TAX_ID ?? "000000000000000",
    invoiceNumber,
    issueDate,
    dueDate: issueDate,
    currency: process.env.ERPNEXT_TEST_CURRENCY ?? "SAR",
    subtotal: 100,
    discount: 0,
    vatTotal: 15,
    grandTotal: 115,
    attachmentRefs: [
      {
        id: randomUUID(),
        name: attachment.name,
        mimeType: "application/pdf",
        size: attachment.size,
        localPath: attachment.path
      }
    ],
    lineItems: [
      {
        id: randomUUID(),
        description: "UiPath ERPNext live connectivity test line",
        quantity: 1,
        unitPrice: 100,
        discount: 0,
        taxRate: 15,
        taxAmount: 15,
        total: 115,
        selectedQoyodMapping: {
          type: "expense",
          id: "uipath-live-test",
          label: "UiPath live test"
        }
      }
    ]
  };
  const now = new Date().toISOString();
  const job: IntakeJob = {
    jobId: `live-${randomUUID()}`,
    status: "reviewed",
    createdAt: now,
    updatedAt: now,
    draft,
    destinations: [{ platform: "erpnext", status: "ready", requestedAt: now, updatedAt: now }],
    events: [{ at: now, level: "info", message: "Live ERPNext smoke test job created." }]
  };

  const invoice = await createErpNextPurchaseInvoiceDraft(job, { testMode: true });
  return {
    ok: true,
    preflight,
    invoice
  };
}

async function main() {
  const result: Record<string, unknown> = {
    time: new Date().toISOString(),
    erpnext: process.env.LIVE_ERPNEXT_TEST === "true" ? await runErpNextLiveSmoke() : { skipped: true },
    uipath: process.env.LIVE_UIPATH_TEST === "true" ? await runUiPathLivePreflight() : { skipped: true }
  };

  const failed = Object.values(result).some((value) =>
    value && typeof value === "object" && "ok" in value && (value as { ok?: boolean }).ok === false
  );

  console.log(JSON.stringify(result, null, 2));
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
