import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { emptyDraft } from '../integration/intakeAdapter';
import { fakeAuthFetch } from '../test/fakeServer';
import { storedRecord, vaultRoutes, type StoredRecord } from '../test/fakeVault';
import { Harness, current } from '../test/sessionHarness';
import { Story } from './Story';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('My story fails closed', () => {
  it('a saved version that doesn’t match what she saved: nothing opens or saves; Try again once it matches', async () => {
    const user = userEvent.setup();
    const base = fakeAuthFetch();
    const stored: StoredRecord[] = [];
    const routes = vaultRoutes(stored);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x');
      const method = init?.method ?? 'GET';
      if (method !== 'GET' && (url.pathname.startsWith('/api/vault/slots/') || url.pathname === '/api/vault/records')) return json(500, { error: 'must not be called' });
      if (url.pathname.startsWith('/api/vault/slots/')) return json(200, { slot: null, draftMode: 'slot' });
      return routes(input, init) ?? base.fetchImpl(input, init);
    });
    const { rerender } = render(<Harness fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await act(async () => {
      await current!.register({ username: 'wren-story', passphrase: 'acorn-maple-violin-otter-quartz', role: 'survivor', ageConfirmed18: true });
    });
    const mk = current!.session!.masterKey;
    stored.push(await storedRecord(mk, { kind: 'draft', draft: emptyDraft(), savedAt: '2026-08-19T00:00:00Z' }, { id: 'r1' }));
    const real = stored[0]!.ledger.contentHash;
    stored[0]!.ledger.contentHash = 'f'.repeat(64); // the ledger attests something else
    rerender(
      <Harness fetchImpl={fetchImpl as unknown as typeof fetch}>
        <MemoryRouter>
          <Story />
        </MemoryRouter>
      </Harness>,
    );

    const stopped = await screen.findByTestId('vault-stopped', {}, { timeout: 15_000 });
    expect(stopped).toHaveTextContent(/doesn’t match what you saved, so we stopped here rather than show it or save over it\. Nothing was changed\./);
    expect(screen.queryByText('Opening your draft…')).toBeNull();
    // no "keep writing from what opened": a story that didn't load cleanly is never resumed

    stored[0]!.ledger.contentHash = real;
    await user.click(within(stopped).getByRole('button', { name: 'Try again' }));
    await vi.waitFor(() => expect(screen.queryByTestId('vault-stopped')).toBeNull(), { timeout: 15_000 });
    await vi.waitFor(() => expect(screen.queryByText('Opening your draft…')).toBeNull(), { timeout: 15_000 });
    const writes = fetchImpl.mock.calls.filter(([, i]) => i?.method === 'PUT' || (i?.method === 'POST' && String(i?.body ?? '').includes('envelope')));
    expect(writes).toHaveLength(0);
  }, 60_000);
});
