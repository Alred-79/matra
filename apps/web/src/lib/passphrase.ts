/**
 * Passphrases: generated suggestions and a strength meter.
 *
 * Generated: distinct random words from WORDLIST (./wordlist.ts, EFF Short Wordlist #1 after a first-pass screen,
 * 1,109 words ≈ 10.1 bits each). Survivors get 6 words (≈ 60.7 bits); attorneys and counselors get 7 (≈ 70.8 bits) and
 * cannot type their own, because their accounts open what survivors share with them. On top of this the passphrase
 * goes through 600,000 PBKDF2 rounds (W5), so 6 words is millions of GPU-years of guessing on average (plan PR 7).
 *
 * Chosen (survivors only): she may type her own, and it must reach an estimated MIN_CHOSEN_BITS. The estimate is
 * deliberately rough and on the low side: only distinct words count, repeats and keyboard runs count for almost
 * nothing, a short list of well-known phrases and passwords counts as one guess, and an ordinary word counts for at
 * most about as much as a random word from the list. No length shortcut: a long string of one letter is still weak.
 */
import type { Role } from '@matra/shared';
import { WORDLIST } from './wordlist';

export { WORDLIST };

/** Words in a survivor's generated passphrase. */
export const SURVIVOR_WORDS = 6;
/** Words in an attorney's or counselor's passphrase (always generated). */
export const PROFESSIONAL_WORDS = 7;
/** What a passphrase she chooses herself must reach (estimated). */
export const MIN_CHOSEN_BITS = 60;
/** Below this the meter says "too easy to guess"; between this and MIN_CHOSEN_BITS it says "almost". */
const OKAY_BITS = 45;
/** Each distinct generated word. */
export const BITS_PER_WORD = Math.log2(WORDLIST.length);

/** Separator between generated words. No word in WORDLIST contains it. */
export const SEPARATOR = '-';

/** How many generated words an account of this role gets. */
export function passphraseWords(role: Role): number {
  return role === 'survivor' ? SURVIVOR_WORDS : PROFESSIONAL_WORDS;
}

/** Only survivors may type a passphrase of their own. */
export function canChoosePassphrase(role: Role): boolean {
  return role === 'survivor';
}

function randomIndex(n: number): number {
  // rejection sampling to avoid modulo bias
  const max = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < max) return buf[0] % n;
  }
}

/** `words` distinct random words from `list`, joined with SEPARATOR, made on this device. */
export function generatePassphrase(words = SURVIVOR_WORDS, list: readonly string[] = WORDLIST): string {
  if (words > list.length) throw new Error('Not enough words in the list');
  const out = new Set<string>();
  while (out.size < words) out.add(list[randomIndex(list.length)]);
  return [...out].join(SEPARATOR);
}

const LIST = new Set(WORDLIST);

/** True when `p` is exactly what generatePassphrase(words) could have made: `words` distinct list words, joined. */
export function isGeneratedPassphrase(p: string, words: number): boolean {
  const parts = p.split(SEPARATOR);
  return parts.length === words && new Set(parts).size === words && parts.every((w) => LIST.has(w));
}

// ───────────── strength estimate ─────────────

/**
 * Well-known passwords and phrases, each worth one guess wherever it appears (lowercase; words separated by spaces).
 * Short on purpose: a guessing attacker's real list is far longer, which is why ordinary words are counted low too.
 */
const COMMON = [
  'password', 'passphrase', 'passw0rd', 'letmein', 'let me in', 'iloveyou', 'i love you', 'qwerty', 'admin', 'welcome',
  'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'batman', 'trustno1', 'starwars',
  'whatever', 'secret', 'changeme', 'abc123', 'matra', 'hello world', 'correct horse battery staple',
  'the quick brown fox jumps over the lazy dog', 'to be or not to be that is the question', 'may the force be with you',
  'once upon a time', 'happy birthday to you', 'twinkle twinkle little star', 'mary had a little lamb', 'open sesame',
  'all you need is love', 'let it be', 'hakuna matata', 'live laugh love', 'carpe diem', 'in god we trust',
  'the lord is my shepherd', 'jesus loves me', 'row row row your boat', 'humpty dumpty sat on a wall',
  'jack and jill went up the hill', 'roses are red violets are blue', 'keep calm and carry on',
];
const COMMON_PHRASES = COMMON.map((c) => c.split(' ')).filter((p) => p.length > 1).sort((a, b) => b.length - a.length);
/** Each entry also as one run-together token ("letmein"). */
const COMMON_TOKENS = new Set(COMMON.map((c) => c.replace(/ /g, '')));
const KNOWN = '\u0000known';

