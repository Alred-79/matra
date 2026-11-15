import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@matra/crypto';
import {
  BITS_PER_WORD,
  MIN_CHOSEN_BITS,
  PROFESSIONAL_WORDS,
  SURVIVOR_WORDS,
  WORDLIST,
  estimateBits,
  generatePassphrase,
  isGeneratedPassphrase,
  passphraseAccepted,
  passphraseStrength,
  passphraseWords,
} from './passphrase';
import { WORDLIST_SHA256 } from './wordlist';

describe('word list', () => {
  it('is the screened EFF short list: at least 1,024 distinct words of 3 to 5 lowercase letters', () => {
    expect(WORDLIST.length).toBe(1109);
    expect(WORDLIST.length).toBeGreaterThanOrEqual(1024);
    expect(new Set(WORDLIST).size).toBe(WORDLIST.length);
    for (const w of WORDLIST) expect(w).toMatch(/^[a-z]{3,5}$/);
  });

  it('is pinned: changing it means updating WORDLIST_SHA256, and an advocate reviewing the change', async () => {
    expect(await sha256Hex(WORDLIST.join(' '))).toBe(WORDLIST_SHA256);
  });

  it('leaves out words the first-pass screen removed', () => {
    for (const w of ['grope', 'gag', 'blade', 'drown', 'woozy', 'dizzy', 'drank', 'acid', 'swab', 'jury', 'cage', 'bride', 'yo-yo'])
      expect(WORDLIST).not.toContain(w);
  });

  it('6 words reach 60 bits, 7 reach 70', () => {
    expect(SURVIVOR_WORDS * BITS_PER_WORD).toBeGreaterThanOrEqual(60);
    expect(PROFESSIONAL_WORDS * BITS_PER_WORD).toBeGreaterThanOrEqual(70);
  });
});

describe('generatePassphrase', () => {
  it('makes 6 distinct list words for survivors and 7 for attorneys and counselors', () => {
    expect(passphraseWords('survivor')).toBe(6);
    expect(passphraseWords('attorney')).toBe(7);
    expect(passphraseWords('counselor')).toBe(7);
    for (let i = 0; i < 200; i++) {
      const p = generatePassphrase();
      const words = p.split('-');
      expect(words).toHaveLength(6);
      expect(new Set(words).size).toBe(6);
      words.forEach((w) => expect(WORDLIST).toContain(w));
      expect(isGeneratedPassphrase(p, 6)).toBe(true);
      expect(passphraseStrength(p).level).toBe('strong');
      expect(isGeneratedPassphrase(generatePassphrase(7), 7)).toBe(true);
    }
  });

  it('isGeneratedPassphrase refuses anything else', () => {
    const p = generatePassphrase(7);
    expect(isGeneratedPassphrase(p, 6)).toBe(false);
    expect(isGeneratedPassphrase(p.replace(/-/g, ' '), 7)).toBe(false);
    expect(isGeneratedPassphrase(p.toUpperCase(), 7)).toBe(false);
    const [a, , ...rest] = p.split('-');
    expect(isGeneratedPassphrase([a, a, ...rest].join('-'), 7)).toBe(false); // a repeated word
    expect(isGeneratedPassphrase('my-own-very-long-and-strong-passphrase', 7)).toBe(false);
  });
});

describe('passphraseStrength', () => {
  it('rates the review’s inputs weak: one word repeated, and 28 of one letter (no length shortcut)', () => {
    expect(passphraseStrength('password password password password').level).toBe('weak');
    expect(passphraseStrength('a'.repeat(28)).level).toBe('weak');
    expect(passphraseStrength('a'.repeat(80)).level).toBe('weak');
    expect(passphraseStrength('abcdefghijklmnopqrstuvwxyz').level).toBe('weak');
    expect(passphraseStrength('qwertyuiop1234567890').level).toBe('weak');
  });

  it('counts distinct words only', () => {
    const [a, b, c] = generatePassphrase().split('-');
    const repeated = [a, b, c, a, b, c].join(' ');
    expect(estimateBits(repeated)).toBeCloseTo(3 * BITS_PER_WORD, 5);
    expect(passphraseStrength(repeated).level).toBe('weak');
    expect(estimateBits(`${a} ${a.toUpperCase()} ${a}`)).toBeLessThan(BITS_PER_WORD + 3);
  });

  it('counts a well-known phrase or password as one guess, wherever it appears', () => {
    expect(passphraseStrength('correct horse battery staple').level).toBe('weak');
    expect(passphraseStrength('Correct-Horse-Battery-Staple').level).toBe('weak');
    expect(passphraseStrength('the quick brown fox jumps over the lazy dog').level).toBe('weak');
    expect(passphraseStrength('iloveyou iloveyou 2024').level).toBe('weak');
    expect(estimateBits('correct horse battery staple')).toBeLessThan(5);
    expect(estimateBits('password1')).toBeLessThan(10);
  });

  it('wants about 60 bits for a phrase she chooses: 5 random words are "almost", 6 are enough', () => {
    const six = generatePassphrase().split('-');
    expect(passphraseStrength(six.slice(0, 5).join(' ')).level).toBe('okay');
    expect(passphraseAccepted(six.slice(0, 5).join(' '))).toBe(false);
    expect(passphraseStrength(six.join(' ')).level).toBe('strong');
    expect(passphraseAccepted(six.join(' '))).toBe(true);
    expect(passphraseStrength('pebble lantern fjord mango heron willow').bits).toBeGreaterThanOrEqual(MIN_CHOSEN_BITS);
    expect(passphraseStrength('MyDogIsNamedRex2019!').level).toBe('weak');
  });

  it('her alias counts for nothing', () => {
    const p = 'bluebird quiet harbor maple lantern seven';
    expect(passphraseAccepted(p)).toBe(true);
    expect(passphraseAccepted(p, ['bluebird-42'])).toBe(false);
  });

  it('too short is too short', () => {
    expect(passphraseStrength('hunter2').level).toBe('too-short');
    expect(passphraseStrength('').level).toBe('too-short');
  });
});
