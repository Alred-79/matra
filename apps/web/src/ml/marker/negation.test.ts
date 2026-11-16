import { describe, expect, it } from 'vitest';
import { dropReasonFor, inQuotes } from './negation';

/** [text, the span, question, expected reason or null] */
const T: Array<[string, string, string, string | null]> = [
  // her own statements are kept
  ['I told my sister Dana yesterday.', 'my sister Dana', 'people.told', null],
  ['It was on March 14 at his place.', 'March 14', 'when.date', null],
  ['I called the police on Tuesday.', 'the police', 'prior.any', null],
  ['I told my mom, but she was busy.', 'my mom', 'people.told', null],
  ['I did not tell my mom, but I told my sister Dana.', 'my sister Dana', 'people.told', null],
  ['I still have the texts.', 'still have the texts', 'evidence.upload', null],
  // negation
  ['I never told my sister.', 'my sister', 'people.told', 'negated'],
  ['I didnt tell anyone.', 'anyone', 'people.told', 'negated'],
  ['No one saw us leave.', 'No one saw', 'people.witnesses', 'negated'],
  ['I did not go to the party on Friday.', 'Friday', 'when.date', 'negated'],
  ['I have no screenshots.', 'screenshots', 'evidence.upload', 'negated'],
  ['I told my mom, not the police.', 'the police', 'prior.any', 'negated'],
  // hypothetical
  ['I wish I had told my sister sooner.', 'my sister', 'people.told', 'hypothetical'],
  ['If I call the police, he will find out.', 'the police', 'prior.any', 'hypothetical'],
  ['I want to tell my mom next week.', 'my mom', 'people.told', 'hypothetical'],
  ['Should I take screenshots of the messages?', 'screenshots', 'evidence.upload', 'hypothetical'],
  ['I might go to the police on Monday.', 'Monday', 'when.date', 'hypothetical'],
  // reported speech and quotes
  ['He said he was at the diner on Friday.', 'Friday', 'when.date', 'reported-speech'],
  ['My friend told me that she called the police.', 'the police', 'prior.any', 'reported-speech'],
  ['"I was at the diner all night," he told them.', 'the diner', 'where.place', 'quoted'],
  ['He wrote "see you at the lake house on Friday" in a text.', 'the lake house', 'where.place', 'quoted'],
  // someone else's act
  ['My sister told her friend about it.', 'her friend', 'people.told', 'other-actor'],
  ['Dana texted her mom as soon as we got home.', 'her mom', 'people.told', 'other-actor'],
  ['My roommate kept the screenshots on her phone.', 'kept the screenshots', 'evidence.upload', 'other-actor'],
  ['He filed a complaint last year.', 'filed a complaint', 'prior.any', 'other-actor'],
  // the clause is about a sensitive group
  ['I have photos of the bruises.', 'have photos', 'evidence.upload', 'sensitive-context'],
  ['My drink tasted strange at the party.', 'the party', 'where.place', 'sensitive-context'],
  ['He grabbed my wrist in the parking lot.', 'the parking lot', 'where.place', 'sensitive-context'],
  ['On March 14, he grabbed my wrist.', 'March 14', 'when.date', null],
];

describe('clause guards', () => {
  for (const [text, s, q, want] of T)
    it(`${want ?? 'keeps'}: ${text}`, () => {
      const start = text.indexOf(s);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(dropReasonFor(text, start, start + s.length, q)).toBe(want);
    });

  it('detects quotes but not apostrophes', () => {
    const t = `she said "at the lake" and it's Dana's place`;
    expect(inQuotes(t, t.indexOf('at the lake'), t.indexOf('at the lake') + 11)).toBe(true);
    expect(inQuotes(t, t.indexOf('Dana'), t.indexOf('Dana') + 4)).toBe(false);
  });

  it('is safe on odd input', () => {
    expect(dropReasonFor('', 0, 0)).toBeNull();
    expect(dropReasonFor('a', 0, 1)).toBeNull();
    expect(() => dropReasonFor('x'.repeat(5000), 10, 20, 'people.told')).not.toThrow();
  });
});
