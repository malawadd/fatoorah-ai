import type { InvoiceDraft, InvoiceLineItem, QoyodMapping, QoyodMappingRule } from "../shared/invoice";
import { normalizedText } from "../shared/invoice";

type RuleCandidate = {
  rule: QoyodMappingRule;
  score: number;
};

function textMatches(rule: QoyodMappingRule, line: InvoiceLineItem): boolean {
  const needle = normalizedText(rule.matchText);
  const haystack = normalizedText(line.description);
  if (!needle || !haystack) return false;
  return rule.matchMode === "exact" ? haystack === needle : haystack.includes(needle);
}

function supplierMatches(rule: QoyodMappingRule, draft: InvoiceDraft): boolean {
  const ruleTaxId = normalizedText(rule.supplierTaxId);
  const ruleSupplier = normalizedText(rule.supplierName);
  if (ruleTaxId && ruleTaxId !== normalizedText(draft.supplierTaxId)) return false;
  if (ruleSupplier && !normalizedText(draft.supplierName).includes(ruleSupplier)) return false;
  return true;
}

function ruleScore(rule: QoyodMappingRule, draft: InvoiceDraft, line: InvoiceLineItem): number {
  let score = 0;
  if (normalizedText(rule.supplierTaxId)) score += 300;
  if (normalizedText(rule.supplierName)) score += 200;
  if (rule.matchMode === "exact") score += 80;
  score += Math.min(80, normalizedText(rule.matchText).length);
  if (rule.taxRate !== undefined && Math.abs(Number(rule.taxRate) - Number(line.taxRate)) <= 0.01) score += 30;
  if (normalizedText(rule.supplierTaxId) === normalizedText(draft.supplierTaxId)) score += 20;
  return score;
}

export function mappingFromRule(rule: QoyodMappingRule): QoyodMapping {
  return {
    type: rule.type,
    id: rule.qoyodId,
    label: rule.label
  };
}

export function findMappingForLine(
  draft: InvoiceDraft,
  line: InvoiceLineItem,
  rules: QoyodMappingRule[]
): QoyodMapping | undefined {
  const candidates: RuleCandidate[] = rules
    .filter((rule) => rule.active)
    .filter((rule) => supplierMatches(rule, draft))
    .filter((rule) => rule.taxRate === undefined || Math.abs(Number(rule.taxRate) - Number(line.taxRate)) <= 0.01)
    .filter((rule) => textMatches(rule, line))
    .map((rule) => ({ rule, score: ruleScore(rule, draft, line) }))
    .sort((left, right) => right.score - left.score || right.rule.updatedAt.localeCompare(left.rule.updatedAt));

  return candidates[0] ? mappingFromRule(candidates[0].rule) : undefined;
}

export function applyMappingRulesToDraft(draft: InvoiceDraft, rules: QoyodMappingRule[]): { draft: InvoiceDraft; appliedCount: number } {
  let appliedCount = 0;
  const lineItems = draft.lineItems.map((line) => {
    if (line.selectedQoyodMapping?.id) return line;
    const selectedQoyodMapping = findMappingForLine(draft, line, rules);
    if (!selectedQoyodMapping) return line;
    appliedCount += 1;
    return { ...line, selectedQoyodMapping };
  });

  return {
    draft: { ...draft, lineItems },
    appliedCount
  };
}