const RUNS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'abcdefghijklmnopqrstuvwxyz', '01234567890'];
const RUNS_BOTH_WAYS = RUNS.flatMap((r) => [r, [...r].reverse().join('')]);

/** "aaaa", "abcd", "4321", "qwer": a few guesses at most. */
function isRun(piece: string): boolean {
  if (piece.length < 3) return false;
  return /^(.)\1+$/u.test(piece) || RUNS_BOTH_WAYS.some((r) => r.includes(piece));
}

/** "abcabc", "haha": the repeated part is all that counts. */
function repeatedUnit(piece: string): string | null {
  for (let n = 1; n <= piece.length / 2; n++) {
    if (piece.length % n) continue;
    const unit = piece.slice(0, n);
    if (unit.repeat(piece.length / n) === piece) return unit;
  }
  return null;
}

function pieceBits(piece: string): number {
  if (piece === KNOWN || COMMON_TOKENS.has(piece)) return 2;
  // a list word first: generated words are uniform over the list, even "tutu" or "yoyo"
  if (LIST.has(piece)) return BITS_PER_WORD;
  if (isRun(piece)) return 3;
  const unit = repeatedUnit(piece);
  if (unit) return pieceBits(unit) + 1;
  if (/^\p{N}+$/u.test(piece)) {
    if (/^(19|20)\d\d$/.test(piece)) return 6; // a year
    return Math.min(piece.length * Math.log2(10), 30);
  }
  // an ordinary word counts for at most about one random list word; a long run of letters is probably several words
  // run together, at about 1.4 bits a letter (English text)
  return piece.length <= 8 ? Math.min(piece.length * 2.5, 11) : piece.length * 1.4;
}

/** Lowercase words and numbers in `s`, with each well-known phrase folded into one KNOWN token. */
function tokens(s: string): string[] {
  let toks = s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((t) => (COMMON_TOKENS.has(t) ? KNOWN : t));
  for (const phrase of COMMON_PHRASES) {
    const out: string[] = [];
    for (let i = 0; i < toks.length; ) {
      if (phrase.every((w, j) => toks[i + j] === w)) {
        out.push(KNOWN);
        i += phrase.length;
      } else out.push(toks[i++]);
    }
    toks = out;
  }
  // "word2024" → "word", "2024"
  return toks.flatMap((t) => (t === KNOWN ? [t] : (t.match(/\p{L}+|\p{N}+/gu) ?? [])));
}

/**
 * Estimated bits of a passphrase she typed. Each distinct word or number counts once. `context` holds words an
 * attacker would try first (her alias), which count for nothing.
 */
export function estimateBits(p: string, context: readonly string[] = []): number {
  const s = p.normalize('NFKC').trim();
  const known = new Set(context.flatMap((c) => tokens(c)).filter((t) => t !== KNOWN));
  const distinct = new Set(tokens(s).filter((t) => !known.has(t)));
  let bits = 0;
  for (const piece of distinct) bits += pieceBits(piece);
  // symbols other than spaces and the usual separators, and capital letters, add a little
  const symbols = new Set(s.match(/[^\p{L}\p{N}\s\-_.,]/gu) ?? []);
  bits += Math.min(symbols.size, 2) * 3;
  if (/\p{Lu}/u.test(s)) bits += /\p{L}\p{Lu}/u.test(s) ? 2 : 1;
  return bits;
}

export type Strength = 'too-short' | 'weak' | 'okay' | 'strong';

/**
 * The meter, for a passphrase she chose. Only 'strong' (an estimated MIN_CHOSEN_BITS or more) is accepted; 'okay'
 * means "almost". `context`: her alias, if she has typed it.
 */
export function passphraseStrength(p: string, context: readonly string[] = []): { level: Strength; message: string; bits: number } {
  const s = p.normalize('NFKC').trim();
  const bits = estimateBits(s, context);
  if (s.length < 12) return { level: 'too-short', bits, message: 'Use at least 12 characters. Six random words work well.' };
  if (bits >= MIN_CHOSEN_BITS) return { level: 'strong', bits, message: 'Strong. Write it down somewhere only you can reach.' };
  if (bits >= OKAY_BITS) return { level: 'okay', bits, message: 'Almost. Add another word that isn’t already in it.' };
  return { level: 'weak', bits, message: 'Too easy to guess. Try six random words, like the one we made for you.' };
}

/** Whether a passphrase she chose may be used. */
export function passphraseAccepted(p: string, context: readonly string[] = []): boolean {
  return passphraseStrength(p, context).level === 'strong';
}
