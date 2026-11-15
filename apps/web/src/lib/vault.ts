/**
 * Vault helpers: sealing / opening encrypted records, evidence upload. Sealed matching lives in lib/matching.ts; her
 * draft lives in its draft slot (lib/draftSlot.ts), never in a record.
 * Record payload (encrypted with encryptJSON under a per-record key wrapped by masterKey):
 *   { kind: 'final', record, savedAt }     her sealed account: exactly these three fields, nothing else, because
 *                                          sharing it with an attorney or releasing it to a counselor hands over the
 *                                          whole envelope
 *   { kind: 'profile', profile, savedAt }  her preferences
 * Records written before draft slots may also be { kind: 'draft', draft, evidence } (every autosave), or a 'final'
 * that also carries `draft` and `escrowedHashes`. They are WORM, so they stay; they are read only to resume an account
 * that has no draft slot yet, and are never shown as versions or shared (isCleanFinal).
 *
 * 'profile' records hold her personal preferences (e.g. the name she'd like to be called). They are encrypted like
 * every other record — the server never sees the name — and `loadVault` leaves them out by default, so screens that
 * work with drafts and sealed accounts never see them. Use getProfile / saveProfile below.
 */
import {
  decryptBlob,
  decryptJSON,
  encryptBlob,
  encryptJSON,
  generateContentKey,
  randomId,
  sha256Hex,
  unwrapKeyWithMaster,
  wrapKeyWithMaster,
} from '@matra/crypto';
import type { BlobMeta, EvidenceItem, EvidenceKind, IntakeRecord, LedgerEntry, VaultRecord } from '@matra/shared';
import { envelopeHash, type ApiClient } from '../api/client';
import type { IntakeDraft } from '../integration/intakeAdapter';
import { stripMetadata } from './metadata';
import { withoutMatchingAnswers, type LoadedDraftSlot } from './draftSlot';
import type { WorkingData } from './session';
import { mirror, typedText } from '../dev/mirror';

/** Her personal preferences, stored only inside an encrypted 'profile' vault record. */
export interface VaultProfile {
  /** What she'd like to be called in the app. Optional; any nickname. Never sent to the server in plaintext. */
  preferredName?: string;
  updatedAt: string;
}

/** A record's decrypted payload, as written now or by an earlier version of the app. */
export interface VaultPayload {
  kind: 'draft' | 'final' | 'profile';
  profile?: VaultProfile;
  record?: IntakeRecord;
  savedAt: string;
  /** legacy only (written before draft slots): her answers, in a 'draft' record or alongside a sealed 'final' */
  draft?: IntakeDraft;
  /** legacy only: evidence details in a 'draft' record (final records carry them in record.evidence) */
  evidence?: EvidenceItem[];
  /** legacy only: fingerprints of identifiers sealed for matching (now kept in the draft slot) */
  escrowedHashes?: string[];
}

/** What may be sealed as a record now: her sealed account or her preferences. Drafts go to the draft slot. */
export type SealPayload =
  | { kind: 'final'; record: IntakeRecord; savedAt: string }
  | { kind: 'profile'; profile: VaultProfile; savedAt: string };

/**
 * The exact plaintext of a sealed record: only the fields of its kind, so nothing else (her draft, unsent words, matching
 * fingerprints) can ever ride along into an envelope she may later share.
 */
function sealedPlaintext(p: SealPayload): SealPayload {
  if (p.kind === 'final') {
    if (!p.record) throw new Error('A sealed account needs its record.');
    return { kind: 'final', record: p.record, savedAt: p.savedAt };
  }
  if (p.kind === 'profile') return { kind: 'profile', profile: p.profile, savedAt: p.savedAt };
  throw new Error('Only a sealed account or preferences can be sealed; drafts are saved to the draft slot.');
}

const CLEAN_FINAL_KEYS = new Set(['kind', 'record', 'savedAt']);

/**
 * Whether this sealed version holds only her account (`{kind, record, savedAt}`), so it may be shared or released. One
 * sealed before draft slots may also hold her draft and matching fingerprints; it is never shared, and she seals again.
 */
