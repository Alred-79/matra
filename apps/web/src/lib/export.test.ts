// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { deriveKeys, encryptBlob, encryptJSON, generateContentKey, newKdfSalt, sealSlot, sha256Hex, slotName, wrapKeyWithMaster } from '@matra/crypto';
import type { BlobMeta, VaultRecord } from '@matra/shared';
import { envelopeHash, type ApiClient } from '../api/client';
import { MatchingApiClient } from '../api/matching';
import { buildDataExport } from './export';
import { storedRecord, vaultApi } from '../test/fakeVault';
import { sampleRecord } from '../brief/fixtures';
import { briefSections } from '../brief';
import { buildExhibits, exhibitNumbersById } from '../evidence/exhibits';

/** Pull every file out of a STORE zip (central directory walk). */
function unzip(zip: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < v.getUint16(eocd + 10, true); i++) {
    const size = v.getUint32(p + 24, true);
    const n = v.getUint16(p + 28, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + n));
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    out.set(name, zip.subarray(start, start + size));
    p += 46 + n;
  }
  return out;
}

/** Sealed matching on or off for one test (the export reads __MATRA_MATCHING__ when it runs). */
const g = globalThis as { __MATRA_MATCHING__?: boolean };
const initial = g.__MATRA_MATCHING__;
afterEach(() => {
  g.__MATRA_MATCHING__ = initial;
});

