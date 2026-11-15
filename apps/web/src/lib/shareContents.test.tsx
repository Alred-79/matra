/**
 * Every consent sentence matches what the recipient can decrypt (MATRA_PLAN PR 9).
 *
 * For each choice she can make on the attorney share screen and on the counselor release screen, the test drives the
 * real screen, takes what her device sends, opens it with the recipient's private key, and checks it against the
 * words, not against a second list kept here: each field the recipient can read must belong to a part of her account
 * that her consent statement names (ACCOUNT_PARTS, @matra/shared consent.ts), the files that open must be exactly the
 * ones she ticked and as many as the statement says, and the screen must show the same parts the statement names. Add
 * a field to her account, or drop words from the consent, and this fails.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  decryptBlob,
  decryptJSON,
  encryptBlob,
  generateContentKey,
  sha256Hex,
  unwrapKeyWithPrivate,
  wrapKeyWithMaster,
} from '@matra/crypto';
import {
  ACCOUNT_PARTS,
  RECORD_FIELD_PART,
  SHARE_ALIAS_RE,
  consentMatches,
  partForPath,
  shareAliasSentence,
  statedFileCount,
  type AttorneyProfile,
  type BlobMeta,
  type EvidenceItem,
  type IntakeRecord,
  type SurvivorReportRequest,
  type WrappedKey,
} from '@matra/shared';
import { sampleRecord } from '../brief/fixtures';
import { ReportRequest } from '../counselor/ReportRequest';
import { Share } from '../screens/Share';
import { useSession } from './session';
import { fakeAuthFetch } from '../test/fakeServer';
import { storedRecord, vaultRoutes, type StoredRecord } from '../test/fakeVault';
import { Harness, current } from '../test/sessionHarness';

// The counselor release exists only with sealed matching on; this file tests both screens.
vi.hoisted(() => {
  (globalThis as { __MATRA_MATCHING__?: boolean }).__MATRA_MATCHING__ = true;
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const PASS = 'acorn-otter-river-lilac-tulip-zebra';

/** Three files her account lists: two uploaded (they can be shared), one she described but never uploaded. */
const FILES = [
  { name: 'wrists-photo.jpg', bytes: 'jpeg bytes of the wrists photo', upload: true },
  { name: 'sunday-text.png', bytes: 'png bytes of the screenshot', upload: true },
  { name: 'voicemail-notes.txt', bytes: 'never uploaded', upload: false },
] as const;

/** Her account with every field filled in, so every field's consent words are exercised. */
const fullRecord: IntakeRecord = {
  ...sampleRecord,
  survivor: {
    ...sampleRecord.survivor,
    accessibility: { interpreter: 'yes', interpreterLanguage: 'Yoruba', otherNeeds: 'An advocate with me in person.' },
  },
  physicalEvidence: { kinds: ['clothing'], description: 'The shirt I wore, in a paper bag in my closet.' },
  safety: { immediateSafety: 'safe', perpetratorHasAccess: true, wantsProtectiveOrder: 'unsure', notes: 'He knows where I live.' },
  financialImpact: {
    medicalCosts: '$400',
    counselingCosts: '$120 a week',
    lostWages: 'Two weeks',
    relocationCosts: 'None yet',
    otherCosts: 'Lock change',
    hasInsurance: 'yes',
  },
  compensation: {
    mailingAddress: { street: '1 Example Lane', city: 'Edison', state: 'NJ', zip: '08817' },
    claimant: 'self',
    claimantDetails: 'Myself',
    alternateContact: { name: 'Ada Okafor', relationship: 'Sister', phone: '(732) 555-0177', email: 'ada.demo@example.com' },
    insuranceCarrier: 'Example Health',
    employer: 'Example Agency',
    workDatesMissed: 'Aug 17 to Aug 28',
    goodCauseExplanation: 'I was afraid to report.',
  },
  goals: { policeReport: 'undecided', attorney: 'yes', compensation: 'yes', protectiveOrder: 'undecided' },
};

