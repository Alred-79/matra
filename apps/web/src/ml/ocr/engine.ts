/**
 * On-device text reading (OCR) for an image, with tesseract.js (Apache-2.0), English only (PR 32, plan 8.5).
 *
 * What it does: turns the pixels of one image into the text printed on it. The text is returned EXACTLY as the engine read
 * it: no cleanup, no spelling correction, no reordering, no summary. It does not say what an image shows, and it does not
 * look at faces or objects (it has no such model).
 *
 * Where everything comes from (threat model W23): our own origin only; the CSP's `connect-src 'self'` would stop anything
 * else anyway. Three files, all pinned in src/ml/manifest.json:
 *   - the English language data: fetched from /models/ and checked in the browser (size and SHA-256) before use, through the
 *     same verified loader and cache as the speech model (src/ml/verify.ts, cache.ts), then handed to the engine as bytes,
 *     so the engine never makes a request of its own (and keeps no copy of its own in IndexedDB: cacheMethod 'none');
 *   - the tesseract.js worker script and its WebAssembly core: CODE the browser starts from a URL, so it cannot be checked
 *     by a fetch-then-run (the bytes that run would be a second fetch). Both are built INTO the app as content-hashed files
 *     (`?url` below), pinned at build time (vite.config.ts, scripts/fetch-models.mjs, scripts/audit-web-build.mjs).
 *
 * It runs only when she asks for it (the caller is a button), loads the engine on demand, and ends its worker when done.
 */
import { loadPinnedFile, VerifiedCache } from '../cache';
import { modelById, type ModelEntry } from '../manifest';
import { defaultEnv, type LoaderEnv } from '../verify';
// The engine's code, built into the app (see manifest.json, models[].bundled): never a /models/ file.
import ocrWorkerUrl from 'tesseract.js/dist/worker.min.js?url';
import ocrCoreUrl from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url';

export const OCR_MODEL_ID = 'tesseract/eng-best-int';
export const OCR_ENGINE_LABEL = 'tesseract.js 7.0.0, English';

export interface OcrResult {
  /** exactly what the engine read */
  text: string;
  engine: string;
}

export interface OcrProgress {
  /** plain words for a status line */
  status: string;
  /** 0 to 1, or undefined when not known */
  fraction?: number;
}

/** The part of tesseract.js this module uses (so tests can pass a fake). */
export interface TesseractLike {
  createWorker(
    langs: Array<{ code: string; data: Uint8Array }>,
    oem: number,
    options: Record<string, unknown>,
  ): Promise<{ recognize(image: Blob | Uint8Array): Promise<{ data: { text: string } }>; terminate(): Promise<unknown> }>;
  OEM: { LSTM_ONLY: number };
}

export class OcrUnavailableError extends Error {
  readonly friendly = true;
  constructor(detail?: string) {
    super(
      'Reading text from images isn’t available in this copy of Matra' + (detail ? ` (${detail})` : '') + '. Your file is not affected.',
    );
    this.name = 'OcrUnavailableError';
  }
}

/** The code URLs must be this app's own build assets, never a file under /models/ and never another origin. */
export function assertOcrCodeUrls(urls: string[], origin = 'http://localhost'): void {
  for (const u of urls) {
    const url = new URL(u, origin);
    if (url.origin !== new URL(origin).origin || url.pathname.startsWith('/models/') || !/^\/(?:assets|@fs|node_modules)\//.test(url.pathname))
      throw new Error(`the OCR code must be a build asset of this app, not ${u}`);
  }
}

async function loadLanguageData(model: ModelEntry, env: LoaderEnv, onProgress?: (p: OcrProgress) => void): Promise<Uint8Array> {
  const file = model.files[0]!;
  onProgress?.({ status: 'Getting the reading data…', fraction: 0 });
  const { bytes } = await loadPinnedFile(model.base + file.path, new VerifiedCache(model.cacheName, env), env, (n) =>
    onProgress?.({ status: 'Getting the reading data…', fraction: Math.min(1, n / file.size) }),
  );
  return bytes;
}

/** WebP is decoded by the browser first (the engine's own image reader is not relied on for it); other types go as they are. */
async function forEngine(image: Blob): Promise<Blob> {
  if (image.type !== 'image/webp' || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return image;
  try {
    const bmp = await createImageBitmap(image);
    try {
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      c.getContext('2d')!.drawImage(bmp, 0, 0);
      return await c.convertToBlob({ type: 'image/png' });
    } finally {
      bmp.close?.();
    }
  } catch {
    return image;
  }
}

export interface ReadTextOptions {
  onProgress?: (p: OcrProgress) => void;
  /** tests: a stand-in for tesseract.js, an environment and the manifest entry */
  tesseract?: TesseractLike;
  env?: LoaderEnv;
  model?: ModelEntry;
  codeUrls?: { worker: string; core: string };
}

/** Read the text printed in one image. The words are the engine's, untouched. */
export async function readTextFromImage(image: Blob, opts: ReadTextOptions = {}): Promise<OcrResult> {
  const env = opts.env ?? defaultEnv();
  const model = opts.model ?? modelById(OCR_MODEL_ID, env.manifest);
  const code = opts.codeUrls ?? { worker: ocrWorkerUrl, core: ocrCoreUrl };
  assertOcrCodeUrls([code.worker, code.core], env.origin);
  const data = await loadLanguageData(model, env, opts.onProgress);
  opts.onProgress?.({ status: 'Starting the reader…' });
  let tess: TesseractLike;
  try {
    tess = opts.tesseract ?? ((await import('tesseract.js')) as unknown as TesseractLike);
  } catch (e) {
    throw new OcrUnavailableError((e as Error).message);
  }
  let worker: Awaited<ReturnType<TesseractLike['createWorker']>> | undefined;
  try {
    worker = await tess.createWorker([{ code: 'eng', data }], tess.OEM.LSTM_ONLY, {
      workerPath: code.worker,
      corePath: code.core, // a path ending in .js: the engine loads exactly this file, with no CDN default
      langPath: '', // never used: the language data is passed in as bytes above
      workerBlobURL: false, // the CSP has no blob: worker source; start the worker from our own file
      cacheMethod: 'none', // no copy of the data in IndexedDB; our own verified cache is the only one
      gzip: true,
      logger: (m: { status?: string; progress?: number }) => {
        if (m.status === 'recognizing text') opts.onProgress?.({ status: 'Reading the text…', fraction: m.progress });
      },
      errorHandler: () => {},
    });
    opts.onProgress?.({ status: 'Reading the text…', fraction: 0 });
    const res = await worker.recognize(await forEngine(image));
    return { text: res.data.text, engine: OCR_ENGINE_LABEL };
  } catch (e) {
    if (e instanceof Error && 'friendly' in e) throw e;
    throw new OcrUnavailableError(typeof e === 'string' ? e : (e as Error)?.message);
  } finally {
    await worker?.terminate().catch(() => {});
  }
}