describe('buildDataExport', () => {
  it.each([
    ['off', false, ['README.txt', 'records.json', 'draft.json', 'evidence/manifest.json', 'evidence/001-wrists.jpg', 'shares.json', 'activity.json']],
    ['on', true, ['README.txt', 'records.json', 'draft.json', 'evidence/manifest.json', 'evidence/001-wrists.jpg', 'escrow.json', 'shares.json', 'activity.json']],
  ])('decrypts every record and evidence file into one archive, with a verifiable manifest (matching %s)', async (_mode, on, names) => {
    g.__MATRA_MATCHING__ = on;
    const { masterKey } = await deriveKeys('export test passphrase', newKdfSalt(), 1000);
    const photo = new TextEncoder().encode('pretend-jpeg-bytes');
    const photoSha = await sha256Hex(photo);
    const blobKey = await generateContentKey();
    const blob: BlobMeta = {
      id: 'b'.repeat(32), ownerId: 'u', sizeBytes: 0, contentHash: 'x', createdAt: '2026-08-15T00:00:00Z',
      ledgerEntryId: 'l2', ownerWrappedKey: await wrapKeyWithMaster(blobKey, masterKey),
    };
    const blobCt = await encryptBlob(photo, blobKey);
    const record = { ...sampleRecord, evidence: [{ ...sampleRecord.evidence[1], blobId: blob.id, sha256: photoSha, fileName: 'wrists.jpg' }] };
    const stored = await storedRecord(masterKey, { kind: 'final', record, savedAt: '2026-08-19T00:00:00Z' }, { id: 'r'.repeat(32), createdAt: '2026-08-19T00:00:00Z' });
    const rec = stored.record;
    // her draft slot: what she is still adding to
    const slot = { name: await slotName(masterKey, 'draft'), ...(await sealSlot({ kind: 'draft', slotVersion: 1, draft: { answers: { 'about.name': 'Wren' } }, evidence: [], savedAt: '2026-09-01T00:00:00Z' }, masterKey)), version: '4'.repeat(32), updatedDay: '2026-09-01' };
    const fake = {
      listRecords: async () => ({ records: [rec] }),
      getRecord: async () => ({ record: rec }),
      getSlot: async () => ({ slot, draftMode: 'slot' }),
      getLedgerEntry: async () => ({ entry: stored.ledger }),
      listBlobs: async () => ({ blobs: [blob] }),
      downloadBlob: async () => blobCt,
      listEscrow: async () => ({ entries: [] }),
      listShares: async () => ({ shares: [] }),
      listAudit: async () => ({ events: [] }),
    };
    // a build with sealed matching has the matching client (lib/session.tsx); a pilot build has the plain one
    const api = (on ? Object.assign(Object.create(MatchingApiClient.prototype), fake) : fake) as ApiClient;

    const out = await buildDataExport(api, masterKey, 'bluebird', new Date('2026-10-07T12:00:00Z'));
    expect(out.fileName).toBe('matra-my-data-2026-10-07.zip');
    expect(out).toMatchObject({ recordCount: 1, evidenceCount: 1, problems: [] });
    const files = unzip(out.zip);
    expect([...files.keys()]).toEqual(names);
    const readme = new TextDecoder().decode(files.get('README.txt'));
    expect(readme).toMatch(/NOT encrypted/);
    // the README lists escrow.json only where the archive has one
    expect(readme.includes('escrow.json')).toBe(on);
    const records = JSON.parse(new TextDecoder().decode(files.get('records.json')));
    expect(records.records[0].payload.record.narrative.freeRecall).toBe(sampleRecord.narrative.freeRecall);
    expect(records.records[0].fingerprintVerified).toBe(true);
    expect(Array.from(files.get('evidence/001-wrists.jpg')!)).toEqual(Array.from(photo));
    const manifest = JSON.parse(new TextDecoder().decode(files.get('evidence/manifest.json')));
    expect(manifest.files[0]).toMatchObject({ fileName: 'wrists.jpg', sha256: photoSha, sha256Matches: true });
    expect(manifest.problems).toEqual([]);
    expect(records.unreadableRecords).toBe(0);
    const draft = JSON.parse(new TextDecoder().decode(files.get('draft.json')));
    expect(draft.draft).toMatchObject({ kind: 'draft', draft: { answers: { 'about.name': 'Wren' } }, savedAt: '2026-09-01T00:00:00Z', savedOnDay: '2026-09-01' });
    expect(readme).toMatch(/draft\.json\s+Your current draft/);
  });

  it('says in the manifest and the result what is left out, and whether it couldn’t be fetched or didn’t match (never a silently partial copy)', async () => {
    g.__MATRA_MATCHING__ = false; // not about sealed matching; a plain client, as in a pilot build
    const { masterKey } = await deriveKeys('export test passphrase', newKdfSalt(), 1000);
    const ok = await storedRecord(masterKey, { kind: 'final', record: sampleRecord, savedAt: '2026-08-19T00:00:00Z' }, { id: 'r'.repeat(32) });
    const lost = await storedRecord(masterKey, { kind: 'final', record: sampleRecord, savedAt: '2026-08-20T00:00:00Z' }, { id: 's'.repeat(32) });
    const changed = await storedRecord(masterKey, { kind: 'final', record: sampleRecord, savedAt: '2026-08-21T00:00:00Z' }, { id: 't'.repeat(32) });
    changed.record.contentHash = 'f'.repeat(64);
    const api = vaultApi([ok, lost, changed]);
    const get = api.getRecord.bind(api);
    Object.assign(api, {
      getRecord: async (id: string) => {
        if (id === lost.record.id) throw new Error('network');
        return get(id);
      },
      listBlobs: async () => ({ blobs: [] }),
      listShares: async () => ({ shares: [] }),
      listAudit: async () => ({ events: [] }),
    });

    const out = await buildDataExport(api, masterKey, 'bluebird', new Date('2026-10-07T12:00:00Z'));
    expect(out).toMatchObject({ recordCount: 1, unreadableRecords: 2, problems: [] });
    const files = unzip(out.zip);
    const manifest = JSON.parse(new TextDecoder().decode(files.get('evidence/manifest.json')));
    expect(manifest.problems).toEqual([
      `Saved version ${'s'.repeat(32)} could not be fetched just now and is not in records.json`,
      `Saved version ${'t'.repeat(32)} does not match its recorded fingerprint (SHA-256), so it is not in records.json`,
    ]);
    const records = JSON.parse(new TextDecoder().decode(files.get('records.json')));
    expect(records.unreadableRecords).toBe(2);
    expect(records.notIncluded).toEqual([
      { kind: 'unavailable', id: 's'.repeat(32) },
      { kind: 'integrity', reason: 'hash', id: 't'.repeat(32) },
    ]);
  });
});