/** The least she can seal: her words, and nothing else she chose to fill in. */
const minimalRecord: IntakeRecord = {
  schemaVersion: 1,
  completedAt: '2026-08-19T14:20:51.000Z',
  survivor: { safeContact: { phone: false, text: false, email: false, voicemail: false } },
  incident: { dateIsApproximate: true, jurisdiction: {}, incidentTypes: [], isOngoing: false },
  narrative: { freeRecall: 'Only these words.', sensory: {} },
  perpetrators: [],
  witnesses: [],
  disclosures: [],
  medical: { soughtCare: false },
  priorReports: [],
  evidence: [],
  safety: { immediateSafety: undefined },
  financialImpact: {},
  goals: { policeReport: 'undecided', attorney: 'undecided', compensation: 'undecided', protectiveOrder: 'undecided' },
};

/** Every field path with a value (a leaf), e.g. ['survivor', 'phone'] or ['perpetrators', '0', 'name']. */
function leaves(v: unknown, path: string[] = []): string[][] {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, [...path, String(i)]));
  if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => leaves(x, [...path, k]));
  return [path];
}

interface Sent {
  recordId: string;
  recipientWrappedKey: WrappedKey;
  blobs: Array<{ blobId: string; recipientWrappedKey: WrappedKey }>;
  consentStatement: string;
  scope?: string[];
  survivorAlias?: string;
}

interface Vault {
  stored: StoredRecord[];
  /** ciphertext by blob id */
  ciphertexts: Map<string, Uint8Array>;
}

/**
 * Everything wrong with what she sent, judged only by her consent statement (and the screen she saw). Empty means the
 * recipient can open exactly what she agreed to.
 */
async function problems(sent: Sent, vault: Vault, privateKey: CryptoKey, saw: { parts: string[]; ticked: string[]; alias?: string }): Promise<string[]> {
  const out: string[] = [];
  const st = sent.consentStatement;
  const promised = new Set(ACCOUNT_PARTS.filter((p) => st.includes(p.consent)).map((p) => p.id));

  // the written account: only fields of parts the statement names
  const key = await unwrapKeyWithPrivate(sent.recipientWrappedKey, privateKey);
  const env = vault.stored.find((r) => r.record.id === sent.recordId)!.record.envelope;
  const payload = await decryptJSON<{ kind: string; record: IntakeRecord; savedAt: string }>(env, key);
  const top = Object.keys(payload).sort().join(',');
  if (top !== 'kind,record,savedAt') out.push(`the envelope holds more than her account: ${top}`);
  for (const path of leaves(payload.record)) {
    const part = partForPath(path);
    if (!part) out.push(`${path.join('.')}: no consent words cover it`);
    else if (!promised.has(part)) out.push(`${path.join('.')}: readable, but the statement doesn't name "${part}"`);
  }

  // the screen showed the same parts the statement names
  const promisedOrder = ACCOUNT_PARTS.filter((p) => promised.has(p.id)).map((p) => p.id);
  if (saw.parts.join(',') !== promisedOrder.join(',')) out.push(`screen shows [${saw.parts}] but the statement names [${promisedOrder}]`);

  // the files themselves: exactly the ones she ticked, as many as the statement says
  const n = statedFileCount(st);
  if (n !== sent.blobs.length) out.push(`statement says ${n} files, ${sent.blobs.length} wrapped`);
  const opened: string[] = [];
  for (const b of sent.blobs) {
    const pt = await decryptBlob(vault.ciphertexts.get(b.blobId)!, await unwrapKeyWithPrivate(b.recipientWrappedKey, privateKey));
    const sha = await sha256Hex(pt);
    opened.push(payload.record.evidence.find((e) => e.sha256 === sha)?.fileName ?? `unlisted file ${sha}`);
  }
  if ([...opened].sort().join(',') !== [...saw.ticked].sort().join(',')) out.push(`files that open: [${opened}], ticked: [${saw.ticked}]`);

  // the attorney share's scope and label
  if (sent.scope) {
    const want = sent.blobs.length ? 'record,evidence' : 'record';
    if (sent.scope.join(',') !== want) out.push(`scope ${sent.scope} for ${sent.blobs.length} files`);
  }
  if (sent.survivorAlias !== undefined) {
    if (!SHARE_ALIAS_RE.test(sent.survivorAlias)) out.push(`label "${sent.survivorAlias}" is not a made-up one`);
    if (!st.includes(shareAliasSentence(sent.survivorAlias))) out.push('the statement names another label');
    if (saw.alias !== sent.survivorAlias) out.push(`screen showed label "${saw.alias}", sent "${sent.survivorAlias}"`);
  }
  // what the server checks before it stores anything (apps/server/src/app.ts)
  if (!consentMatches(st, { files: sent.blobs.length, alias: sent.survivorAlias })) out.push('the server would refuse this consent');

  // the statement is plain text on the server: nothing from her account in it
  for (const path of leaves(payload.record)) {
    const value = path.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], payload.record);
    // free text, names and numbers (a one-word lowercase answer like "employer" can be one of the consent's own words)
    if (typeof value === 'string' && value.length >= 6 && /[\sA-Z0-9@]/.test(value) && partForPath(path) !== 'sealed' && st.includes(value))
      out.push(`the statement carries "${value}" from her account`);
  }
  return out;
}

