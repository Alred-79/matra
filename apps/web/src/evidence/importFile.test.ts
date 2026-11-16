import { afterEach, describe, expect, it, vi } from 'vitest';
import { sealSlot, sha256Hex, slotName } from '@matra/crypto';
import { setDraftMode } from '../lib/draftSlot';
import { commit, hashOriginal, isHex64, newSalt, verifyCommitment, verifyOriginal } from './commitment';
import { importEvidence } from './importFile';
import { EVIDENCE_PRIVATE_SLOT, loadPrivate } from './privateStore';
import { everythingSent, fakeApi, testKeys } from './testkit.test-util';

vi.mock('../lib/metadata', async (orig) => {
  const real = await orig<typeof import('../lib/metadata')>();
  return {
    ...real,
    // jsdom has no createImageBitmap: stand in for the canvas re-encode (JPEG/PNG/WebP become different bytes, no metadata)
    stripMetadata: async (file: Blob & { type: string }) => {
      if (!real.canStrip(file.type)) return { blob: file, stripped: false, note: real.adviceFor(file.type) };
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { blob: new Blob([bytes.subarray(0, Math.max(8, bytes.length - 5)), new Uint8Array([9, 9])], { type: file.type }), stripped: true, note: 'removed' };
    },
  };
});

afterEach(() => setDraftMode('slot'));

const file = (bytes: Uint8Array, name: string, type: string) => new File([bytes as BlobPart], name, { type });
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** A PNG header with IHDR of this size and nothing else: enough for the size reader. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv = new DataView(b.buffer);
  dv.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b;
}

describe('commitment', () => {
  it('is SHA-256(salt || hash), 64 hex, different for another salt, and not the plain hash', async () => {
    const h = await hashOriginal(rand(50));
    const s1 = newSalt();
    const s2 = newSalt();
    const c = await commit(s1, h);
    expect(isHex64(c)).toBe(true);
    expect(c).not.toBe(h);
    expect(await commit(s2, h)).not.toBe(c);
    expect(await verifyCommitment(s1, h, c)).toBe(true);
    expect(await verifyCommitment(s2, h, c)).toBe(false);
    await expect(commit('zz', h)).rejects.toThrow();
    // the documented recomputation: sha256 of the 32 salt bytes then the 32 hash bytes
    const raw = new Uint8Array(64);
    for (let i = 0; i < 32; i++) (raw[i] = parseInt(s1.slice(i * 2, i * 2 + 2), 16)), (raw[32 + i] = parseInt(h.slice(i * 2, i * 2 + 2), 16));
    expect(await sha256Hex(raw)).toBe(c);
  });
});