export function isCleanFinal(payload: VaultPayload): boolean {
  return payload.kind === 'final' && !!payload.record && Object.keys(payload).every((k) => CLEAN_FINAL_KEYS.has(k));
}

/** Shown instead of sharing a sealed version saved before draft slots (it also holds her draft). */
export const LEGACY_FINAL_NOTICE =
  'Your sealed account was saved in an older format that also keeps your working notes with it. To share only your account, open My story and seal it again first. The earlier version stays as it was.';

export interface OpenedRecord {
  meta: VaultRecord;
  payload: VaultPayload;
  key: CryptoKey;
  /** recomputed envelope hash matches the server's contentHash (and the ledger's, if fetched) */
  verified: boolean;
  ledgerEntry?: LedgerEntry;
  supersededBy?: string;
}

export async function sealPayload(api: ApiClient, masterKey: CryptoKey, input: SealPayload, supersedes?: string) {
  const payload = sealedPlaintext(input);
  const key = await generateContentKey();
  const envelope = await encryptJSON(payload, key);
  const ownerWrappedKey = await wrapKeyWithMaster(key, masterKey);
  mirror(
    payload.kind === 'final' ? 'Her story (sealed)' : 'Her preferences',
    typedText(payload.kind === 'final' ? payload.record : payload),
    `Encrypted here (AES-256-GCM, a new key per version). The server gets the envelope (${envelope.ct.length} base64 characters), the key wrapped by her own key, and a hash.`,
  );
  const res = await api.createRecord({ envelope, ownerWrappedKey, supersedes });
  return { ...res, key };
}

export async function openRecord(api: ApiClient, masterKey: CryptoKey, id: string, withLedger = true): Promise<OpenedRecord> {
  const { record } = await api.getRecord(id);
  const key = await unwrapKeyWithMaster(record.ownerWrappedKey, masterKey);
  const payload = await decryptJSON<VaultPayload>(record.envelope, key);
  const recomputed = await envelopeHash(record.envelope);
  let ledgerEntry: LedgerEntry | undefined;
  if (withLedger && record.ledgerEntryId) {
    try {
      ledgerEntry = (await api.getLedgerEntry(record.ledgerEntryId)).entry;
    } catch {
      /* ledger lookup optional */
    }
  }
  const verified = recomputed === record.contentHash && (!ledgerEntry || ledgerEntry.contentHash === recomputed);
  return { meta: record, payload, key, verified, ledgerEntry };
}

/**
 * The opened records, newest first, plus how many saved versions could not be opened (fetch or decryption failed).
 * Those are still listed by the server; they are left out here, so whatever is "latest" may be an older version.
 * Screens that resume or summarize her space show `unreadable` with unreadableNotice.
 */
export type LoadedVault = OpenedRecord[] & { unreadable: number };

/**
 * Load and decrypt every record in the vault, newest first, marking superseded versions.
 * Profile (preferences) records are left out unless `includeProfile` is set. A record that fails to open is counted in
 * `unreadable` (never dropped silently): she must not resume from an older version without being told.
 */
export async function loadVault(
  api: ApiClient,
  masterKey: CryptoKey,
  { includeProfile = false, withLedger = true }: { includeProfile?: boolean; withLedger?: boolean } = {},
): Promise<LoadedVault> {
  const { records } = await api.listRecords();
  const opened = await Promise.all(records.map((r) => openRecord(api, masterKey, r.id, withLedger).catch(() => null)));
  const unreadable = opened.filter((x) => x === null).length;
  const list = opened.filter((x): x is OpenedRecord => !!x && (includeProfile || x.payload.kind !== 'profile'));
  const supersededBy = new Map<string, string>();
  for (const r of list) if (r.meta.supersedes) supersededBy.set(r.meta.supersedes, r.meta.id);
  for (const r of list) r.supersededBy = supersededBy.get(r.meta.id);
  list.sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt));
  return Object.assign(list, { unreadable });
}

/**
 * Refusing to save from a partial vault: some saved versions couldn't be opened, so saving now would put an older
 * version on top of her newest. The message is unreadableNotice's calm wording (friendlyError shows it as is).
 */
export class UnreadableVaultError extends Error {
  constructor(readonly unreadable: number) {
    super(unreadableNotice(unreadable) ?? 'Some saved versions of your space could not be opened just now.');
    this.name = 'UnreadableVaultError';
  }
}