/** Her space: `record` sealed, the FILES uploaded ones in her blob list, and the screen's routes. */
async function space(record: IntakeRecord, mk: CryptoKey, extra: (url: URL, init?: RequestInit) => Response | null) {
  const stored: StoredRecord[] = [];
  const ciphertexts = new Map<string, Uint8Array>();
  const metas: BlobMeta[] = [];
  const evidence: EvidenceItem[] = [];
  for (const [i, f] of FILES.entries()) {
    const bytes = new TextEncoder().encode(f.bytes);
    const item: EvidenceItem = { id: `ev${i}`, kind: 'photo', fileName: f.name, mimeType: 'application/octet-stream', sizeBytes: bytes.length, sha256: await sha256Hex(bytes), metadataStripped: true };
    if (f.upload) {
      const key = await generateContentKey();
      item.blobId = `b${i}`;
      ciphertexts.set(item.blobId, await encryptBlob(bytes, key));
      metas.push({ id: item.blobId, ownerId: 'u', sizeBytes: bytes.length, contentHash: 'c', createdAt: '2026-08-18T00:00:00Z', ledgerEntryId: `l-${i}`, ownerWrappedKey: await wrapKeyWithMaster(key, mk) });
    }
    evidence.push(item);
  }
  stored.push(await storedRecord(mk, { kind: 'final', record: { ...record, evidence }, savedAt: '2026-08-19T14:21:00Z' }, { id: 'r-final', createdAt: '2026-08-19T14:22:07.381Z' }));
  const routes = vaultRoutes(stored);
  const route = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x');
    if (url.pathname === '/api/vault/blobs' && (init?.method ?? 'GET') === 'GET') return json(200, { blobs: metas });
    return extra(url, init) ?? routes(input, init);
  };
  return { vault: { stored, ciphertexts }, route };
}

/** What the screen listed as always shared, by part id. */
const partsOnScreen = () =>
  within(screen.getByTestId('account-parts'))
    .getAllByRole('listitem')
    .map((li) => li.getAttribute('data-part')!);

function Gate() {
  return useSession().session ? <Share /> : <p>Signed out</p>;
}

