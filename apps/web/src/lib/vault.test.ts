import { describe, expect, it, onTestFinished } from 'vitest';
import type { EvidenceItem, IntakeRecord } from '@matra/shared';
import type { ApiClient } from '../api/client';
import { draftToRecord, emptyDraft } from '../intake';
import { DEFAULT_KDF_ITERATIONS, decryptJSON, deriveKeys, encryptJSON, generateContentKey, newKdfSalt, unwrapKeyWithMaster, wrapKeyWithMaster } from '@matra/crypto';
import { foldInLateEvidence, isCleanFinal, loadVault, resumeFrom, sealPayload, unreadableNotice, type OpenedRecord, type VaultPayload } from './vault';
import type { WorkingData } from './session';
import type { LoadedDraftSlot } from './draftSlot';

/** A record as an earlier version of the app wrote it (before draft slots), straight through the API. */
async function legacyRecord(api: ApiClient, masterKey: CryptoKey, payload: VaultPayload, supersedes?: string) {
  const key = await generateContentKey();
  return api.createRecord({ envelope: await encryptJSON(payload, key), ownerWrappedKey: await wrapKeyWithMaster(key, masterKey), supersedes });
}

const file = (blobId: string): EvidenceItem => ({
  id: `e-${blobId}`,
  kind: 'photo',
  fileName: `${blobId}.jpg`,
  mimeType: 'image/jpeg',
  sizeBytes: 3,
  sha256: '0'.repeat(64),
  blobId,
  metadataStripped: true,
});

describe('loadVault: records that fail to open are counted, not dropped silently', () => {
  it('reports how many saved versions could not be opened, so a resumed draft is never silently an older one', async () => {
    const { masterKey } = await deriveKeys('vault test passphrase words', newKdfSalt(), Math.min(DEFAULT_KDF_ITERATIONS, 1000));
    const records: any[] = [];
    const api = {
      async createRecord(req: any) {
        const rec = { id: `r${records.length + 1}`, ownerId: 'u1', supersedes: req.supersedes, contentHash: 'h',
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, records.length)).toISOString(), ledgerEntryId: 'l', envelope: req.envelope, ownerWrappedKey: req.ownerWrappedKey };
        records.push(rec);
        return { record: rec, ledgerEntry: { seq: records.length, timestamp: rec.createdAt } };
      },
      async listRecords() {
        return { records };
      },
      async getRecord(id: string) {
        if (id === 'r2') throw new Error('network');
        const r = records.find((x) => x.id === id);
        // r3's ciphertext was damaged: it no longer decrypts
        return { record: id === 'r3' ? { ...r, envelope: { ...r.envelope, ct: r.envelope.ct.slice(0, -8) + 'AAAAAAA=' } } : r };
      },
    } as unknown as ApiClient;
    const draft = (n: number) => ({ answers: { n } }) as unknown as NonNullable<WorkingData['draft']>;
    // drafts saved as records, as every autosave was before draft slots
    const first = await legacyRecord(api, masterKey, { kind: 'draft', draft: draft(1), savedAt: '2026-01-01T00:00:00Z' });
    const second = await legacyRecord(api, masterKey, { kind: 'draft', draft: draft(2), savedAt: '2026-01-01T00:01:00Z' }, first.record.id);
    await legacyRecord(api, masterKey, { kind: 'draft', draft: draft(3), savedAt: '2026-01-01T00:02:00Z' }, second.record.id);

    const vault = await loadVault(api, masterKey, { withLedger: false });
    expect(vault.map((r) => r.meta.id)).toEqual(['r1']);
    expect(vault.unreadable).toBe(2);
    // what she would resume from is the oldest version: the screen must say so
    expect(resumeFrom(null, vault).draft).toEqual(draft(1));
    expect(unreadableNotice(vault.unreadable)).toMatch(/couldn’t open 2 saved versions.*may not be your newest save/);
    expect(unreadableNotice(1)).toMatch(/one saved version/);
    expect(unreadableNotice(0)).toBeNull();
  });
});

