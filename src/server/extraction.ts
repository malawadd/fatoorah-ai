import { readFile } from "node:fs/promises";
import type { AttachmentRef, ExtractionMetadata, IntakeJob, InvoiceDraft } from "../shared/invoice";
import { invoiceDraftSchema } from "../shared/invoice";

type ExtractionJobInput = {
  jobId: string;
  callbackUrl: string;
  sourceUrl: string;
  attachment: Pick<AttachmentRef, "id" | "name" | "mimeType" | "size" | "bucketPath"> | null;
  qrTlv: InvoiceDraft["qrTlv"] | null;
  seededDraft: InvoiceDraft;
};

type ExtractionResult = {
  draft: InvoiceDraft;
  extraction: ExtractionMetadata;
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-4.1";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

const invoiceDraftJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "supplierName",
    "supplierTaxId",
    "invoiceNumber",
    "issueDate",
    "dueDate",
    "currency",
    "subtotal",
    "discount",
    "vatTotal",
    "grandTotal",
    "attachmentRefs",
    "qrTlv",
    "lineItems"
  ],
  properties: {
    supplierName: { type: "string" },
    supplierTaxId: { type: "string" },
    invoiceNumber: { type: "string" },
    issueDate: { type: "string", description: "ISO date yyyy-mm-dd or empty string" },
    dueDate: { type: "string", description: "ISO date yyyy-mm-dd or empty string" },
    currency: { type: "string" },
    subtotal: { type: "number" },
    discount: { type: "number" },
    vatTotal: { type: "number" },
    grandTotal: { type: "number" },
    attachmentRefs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "mimeType", "size"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          mimeType: { type: "string" },
          size: { type: "number" }
        }
      }
    },
    qrTlv: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["sellerName", "vatRegistrationNumber", "timestamp", "totalWithVat", "vatTotal", "rawPayload", "rawTags"],
          properties: {
            sellerName: { type: "string" },
            vatRegistrationNumber: { type: "string" },
            timestamp: { type: "string" },
            totalWithVat: { type: "number" },
            vatTotal: { type: "number" },
            rawPayload: { type: "string" },
            rawTags: {
              type: "object",
              additionalProperties: false,
              properties: {}
            }
          }
        },
        { type: "null" }
      ]
    },
    lineItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "description",
          "quantity",
          "unitPrice",
          "discount",
          "taxRate",
          "taxAmount",
          "total",
          "selectedQoyodMapping"
        ],
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          quantity: { type: "number" },
          unitPrice: { type: "number" },
          discount: { type: "number" },
          taxRate: { type: "number" },
          taxAmount: { type: "number" },
          total: { type: "number" },
          selectedQoyodMapping: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["type", "id", "label"],
                properties: {
                  type: { enum: ["item", "expense"] },
                  id: { type: "string" },
                  label: { type: "string" }
                }
              },
              { type: "null" }
            ]
          }
        }
      }
    }
  }
};

function firstAttachment(job: IntakeJob): AttachmentRef | undefined {
  return job.draft.attachmentRefs[0];
}

export function buildExtractionJobInput(job: IntakeJob, apiBaseUrl: string): ExtractionJobInput {
  const attachment = firstAttachment(job);
  return {
    jobId: job.jobId,
    callbackUrl: `${apiBaseUrl}/api/extraction/jobs/${job.jobId}/result`,
    sourceUrl: `${apiBaseUrl}/api/extraction/jobs/${job.jobId}/source`,
    attachment: attachment
      ? {
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        bucketPath: attachment.bucketPath
      }
      : null,
    qrTlv: job.draft.qrTlv ?? null,
    seededDraft: job.draft
  };
}

export async function startExternalExtraction(job: IntakeJob, input: ExtractionJobInput): Promise<void> {
  const url = process.env.EXTRACTION_START_URL;
  if (!url) {
    throw new Error("EXTRACTION_START_URL is required when EXTRACTION_MODE=external.");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.EXTRACTION_CALLBACK_TOKEN ? { "x-extraction-token": process.env.EXTRACTION_CALLBACK_TOKEN } : {})
    },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`External extraction start failed with ${response.status}${body ? `: ${body}` : ""}`);
  }
}

export async function extractInvoiceDraft(job: IntakeJob): Promise<ExtractionResult> {
  const attachment = firstAttachment(job);
  if (!attachment?.localPath) {
    return {
      draft: job.draft,
      extraction: {
        provider: "manual",
        confidence: 0,
        warnings: ["No local attachment was available for LLM extraction."]
      }
    };
  }

  const openAiKey = process.env.OPENAI_API_KEY;
  if (!openAiKey) {
    return {
      draft: job.draft,
      extraction: {
        provider: "manual",
        confidence: 0,
        warnings: ["OPENAI_API_KEY is not configured; seeded QR draft is awaiting manual review."]
      }
    };
  }

  const openAiResult = await extractWithOpenAi(job, attachment, openAiKey);
  if (!process.env.DEEPSEEK_API_KEY) {
    return openAiResult;
  }

  return normalizeWithDeepSeek(job, openAiResult).catch((error: unknown) => ({
    ...openAiResult,
    extraction: {
      ...openAiResult.extraction,
      warnings: [
        ...(openAiResult.extraction.warnings ?? []),
        `DeepSeek normalization skipped: ${error instanceof Error ? error.message : String(error)}`
      ]
    }
  }));
}

