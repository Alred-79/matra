import { describe, expect, it } from 'vitest';
import type { EvidenceItem } from '@matra/shared';
import { buildExhibits, csvCell, exhibitListCsv, fingerprintsById, redactedCopyDescription, redactedCopyLabel } from './exhibits';
import { EvidenceIndex, fold } from './search';
import type { PrivateItem } from './privateStore';

const item = (id: string, name: string, over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  id, kind: 'photo', fileName: name, mimeType: 'image/png', sizeBytes: 1500, sha256: 'a'.repeat(64), blobId: `b-${id}`, metadataStripped: true, ...over,
});
const blob = (id: string, createdAt: string) => ({ id: `b-${id}`, createdAt, sizeBytes: 1500 });
const C = (n: string) => n.repeat(64);

describe('exhibit list', () => {
  const items = [item('i1', 'receipt.png', { description: 'Receipt from the pharmacy' }), item('i2', 'texts.pdf', { kind: 'document', mimeType: 'application/pdf', sizeBytes: 5000 }), item('i3', 'copy.png')];
  const blobs = [blob('i2', '2026-11-02T10:00:00Z'), blob('i1', '2026-11-01T10:00:00Z'), blob('i3', '2026-11-03T10:00:00Z'), { id: 'b-orig', createdAt: '2026-11-01T10:00:01Z', sizeBytes: 9 }];
  const priv: Record<string, PrivateItem> = {
    i1: { commitment: C('c'), importedAt: '2026-11-01T09:59:59.000Z', originalBlobId: 'b-orig', ocr: { text: 'Total $12.50', engine: 'x', at: 'y' } },
    i3: { derivedFrom: 'i1', commitment: C('d') },
  };

  it('numbers files in the order they were added, leaves a kept original out of the list, and carries the details', () => {
    const list = buildExhibits(blobs, items, priv);
    expect(list.map((e) => [e.number, e.fileName])).toEqual([[1, 'receipt.png'], [2, 'texts.pdf'], [3, 'copy.png']]);
    expect(list[0]).toMatchObject({ addedAt: '2026-11-01T09:59:59.000Z', kindLabel: 'Photo', fingerprint: C('c'), ocrText: 'Total $12.50' });
    expect(list[1]).toMatchObject({ addedAt: '2026-11-02T10:00:00Z', kindLabel: 'Document', fingerprint: '' });
    expect(list[2]!.derivedFrom).toBe('i1');
    expect(fingerprintsById(list)).toEqual({ i1: C('c'), i3: C('d') });
  });

  it('exports number, name, date added, type, size and the salted fingerprint, and nothing about what a file shows', () => {
    const csv = exhibitListCsv(buildExhibits(blobs, items, priv));
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('"Exhibit","File name","Date added","Type","Size","Salted fingerprint of the original"');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(`"1","receipt.png","2026-11-01T09:59:59.000Z","Photo (image/png)","1.5 KB (1500 bytes)","${C('c')}"`);
    expect(csv).not.toContain('Total $12.50'); // the text read from an image is not in the list
    expect(csv).not.toContain('pharmacy'); // nor her descriptions
  });

  it('a file name cannot run as a formula in a spreadsheet, and quotes are doubled', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    for (const bad of ['+1', '-2', '@SUM(1)', '\tx', '\rx']) expect(csvCell(bad).startsWith(`"'`)).toBe(true);
    expect(csvCell('plain, with comma')).toBe('"plain, with comma"');
  });

  it('labels a redacted copy and says the original is unchanged', () => {
    expect(redactedCopyLabel(3)).toBe('Redacted copy of exhibit 3');
    expect(redactedCopyDescription(3)).toMatch(/Redacted copy of exhibit 3\. The original file is unchanged/);
  });
});

describe('local search', () => {
  const list = buildExhibits(
    [blob('i1', '2026-11-01T10:00:00Z'), blob('i2', '2026-11-02T10:00:00Z')],
    [item('i1', 'Pharmacy receipt.png', { description: 'Café receipt from Friday' }), item('i2', 'texts.pdf')],
    { i1: { ocr: { text: 'INVOICE 4471\nPaid 03/04/2026\nTotal $12.50', engine: 'e', at: 'a' } } },
  );
  const index = new EvidenceIndex(list);

  it('finds words in names, descriptions and image text, ignoring case and accents, and says where', () => {
    expect(index.search('pharmacy').map((h) => [h.number, h.fields])).toEqual([[1, ['name']]]);
    expect(index.search('CAFE')[0]).toMatchObject({ number: 1, fields: ['description'] });
    const hit = index.search('4471')[0]!;
    expect(hit).toMatchObject({ number: 1, fields: ['text'] });
    // the excerpt is the original words, with the match inside it
    expect(hit.excerpt!.text.slice(hit.excerpt!.start, hit.excerpt!.end)).toBe('4471');
    expect(hit.excerpt!.text).toContain('INVOICE 4471');
  });

  it('needs every word, at the start of a word; no match, empty or whitespace gives nothing', () => {
    expect(index.search('receipt friday')).toHaveLength(1);
    expect(index.search('receipt 9999')).toEqual([]);
    expect(index.search('eceipt')).toEqual([]); // inside a word is not a match
    expect(index.search('')).toEqual([]);
    expect(index.search('   ')).toEqual([]);
    expect(index.search('texts')[0]!.excerpt).toBeUndefined(); // a name match needs no excerpt
  });

  it('keeps the original text intact across accents and odd characters', () => {
    const { norm, map } = fold('Café 😀 É');
    expect(norm).toBe('cafe 😀 e');
    expect(map.length).toBe([...norm].length);
  });
});

describe('exhibit list for the export: files whose details were never saved', () => {
  it('lists them as "(name not saved)" only when asked, and never as a normal exhibit', () => {
    const blobs = [blob('i1', '2026-11-01T10:00:00Z'), { id: 'b-orphan', createdAt: '2026-11-02T10:00:00Z', sizeBytes: 77 }];
    const items = [item('i1', 'a.png')];
    expect(buildExhibits(blobs, items, {}).map((e) => e.fileName)).toEqual(['a.png']);
    const all = buildExhibits(blobs, items, {}, { includeUnnamed: true });
    expect(all.map((e) => [e.number, e.fileName, e.sizeBytes])).toEqual([[1, 'a.png', 1500], [2, '(name not saved)', 77]]);
  });
});
