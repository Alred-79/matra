/**
 * Adding a file (PR 31): everything that happens on her device before anything is sent.
 *
 *   1. hash her ORIGINAL bytes (before stripping) and make a salted commitment to that hash (./commitment.ts)
 *   2. read what the file says about itself (size in pixels, camera fields) and flag a likely screenshot (./screenshot.ts)
 *   3. strip hidden details if the type can be stripped (JPEG, PNG, WebP only: lib/metadata.ts), hash the copy
 *   4. if she chose to keep the original and it differs from the copy: encrypt it as a second file (off by default)
 *   5. save the plain hash and the salt in her PRIVATE evidence slot, then encrypt the copy and upload it with ONLY the
 *      commitment (the plain hash and the salt never leave her device unencrypted)
 *
 * It does not interpret the file: no caption, no objects, no faces.
 */
import { encryptBlob, generateContentKey, randomId, wrapKeyWithMaster } from '@matra/crypto';
import type { EvidenceItem, EvidenceKind, LedgerEntry } from '@matra/shared';
import type { ApiClient } from '../api/client';
import { mirror } from '../dev/mirror';
import { stripMetadata } from '../lib/metadata';
import { commit, hashOriginal, newSalt } from './commitment';
import { unstrippedWarning } from './formats';
import { readImageFacts } from './imageFacts';
import { loadPrivate, setPrivateItem, type PrivateItem } from './privateStore';
import { currentDraftMode } from '../lib/draftSlot';
import { screenshotSignals } from './screenshot';
import { DATES_FOUND_IN_BUILD } from './datesFlag';

export function evidenceKindFor(file: { type: string; name: string }, screenshotLikely = false): EvidenceKind {
  const t = file.type.toLowerCase();
  if (t.startsWith('image/')) return screenshotLikely || /screen\s?shot|screen_shot|screenshot/i.test(file.name) ? 'screenshot' : 'photo';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t === 'application/pdf' || t.startsWith('text/') || t.includes('document')) return 'document';
  return 'other';
}

export interface ImportOptions {
  description?: string;
  capturedAt?: string;
  /** keep her original (with its hidden details) as a second encrypted file. Off unless she turns it on. */
  keepOriginal?: boolean;
  /** this file is a copy made from another exhibit (a redacted copy): the exhibit's id */
  derivedFrom?: string;
}

export interface UploadedEvidence {
  item: EvidenceItem;
  /** what is kept privately about it (commitment, screenshot label, whether the original was kept); null if nothing was */
  details: PrivateItem | null;
  /** stripped plaintext, for an in-memory preview only */
  plaintext: Blob;
  note: string;
  /** set when the file was NOT cleaned: what was kept, in plain words */
  warning: string | null;
  /** set when the private details (original fingerprint, salt) could not be kept, and so no commitment was made */
  privateNote: string | null;
  ledgerEntry: LedgerEntry;
  commitmentEntry?: LedgerEntry;
}

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

async function encryptForUpload(bytes: Uint8Array, masterKey: CryptoKey) {
  const key = await generateContentKey();
  return { ct: await encryptBlob(bytes, key), wrapped: await wrapKeyWithMaster(key, masterKey) };
}

export async function importEvidence(api: ApiClient, masterKey: CryptoKey, file: File, opts: ImportOptions = {}): Promise<UploadedEvidence> {
  const originalBytes = await bytesOf(file);
  const originalSha256 = await hashOriginal(originalBytes);
  const facts = file.type.toLowerCase().startsWith('image/') ? readImageFacts(originalBytes) : null;
  const shot = screenshotSignals({ fileName: file.name, mimeType: file.type || '', width: facts?.width, height: facts?.height, hasCameraData: facts?.hasCameraData ?? false });

  const { blob, stripped, note } = await stripMetadata(file);
  const bytes = stripped ? await bytesOf(blob) : originalBytes;
  const sha256 = await hashOriginal(bytes);

  // Can her private details be kept? (not when the server keeps every slot write as a permanent record, nor when the slot
  // she has does not open). If not, no commitment is made: a commitment she could never open is worth nothing.
  let privateNote: string | null = null;
  try {
    const cur = await loadPrivate(api, masterKey);
    if (cur.unreadable) privateNote = 'We couldn’t open the extra details saved about your files, so no private fingerprint of this file’s original was kept.';
    else if (currentDraftMode() === 'keep-versions') privateNote = 'This copy of Matra keeps every save permanently, so it does not keep a private fingerprint of the original file.';
  } catch {
    privateNote = 'We couldn’t reach your saved details just now, so no private fingerprint of this file’s original was kept.';
  }

  const id = randomId();
  const salt = privateNote ? undefined : newSalt();
  const commitment = salt ? await commit(salt, originalSha256) : undefined;
  const keepOriginal = !!opts.keepOriginal && !!salt && stripped && sha256 !== originalSha256;

  mirror(
    'Evidence file',
    `${file.name} (${bytes.byteLength} bytes${stripped ? ', location and camera data removed here' : ''})`,
    `Encrypted here. The server gets the ciphertext and a scrambled (salted) commitment, never the file's plain hash or its name.`,
  );

  let originalBlobId: string | undefined;
  if (keepOriginal) {
    const e = await encryptForUpload(originalBytes, masterKey);
    originalBlobId = (await api.uploadBlob(e.ct, e.wrapped)).blob.id;
  }
  const importedAt = new Date().toISOString();
  let priv: PrivateItem | null = null;
  if (salt) {
    priv = {
      originalSha256,
      salt,
      ...(commitment && { commitment }),
      originalSize: originalBytes.byteLength,
      originalType: file.type || 'application/octet-stream',
      importedAt,
      ...(shot.likely && { screenshotLikely: true }),
      // the original's own date strings, only in a build with "dates found in your files" (off by default)
      ...(DATES_FOUND_IN_BUILD && facts?.exifDates.length && { metadataDates: facts.exifDates }),
      ...(originalBlobId && { originalBlobId }),
      ...(opts.derivedFrom && { derivedFrom: opts.derivedFrom }),
    };
    try {
      await setPrivateItem(api, masterKey, id, priv);
    } catch (e) {
      // not saved: do not commit to something she could not open
      priv = null;
      return finish(undefined, `We couldn’t save the private fingerprint of this file’s original (${(e as Error).message}). The file itself is added.`);
    }
  }
  return finish(commitment, privateNote);

  async function finish(c: string | undefined, pn: string | null): Promise<UploadedEvidence> {
    const e = await encryptForUpload(bytes, masterKey);
    const res = await api.uploadBlob(e.ct, e.wrapped, c);
    const item: EvidenceItem = {
      id,
      kind: evidenceKindFor(file, shot.likely),
      fileName: file.name,
      mimeType: blob.type || file.type || 'application/octet-stream',
      sizeBytes: bytes.byteLength,
      sha256,
      blobId: res.blob.id,
      description: opts.description || undefined,
      capturedAt: opts.capturedAt || undefined,
      metadataStripped: stripped,
    };
    return {
      item,
      details: priv,
      plaintext: new Blob([bytes as BlobPart], { type: item.mimeType }),
      note,
      warning: unstrippedWarning(item.mimeType, stripped),
      privateNote: pn,
      ledgerEntry: res.ledgerEntry,
      ...(res.commitmentEntry && { commitmentEntry: res.commitmentEntry }),
    };
  }
}