async function extractWithOpenAi(job: IntakeJob, attachment: AttachmentRef, apiKey: string): Promise<ExtractionResult> {
  const model = process.env.OPENAI_EXTRACTION_MODEL || DEFAULT_OPENAI_MODEL;
  const bytes = await readFile(attachment.localPath ?? "");
  const dataUrl = `data:${attachment.mimeType};base64,${bytes.toString("base64")}`;
  const content = attachment.mimeType === "application/pdf"
    ? [
      { type: "input_text", text: promptFor(job) },
      { type: "input_file", filename: attachment.name, file_data: dataUrl }
    ]
    : [
      { type: "input_text", text: promptFor(job) },
      { type: "input_image", image_url: dataUrl }
    ];

  const response = await fetch(`${process.env.OPENAI_BASE_URL || OPENAI_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "Extract invoice data into the provided schema. Return only values visible in the source. Use empty strings or zeroes when unsure. Never invent destination mappings."
            }
          ]
        },
        { role: "user", content }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "invoice_draft",
          schema: invoiceDraftJsonSchema,
          strict: true
        }
      }
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI extraction failed with ${response.status}${body ? `: ${body}` : ""}`);
  }

  const body = await response.json();
  const candidate = parseJsonFromResponse(body);
  return {
    draft: mergeExtractedDraft(job, candidate),
    extraction: {
      provider: "openai",
      model,
      confidence: inferConfidence(candidate),
      warnings: []
    }
  };
}

async function normalizeWithDeepSeek(job: IntakeJob, result: ExtractionResult): Promise<ExtractionResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return result;

  const model = process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL;
  const baseUrl = process.env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL;
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Normalize invoice JSON only. Preserve facts from the draft. Do not add destination mapping IDs. Output a single JSON object matching InvoiceDraft."
        },
        {
          role: "user",
          content: JSON.stringify({
            qrTlv: job.draft.qrTlv ?? null,
            draft: result.draft
          })
        }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`DeepSeek normalization failed with ${response.status}${body ? `: ${body}` : ""}`);
  }

  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("DeepSeek returned no JSON content.");
  }

  const candidate = JSON.parse(content);
  return {
    draft: mergeExtractedDraft(job, candidate),
    extraction: {
      provider: "deepseek",
      model,
      confidence: result.extraction.confidence,
      warnings: result.extraction.warnings ?? []
    }
  };
}

function promptFor(job: IntakeJob): string {
  return [
    "Extract a purchase invoice for invoice intake.",
    "Include all visible line items.",
    "Use SAR as currency when the invoice is Saudi and no explicit currency is visible.",
    "Tax rates are percentages, not fractions.",
    "Do not create or guess destination item/expense mappings.",
    `Known ZATCA QR TLV data: ${JSON.stringify(job.draft.qrTlv ?? null)}`
  ].join("\n");
}

function parseJsonFromResponse(body: unknown): unknown {
  const text = collectText(body).trim();
  if (!text) {
    throw new Error("Model response did not include extractable text.");
  }

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Model response did not include valid JSON.");
    }
    return JSON.parse(match[0]);
  }
}

function collectText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(collectText).join("\n");

  const object = value as Record<string, unknown>;
  if (typeof object.output_text === "string") return object.output_text;
  if (typeof object.text === "string") return object.text;
  return Object.values(object).map(collectText).join("\n");
}

function mergeExtractedDraft(job: IntakeJob, candidate: unknown): InvoiceDraft {
  const payload = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
  const rawLineItems = Array.isArray(payload.lineItems) ? payload.lineItems : [];
  const lineItems = rawLineItems.map((line, index) => {
    const item = line && typeof line === "object" ? line as Record<string, unknown> : {};
    return {
      ...item,
      id: typeof item.id === "string" && item.id.trim() ? item.id : `line-${index + 1}`,
      selectedQoyodMapping: undefined
    };
  });

  return invoiceDraftSchema.parse({
    ...job.draft,
    ...payload,
    attachmentRefs: job.draft.attachmentRefs,
    qrTlv: job.draft.qrTlv,
    lineItems
  });
}

function inferConfidence(candidate: unknown): number {
  const payload = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
  const filled = [
    payload.supplierName,
    payload.invoiceNumber,
    payload.issueDate,
    payload.grandTotal,
    Array.isArray(payload.lineItems) && payload.lineItems.length > 0 ? "line-items" : ""
  ].filter(Boolean).length;
  return Math.round((filled / 5) * 100) / 100;
}