/** She opens the attorney share screen, ticks `ticked`, agrees, shares. Returns what her device sent. */
async function shareWithAttorney(record: IntakeRecord, ticked: string[], username: string) {
  const user = userEvent.setup();
  const base = fakeAuthFetch();
  const attorneys: AttorneyProfile[] = [];
  const sent: Sent[] = [];
  const hold: { route?: (i: RequestInfo | URL, n?: RequestInit) => Response | null } = {};
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => hold.route?.(input, init) ?? base.fetchImpl(input, init));
  render(
    <Harness fetchImpl={fetchImpl as unknown as typeof fetch}>
      <MemoryRouter>
        <Gate />
      </MemoryRouter>
    </Harness>,
  );
  await act(async () => {
    await current!.register({ username, passphrase: PASS, role: 'survivor', ageConfirmed18: true });
  });
  const s = current!.session!;
  const built = await space(record, s.masterKey, (url, init) => {
    if (url.pathname === '/api/attorneys') return json(200, { attorneys });
    if (url.pathname === '/api/shares' && init?.method === 'POST') {
      sent.push(JSON.parse(String(init.body)));
      return json(201, { share: {}, ledgerEntry: {} });
    }
    return null;
  });
  hold.route = built.route;
  // the attorney's key is her own here, so the test can open what the attorney would receive
  attorneys.push({ userId: 'a1', displayName: 'Attorney Test', jurisdictions: ['NJ'], practiceAreas: [], verified: true, acceptsProBono: true, publicKey: s.user.publicKey });
  await act(async () => {
    current!.lock();
  });
  await act(async () => {
    await current!.login(username, PASS);
  });
  const review = await screen.findByRole('button', { name: 'Review and decide' }, { timeout: 15_000 });
  // a development build has no org key to check the attorney against: its badge claims nothing
  expect(screen.getByText('Not checked (development version)')).toHaveClass('badge', 'neutral');
  expect(screen.queryByText('Verified attorney')).toBeNull();
  await user.click(review);
  // none is ticked until she ticks it
  for (const f of FILES.filter((x) => x.upload)) expect(screen.getByLabelText(new RegExp(f.name))).not.toBeChecked();
  expect(screen.queryByLabelText(/voicemail-notes/)).toBeNull(); // never uploaded: nothing to share
  for (const name of ticked) await user.click(screen.getByLabelText(new RegExp(name)));
  const alias = /“(Client [^”]+)”/.exec(screen.getByTestId('share-alias').textContent ?? '')?.[1];
  const parts = partsOnScreen();
  await user.click(screen.getByLabelText('I agree to the statement above.'));
  await user.click(screen.getByRole('button', { name: /Yes, share with Attorney Test/ }));
  await screen.findByText(/Shared with Attorney Test/, {}, { timeout: 15_000 });
  expect(sent).toHaveLength(1);
  return { sent: sent[0]!, vault: built.vault, privateKey: current!.session!.privateKey, saw: { parts, ticked, alias }, username };
}

/** She opens the counselor's request, ticks `ticked`, confirms the key, agrees, says yes. Returns what her device sent. */
async function releaseToCounselor(ticked: string[], username: string) {
  const user = userEvent.setup();
  const base = fakeAuthFetch();
  const requests: SurvivorReportRequest[] = [];
  const sent: Sent[] = [];
  const hold: { route?: (i: RequestInfo | URL, n?: RequestInit) => Response | null } = {};
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => hold.route?.(input, init) ?? base.fetchImpl(input, init));
  const { rerender } = render(<Harness fetchImpl={fetchImpl as unknown as typeof fetch} />);
  await act(async () => {
    await current!.register({ username, passphrase: PASS, role: 'survivor', ageConfirmed18: true });
  });
  const s = current!.session!;
  const built = await space(fullRecord, s.masterKey, (url, init) => {
    if (url.pathname === '/api/report-requests') return json(200, { requests });
    if (url.pathname === '/api/escrow') return json(200, { entries: [] });
    if (url.pathname === '/api/report-requests/rq1/consent' && init?.method === 'POST') {
      sent.push(JSON.parse(String(init.body)));
      return json(201, { release: {}, ledgerEntry: {} });
    }
    return null;
  });
  hold.route = built.route;
  requests.push({
    id: 'rq1', entryId: 'e1', status: 'pending', createdAt: '2026-09-01T00:00:00Z',
    counselor: { userId: 'c1', displayName: 'Counselor Test', jurisdictions: ['NJ'], publicKey: s.user.publicKey },
  });
  rerender(
    <Harness fetchImpl={fetchImpl as unknown as typeof fetch}>
      <MemoryRouter initialEntries={['/vault/requests/rq1']}>
        <Routes>
          <Route path="/vault/requests/:id" element={<ReportRequest />} />
        </Routes>
      </MemoryRouter>
    </Harness>,
  );
  await screen.findByTestId('share-contents', {}, { timeout: 15_000 });
  for (const f of FILES.filter((x) => x.upload)) expect(screen.getByLabelText(new RegExp(f.name))).not.toBeChecked();
  for (const name of ticked) await user.click(screen.getByLabelText(new RegExp(name)));
  const parts = partsOnScreen();
  await user.click(screen.getByLabelText('This matches what the counselor told me.'));
  await user.click(screen.getByLabelText('I agree to the statement above.'));
  await user.click(screen.getByRole('button', { name: 'Yes, share my report' }));
  await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 15_000 });
  return { sent: sent[0]!, vault: built.vault, privateKey: s.privateKey, saw: { parts, ticked } };
}