describe('importing a file (PR 31)', () => {
  it('the server never sees the plain hash, the salt or the file; it gets only the commitment; and she can verify with the salt', async () => {
    const { masterKey } = await testKeys();
    const { api, slots, uploads } = fakeApi();
    const original = rand(400);
    const res = await importEvidence(api, masterKey, file(original, 'photo.jpg', 'image/jpeg'));
    const plain = await hashOriginal(original);
    const copyHash = res.item.sha256;
    expect(copyHash).not.toBe(plain); // the cleaned copy is not the original

    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.commitment).toMatch(/^[0-9a-f]{64}$/);
    const sent = everythingSent(uploads, slots);
    const priv = (await loadPrivate(api, masterKey)).value.items[res.item.id]!;
    for (const secret of [plain, priv.salt!, hex(original)]) expect(sent).not.toContain(secret);
    expect(sent).toContain(uploads[0]!.commitment);
    // the slot is opaque: the server sees an envelope, not the details
    expect(sent).not.toContain(res.item.fileName);

    // she can verify: her private slot holds the salt and the plain hash
    expect(priv.originalSha256).toBe(plain);
    expect(priv.commitment).toBe(uploads[0]!.commitment);
    expect(await verifyCommitment(priv.salt!, priv.originalSha256!, uploads[0]!.commitment!)).toBe(true);
    expect(await verifyOriginal(priv.salt!, original, uploads[0]!.commitment!)).toBe(true);
    expect(await verifyOriginal(priv.salt!, rand(400), uploads[0]!.commitment!)).toBe(false);
    expect(await verifyOriginal(newSalt(), original, uploads[0]!.commitment!)).toBe(false);
    // the item itself (which goes into her draft and sealed record) carries neither the salt nor the original hash
    expect(JSON.stringify(res.item)).not.toContain(priv.salt!);
    expect(JSON.stringify(res.item)).not.toContain(plain);
  });

  it('the same file added twice gets two different commitments', async () => {
    const { masterKey } = await testKeys();
    const { api, uploads } = fakeApi();
    const bytes = rand(100);
    await importEvidence(api, masterKey, file(bytes, 'a.pdf', 'application/pdf'));
    await importEvidence(api, masterKey, file(bytes, 'a.pdf', 'application/pdf'));
    expect(uploads[0]!.commitment).not.toBe(uploads[1]!.commitment);
  });

  it('only JPEG, PNG and WebP are stripped; everything else is stored as it is, with a plain warning', async () => {
    const { masterKey } = await testKeys();
    const { api } = fakeApi();
    for (const [type, name, stripped] of [
      ['image/jpeg', 'a.jpg', true],
      ['image/png', 'a.png', true],
      ['image/webp', 'a.webp', true],
      ['image/heic', 'a.heic', false],
      ['video/mp4', 'a.mp4', false],
      ['audio/mpeg', 'a.mp3', false],
      ['application/pdf', 'a.pdf', false],
      ['text/plain', 'a.txt', false],
    ] as const) {
      const bytes = rand(64);
      const r = await importEvidence(api, masterKey, file(bytes, name, type));
      expect(r.item.metadataStripped, type).toBe(stripped);
      if (stripped) expect(r.warning, type).toBeNull();
      else {
        expect(r.warning, type).toMatch(/Hidden details were not removed from this file/);
        // stored exactly as chosen: the hash of what is kept is the hash of the original
        expect(r.item.sha256).toBe(await hashOriginal(bytes));
      }
    }
  });

  it('flags a screenshot by name, or by a screen size with no camera data; not a photo with camera data', async () => {
    const { masterKey } = await testKeys();
    const { api } = fakeApi();
    const byName = await importEvidence(api, masterKey, file(rand(60), 'Screenshot 2026-03-03 at 10.12.04.png', 'image/png'));
    expect(byName.item.kind).toBe('screenshot');
    expect(byName.details?.screenshotLikely).toBe(true);
    const bySize = await importEvidence(api, masterKey, file(png(1170, 2532), 'IMG_0042.PNG', 'image/png'));
    expect(bySize.item.kind).toBe('screenshot');
    const odd = await importEvidence(api, masterKey, file(png(1234, 987), 'IMG_0043.PNG', 'image/png'));
    expect(odd.item.kind).toBe('photo');
    expect(odd.details?.screenshotLikely).toBeUndefined();
    const doc = await importEvidence(api, masterKey, file(rand(60), 'Screenshot.pdf', 'application/pdf'));
    expect(doc.item.kind).toBe('document'); // only images are labelled
  });

  it('keeping the original is off by default, opt-in, only when it differs from the copy, and is a second encrypted file', async () => {
    const { masterKey } = await testKeys();
    const { api, uploads } = fakeApi();
    const off = await importEvidence(api, masterKey, file(rand(200), 'a.jpg', 'image/jpeg'));
    expect(uploads).toHaveLength(1);
    expect(off.details?.originalBlobId).toBeUndefined();

    const on = await importEvidence(api, masterKey, file(rand(200), 'b.jpg', 'image/jpeg'), { keepOriginal: true });
    expect(uploads).toHaveLength(3); // the original, then the copy
    expect(on.details?.originalBlobId).toBe(String(2).padStart(32, '0'));
    expect(uploads[1]!.commitment).toBeUndefined(); // only the copy carries the commitment

    // a type that is stored as-is has no separate original to keep
    const pdf = await importEvidence(api, masterKey, file(rand(80), 'c.pdf', 'application/pdf'), { keepOriginal: true });
    expect(uploads).toHaveLength(4);
    expect(pdf.details?.originalBlobId).toBeUndefined();
  });

  it('when the server keeps every draft save for good, nothing private is written and no commitment is made', async () => {
    const { masterKey } = await testKeys();
    const { api, uploads, slotPuts } = fakeApi('keep-versions');
    const r = await importEvidence(api, masterKey, file(rand(100), 'a.jpg', 'image/jpeg'), { keepOriginal: true });
    expect(slotPuts).toHaveLength(0);
    expect(uploads).toHaveLength(1); // no original kept either
    expect(uploads[0]!.commitment).toBeUndefined();
    expect(r.privateNote).toMatch(/keeps every save permanently/);
    expect(r.details).toBeNull();
    expect(r.item.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('an original she asked to keep that could not be kept is never dropped silently', () => {
    const NOT_KEPT = /Your original was NOT kept here either, so please keep it on your device/;

    it('when the server keeps every draft save for good', async () => {
      const { masterKey } = await testKeys();
      const { api, uploads } = fakeApi('keep-versions');
      const r = await importEvidence(api, masterKey, file(rand(100), 'a.jpg', 'image/jpeg'), { keepOriginal: true });
      expect(uploads).toHaveLength(1);
      expect(r.privateNote).toMatch(NOT_KEPT);
    });

    it('when her private slot is stored but does not open', async () => {
      const { masterKey } = await testKeys();
      const { api, slots, uploads } = fakeApi();
      const name = await slotName(masterKey, EVIDENCE_PRIVATE_SLOT);
      slots.set(name, { name, ...(await sealSlot({ kind: 'something-else' }, masterKey)), version: '9'.repeat(32), updatedDay: 'd' });
      const r = await importEvidence(api, masterKey, file(rand(100), 'a.jpg', 'image/jpeg'), { keepOriginal: true });
      expect(uploads).toHaveLength(1);
      expect(r.privateNote).toMatch(NOT_KEPT);
      expect(r.details).toBeNull();
    });

    it('when saving the private details fails: no commitment, no original, and she is told', async () => {
      const { masterKey } = await testKeys();
      const { api, uploads } = fakeApi();
      (api as unknown as { putSlot: () => Promise<never> }).putSlot = async () => Promise.reject(new Error('server said no'));
      const r = await importEvidence(api, masterKey, file(rand(100), 'a.jpg', 'image/jpeg'), { keepOriginal: true });
      expect(uploads).toHaveLength(1);
      expect(uploads[0]!.commitment).toBeUndefined();
      expect(r.privateNote).toMatch(NOT_KEPT);
      expect(r.details).toBeNull();
    });

    it('when the original itself fails to upload: the file and its fingerprint stand, she is told, and no original is offered', async () => {
      const { masterKey } = await testKeys();
      const { api, uploads } = fakeApi();
      const real = api.uploadBlob.bind(api);
      let n = 0;
      (api as unknown as { uploadBlob: typeof real }).uploadBlob = async (ct, wk, c) => {
        if (++n === 1) throw new Error('upload failed');
        return real(ct, wk, c);
      };
      const r = await importEvidence(api, masterKey, file(rand(100), 'a.jpg', 'image/jpeg'), { keepOriginal: true });
      expect(uploads).toHaveLength(1);
      expect(r.privateNote).toMatch(NOT_KEPT);
      expect(r.details?.originalBlobId).toBeUndefined();
      expect(r.details?.commitment).toBe(uploads[0]!.commitment);
    });

    it('says nothing about an original she did not ask to keep, or one that is kept as it is anyway', async () => {
      const { masterKey } = await testKeys();
      const { api } = fakeApi('keep-versions');
      expect((await importEvidence(api, masterKey, file(rand(100), 'a.jpg', 'image/jpeg'))).privateNote).not.toMatch(NOT_KEPT);
      expect((await importEvidence(api, masterKey, file(rand(100), 'a.pdf', 'application/pdf'), { keepOriginal: true })).privateNote).not.toMatch(NOT_KEPT);
    });
  });
});
