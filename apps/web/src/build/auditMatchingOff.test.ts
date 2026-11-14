// @vitest-environment node
/**
 * A MATRA_MATCHING=off build ships no sealed-matching code (scripts/audit-web-build.mjs, check 4): a real `vite build`
 * of each kind, audited. The "on" build audited as "off" must fail, or the check proves nothing.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = path.resolve(WEB, '..', '..');
const VITE = path.resolve(ROOT, 'node_modules', '.bin', 'vite');
const AUDIT = path.resolve(ROOT, 'scripts', 'audit-web-build.mjs');

/** Environment without any matching or pin variable from the caller's shell. */
function cleanEnv(extra: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !/^MATRA_(MATCHING|DEMO_MODE|VOICE_HARNESS|ATTESTATION_PLATFORM_PUBKEY|MATCHER_MEASUREMENT|COUNSELOR_ROSTER_PUBKEY|OPRF_\w+)$/.test(k)) env[k] = v;
  return { ...env, ...extra };
}

function build(matching: 'on' | 'off'): string {
  const out = path.join(WEB, 'node_modules', `.audit-matching-${matching}`);
  const r = spawnSync(VITE, ['build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: WEB,
    env: cleanEnv({ NODE_ENV: 'production', MATRA_DEMO_MODE: '1', MATRA_MATCHING: matching }),
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (r.status !== 0) throw new Error(`vite build (${matching}) failed: ${r.stderr}${r.stdout}`);
  return out;
}

const audit = (dist: string, mode?: 'on' | 'off', env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [AUDIT, dist, ...(mode ? [`--matching=${mode}`] : [])], { env: cleanEnv(env), encoding: 'utf8' });

describe('build audit: sealed matching left out of a MATRA_MATCHING=off build', () => {
  it('an off build passes; the same check on an on build fails, naming what it found', () => {
    const off = build('off');
    const ok = audit(off);
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/no sealed-matching code \(MATRA_MATCHING=off\)/);

    const on = build('on');
    const bad = audit(on, 'off');
    expect(bad.status).toBe(1);
    for (const m of ['/api/matching', '/api/counselor', '/api/escrow', '/api/report-requests', 'oprf', 'counselor/matches'])
      expect(bad.stderr).toContain(`"${m}"`);
    // and an on build audited as on passes (the variable works as well as the flag)
    expect(audit(on, undefined, { MATRA_MATCHING: 'on' }).status).toBe(0);
  }, 300_000);

  it('flags each matching-only string, in any shipped text file', () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'matra-audit-'));
    try {
      fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><script src="/assets/a.js"></script></head></html>');
      fs.mkdirSync(path.join(dist, 'assets'));
      for (const [i, s] of ['fetch("/API/Matching/config")', 'route:"counselor/reports/:id"', 'const OPRF=1', 'x("/api/report-releases/1")'].entries()) {
        fs.writeFileSync(path.join(dist, 'assets', `a.js`), `console.log(1);${s}`);
        const r = audit(dist);
        expect([i, r.status]).toEqual([i, 1]);
        expect(r.stderr).toMatch(/but this is a MATRA_MATCHING=off build/);
      }
      fs.writeFileSync(path.join(dist, 'assets', 'a.js'), 'const words = "A school counselor can help."');
      expect(audit(dist).status).toBe(0);
      expect(audit(dist, 'maybe' as 'on').status).toBe(1);
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });
});
