import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { decryptJSON, encryptJSON, generateContentKey, unwrapKeyWithPrivate, wrapKeyWithMaster } from '@matra/crypto';
import type { AttorneyProfile, VaultRecord, WrappedKey } from '@matra/shared';
import { envelopeHash } from '../api/client';
import { sampleRecord } from '../brief/fixtures';
import { useSession } from '../lib/session';
import { fakeAuthFetch } from '../test/fakeServer';
import { Harness, current } from '../test/sessionHarness';
import { Share } from './Share';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function Gate() {
  return useSession().session ? <Share /> : <p>Signed out</p>;
}

describe('Share: saved versions that could not be opened', () => {
  it('tells her, and keeps "Yes, share" off, so an older version is never shared silently', async () => {
    const user = userEvent.setup();
    const base = fakeAuthFetch();
    const records: VaultRecord[] = [];
    const attorneys: AttorneyProfile[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x');
      if (url.pathname === '/api/vault/records') return json(200, { records });
      if (url.pathname.startsWith('/api/vault/records/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop()!);
        // her newest sealed version can't be fetched right now
        if (id === 'r-newest') return json(500, { error: 'Something went wrong' });
        return json(200, { record: records.find((r) => r.id === id) });
      }
      if (url.pathname.startsWith('/api/ledger/entries/')) return json(404, { error: 'not found' });
      if (url.pathname === '/api/attorneys') return json(200, { attorneys });
      return base.fetchImpl(input, init);
    });
    render(
      <Harness fetchImpl={fetchImpl as unknown as typeof fetch}>
        <MemoryRouter>
          <Gate />
        </MemoryRouter>
      </Harness>,
    );
    await act(async () => {
      await current!.register({ username: 'wren-share', passphrase: 'acorn-maple-violin-otter-quartz', role: 'survivor', ageConfirmed18: true });
    });
    // fill her vault after sign-up (her master key exists now): one readable sealed version, one that fails to load
    const key = await generateContentKey();
    const envelope = await encryptJSON({ kind: 'final', record: sampleRecord, savedAt: '2026-08-19T00:00:00Z' }, key);
    const older: VaultRecord = {
      id: 'r-older', ownerId: 'u', createdAt: '2026-08-19T00:00:00Z', contentHash: await envelopeHash(envelope),
      ledgerEntryId: 'l1', envelope, ownerWrappedKey: await wrapKeyWithMaster(key, current!.session!.masterKey),
    };
    records.push(older, { ...older, id: 'r-newest', createdAt: '2026-08-20T00:00:00Z', supersedes: 'r-older' });
    // any valid RSA key will do for the attorney (this test build pins no org key, so it shows as unpinned)
    attorneys.push({
      userId: 'a1', displayName: 'Attorney Test', jurisdictions: ['NJ'], practiceAreas: [], verified: true, acceptsProBono: true,
      publicKey: current!.session!.user.publicKey,
    });
    // the screen loaded its vault on mount, before the records existed; remount it now that they do
    await act(async () => {
      current!.lock();
    });
    await act(async () => {
      await current!.login('wren-share', 'acorn-maple-violin-otter-quartz');
    });

    const note = await screen.findByTestId('vault-unreadable', {}, { timeout: 15_000 });
    expect(note).toHaveTextContent(/couldn’t open one saved version.*may not be your newest save/);

    await user.click(await screen.findByRole('button', { name: 'Review and decide' }, { timeout: 15_000 }));
    await user.click(screen.getByLabelText('I agree to the statement above.'));
    expect(screen.getByRole('button', { name: /Yes, share with Attorney Test/ })).toBeDisabled();
    expect(fetchImpl.mock.calls.some(([u, i]) => String(u).endsWith('/api/shares') && i?.method === 'POST')).toBe(false);
  }, 60_000);
});