describe('buildDataExport: the evidence reader’s lists', () => {
  it('adds the exhibit list and her private details (salt, original hash, text read), which verify a salted fingerprint', async () => {
    g.__MATRA_MATCHING__ = false;
    const { masterKey } = await deriveKeys('export reader test passphrase', newKdfSalt(), 1000);
    const bytes = new TextEncoder().encode('a stored copy');
    const blobKey = await generateContentKey();
    const blob: BlobMeta = { id: 'b'.repeat(32), ownerId: 'u', sizeBytes: 0, contentHash: 'x', createdAt: '2026-08-15T00:00:00Z', ledgerEntryId: 'l2', ownerWrappedKey: await wrapKeyWithMaster(blobKey, masterKey) };
    const blobCt = await encryptBlob(bytes, blobKey);
    const original = new TextEncoder().encode('the original');
    const originalSha = await sha256Hex(original);
    const salt = '5'.repeat(64);
    const raw = new Uint8Array(64);
    for (let i = 0; i < 32; i++) (raw[i] = parseInt(salt.slice(i * 2, i * 2 + 2), 16)), (raw[32 + i] = parseInt(originalSha.slice(i * 2, i * 2 + 2), 16));
    const commitment = await sha256Hex(raw);
    const item = { id: 'i1', kind: 'photo', fileName: 'wrists.jpg', mimeType: 'image/jpeg', sizeBytes: bytes.length, sha256: await sha256Hex(bytes), blobId: blob.id, metadataStripped: true };
    const draft = { name: await slotName(masterKey, 'draft'), ...(await sealSlot({ kind: 'draft', slotVersion: 1, evidence: [item], savedAt: '2026-09-01T00:00:00Z' }, masterKey)), version: '4'.repeat(32), updatedDay: '2026-09-01' };
    const priv = {
      name: await slotName(masterKey, 'evidence-private'),
      ...(await sealSlot({ kind: 'evidence-private', v: 1, savedAt: 'x', items: { i1: { originalSha256: originalSha, salt, commitment, importedAt: '2026-08-14T23:00:00.000Z', ocr: { text: 'Total $12.50', engine: 'tesseract', at: 'z' } } } }, masterKey)),
      version: '5'.repeat(32),
      updatedDay: '2026-09-01',
    };
    const fake = {
      listRecords: async () => ({ records: [] }),
      getRecord: async () => ({ record: undefined }),
      getSlot: async (name: string) => ({ slot: name === draft.name ? draft : name === priv.name ? priv : null, draftMode: 'slot' }),
      getLedgerEntry: async () => ({ entry: undefined }),
      listBlobs: async () => ({ blobs: [blob] }),
      downloadBlob: async () => blobCt,
      listShares: async () => ({ shares: [] }),
      listAudit: async () => ({ events: [] }),
    } as unknown as ApiClient;
    const built = await buildDataExport(fake, masterKey, 'bluebird', new Date('2026-10-07T12:00:00Z'));
    expect(built.evidenceCount).toBe(1); // the two lists are not evidence files
    const files = unzip(built.zip);
    const text = (n: string) => new TextDecoder().decode(files.get(n)!);
    expect(text('evidence/exhibit-list.csv')).toContain(`"1","wrists.jpg","2026-08-14T23:00:00.000Z","Photo (image/jpeg)"`);
    expect(text('evidence/exhibit-list.csv')).toContain(commitment);
    const details = JSON.parse(text('evidence/private-details.json')) as { files: Array<{ originalSha256: string; salt: string; saltedFingerprint: string; textRead: string }> };
    expect(details.files[0]).toMatchObject({ originalSha256: originalSha, salt, saltedFingerprint: commitment, textRead: 'Total $12.50' });
    expect(text('README.txt')).toContain('evidence/private-details.json');
    // a file whose details were never saved is listed as such, not left out
    expect(text('evidence/exhibit-list.csv')).not.toContain('(name not saved)');
    // the exhibit list (shareable) never holds the salt or the plain hash
    expect(text('evidence/exhibit-list.csv')).not.toContain(salt);
    expect(text('evidence/exhibit-list.csv')).not.toContain(originalSha);
  });
});