/** Calm words for saved versions that couldn't be opened (null when there are none). */
export function unreadableNotice(n: number): string | null {
  if (!(n > 0)) return null;
  return (
    `We couldn’t open ${n === 1 ? 'one saved version' : `${n} saved versions`} of your space just now. ` +
    `${n === 1 ? 'It is' : 'They are'} still stored, but what you see here may not be your newest save. ` +
    'Before you continue, you could try again in a moment, or sign out and back in.'
  );
}

export function latestOf(list: OpenedRecord[], kind: VaultPayload['kind']): OpenedRecord | undefined {
  return list.find((r) => r.payload.kind === kind && !r.supersededBy) ?? list.find((r) => r.payload.kind === kind);
}

export function finals(list: OpenedRecord[]): OpenedRecord[] {
  return list.filter((r) => r.payload.kind === 'final' && r.payload.record);
}

/** Where she picks her story back up, and what goes with it. */
export interface ResumePoint {
  draft?: IntakeDraft;
  /** file details to keep with the draft (the sealed version's are merged in by the caller) */
  evidence: EvidenceItem[];
  /** her latest sealed version, if any */
  final?: OpenedRecord;
  /** sealed matching on: fingerprints already sealed */
  escrowedHashes: string[];
  /** where it came from: her draft slot, or (an account with no slot yet) the records saved before slots */
  from: 'slot' | 'legacy' | 'none';
}

/**
 * Where to pick the intake back up: her draft slot. It is kept after sealing, so adding evidence or a detail after
 * sealing never means starting over. An account with no slot yet (it last saved before draft slots) resumes from those
 * records instead: the newest legacy draft record if it is newer than the latest seal, otherwise the answers a legacy
 * seal kept beside it. Its next save then makes the slot. Matching answers and fingerprints are dropped in a build
 * without sealed matching (draftSlot.ts withoutMatchingAnswers).
 */
export function resumeFrom(slot: LoadedDraftSlot | null, list: OpenedRecord[]): ResumePoint {
  const final = latestOf(list, 'final');
  const legacyEscrowed = final?.payload.escrowedHashes ?? [];
  const forBuild = (r: ResumePoint): ResumePoint =>
    __MATRA_MATCHING__ ? r : { ...r, draft: r.draft && withoutMatchingAnswers(r.draft), escrowedHashes: [] };
  if (slot)
    return forBuild({
      draft: slot.value.draft,
      evidence: slot.value.evidence,
      final,
      escrowedHashes: slot.value.escrowedHashes ?? legacyEscrowed,
      from: 'slot',
    });
  const draftRecord = latestOf(list, 'draft');
  const draftIsNewer = !!draftRecord && !draftRecord.supersededBy && (!final || draftRecord.meta.createdAt > final.meta.createdAt);
  const draft = (draftIsNewer ? draftRecord.payload.draft : undefined) ?? final?.payload.draft;
  return forBuild({
    draft,
    evidence: (draftIsNewer ? draftRecord.payload.evidence : undefined) ?? [],
    final,
    escrowedHashes: legacyEscrowed,
    from: draft ? 'legacy' : 'none',
  });
}

/** File details an older draft record kept (legacy), so a file added then still has its name. */
export function legacyDraftEvidence(list: OpenedRecord[]): EvidenceItem[] {
  return list.filter((r) => r.payload.kind === 'draft').flatMap((r) => r.payload.evidence ?? []);
}

// ───────────── profile (preferences) ─────────────

/** The latest encrypted profile record, if she has one. */
export async function getProfile(api: ApiClient, masterKey: CryptoKey): Promise<{ profile: VaultProfile; recordId: string } | null> {
  const list = await loadVault(api, masterKey, { includeProfile: true, withLedger: false });
  const r = latestOf(list, 'profile');
  return r?.payload.profile ? { profile: r.payload.profile, recordId: r.meta.id } : null;
}

