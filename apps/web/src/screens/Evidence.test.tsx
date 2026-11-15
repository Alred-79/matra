import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { encryptJSON, generateContentKey, openSlot, wrapKeyWithMaster } from '@matra/crypto';
import type { VaultRecord } from '@matra/shared';
import { envelopeHash } from '../api/client';
import { emptyDraft } from '../integration/intakeAdapter';
import { fakeAuthFetch } from '../test/fakeServer';
import { Harness, current } from '../test/sessionHarness';
import { Evidence } from './Evidence';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('Evidence: saved versions that could not be opened', () => {
  it('keeps the upload but never saves an older draft over her newest one', async () => {
    const user = userEvent.setup();
    const base = fakeAuthFetch();
    const records: VaultRecord[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x');
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/vault/records' && method === 'GET') return json(200, { records });
      if (url.pathname === '/api/vault/records' && method === 'POST') return json(500, { error: 'must not be called' });
      if (url.pathname.startsWith('/api/vault/records/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop()!);
        if (id === 'r-newest') return json(500, { error: 'Something went wrong' }); // her newest draft
        return json(200, { record: records.find((r) => r.id === id) });
      }
      if (url.pathname.startsWith('/api/vault/slots/') && method === 'GET') return json(200, { slot: null, draftMode: 'slot' });
      if (url.pathname.startsWith('/api/vault/slots/')) return json(500, { error: 'must not be called' });
      if (url.pathname === '/api/vault/blobs' && method === 'GET') return json(200, { blobs: [] });
      if (url.pathname === '/api/vault/blobs' && method === 'POST') {
        const at = '2026-09-01T00:00:00Z';
        return json(201, {
          blob: { id: 'b'.repeat(32), ownerId: 'u', sizeBytes: 4, contentHash: 'h', createdAt: at, ledgerEntryId: 'l9', ownerWrappedKey: {} },
          ledgerEntry: { id: 'l9', seq: 9, type: 'blob.sealed', subjectId: 'b'.repeat(32), contentHash: 'h', prevHash: 'p', entryHash: 'e', timestamp: at },
        });
      }
      if (url.pathname.startsWith('/api/ledger/entries/')) return json(404, { error: 'not found' });
      return base.fetchImpl(input, init);
    });
    const { rerender } = render(<Harness fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await act(async () => {
      await current!.register({ username: 'wren-evidence', passphrase: 'acorn-maple-violin-otter-quartz', role: 'survivor', ageConfirmed18: true });
    });
    const s = current!.session!;
    const key = await generateContentKey();
    const envelope = await encryptJSON({ kind: 'draft', draft: emptyDraft(), savedAt: '2026-08-19T00:00:00Z' }, key);
    const older: VaultRecord = {
      id: 'r-older', ownerId: s.user.id, createdAt: '2026-08-19T00:00:00Z', contentHash: await envelopeHash(envelope),
      ledgerEntryId: 'l1', envelope, ownerWrappedKey: await wrapKeyWithMaster(key, s.masterKey),
    };
    records.push(older, { ...older, id: 'r-newest', createdAt: '2026-08-20T00:00:00Z', supersedes: 'r-older' });
    rerender(
      <Harness fetchImpl={fetchImpl as unknown as typeof fetch}>
        <MemoryRouter>
          <Evidence />
        </MemoryRouter>
      </Harness>,
    );

    // no draft in memory (a fresh sign-in): her draft would come from the vault
    expect(await screen.findByTestId('vault-unreadable', {}, { timeout: 15_000 })).toBeInTheDocument();
    await user.upload(screen.getByLabelText('Choose evidence files'), new File(['note'], 'note.pdf', { type: 'application/pdf' }));

    expect(await screen.findByText(/Your files are safely uploaded, but we couldn’t add their details to your draft: We couldn’t open one saved version/, {}, { timeout: 15_000 })).toBeInTheDocument();
    const posts = fetchImpl.mock.calls.filter(([u, i]) => new URL(String(u), 'http://x').pathname === '/api/vault/records' && i?.method === 'POST');
    expect(posts).toHaveLength(0);
    const slotWrites = fetchImpl.mock.calls.filter(([u, i]) => new URL(String(u), 'http://x').pathname.startsWith('/api/vault/slots/') && i?.method === 'PUT');
    expect(slotWrites).toHaveLength(0);
    // the file's details stay in memory for My story
    expect((await current!.getWorkingData())?.evidence.map((e) => e.fileName)).toEqual(['note.pdf']);
  }, 60_000);

  it('saves the file details into her draft slot (never a new record), naming the seq it read', async () => {
    const user = userEvent.setup();
    const base = fakeAuthFetch();
    let slot: { name: string; envelope: unknown; wrappedKey: unknown; seq: number; updatedDay: string } | null = null;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x');
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/vault/records' && method === 'GET') return json(200, { records: [] });
      if (url.pathname === '/api/vault/records' && method === 'POST') return json(500, { error: 'must not be called' });
      if (url.pathname.startsWith('/api/vault/slots/') && method === 'GET') return json(200, { slot, draftMode: 'slot' });
      if (url.pathname.startsWith('/api/vault/slots/') && method === 'PUT') {
        const body = JSON.parse(String(init!.body));
        if ((slot?.seq ?? 0) !== body.expectedSeq) return json(409, { error: 'stale', code: 'slot_conflict' });
        slot = { name: url.pathname.split('/').pop()!, envelope: body.envelope, wrappedKey: body.wrappedKey, seq: (slot?.seq ?? 0) + 1, updatedDay: '2026-11-14' };
        return json(200, { seq: slot.seq, updatedDay: slot.updatedDay, draftMode: 'slot' });
      }
      if (url.pathname === '/api/vault/blobs' && method === 'GET') return json(200, { blobs: [] });
      if (url.pathname === '/api/vault/blobs' && method === 'POST') {
        const at = '2026-09-01T00:00:00Z';
        return json(201, {
          blob: { id: 'c'.repeat(32), ownerId: 'u', sizeBytes: 4, contentHash: 'h', createdAt: at, ledgerEntryId: 'l9', ownerWrappedKey: {} },
          ledgerEntry: { id: 'l9', seq: 9, type: 'blob.sealed', subjectId: 'c'.repeat(32), contentHash: 'h', prevHash: 'p', entryHash: 'e', timestamp: at },
        });
      }
      if (url.pathname.startsWith('/api/ledger/entries/')) return json(404, { error: 'not found' });
      return base.fetchImpl(input, init);
    });
    const { rerender } = render(<Harness fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await act(async () => {
      await current!.register({ username: 'wren-slot', passphrase: 'acorn-maple-violin-otter-quartz', role: 'survivor', ageConfirmed18: true });
    });
    rerender(
      <Harness fetchImpl={fetchImpl as unknown as typeof fetch}>
        <MemoryRouter>
          <Evidence />
        </MemoryRouter>
      </Harness>,
    );
    await user.upload(await screen.findByLabelText('Choose evidence files'), new File(['note'], 'note.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText('Saved to your space and added to your draft story.', {}, { timeout: 15_000 })).toBeInTheDocument();
    const posts = fetchImpl.mock.calls.filter(([u, i]) => new URL(String(u), 'http://x').pathname === '/api/vault/records' && i?.method === 'POST');
    expect(posts).toHaveLength(0);
    expect(slot!.seq).toBe(1);
    const s = current!.session!;
    const opened = await openSlot<{ kind: string; evidence: Array<{ fileName: string }> }>(slot as never, s.masterKey);
    expect(opened.kind).toBe('draft');
    expect(opened.evidence.map((e) => e.fileName)).toEqual(['note.pdf']);
    expect((await current!.getWorkingData())?.slotSeq).toBe(1);
  }, 60_000);
});