describe('Share: only the sealed account itself is ever shared', () => {
  it.each([
    ['a version sealed now ({kind, record, savedAt})', false],
    ['a version sealed before draft slots (it also holds her draft and matching fingerprints)', true],
  ])('%s', async (_name, legacy) => {
    const user = userEvent.setup();
    const base = fakeAuthFetch();
    const records: VaultRecord[] = [];
    const attorneys: AttorneyProfile[] = [];
    const shares: Array<{ recordId: string; recipientWrappedKey: WrappedKey }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x');
      if (url.pathname === '/api/vault/records') return json(200, { records });
      if (url.pathname.startsWith('/api/vault/records/'))
        return json(200, { record: records.find((r) => r.id === decodeURIComponent(url.pathname.split('/').pop()!)) });
      if (url.pathname.startsWith('/api/ledger/entries/')) return json(404, { error: 'not found' });
      if (url.pathname === '/api/attorneys') return json(200, { attorneys });
      if (url.pathname === '/api/vault/blobs') return json(200, { blobs: [] });
      if (url.pathname === '/api/shares' && init?.method === 'POST') {
        shares.push(JSON.parse(String(init.body)));
        return json(201, { share: {}, ledgerEntry: {} });
      }
      return base.fetchImpl(input, init);
    });
    render(
      <Harness fetchImpl={fetchImpl as unknown as typeof fetch}>
        <MemoryRouter>
          <Gate />
        </MemoryRouter>
      </Harness>,
    );
    await act(async () => {
      await current!.register({ username: 'wren-clean', passphrase: 'acorn-maple-violin-otter-quartz', role: 'survivor', ageConfirmed18: true });
    });
    const key = await generateContentKey();
    const payload = legacy
      ? { kind: 'final', record: sampleRecord, draft: { answers: { 'person.matchContact': { detail: '555-0100' } } }, escrowedHashes: ['ab12'], savedAt: '2026-08-19T00:00:00Z' }
      : { kind: 'final', record: sampleRecord, savedAt: '2026-08-19T00:00:00Z' };
    const envelope = await encryptJSON(payload, key);
    records.push({
      id: 'r-final', ownerId: 'u', createdAt: '2026-08-19T00:00:00Z', contentHash: await envelopeHash(envelope),
      ledgerEntryId: 'l1', envelope, ownerWrappedKey: await wrapKeyWithMaster(key, current!.session!.masterKey),
    });
    // the attorney's key is her own here, so the test can open what the attorney would receive
    attorneys.push({
      userId: 'a1', displayName: 'Attorney Test', jurisdictions: ['NJ'], practiceAreas: [], verified: true, acceptsProBono: true,
      publicKey: current!.session!.user.publicKey,
    });
    await act(async () => {
      current!.lock();
    });
    await act(async () => {
      await current!.login('wren-clean', 'acorn-maple-violin-otter-quartz');
    });

    await user.click(await screen.findByRole('button', { name: 'Review and decide' }, { timeout: 15_000 }));
    await user.click(screen.getByLabelText('I agree to the statement above.'));
    const yes = screen.getByRole('button', { name: /Yes, share with Attorney Test/ });
    if (legacy) {
      expect(screen.getByText(/saved in an older format that also keeps your working notes/)).toBeInTheDocument();
      expect(yes).toBeDisabled();
      expect(shares).toHaveLength(0);
      return;
    }
    expect(yes).toBeEnabled();
    await user.click(yes);
    await screen.findByText(/Shared with Attorney Test/, {}, { timeout: 15_000 });
    expect(shares).toHaveLength(1);
    // what the attorney can open: exactly her account
    const recordKey = await unwrapKeyWithPrivate(shares[0]!.recipientWrappedKey, current!.session!.privateKey);
    const opened = await decryptJSON<Record<string, unknown>>(records.find((r) => r.id === shares[0]!.recordId)!.envelope, recordKey);
    expect(Object.keys(opened).sort()).toEqual(['kind', 'record', 'savedAt']);
  }, 60_000);
});
