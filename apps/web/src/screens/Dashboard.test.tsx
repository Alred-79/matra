import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { AttorneyProfile, Share } from '@matra/shared';
import { sampleRecord } from '../brief/fixtures';
import { useSession } from '../lib/session';
import { fakeAuthFetch } from '../test/fakeServer';
import { storedRecord, vaultRoutes, type StoredRecord } from '../test/fakeVault';
import { Harness, current } from '../test/sessionHarness';
import { Dashboard } from './Dashboard';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function Home() {
  return useSession().session ? <Dashboard /> : <p>Signed out</p>;
}

/** Home over a fake server: her records (with ledger entries), shares and attorneys, filled after she signs up. */
async function homeWith(username: string, fail: Parameters<typeof vaultRoutes>[1] = {}) {
  const base = fakeAuthFetch();
  const stored: StoredRecord[] = [];
  const shares: Share[] = [];
  const attorneys: AttorneyProfile[] = [];
  const routes = vaultRoutes(stored, fail);
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x');
    const hit = routes(input, init);
    if (hit) return hit;
    if (url.pathname === '/api/vault/blobs') return json(200, { blobs: [] });
    if (url.pathname === '/api/shares') return json(200, { shares });
    if (url.pathname === '/api/attorneys') return json(200, { attorneys });
    if (url.pathname === '/api/audit') return json(200, { events: [] });
    return base.fetchImpl(input, init);
  });
  render(
    <Harness fetchImpl={fetchImpl as unknown as typeof fetch}>
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    </Harness>,
  );
  await act(async () => {
    await current!.register({ username, passphrase: 'acorn-maple-violin-otter-quartz', role: 'survivor', ageConfirmed18: true });
  });
  const mk = current!.session!.masterKey;
  /** Home loaded on sign-up, before the records existed: sign in again so it loads them */
  const reopen = async () => {
    await act(async () => {
      current!.lock();
    });
    await act(async () => {
      await current!.login(username, 'acorn-maple-violin-otter-quartz');
    });
  };
  return { fetchImpl, stored, shares, attorneys, mk, reopen };
}

const share = (id: string, recordId: string, extra: Partial<Share> = {}): Share => ({
  id, recordId, survivorId: 'u', attorneyId: `a-${id}`, status: 'active', consentStatement: 'I consent.', scope: ['record'],
  createdAt: '2026-08-21T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', ledgerEntryId: 'l', attorneyVerified: true, ...extra,
});

describe('Home: sharing', () => {
  it('a share of a version sealed before draft slots (it also holds her draft) can’t be renewed; a share of a clean one can', async () => {
    const h = await homeWith('wren-renew');
    h.stored.push(
      await storedRecord(h.mk, { kind: 'final', record: sampleRecord, draft: { answers: {} }, escrowedHashes: ['ab'], savedAt: '2026-08-19T00:00:00Z' }, { id: 'r-legacy' }),
      await storedRecord(h.mk, { kind: 'final', record: sampleRecord, savedAt: '2026-08-20T00:00:00Z' }, { id: 'r-clean' }),
    );
    h.shares.push(share('s-legacy', 'r-legacy'), share('s-clean', 'r-clean'));
    await h.reopen();

    const legacyNote = await screen.findByTestId('share-legacy', {}, { timeout: 15_000 });
    const legacyRow = legacyNote.closest('li')!;
    expect(within(legacyRow).queryByRole('button', { name: /^Renew/ })).toBeNull();
    expect(within(legacyRow).getByTestId('share-revoke')).toBeInTheDocument();
    const rows = screen.getAllByTestId('share-revoke').map((b) => b.closest('li')!);
    const cleanRow = rows.find((r) => r !== legacyRow)!;
    expect(within(cleanRow).getByRole('button', { name: /^Renew/ })).toBeInTheDocument();
  }, 60_000);
});

describe('Home reads partially, and says what is left out and why', () => {
  it('a saved version that doesn’t match what she saved: left out, with the "doesn’t match" note', async () => {
    const h = await homeWith('wren-partial');
    h.stored.push(
      await storedRecord(h.mk, { kind: 'final', record: sampleRecord, savedAt: '2026-08-19T00:00:00Z' }, { id: 'r-old' }),
      await storedRecord(h.mk, { kind: 'final', record: sampleRecord, savedAt: '2026-08-20T00:00:00Z' }, { id: 'r-new', supersedes: 'r-old' }),
    );
    h.stored[1]!.ledger.contentHash = 'f'.repeat(64);
    await h.reopen();
    const note = await screen.findByTestId('vault-unreadable', {}, { timeout: 15_000 });
    expect(note).toHaveAttribute('data-kind', 'integrity');
    expect(note).toHaveTextContent(/One saved version of your space doesn’t match what you saved, so it is left out here/);
  }, 60_000);

  it('one that couldn’t be fetched: the "couldn’t reach Matra" note', async () => {
    const h = await homeWith('wren-away', { record: { 'r-new': 503 } });
    h.stored.push(await storedRecord(h.mk, { kind: 'final', record: sampleRecord, savedAt: '2026-08-20T00:00:00Z' }, { id: 'r-new' }));
    await h.reopen();
    const note = await screen.findByTestId('vault-unreadable', {}, { timeout: 15_000 });
    expect(note).toHaveAttribute('data-kind', 'unavailable');
    expect(note).toHaveTextContent(/We couldn’t reach Matra to open one saved version of your space just now/);
  }, 60_000);
});
