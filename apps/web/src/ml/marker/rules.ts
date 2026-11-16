/**
 * The v1 engine: the existing rule-based extraction in src/understand (PLAN_REVIEW finding 10), reduced to what a mark
 * needs. Each suggestion's value, label and confidence are thrown away; what is kept is the step it points at and the
 * spans of her own words it came from. No model, no download, nothing new on her device.
 */
import { questionForTarget } from './bank';
import { understand } from '../../understand';
import type { MarkBank, MarkCandidate } from './types';

export const RULES_ENGINE_ID = 'understand-rules';
/** Bump when src/understand changes in a way that moves marks (the eval is re-run on every change). */
export const RULES_ENGINE_VERSION = 'rules-1';

export interface RulesOptions {
  /** Reference date for relative expressions ("last friday"). Marks never carry the resolved value. */
  now?: Date;
}

export function rulesCandidates(text: string, bank: MarkBank, opts: RulesOptions = {}): MarkCandidate[] {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const now = opts.now ?? new Date();
  const suggestions = understand([{ id: 'marker', createdAt: now.toISOString(), text, source: 'typed' }], { now });
  const out: MarkCandidate[] = [];
  for (const s of suggestions) {
    const q = questionForTarget(bank, s.target);
    // an engine target with no question in this bank (or a sensitive one) is still passed on, so the validator counts the drop
    const questionId = q?.id ?? s.target;
    for (const src of s.sources) out.push({ questionId, start: src.start, end: src.end, exactSpan: text.slice(src.start, src.end) });
  }
  return out;
}