/** Encrypt and save her preferences as a new profile record (superseding the previous one, if any). */
export async function saveProfile(
  api: ApiClient,
  masterKey: CryptoKey,
  input: { preferredName?: string },
  supersedes?: string,
): Promise<{ profile: VaultProfile; recordId: string }> {
  const name = input.preferredName?.trim().slice(0, 60);
  const profile: VaultProfile = { ...(name && { preferredName: name }), updatedAt: new Date().toISOString() };
  const res = await sealPayload(api, masterKey, { kind: 'profile', profile, savedAt: profile.updatedAt }, supersedes);
  return { profile, recordId: res.record.id };
}

// ───────────── evidence ─────────────

export function evidenceKindFor(file: { type: string; name: string }): EvidenceKind {
  const t = file.type.toLowerCase();
  if (t.startsWith('image/')) return /screen\s?shot|screen_shot|screenshot/i.test(file.name) ? 'screenshot' : 'photo';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t === 'application/pdf' || t.startsWith('text/') || t.includes('document')) return 'document';
  return 'other';
}

export interface UploadedEvidence {
  item: EvidenceItem;
  /** stripped plaintext, for an in-memory preview only */
  plaintext: Blob;
  note: string;
  ledgerEntry: LedgerEntry;
}

export async function uploadEvidence(
  api: ApiClient,
  masterKey: CryptoKey,
  file: File,
  extra: { description?: string; capturedAt?: string } = {},
): Promise<UploadedEvidence> {
  const { blob, stripped, note } = await stripMetadata(file);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  const key = await generateContentKey();
  const ct = await encryptBlob(bytes, key);
  const wrapped = await wrapKeyWithMaster(key, masterKey);
  mirror(
    'Evidence file',
    `${file.name} (${formatBytes(bytes.byteLength)}${stripped ? ', location and camera data removed here' : ''})`,
    `Encrypted here. The server gets ${formatBytes(ct.byteLength)} of ciphertext and its hash; not the file name.`,
  );
  const res = await api.uploadBlob(ct, wrapped);
  const item: EvidenceItem = {
    id: randomId(),
    kind: evidenceKindFor(file),
    fileName: file.name,
    mimeType: blob.type || file.type || 'application/octet-stream',
    sizeBytes: bytes.byteLength,
    sha256,
    blobId: res.blob.id,
    description: extra.description || undefined,
    capturedAt: extra.capturedAt || undefined,
    metadataStripped: stripped,
  };
  return { item, plaintext: new Blob([bytes], { type: item.mimeType }), note, ledgerEntry: res.ledgerEntry };
}

/** Decrypt an evidence blob and check its SHA-256 against the recorded hash. */
export async function openEvidence(api: ApiClient, key: CryptoKey, blobId: string, expectedSha256?: string) {
  const ct = await api.downloadBlob(blobId);
  const pt = await decryptBlob(ct, key);
  const hash = await sha256Hex(pt);
  return { bytes: pt, hash, verified: expectedSha256 ? hash === expectedSha256 : undefined };
}

export async function blobKeyFor(meta: BlobMeta, masterKey: CryptoKey): Promise<CryptoKey> {
  return unwrapKeyWithMaster(meta.ownerWrappedKey, masterKey);
}

export function mergeEvidence(...lists: (EvidenceItem[] | undefined)[]): EvidenceItem[] {
  const out = new Map<string, EvidenceItem>();
  for (const l of lists) for (const e of l ?? []) out.set(e.blobId ?? e.id, e);
  return Array.from(out.values());
}

/**
 * The story's working copy, plus any files the in-memory working data has that it doesn't (details saved by the
 * Evidence page after the story opened). Her draft stays the story's own; the slot seq follows the newer save.
 * Returns null when there is nothing new.
 */
export function foldInLateEvidence(story: WorkingData, mem: WorkingData | null): WorkingData | null {
  if (!mem) return null;
  const known = new Set(story.evidence.map((e) => e.blobId ?? e.id));
  if (mem.evidence.every((e) => known.has(e.blobId ?? e.id))) return null;
  return {
    ...story,
    evidence: mergeEvidence(story.evidence, mem.evidence),
    slotSeq: mem.slotSeq ?? story.slotSeq,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function shortHash(h: string, n = 12): string {
  return h.length > n * 2 ? `${h.slice(0, n)}…${h.slice(-6)}` : h;
}
