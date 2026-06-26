import { describe, expect, it } from "vitest";
import type { BatchDetails, IntakeJob } from "../shared/invoice";
import { buildCaseBatchProgress } from "./caseProgress";

function jobFixture(patch: Partial<IntakeJob> = {}): IntakeJob {
  return {
    jobId: "job-1",
    status: "needs_review",
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    draft: {
      supplierName: "Demo Supplier",
      supplierTaxId: "300000000000003",
      invoiceNumber: "INV-1",
      issueDate: "2026-06-26",
      dueDate: "",
      currency: "SAR",
      subtotal: 100,
      discount: 0,
      vatTotal: 15,
      grandTotal: 115,
      attachmentRefs: [],
      lineItems: []
    },
    destinations: [],
    events: [],
    ...patch
  };
}

function batchDetails(jobs: IntakeJob[], status: BatchDetails["batch"]["status"]): BatchDetails {
  return {
    batch: {
      batchId: "batch-1",
      name: "Demo Batch",
      status,
      createdAt: "2026-06-26T00:00:00.000Z",
      updatedAt: "2026-06-26T00:00:00.000Z",
      options: { readyPolicy: "per_invoice", autoApplyMappings: true },
      jobIds: jobs.map((job) => job.jobId),
      events: [],
      caseStage: "Capture Intake",
      caseStatus: "active",
      caseRuntimeMode: "live"
    },
    jobs,
    summary: {
      batchId: "batch-1",
      name: "Demo Batch",
      status,
      createdAt: "2026-06-26T00:00:00.000Z",
      updatedAt: "2026-06-26T00:00:00.000Z",
      totalJobs: jobs.length,
      counts: Object.fromEntries(jobs.map((job) => [job.status, 1])),
      caseStage: "Capture Intake",
      caseStatus: "active",
      caseRuntimeMode: "live"
    }
  };
}

describe("case batch progress", () => {
  it("moves extraction-complete invoices to finance review", () => {
    const progress = buildCaseBatchProgress(batchDetails([jobFixture()], "needs_review"), "https://demo.example");

    expect(progress.nextStage).toBe("Finance Review And Mapping");
    expect(progress.reviewUrl).toBe("https://demo.example/?batchId=batch-1");
  });

  it("routes ERPNext-selected reviewed invoices to destination posting until the draft exists", () => {
    const progress = buildCaseBatchProgress(batchDetails([
      jobFixture({
        status: "posting",
        destinations: [{ platform: "erpnext", status: "posting", updatedAt: "2026-06-26T00:01:00.000Z" }]
      })
    ], "posting"));

    expect(progress.nextStage).toBe("Destination Posting");
    expect(progress.flags.destinationPostingComplete).toBe(false);
  });

  it("routes mixed ERPNext and Qoyod invoices to Qoyod drafting after ERPNext draft creation", () => {
    const progress = buildCaseBatchProgress(batchDetails([
      jobFixture({
        status: "ready_for_qoyod",
        destinations: [
          { platform: "erpnext", status: "draft_created", externalReference: "ACC-PINV-1", updatedAt: "2026-06-26T00:01:00.000Z" },
          { platform: "qoyod", status: "ready", updatedAt: "2026-06-26T00:01:00.000Z" }
        ]
      })
    ], "ready_for_qoyod"));

    expect(progress.nextStage).toBe("Qoyod Drafting");
    expect(progress.references.erpnextDraftReferences).toEqual(["ACC-PINV-1"]);
  });

  it("closes when selected destinations have draft references", () => {
    const progress = buildCaseBatchProgress(batchDetails([
      jobFixture({
        status: "draft_saved",
        destinations: [
          { platform: "erpnext", status: "draft_created", externalReference: "ACC-PINV-1", updatedAt: "2026-06-26T00:01:00.000Z" },
          { platform: "qoyod", status: "draft_created", externalReference: "BILL-1", updatedAt: "2026-06-26T00:02:00.000Z" }
        ]
      })
    ], "draft_saved"));

    expect(progress.nextStage).toBe("Closed");
    expect(progress.caseStatus).toBe("closed");
  });
});