const NONE: string[] = [];
const ONE = ['sunday-text.png'];
const BOTH = ['wrists-photo.jpg', 'sunday-text.png'];

describe('the consent words cover every field of her account', () => {
  it('her full test account fills in every field the words are mapped from', () => {
    for (const k of Object.keys(RECORD_FIELD_PART)) expect(fullRecord, k).toHaveProperty(k);
    for (const k of Object.keys(RECORD_FIELD_PART.survivor)) expect(fullRecord.survivor, `survivor.${k}`).toHaveProperty(k);
    for (const path of leaves(fullRecord)) expect(partForPath(path), path.join('.')).toBeDefined();
    expect(partForPath(['survivor', 'somethingNew'])).toBeUndefined();
    expect(partForPath(['somethingNew'])).toBeUndefined();
  });
});

describe('attorney share: what the attorney can decrypt is exactly what her consent says', () => {
  it.each([
    ['every field filled in, no files ticked', fullRecord, NONE],
    ['every field filled in, one file ticked', fullRecord, ONE],
    ['every field filled in, both uploaded files ticked', fullRecord, BOTH],
    ['only her words, no files ticked', minimalRecord, NONE],
    ['only her words, one file ticked', minimalRecord, ONE],
  ])('%s', async (_name, record, ticked) => {
    const r = await shareWithAttorney(record, ticked, `wren-${ticked.length}-${record === fullRecord ? 'full' : 'min'}`);
    expect(await problems(r.sent, r.vault, r.privateKey, r.saw)).toEqual([]);
    expect(r.sent.survivorAlias).not.toContain(r.username);
    expect(r.sent.consentStatement).not.toContain(r.username);
  }, 60_000);

  it('the check has teeth: drop words from her consent, or send a file she didn’t tick, and it says so', async () => {
    const r = await shareWithAttorney(fullRecord, ONE, 'wren-teeth');
    const evidenceList = ACCOUNT_PARTS.find((p) => p.id === 'evidenceList')!;
    const contact = ACCOUNT_PARTS.find((p) => p.id === 'contact')!;
    const narrowed = { ...r.sent, consentStatement: r.sent.consentStatement.replace(evidenceList.consent, '').replace(contact.consent, '') };
    const found = await problems(narrowed, r.vault, r.privateKey, r.saw);
    expect(found).toContain('survivor.phone: readable, but the statement doesn\'t name "contact"');
    expect(found).toContain('evidence.0.fileName: readable, but the statement doesn\'t name "evidenceList"');
    expect(found.some((p) => p.startsWith('screen shows'))).toBe(true);
    const extraFile = await problems(r.sent, r.vault, r.privateKey, { ...r.saw, ticked: [] });
    expect(extraFile).toContain('files that open: [sunday-text.png], ticked: []');
    const leaked = await problems({ ...r.sent, consentStatement: `${r.sent.consentStatement}\n${fullRecord.survivor.legalName}` }, r.vault, r.privateKey, r.saw);
    expect(leaked).toContain(`the statement carries "${fullRecord.survivor.legalName}" from her account`);
  }, 60_000);

  it('two shares get different labels, neither of them her username', async () => {
    const a = await shareWithAttorney(minimalRecord, NONE, 'wren-label');
    cleanup();
    const b = await shareWithAttorney(minimalRecord, NONE, 'wren-label2');
    expect(a.sent.survivorAlias).toMatch(SHARE_ALIAS_RE);
    expect(b.sent.survivorAlias).toMatch(SHARE_ALIAS_RE);
    expect(a.sent.survivorAlias).not.toBe(b.sent.survivorAlias);
  }, 60_000);
});

describe('counselor release: what the counselor can decrypt is exactly what her consent says', () => {
  it.each([
    ['no files ticked', NONE],
    ['one file ticked', ONE],
    ['both uploaded files ticked', BOTH],
  ])('%s', async (_name, ticked) => {
    const r = await releaseToCounselor(ticked, `wren-rel-${ticked.length}`);
    expect(await problems(r.sent, r.vault, r.privateKey, r.saw)).toEqual([]);
  }, 60_000);
});
