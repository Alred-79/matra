/**
 * What a recipient can read when she shares, in the words her consent uses. One table, used by the share screen, the
 * counselor release screen, the consent statements they store, and the server's checks, so the words and the bytes
 * can't drift apart (apps/web/src/lib/shareContents.test.tsx decrypts what a recipient gets for every choice and checks
 * it against these words).
 *
 * A share wraps the key of her whole sealed version, so a recipient can read all of her written account: every field
 * she filled in. Only the evidence files themselves are chosen one by one. Narrowing the account itself would mean a
 * re-encrypted copy that no longer matches what the ledger attests (MATRA_PLAN PR 9; per-field redaction is later work).
 *
 * The consent statement is stored as plain text on the server and hashed into the ledger, so it never carries anything
 * from her account: it names these parts in the same fixed words whatever she filled in.
 */
import type { IntakeRecord } from './index.js';

export type AccountPartId = 'identity' | 'contact' | 'incident' | 'people' | 'care' | 'safety' | 'costs' | 'goals' | 'evidenceList' | 'sealed';

export interface AccountPart {
  id: AccountPartId;
  /** On her screen, second person. */
  screen: string;
  /** In her consent statement, first person. */
  consent: string;
}

export const ACCOUNT_PARTS: readonly AccountPart[] = [
  {
    id: 'identity',
    screen: 'your name and legal name, date of birth, pronouns and language',
    consent: 'my name and legal name, date of birth, pronouns and language',
  },
  {
    id: 'contact',
    screen: 'your phone number and email, how it’s safe to reach you, the state and county you live in, and any interpreter or access needs',
    consent: 'my phone number and email, how it’s safe to reach me, the state and county I live in, and any interpreter or access needs',
  },
  { id: 'incident', screen: 'what happened, in your own words, and when and where it happened', consent: 'what happened, in my own words, and when and where it happened' },
  { id: 'people', screen: 'who did this, anyone who saw or heard something, and who you’ve told', consent: 'who did this, anyone who saw or heard something, and who I’ve told' },
  { id: 'care', screen: 'medical care, reports you’ve made, and physical evidence you kept', consent: 'medical care, reports I’ve made, and physical evidence I kept' },
  { id: 'safety', screen: 'your answers about your safety', consent: 'my answers about my safety' },
  {
    id: 'costs',
    screen: 'costs and losses, and any compensation details you gave (such as a mailing address, employer or another contact person)',
    consent: 'costs and losses, and any compensation details I gave (such as a mailing address, employer or another contact person)',
  },
  { id: 'goals', screen: 'what you’d like to do next', consent: 'what I’d like to do next' },
  {
    id: 'evidenceList',
    screen: 'the list of all your evidence files, with their names, descriptions, dates and fingerprints, including files you don’t share',
    consent: 'the list of all my evidence files, with their names, descriptions, dates and fingerprints, including files I don’t share',
  },
  { id: 'sealed', screen: 'when you sealed it', consent: 'when I sealed it' },
];

/**
 * Which part covers each field of her account. Typed over every key, so a new field in IntakeRecord doesn't compile
 * until someone decides which consent words cover it.
 */
export const RECORD_FIELD_PART: { [K in Exclude<keyof IntakeRecord, 'survivor'>]-?: AccountPartId } & {
  survivor: { [K in keyof IntakeRecord['survivor']]-?: AccountPartId };
} = {
  schemaVersion: 'sealed',
  completedAt: 'sealed',
  survivor: {
    preferredName: 'identity',
    legalName: 'identity',
    dateOfBirth: 'identity',
    pronouns: 'identity',
    preferredLanguage: 'identity',
    phone: 'contact',
    email: 'contact',
    safeContact: 'contact',
    safeContactNotes: 'contact',
    residenceState: 'contact',
    residenceCounty: 'contact',
    accessibility: 'contact',
  },
  incident: 'incident',
  narrative: 'incident',
  perpetrators: 'people',
  witnesses: 'people',
  disclosures: 'people',
  medical: 'care',
  priorReports: 'care',
  physicalEvidence: 'care',
  evidence: 'evidenceList',
  safety: 'safety',
  financialImpact: 'costs',
  compensation: 'costs',
  goals: 'goals',
};

/** The part that covers a field path like ['survivor', 'phone'] or ['narrative', 'freeRecall']; undefined if none. */
export function partForPath(path: readonly string[]): AccountPartId | undefined {
  const [top, sub] = path;
  if (top === undefined || !Object.hasOwn(RECORD_FIELD_PART, top)) return undefined;
  const v = (RECORD_FIELD_PART as Record<string, AccountPartId | Record<string, AccountPartId>>)[top]!;
  if (typeof v === 'string') return v;
  return sub !== undefined && Object.hasOwn(v, sub) ? v[sub] : undefined;
}

/** Her consent's sentence about the written account: always shared, and what it holds (fixed words). */
export function writtenAccountSentence(): string {
  return `My written account is always shared. It holds everything I wrote or chose in Matra, including any of these I gave: ${ACCOUNT_PARTS.map((p) => p.consent).join('; ')}.`;
}

/** Her consent's sentence about the evidence files themselves (the server checks it against the files wrapped). */
export function sharedFilesSentence(n: number): string {
  return n === 0
    ? 'I am not sharing any of the evidence files themselves.'
    : `I am also sharing ${n} of the evidence files themselves, the ${n === 1 ? 'one' : 'ones'} I chose.`;
}

const FILES_RE = /I am not sharing any of the evidence files themselves\.|I am also sharing (\d+) of the evidence files themselves, the (?:one|ones) I chose\./g;

/** How many files a consent statement says are shared; null if it doesn't say, or says it more than once. */
export function statedFileCount(statement: string): number | null {
  const hits = [...statement.matchAll(FILES_RE)];
  if (hits.length !== 1) return null;
  const n = hits[0]![1] === undefined ? 0 : Number(hits[0]![1]);
  return sharedFilesSentence(n) === hits[0]![0] ? n : null;
}

/**
 * The label a recipient sees for a share ("Client K7QZ4"): made up on her device for that share only, so it is never
 * her username (half of her sign-in, and of her recovery) and two shares can't be linked by it. No vowels, so it never
 * spells a word; no 0/1, so it can be read aloud.
 */
export const SHARE_ALIAS_RE = /^Client [BCDFGHJKLMNPQRSTVWXZ2-9]{5}$/;
const ALIAS_CHARS = 'BCDFGHJKLMNPQRSTVWXZ23456789';

export function newShareAlias(): string {
  let out = '';
  const buf = new Uint8Array(16);
  while (out.length < 5) {
    globalThis.crypto.getRandomValues(buf);
    for (const b of buf) {
      // 252 = 9 × 28: drop the top few values so every character is equally likely
      if (b < 252 && out.length < 5) out += ALIAS_CHARS[b % ALIAS_CHARS.length];
    }
  }
  return `Client ${out}`;
}

/** Her consent's sentence naming the share's label (the server checks it is the label stored). */
export function shareAliasSentence(alias: string): string {
  return `Matra shows this share to them as "${alias}", a name made up for this share only, not my username.`;
}

/**
 * Does this consent statement say what the server is about to store? The written account sentence, the right number
 * of files, and (for an attorney share) the label. The server refuses a share or release where it doesn't.
 */
export function consentMatches(statement: string, sent: { files: number; alias?: string }): boolean {
  return (
    statement.includes(writtenAccountSentence()) &&
    statedFileCount(statement) === sent.files &&
    (sent.alias === undefined || statement.includes(shareAliasSentence(sent.alias)))
  );
}
