/**
 * The exhibit list (PR 34): her files in the order she added them, numbered, with what a reader of the list needs: name,
 * date added, type, size and the salted fingerprint of the original. Built on her device from her own lists; exported as
 * CSV (and into the PDF through BriefOptions.exhibitFingerprints, and the data export zip).
 *
 * "Exhibit N" is only a position in her own list (so a redacted copy can say which file it was made from); it is not a court
 * exhibit number. A kept original (a second encrypted file) is not a separate exhibit: it belongs to the file it came from.
 */
import type { BlobMeta, EvidenceItem } from '@matra/shared';
import { EVIDENCE_KIND_LABELS } from '../brief/format';
import { formatBytes } from '../lib/vault';
import type { PrivateItem } from './privateStore';

export interface Exhibit {
  number: number;
  /** EvidenceItem.id */
  id: string;
  blobId: string;
  fileName: string;
  /** ISO time she added it (her device's clock when known, else when the server sealed it) */
  addedAt: string;
  kindLabel: string;
  mimeType: string;
  sizeBytes: number;
  /** the salted commitment to the original's hash; empty when none was made */
  fingerprint: string;
  description?: string;
  capturedAt?: string;
  screenshotLikely: boolean;
  /** the exhibit this one is a redacted copy of */
  derivedFrom?: string;
  ocrText?: string;
}

type BlobLike = Pick<BlobMeta, 'id' | 'createdAt' | 'sizeBytes'>;

/** Files she has details for, in the order the server sealed them (blobs arrive oldest first), numbered from 1. */
export function buildExhibits(
  blobs: readonly BlobLike[],
  items: readonly EvidenceItem[],
  priv: Readonly<Record<string, PrivateItem>>,
  /** the export lists a file whose details were never saved (another device saved its draft first) as "(name not saved)" */
  opts: { includeUnnamed?: boolean } = {},
): Exhibit[] {
  const byBlob = new Map(items.filter((i) => i.blobId).map((i) => [i.blobId!, i]));
  const keptOriginals = new Set(Object.values(priv).flatMap((p) => (p.originalBlobId ? [p.originalBlobId] : [])));
  const ordered = [...blobs].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  const out: Exhibit[] = [];
  for (const b of ordered) {
    const item = byBlob.get(b.id);
    if (keptOriginals.has(b.id)) continue;
    if (!item) {
      if (opts.includeUnnamed)
        out.push({ number: out.length + 1, id: `unnamed-${b.id}`, blobId: b.id, fileName: '(name not saved)', addedAt: b.createdAt, kindLabel: 'Unknown', mimeType: 'unknown', sizeBytes: b.sizeBytes, fingerprint: '', screenshotLikely: false });
      continue;
    }
    const p = priv[item.id];
    out.push({
      number: out.length + 1,
      id: item.id,
      blobId: b.id,
      fileName: item.fileName,
      addedAt: p?.importedAt || b.createdAt,
      kindLabel: EVIDENCE_KIND_LABELS[item.kind] ?? item.kind,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes || b.sizeBytes,
      fingerprint: p?.commitment ?? '',
      ...(item.description && { description: item.description }),
      ...(item.capturedAt && { capturedAt: item.capturedAt }),
      screenshotLikely: !!p?.screenshotLikely || item.kind === 'screenshot',
      ...(p?.derivedFrom && { derivedFrom: p.derivedFrom }),
      ...(p?.ocr?.text && { ocrText: p.ocr.text }),
    });
  }
  return out;
}

/** The commitments by item id, for the PDF's Evidence Inventory. */
export const fingerprintsById = (list: readonly Exhibit[]): Record<string, string> =>
  Object.fromEntries(list.filter((e) => e.fingerprint).map((e) => [e.id, e.fingerprint]));

/**
 * A cell that opens safely in a spreadsheet: quoted, and a leading = + - @ tab or CR (a formula, to a spreadsheet) is
 * neutralised with a leading apostrophe, so a file name cannot run anything on her screen or an advocate's.
 */
export function csvCell(v: string | number): string {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export const EXHIBIT_CSV_COLUMNS = ['Exhibit', 'File name', 'Date added', 'Type', 'Size', 'Salted fingerprint of the original'] as const;

/** The exhibit list as CSV: number, name, date added, type, size, salted-commitment fingerprint. CRLF line ends. */
export function exhibitListCsv(list: readonly Exhibit[]): string {
  const rows = list.map((e) => [e.number, e.fileName, e.addedAt, `${e.kindLabel} (${e.mimeType})`, `${formatBytes(e.sizeBytes)} (${e.sizeBytes} bytes)`, e.fingerprint]);
  return [EXHIBIT_CSV_COLUMNS.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}

/** What a redacted copy of this exhibit is called, and what its description says. The original is not changed. */
export const redactedCopyLabel = (number: number): string => `Redacted copy of exhibit ${number}`;
export const redactedCopyDescription = (number: number): string => `${redactedCopyLabel(number)}. The original file is unchanged and is still in your space.`;