describe('foldInLateEvidence', () => {
  const draft = { answers: { mine: true } } as unknown as WorkingData['draft'];
  const story: WorkingData = { draft, evidence: [file('a')], slotSeq: 1 };

  it('adds files saved after the story opened, keeps her draft, and follows the newer slot save', () => {
    const mem: WorkingData = { draft: null, evidence: [file('a'), file('b')], slotSeq: 2 };
    const next = foldInLateEvidence(story, mem)!;
    expect(next.evidence.map((e) => e.blobId)).toEqual(['a', 'b']);
    expect(next.draft).toBe(draft);
    expect(next.slotSeq).toBe(2);
  });

  it('returns null when nothing is new (including the story’s own saves)', () => {
    expect(foldInLateEvidence(story, null)).toBeNull();
    expect(foldInLateEvidence(story, { ...story, slotSeq: 9 })).toBeNull();
    expect(foldInLateEvidence(story, { draft: null, evidence: [] })).toBeNull();
  });

  it('never drops a file the story has that the in-memory copy lacks', () => {
    const mem: WorkingData = { draft: null, evidence: [file('c')] };
    const next = foldInLateEvidence(story, mem)!;
    expect(next.evidence.map((e) => e.blobId)).toEqual(['a', 'c']);
    expect(next.slotSeq).toBe(1);
  });
});

/** An in-memory records API: enough for sealPayload and loadVault. */
function recordsApi() {
  const records: any[] = [];
  const api = {
    async createRecord(req: any) {
      const rec = { id: `r${records.length + 1}`, ownerId: 'u1', supersedes: req.supersedes, contentHash: 'h',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, records.length)).toISOString(), ledgerEntryId: 'l', envelope: req.envelope, ownerWrappedKey: req.ownerWrappedKey };
      records.push(rec);
      return { record: rec, ledgerEntry: { seq: records.length, timestamp: rec.createdAt } };
    },
    async listRecords() {
      return { records };
    },
    async getRecord(id: string) {
      return { record: records.find((x) => x.id === id) };
    },
  } as unknown as ApiClient;
  return { api, records };
}

const keys = () => deriveKeys('seal only the record', newKdfSalt(), 1000);

describe('sealPayload: a sealed account holds only the record', () => {
  it('a sealed final decrypts to exactly kind, record and savedAt, even if a caller passes more', async () => {
    const { masterKey } = await keys();
    const { api, records } = recordsApi();
    const record = draftToRecord(emptyDraft());
    const extra = { kind: 'final', record, savedAt: '2026-02-01T00:00:00Z', draft: emptyDraft(), escrowedHashes: ['ab'], evidence: [] };
    await sealPayload(api, masterKey, extra as unknown as Parameters<typeof sealPayload>[2]);
    const sent = records[0];
    const plaintext = await decryptJSON<Record<string, unknown>>(sent.envelope, await unwrapKeyWithMaster(sent.ownerWrappedKey, masterKey));
    expect(Object.keys(plaintext).sort()).toEqual(['kind', 'record', 'savedAt']);
    expect(plaintext).toEqual({ kind: 'final', record, savedAt: '2026-02-01T00:00:00Z' });
  });

  it('never seals a draft as a record (drafts go to the draft slot)', async () => {
    const { masterKey } = await keys();
    const { api, records } = recordsApi();
    const draft = { kind: 'draft', draft: emptyDraft(), savedAt: 'x' } as unknown as Parameters<typeof sealPayload>[2];
    await expect(sealPayload(api, masterKey, draft)).rejects.toThrow(/draft slot/);
    expect(records).toHaveLength(0);
  });

  it('isCleanFinal: only {kind, record, savedAt} may be shared; a legacy final with her draft may not', () => {
    const record = draftToRecord(emptyDraft());
    expect(isCleanFinal({ kind: 'final', record, savedAt: 'x' })).toBe(true);
    expect(isCleanFinal({ kind: 'final', record, savedAt: 'x', draft: emptyDraft() })).toBe(false);
    expect(isCleanFinal({ kind: 'final', record, savedAt: 'x', escrowedHashes: [] })).toBe(false);
    expect(isCleanFinal({ kind: 'draft', savedAt: 'x' })).toBe(false);
    expect(isCleanFinal({ kind: 'final', savedAt: 'x' })).toBe(false);
  });
});

