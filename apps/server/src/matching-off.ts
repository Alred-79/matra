/**
 * Sealed matching, off (MATRA_MATCHING=off, the pilot default; @matra/shared matching-mode.ts).
 *
 * Off means the app server holds nothing that belongs to matching and answers nothing about it:
 *   - index.ts skips the OPRF, phone and matcher loaders, and createApp({ matching: false }) deals no ephemeral key,
 *     writes no matching_meta row and runs no matcher sync loop;
 *   - every matching route (MATCHING_ROUTE_PREFIXES) answers 404 `matching_disabled`, signed in or not;
 *   - counselor accounts can't be registered;
 *   - a server told "off" but also given a matching secret refuses to start (MATCHING_ONLY_VARS): someone expected
 *     matching to run, and a key share sitting unused next to the app is still a key share;
 *   - leftover matching rows in the database (from an earlier "on") are a warning in development and a refusal in
 *     production, so an operator can't switch matching off without deciding what happens to people's sealed entries.
 */
import type { NextFunction, Request, Response } from 'express';
import { parseMatchingMode, type MatchingMode } from '@matra/shared';
import type { DB } from './db.js';

/** Every API route that exists only for sealed matching, staged release to counselors, or the counselor portal. */
export const MATCHING_ROUTE_PREFIXES = ['/api/matching', '/api/escrow', '/api/counselor', '/api/report-requests', '/api/report-releases'];

/**
 * Environment variables only sealed matching reads. Any of them set (non-empty) with MATRA_MATCHING=off is refused:
 * the OPRF key shares and holder settings, the holder-token key, the matcher and its keys, and the phone-token key.
 */
export const MATCHING_ONLY_VARS: RegExp[] = [
  /^MATRA_OPRF_SHARE/, // MATRA_OPRF_SHARE_<i>, _<i>_FILE, MATRA_OPRF_SHARE_PUBKEYS
  /^MATRA_OPRF_HOLDER_URLS$/,
  /^MATRA_HOLDER_TOKEN_KEY/,
  /^MATRA_MATCHER_(URL|KEY|KEY_FILE|TOKEN|TOKEN_FILE)$/,
  /^MATRA_ATTESTATION_PLATFORM_KEY(_FILE)?$/,
  /^MATRA_PHONE_HASH_KEY(_FILE)?$/,
];

type Env = Record<string, string | undefined>;

/** Names of the matching-only variables that are set (non-empty) in `env`, sorted. */
export function matchingOnlyVarsSet(env: Env): string[] {
  return Object.keys(env)
    .filter((k) => (env[k] ?? '').trim() !== '' && MATCHING_ONLY_VARS.some((re) => re.test(k)))
    .sort();
}

/**
 * MATRA_MATCHING for the app server. Production must set it ("off" for the pilot). Outside production it defaults to
 * "off". With "off", any matching-only variable is a fatal configuration error.
 */
export function loadMatchingMode(env: Env = process.env): MatchingMode {
  const production = env.NODE_ENV === 'production';
  const mode = parseMatchingMode(env.MATRA_MATCHING);
  if (!mode && production)
    throw new Error(
      'MATRA_MATCHING must be set in production: "off" (the pilot: sealed matching left out) or "on" (see docs/DEPLOY.md).',
    );
  const resolved = mode ?? 'off';
  if (resolved === 'off') {
    const set = matchingOnlyVarsSet(env);
    if (set.length)
      throw new Error(
        `MATRA_MATCHING is off${mode ? '' : ' (the default)'}, but ${set.join(', ')} ${set.length > 1 ? 'are' : 'is'} set. ` +
          'Those are only for sealed matching: remove them, or set MATRA_MATCHING=on.',
      );
  }
  return resolved;
}

/** The one answer every matching route gives when matching is off. */
export const MATCHING_DISABLED = { error: 'Sealed matching isn’t part of this service.', code: 'matching_disabled' } as const;

/** Express middleware for MATCHING_ROUTE_PREFIXES when matching is off: 404 before any auth or body handling. */
export function matchingDisabled(_req: Request, res: Response, _next: NextFunction): void {
  res.status(404).json(MATCHING_DISABLED);
}

/** Rows a previous "on" left behind: survivors' sealed entries, and reports released to counselors. */
export function leftoverMatchingRows(db: DB): { matchEntries: number; reportReleases: number } {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    matchEntries: n('SELECT COUNT(*) AS n FROM match_entries'),
    reportReleases: n('SELECT COUNT(*) AS n FROM report_releases'),
  };
}

/**
 * Matching off over a database that still has matching rows: production refuses to start (an operator has to decide,
 * with counsel, what happens to them first); development warns. Nothing is deleted here.
 */
export function checkLeftoverMatchingRows(db: DB, production: boolean): void {
  const { matchEntries, reportReleases } = leftoverMatchingRows(db);
  if (!matchEntries && !reportReleases) return;
  const msg =
    `MATRA_MATCHING is off, but this database still holds ${matchEntries} sealed-match entr${matchEntries === 1 ? 'y' : 'ies'} ` +
    `and ${reportReleases} report release${reportReleases === 1 ? '' : 's'} from when matching was on. They stay untouched and unreachable.`;
  if (production) throw new Error(`${msg} Refusing to start in production: decide what happens to them first (docs/DEPLOY.md).`);
  console.warn(`[matra] WARNING: ${msg}`);
}
