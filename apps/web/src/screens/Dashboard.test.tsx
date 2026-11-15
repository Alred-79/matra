import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { encryptJSON, generateContentKey, wrapKeyWithMaster } from '@matra/crypto';
import type { Share, VaultRecord } from '@matra/shared';
import { envelopeHash } from '../api/client';
import { sampleRecord } from '../brief/fixtures';
import { useSession } from '../lib/session';
import { fakeAuthFetch } from '../test/fakeServer';
import { Harness, current } from '../test/sessionHarness';
import { Dashboard } from './Dashboard';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function Home() {
  return useSession().session ? <Dashboard /> : <p>Signed out</p>;
}

describe('Home: sharing', () => {
  it('a share of a version sealed before draft slots (it also holds her draft) can’t be renewed; a share of a clean one can', async () => {
    const base = fakeAuthFetch();
    const records: VaultRecord[] = [];
    const shares: Share[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x');
      if (url.pathname === '/api/vault/records') return json(200, { records });
      if (url.pathname.startsWith('/api/vault/records/'))
        return json(200, { record: records.find((r) => r.id === decodeURIComponent(url.pathname.split('/').pop()!)) });
      if (url.pathname.startsWith('/api/ledger/entries/')) return json(404, { error: 'not found' });
      if (url.pathname === '/api/vault/blobs') return json(200, { blobs: [] });
      if (url.pathname === '/api/shares') return json(200, { shares });
      if (url.pathname === '/api/attorneys') return json(200, { attorneys: [] });
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
      await current!.register({ username: 'wren-renew', passphrase: 'acorn-maple-violin-otter-quartz', role: 'survivor', ageConfirmed18: true });
    });
    const mk = current!.session!.masterKey;
    const seal = async (id: string, payload: unknown, at: string) => {
      const key = await generateContentKey();
      const envelope = await encryptJSON(payload, key);
      records.push({ id, ownerId: 'u', createdAt: at, contentHash: await envelopeHash(envelope), ledgerEntryId: 'l', envelope, ownerWrappedKey: await wrapKeyWithMaster(key, mk) });
    };
    await seal('r-legacy', { kind: 'final', record: sampleRecord, draft: { answers: {} }, escrowedHashes: ['ab'], savedAt: '2026-08-19T00:00:00Z' }, '2026-08-19T00:00:00Z');
    await seal('r-clean', { kind: 'final', record: sampleRecord, savedAt: '2026-08-20T00:00:00Z' }, '2026-08-20T00:00:00Z');
    const share = (id: string, recordId: string): Share => ({
      id, recordId, survivorId: 'u', attorneyId: `a-${id}`, status: 'active', consentStatement: 'I consent.', scope: ['record'],
      createdAt: '2026-08-21T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', ledgerEntryId: 'l', attorneyVerified: true,
    });
    shares.push(share('s-legacy', 'r-legacy'), share('s-clean', 'r-clean'));
    await act(async () => {
      current!.lock();
    });
    await act(async () => {
      await current!.login('wren-renew', 'acorn-maple-violin-otter-quartz');
    });

    const legacyNote = await screen.findByTestId('share-legacy', {}, { timeout: 15_000 });
    const legacyRow = legacyNote.closest('li')!;
    expect(within(legacyRow).queryByRole('button', { name: /^Renew/ })).toBeNull();
    expect(within(legacyRow).getByTestId('share-revoke')).toBeInTheDocument();
    const rows = screen.getAllByTestId('share-revoke').map((b) => b.closest('li')!);
    const cleanRow = rows.find((r) => r !== legacyRow)!;
    expect(within(cleanRow).getByRole('button', { name: /^Renew/ })).toBeInTheDocument();
  }, 60_000);
});
