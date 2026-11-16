/**
 * The single choke point between any engine and anything she can see or any log. Whatever proposes marks (the rule
 * engine today, a model later), its output goes through validateMarks, and anything that fails a check is dropped and
 * counted. Nothing is repaired, shifted or "fixed up": a mark is either exactly right or it is gone.
 *
 * Checks, in order:
 *   1. the question is in the bank, and its group is neutral (never sensitive: PLAN_REVIEW finding 7; never excluded);
 *      the sensitive prefixes in bank.ts are re-applied here even if the bank passed in says otherwise
 *      and, when a list of enabled questions is given, that the question cleared the eval gate (plan 8.7: a question whose
 *      precision is under the bar has its marks switched off)
 *   2. offsets are integers with 0 <= start < end <= text.length
 *   3. exactSpan === text.slice(start, end), character for character (so it is her exact words)
 *   4. the span is not blank, and not a whole paragraph (it must point at a phrase)
 *   5. the clause guards (negation.ts): negated, hypothetical, quoted, reported speech, someone else's action
 *   6. no overlapping duplicate for the same question; at most MAX_MARKS_PER_QUESTION per question
 */
import { groupOf } from './bank';
import { dropReasonFor } from './negation';
import type { DropCounts, DropReason, Mark, MarkBank, MarkCandidate } from './types';

export const MAX_MARKS_PER_QUESTION = 2;
/** A mark points at a phrase, not a passage. */
export const MAX_SPAN_CHARS = 160;

export interface ValidationResult {
  marks: Mark[];
  dropped: number;
  droppedByReason: DropCounts;
}

export function validateMarks(text: string, bank: MarkBank, candidates: readonly MarkCandidate[], enabled?: ReadonlySet<string> | null): ValidationResult {
  const byQuestion = new Map(bank.questions.map((q) => [q.id, q]));
  const droppedByReason: DropCounts = {};
  const drop = (r: DropReason) => {
    droppedByReason[r] = (droppedByReason[r] ?? 0) + 1;
  };
  const kept: Mark[] = [];
  // reading order, so "at most two per question" keeps the earliest and results do not depend on engine order
  const ordered = [...candidates].sort((a, b) => a.start - b.start || a.end - b.end || (a.questionId < b.questionId ? -1 : 1));
  for (const c of ordered) {
    const q = typeof c.questionId === 'string' ? byQuestion.get(c.questionId) : undefined;
    if (!q) {
      drop('unknown-question');
      continue;
    }
    // the bank's own tag AND the built-in rules: the stricter wins
    const builtIn = groupOf(q.id);
    if (q.group === 'sensitive' || builtIn === 'sensitive') {
      drop('sensitive-group');
      continue;
    }
    if (q.group !== 'neutral' || builtIn !== 'neutral') {
      drop('excluded-group');
      continue;
    }
    if (enabled && !enabled.has(c.questionId)) {
      drop('disabled-question');
      continue;
    }
    if (!Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start < 0 || c.end <= c.start || c.end > text.length) {
      drop('bad-offsets');
      continue;
    }
    if (typeof c.exactSpan !== 'string' || text.slice(c.start, c.end) !== c.exactSpan) {
      drop('not-exact-substring');
      continue;
    }
    if (!/\S/.test(c.exactSpan)) {
      drop('empty-or-whitespace');
      continue;
    }
    if (c.exactSpan.length > MAX_SPAN_CHARS) {
      drop('too-long');
      continue;
    }
    const reason = dropReasonFor(text, c.start, c.end, c.questionId);
    if (reason) {
      drop(reason);
      continue;
    }
    if (kept.some((m) => m.questionId === c.questionId && m.start < c.end && c.start < m.end)) {
      drop('duplicate');
      continue;
    }
    if (kept.filter((m) => m.questionId === c.questionId).length >= MAX_MARKS_PER_QUESTION) {
      drop('over-limit');
      continue;
    }
    kept.push({ questionId: c.questionId, start: c.start, end: c.end, exactSpan: c.exactSpan });
  }
  const dropped = Object.values(droppedByReason).reduce((n, v) => n + (v ?? 0), 0);
  return { marks: kept, dropped, droppedByReason };
}