describe('one numbering: the screen, the export, the CSV and the PDF agree on every exhibit number', () => {
  it('with an unnamed file, an original whose link was never saved, and a redacted copy', async () => {
    g.__MATRA_MATCHING__ = false;
    const { masterKey } = await deriveKeys('numbering test passphrase', newKdfSalt(), 1000);
    const bytes = new TextEncoder().encode('stored');
    const makeBlob = async (id: string, createdAt: string, contentHash = 'x') => {
      const key = await generateContentKey();
      return { blob: { id, ownerId: 'u', sizeBytes: 0, contentHash, createdAt, ledgerEntryId: `l-${id}`, ownerWrappedKey: await wrapKeyWithMaster(key, masterKey) } as BlobMeta, ct: await encryptBlob(bytes, key) };
    };
    const PENDING = 'd'.repeat(64);
    const made = [
      await makeBlob('1'.repeat(32), '2026-08-01T00:00:00Z'), // unnamed: another device saved its draft first
      await makeBlob('2'.repeat(32), '2026-08-02T00:00:00Z'), // receipt
      await makeBlob('3'.repeat(32), '2026-08-02T00:00:01Z', PENDING), // its original: uploaded, link never saved
      await makeBlob('4'.repeat(32), '2026-08-03T00:00:00Z'), // redacted copy of the receipt
    ];
    const mk = async (id: string, fileName: string, blobId: string) => ({ id, kind: 'photo', fileName, mimeType: 'image/png', sizeBytes: bytes.length, sha256: await sha256Hex(bytes), blobId, metadataStripped: true });
    const items = [await mk('iA', 'receipt.png', made[1]!.blob.id), await mk('iB', 'Redacted copy of exhibit 1 - receipt.png', made[3]!.blob.id)];
    const privItems = { iA: { commitment: 'a'.repeat(64), originalPending: { ciphertextSha256: PENDING } }, iB: { commitment: 'b'.repeat(64), derivedFrom: 'iA' } };
    const draft = { name: await slotName(masterKey, 'draft'), ...(await sealSlot({ kind: 'draft', slotVersion: 1, evidence: items, savedAt: '2026-09-01T00:00:00Z' }, masterKey)), version: '4'.repeat(32), updatedDay: '2026-09-01' };
    const priv = { name: await slotName(masterKey, 'evidence-private'), ...(await sealSlot({ kind: 'evidence-private', v: 1, savedAt: 'x', items: privItems }, masterKey)), version: '5'.repeat(32), updatedDay: '2026-09-01' };
    const blobs = made.map((m) => m.blob);
    const fake = {
      listRecords: async () => ({ records: [] }),
      getRecord: async () => ({ record: undefined }),
      getSlot: async (name: string) => ({ slot: name === draft.name ? draft : name === priv.name ? priv : null, draftMode: 'slot' }),
      getLedgerEntry: async () => ({ entry: undefined }),
      listBlobs: async () => ({ blobs }),
      downloadBlob: async (id: string) => made.find((m) => m.blob.id === id)!.ct,
      listShares: async () => ({ shares: [] }),
      listAudit: async () => ({ events: [] }),
    } as unknown as ApiClient;

    // the screen: buildExhibits over the same blobs, items and private details (screens/Evidence.tsx)
    const onScreen = buildExhibits(blobs, items as never, privItems as never);
    expect(onScreen.map((e) => [e.number, e.id])).toEqual([[1, 'iA'], [2, 'iB']]);
    expect(onScreen[1]!.redactedCopyOf).toBe(1);

    // the export and its CSV
    const files = unzip((await buildDataExport(fake, masterKey, 'bluebird', new Date('2026-10-07T12:00:00Z'))).zip);
    const text = (n: string) => new TextDecoder().decode(files.get(n)!);
    const csvRows = text('evidence/exhibit-list.csv').trimEnd().split('\r\n').slice(1);
    expect(csvRows.map((r) => r.split('","')[0]!.replace(/^"/, ''))).toEqual(onScreen.map((e) => String(e.number)));
    expect(csvRows).toHaveLength(2);
    expect(csvRows[1]).toContain('Redacted copy of exhibit 1');
    const details = JSON.parse(text('evidence/private-details.json')) as { files: Array<{ exhibit: number; fileName: string; redactedCopyOf?: number }> };
    expect(details.files.map((f) => f.exhibit)).toEqual(onScreen.map((e) => e.number));
    expect(details.files[1]!.redactedCopyOf).toBe(1); // points at the receipt, exhibit 1, whatever else is in the archive
    // the unnamed file takes no number and is kept apart; the unlinked original is named as the original it is
    expect([...files.keys()].filter((n) => n.startsWith('evidence/unattributed/'))).toEqual([`evidence/unattributed/001-${'1'.repeat(32)}.bin`]);
    expect([...files.keys()].some((n) => n.endsWith('original-of-receipt.png'))).toBe(true);
    expect(text('evidence/exhibit-list.csv')).not.toContain('name not saved');
    const manifest = JSON.parse(text('evidence/manifest.json')) as { files?: Array<{ blobId: string; attributedToAFile?: boolean }> } | Array<{ blobId: string; attributedToAFile?: boolean }>;
    const entries = Array.isArray(manifest) ? manifest : (manifest.files ?? []);
    expect(entries.filter((m) => m.attributedToAFile === false).map((m) => m.blobId)).toEqual(['1'.repeat(32)]);

    // the PDF: its "#" column is the same number for the same file
    const sections = briefSections({ ...sampleRecord, evidence: [items[1]!, items[0]!] as never }, { exhibitNumbers: exhibitNumbersById(onScreen) });
    const table = sections.find((s) => s.id === 'evidence')!.blocks.find((b) => b.kind === 'table') as { rows: Array<{ cells: string[] }> };
    expect(table.rows.map((r) => [r.cells[0], r.cells[1]])).toEqual(onScreen.map((e) => [String(e.number), e.fileName]));
  });
});