describe('resumeFrom: her draft slot first, then (no slot yet) the records saved before slots', () => {
  const opened = (id: string, createdAt: string, payload: VaultPayload): OpenedRecord =>
    ({ meta: { id, createdAt } as OpenedRecord['meta'], payload, key: {} as CryptoKey, verified: true }) as OpenedRecord;
  const d = (n: number) => ({ ...emptyDraft(), answers: { n: String(n) } }) as unknown as NonNullable<WorkingData['draft']>;
  const record = draftToRecord(emptyDraft());
  const slot = (value: Partial<LoadedDraftSlot['value']>): LoadedDraftSlot => ({
    value: { kind: 'draft', slotVersion: 1, evidence: [], savedAt: '2026-03-01T00:00:00Z', ...value },
    seq: 3,
    updatedDay: '2026-03-01',
  });

  it('resumes from the slot after a seal, so she can add to the sealed version later', () => {
    const final = opened('f1', '2026-02-01T00:00:00Z', { kind: 'final', record, savedAt: 'x' });
    const r = resumeFrom(slot({ draft: d(7), evidence: [file('a')], sealedRecordId: 'f1' }), [final]);
    expect(r).toMatchObject({ from: 'slot', draft: d(7), final });
    expect(r.evidence.map((e) => e.blobId)).toEqual(['a']);
  });

  it('with no slot: a legacy draft record newer than the seal, else the answers a legacy seal kept', () => {
    const legacyFinal = opened('f1', '2026-02-01T00:00:00Z', { kind: 'final', record, draft: d(1), escrowedHashes: ['h1'], savedAt: 'x' });
    const newerDraft = opened('d1', '2026-02-02T00:00:00Z', { kind: 'draft', draft: d(2), evidence: [file('b')], savedAt: 'x' });
    expect(resumeFrom(null, [newerDraft, legacyFinal])).toMatchObject({ from: 'legacy', draft: d(2) });
    expect(resumeFrom(null, [legacyFinal])).toMatchObject({ from: 'legacy', draft: d(1) });
    expect(resumeFrom(null, [])).toMatchObject({ from: 'none', draft: undefined, evidence: [], escrowedHashes: [] });
  });

  it('without sealed matching, drops the matching answers and fingerprints an earlier build saved', () => {
    const g = globalThis as { __MATRA_MATCHING__?: boolean };
    const was = g.__MATRA_MATCHING__;
    g.__MATRA_MATCHING__ = false;
    onTestFinished(() => void (g.__MATRA_MATCHING__ = was));
    const withMatching = { ...d(1), answers: { 'person.escrow': { p1: 'yes' }, 'person.matchContact': { method: 'text', detail: '555-0100' }, 'about.name': 'J' } } as unknown as NonNullable<WorkingData['draft']>;
    const legacyFinal = opened('f1', '2026-02-01T00:00:00Z', { kind: 'final', record, draft: withMatching, escrowedHashes: ['h1'], savedAt: 'x' });
    for (const r of [resumeFrom(null, [legacyFinal]), resumeFrom(slot({ draft: withMatching, escrowedHashes: ['h2'] }), [legacyFinal])]) {
      expect(Object.keys(r.draft!.answers)).toEqual(['about.name']);
      expect(r.escrowedHashes).toEqual([]);
    }
  });

  it('with sealed matching on, keeps them: fingerprints from the slot, or (no slot yet) from a legacy seal', () => {
    const g = globalThis as { __MATRA_MATCHING__?: boolean };
    const was = g.__MATRA_MATCHING__;
    g.__MATRA_MATCHING__ = true;
    onTestFinished(() => void (g.__MATRA_MATCHING__ = was));
    const legacyFinal = opened('f1', '2026-02-01T00:00:00Z', { kind: 'final', record, draft: d(1), escrowedHashes: ['h1'], savedAt: 'x' });
    expect(resumeFrom(null, [legacyFinal]).escrowedHashes).toEqual(['h1']);
    expect(resumeFrom(slot({ draft: d(2), escrowedHashes: ['h2'] }), [legacyFinal]).escrowedHashes).toEqual(['h2']);
    expect(resumeFrom(slot({ draft: d(2) }), [legacyFinal]).escrowedHashes).toEqual(['h1']);
  });
});
