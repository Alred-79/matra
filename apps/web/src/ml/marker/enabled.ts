/**
 * The questions whose marks are switched on: those that cleared the per-question precision bar (>= 0.80) on the DEV split of
 * the eval (tools/eval/span-marker; plan 8.7). Chosen on dev only, then frozen and checked once on the held-out test split.
 * where.area is not listed: it produced fewer than 5 marks on dev, too few to show its precision. A question not listed here
 * never produces a mark. Regenerate with `npm run eval:marker -- --write` after any change to the
 * engine, the guards, the bank or the data; apps/web/src/ml/marker/enabled.test.ts fails if this list and the committed
 * result differ.
 */
export const ENABLED_QUESTIONS: readonly string[] = [
  'when.date',
  'when.time',
  'where.place',
  'where.address',
  'people.told',
  'people.witnesses',
  'prior.any',
  'evidence.upload',
];
