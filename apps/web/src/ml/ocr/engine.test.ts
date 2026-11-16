import { describe, expect, it, vi } from 'vitest';
import { MANIFEST, modelById, type Manifest, type ModelEntry } from '../manifest';
import { IntegrityError, sha256Hex } from '../verify';
import { ORIGIN, enc, envFor, fakeFetch } from '../testkit.test-util';
import { OCR_MODEL_ID, OcrUnavailableError, assertOcrCodeUrls, readTextFromImage, type TesseractLike } from './engine';

const LANG = enc('pretend this is gzipped english data');
async function setup(served?: Record<string, Uint8Array | { status: number }>) {
  const model: ModelEntry = {
    id: OCR_MODEL_ID,
    task: 'ocr',
    revision: 'test',
    dtype: 'lstm-int8',
    base: '/models/tesseract/eng-best-int/',
    cacheName: 'ml-model-ocr-test',
    files: [{ path: 'eng.traineddata.gz', size: LANG.length, sha256: await sha256Hex(LANG) }],
  };
  const manifest: Manifest = { ...MANIFEST, models: [model] };
  const fetchImpl = fakeFetch(served ?? { '/models/tesseract/eng-best-int/eng.traineddata.gz': LANG });
  return { model, manifest, fetchImpl, env: envFor(manifest, fetchImpl) };
}

const CODE = { worker: '/assets/worker.min-abc123.js', core: '/assets/tesseract-core-simd-lstm.wasm-def456.js' };

function fakeTesseract(text: string) {
  const terminate = vi.fn(async () => {});
  const recognize = vi.fn(async () => ({ data: { text } }));
  const createWorker = vi.fn(async () => ({ recognize, terminate }));
  const t: TesseractLike = { createWorker, OEM: { LSTM_ONLY: 1 } };
  return { t, createWorker, recognize, terminate };
}
const image = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

describe('on-device text reading', () => {
  it('returns the engine’s text exactly: no cleanup, correction, trimming or summary', async () => {
    const odd = '  Thsi  is  a recipt \n\n  Total:  $ 12 .50\t\n  Pay by 03/04/2O26 \n';
    const { env, model } = await setup();
    const f = fakeTesseract(odd);
    const res = await readTextFromImage(image, { env, model, tesseract: f.t, codeUrls: CODE });
    expect(res.text).toBe(odd);
    expect(res.engine).toMatch(/tesseract/i);
  });

  it('gives the engine the verified language data as bytes, our own build files as code, no CDN, no blob: worker, no IndexedDB copy', async () => {
    const { env, model, fetchImpl } = await setup();
    const f = fakeTesseract('x');
    await readTextFromImage(image, { env, model, tesseract: f.t, codeUrls: CODE });
    const [langs, oem, options] = f.createWorker.mock.calls[0] as unknown as [Array<{ code: string; data: Uint8Array }>, number, Record<string, unknown>];
    expect(langs).toHaveLength(1);
    expect(langs[0]!.code).toBe('eng');
    expect(Array.from(langs[0]!.data)).toEqual(Array.from(LANG));
    expect(oem).toBe(1);
    expect(options).toMatchObject({ workerPath: CODE.worker, corePath: CODE.core, workerBlobURL: false, cacheMethod: 'none' });
    expect(String(options.corePath).endsWith('js')).toBe(true); // a file, so the engine never picks (or fetches) a default
    // the only request made was for the pinned language file, on our own origin
    expect(fetchImpl.calls).toEqual(['/models/tesseract/eng-best-int/eng.traineddata.gz']);
    expect(f.terminate).toHaveBeenCalledTimes(1);
  });

  it('refuses language data that is not the pinned file: nothing is read and no engine is started', async () => {
    const tampered = new Uint8Array(LANG);
    tampered[0] ^= 1;
    const { env, model } = await setup({ '/models/tesseract/eng-best-int/eng.traineddata.gz': tampered });
    const f = fakeTesseract('x');
    await expect(readTextFromImage(image, { env, model, tesseract: f.t, codeUrls: CODE })).rejects.toBeInstanceOf(IntegrityError);
    expect(f.createWorker).not.toHaveBeenCalled();
    // a short file too
    const short = await setup({ '/models/tesseract/eng-best-int/eng.traineddata.gz': LANG.slice(0, 5) });
    await expect(readTextFromImage(image, { env: short.env, model: short.model, tesseract: fakeTesseract('x').t, codeUrls: CODE })).rejects.toBeInstanceOf(IntegrityError);
    // and a missing one
    const gone = await setup({});
    await expect(readTextFromImage(image, { env: gone.env, model: gone.model, tesseract: fakeTesseract('x').t, codeUrls: CODE })).rejects.toBeInstanceOf(IntegrityError);
  });

  it('refuses code that is not a build asset of this app: a /models/ file, another origin, a CDN', () => {
    expect(() => assertOcrCodeUrls([CODE.worker, CODE.core], ORIGIN)).not.toThrow();
    for (const bad of ['/models/tesseract/worker.min.js', 'https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/worker.min.js', '//evil.test/assets/x.js', `${ORIGIN}.evil.test/assets/x.js`, '/x.js'])
      expect(() => assertOcrCodeUrls([bad], ORIGIN), bad).toThrow(/build asset/);
  });

  it('reports an engine that will not start as unavailable, with the worker ended; her file is untouched', async () => {
    const { env, model } = await setup();
    const terminate = vi.fn(async () => {});
    const t: TesseractLike = {
      OEM: { LSTM_ONLY: 1 },
      createWorker: async () => ({ recognize: async () => Promise.reject('Failed to load TesseractCore'), terminate }),
    };
    const err = await readTextFromImage(image, { env, model, tesseract: t, codeUrls: CODE }).catch((e) => e);
    expect(err).toBeInstanceOf(OcrUnavailableError);
    expect(String(err.message)).toMatch(/Your file is not affected/);
    expect(terminate).toHaveBeenCalled();
  });

  it('the real manifest pins the OCR data and both code files, with a licence-checked npm source', () => {
    const m = modelById(OCR_MODEL_ID);
    expect(m.task).toBe('ocr');
    expect(m.files).toHaveLength(1);
    expect(m.files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.bundled!.map((b) => b.role).sort()).toEqual(['ocr-core', 'ocr-worker']);
    for (const b of m.bundled!) expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.base).toMatch(/^\/models\//);
    // total size stays small (the plan's budget for OCR is about 20 MB)
    const total = m.files.reduce((n, f) => n + f.size, 0) + m.bundled!.reduce((n, b) => n + b.size, 0);
    expect(total).toBeLessThan(20_000_000);
  });
});
