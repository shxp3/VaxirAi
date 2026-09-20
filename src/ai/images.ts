import { requestJson } from './http.js';
import { AppError } from '../utils/errors.js';

export interface GeneratedImage { bytes: Buffer; mediaType: string; extension: string }
export interface ImageReference { dataUrl: string; url: string }
export interface ImageOptions { aspectRatio?: string; timeoutMs: number; references?: ImageReference[] }

/** Pollinations models with image-input support (edits). Others fall back to kontext when editing. */
const POLLINATIONS_EDIT_MODELS = new Set(['kontext', 'klein', 'nanobanana', 'p-image-edit', 'gptimage', 'gptimage-large', 'seedream5', 'seedream', 'wan-image', 'nova-canvas']);
function pollinationsEditModel(name: string): string {
  const base = name.trim().toLowerCase() || 'flux';
  if (POLLINATIONS_EDIT_MODELS.has(base) || base.startsWith('seedream')) return name;
  return 'kontext';
}

const ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4']);

export function cleanImagePrompt(prompt: string): string {
  const text = prompt.trim().replace(/\0/g, '');
  if (!text || text.length > 1000) throw new AppError('input');
  return text;
}

export type ImageProviderName = 'openrouter' | 'pollinations';

export function cleanImageProvider(value: string | null | undefined, fallback: ImageProviderName): ImageProviderName {
  if (!value) return fallback;
  const name = value.trim().toLowerCase();
  if (name === 'openrouter' || name === 'pollinations') return name;
  throw new AppError('input');
}

export function cleanAspectRatio(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const ratio = value.trim();
  if (!ASPECT_RATIOS.has(ratio)) throw new AppError('input');
  return ratio;
}

function extensionFor(mediaType: string): string {
  const type = mediaType.trim().toLowerCase();
  if (type === 'image/jpeg' || type === 'image/jpg') return 'jpg';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/svg+xml') return 'svg';
  return 'png';
}

const POLLINATIONS_DIMS: Record<string, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 },
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '4:3': { width: 1152, height: 864 },
  '3:4': { width: 864, height: 1152 },
  '3:2': { width: 1200, height: 800 },
  '2:3': { width: 800, height: 1200 },
  '4:5': { width: 960, height: 1200 },
  '5:4': { width: 1200, height: 960 },
};

function imageError(status: number): never {
  if (status === 429) throw new AppError('quota');
  if (status === 413) throw new AppError('too_large');
  if ([401, 403].includes(status)) throw new AppError('auth');
  if ([400, 404, 422].includes(status)) throw new AppError('model');
  throw new AppError('unavailable');
}

/** Free tier (no key required, throttled). Docs: https://gen.pollinations.ai/api/docs */
export class PollinationsImageProvider {
  async generate(prompt: string, model: string, apiKey: string, options: ImageOptions): Promise<GeneratedImage> {
    const text = cleanImagePrompt(prompt);
    const dims = POLLINATIONS_DIMS[options.aspectRatio ?? '1:1'] ?? POLLINATIONS_DIMS['1:1']!;
    const refs = (options.references ?? []).map(r => r.url).filter(u => u.startsWith('https://'));
    if (refs.length > 4) throw new AppError('input');
    for (const u of refs) {
      let parsed: URL;
      try { parsed = new URL(u); } catch { throw new AppError('input'); }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new AppError('input');
    }
    const name = (model || 'flux').trim() || 'flux';
    if (!/^[\w./:@+-]+$/.test(name) || name.length > 200) throw new AppError('config');
    const params = new URLSearchParams({ model: refs.length ? pollinationsEditModel(name) : name, width: String(dims.width), height: String(dims.height), nologo: 'true' });
    if (refs.length) params.set('image', refs.join('|'));
    if (apiKey) params.set('key', apiKey);
    const url = `https://gen.pollinations.ai/image/${encodeURIComponent(text)}?${params}`;
    const signal = AbortSignal.timeout(options.timeoutMs);
    let response: Response;
    try { response = await fetch(url, { signal }); }
    catch (error) { if (signal.aborted) throw new AppError('timeout'); throw new AppError('unavailable'); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); imageError(response.status); }
    const mediaType = response.headers.get('content-type')?.toLowerCase().split(';')[0]?.trim() ?? '';
    if (!mediaType.startsWith('image/')) { await response.body?.cancel().catch(() => {}); throw new AppError('malformed'); }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new AppError('too_large');
    return { bytes, mediaType, extension: extensionFor(mediaType) };
  }
}

export class OpenRouterImageProvider {
  async generate(prompt: string, model: string, apiKey: string, options: ImageOptions): Promise<GeneratedImage> {
    const text = cleanImagePrompt(prompt);
    if (!model || !/^[\w./:@+-]+$/.test(model) || model.length > 200) throw new AppError('config');
    if (!apiKey || /[\r\n]/.test(apiKey)) throw new AppError('config');
    const data = await requestJson('https://openrouter.ai/api/v1/images', { Authorization: `Bearer ${apiKey}` }, {
      model,
      prompt: text,
      n: 1,
      ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
      ...((options.references?.length ?? 0) ? { input_references: options.references!.map(r => ({ type: 'image_url', image_url: { url: r.dataUrl } })) } : {}),
    }, options.timeoutMs);
    if (data?.error) {
      const code = String((data.error as { code?: unknown }).code ?? '');
      throw new AppError(code === '429' ? 'quota' : ['401', '403'].includes(code) ? 'auth' : ['400', '404', '422'].includes(code) ? 'model' : 'unavailable');
    }
    const item = Array.isArray(data?.data) ? data.data[0] : undefined;
    const b64 = typeof item?.b64_json === 'string' ? item.b64_json : undefined;
    if (!b64) throw new AppError('malformed');
    let bytes: Buffer;
    try { bytes = Buffer.from(b64, 'base64'); } catch { throw new AppError('malformed'); }
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new AppError('too_large');
    const mediaType = typeof item?.media_type === 'string' && item.media_type.startsWith('image/') ? item.media_type : 'image/png';
    return { bytes, mediaType, extension: extensionFor(mediaType) };
  }
}
