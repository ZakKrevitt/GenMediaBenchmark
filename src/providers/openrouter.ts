import { isIP } from 'node:net';
import { z } from 'zod';
import { GateError } from '../lib/contracts';
import type { UsedSettings } from '../lib/fal-schema';
import { classifyHttp, wholeCents } from './http';
import type { StudioPoll, StudioSubmission } from './studio-providers';

// OpenRouter's video API (docs: guides/overview/multimodal/video-generation, read 5 October 2026):
// one async endpoint for every model. Each model publishes the durations, resolutions, frames and
// start-image support it accepts, and its price as "SKUs", so requests snap to valid values without
// a schema, and the finished job reports what OpenRouter actually charged (usage.cost).

const API = 'https://openrouter.ai/api/v1/';

const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number().nullish(),
  supported_resolutions: z.array(z.string()).nullish(),
  supported_aspect_ratios: z.array(z.string()).nullish(),
  supported_durations: z.array(z.number()).nullish(),
  supported_frame_images: z.array(z.string()).nullish(),
  generate_audio: z.boolean().nullish(),
  seed: z.boolean().nullish(),
  pricing_skus: z.record(z.string(), z.string()).nullish(),
});
export type OpenRouterModel = z.infer<typeof modelSchema>;

/** Every OpenRouter video model. The list is public; no key is needed. */
export async function openRouterVideoModels(fetcher: typeof fetch = fetch) {
  let response: Response;
  try {
    response = await fetcher(`${API}videos/models`, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  } catch {
    throw new GateError('RETRYABLE_NETWORK', 'OpenRouter is unreachable. Try again in a moment.');
  }
  if (!response.ok) throw classifyHttp(response.status);
  const body = z.object({ data: z.array(z.unknown()) }).parse(await response.json());
  return body.data.flatMap((m) => {
    const parsed = modelSchema.safeParse(m);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Why a model cannot run from a prompt (and one start image in image mode). */
export function openRouterBlocker(m: OpenRouterModel, mode: 'text' | 'image') {
  // Edit, upscale and avatar models list no durations: they work from an existing video or avatar.
  if (!m.supported_durations?.length) return 'Works from an existing video, not a prompt';
  if (mode === 'image' && !m.supported_frame_images?.includes('first_frame')) return 'Takes no start image';
  return null;
}

const resNumber = (r: string) => {
  const v = r.toLowerCase();
  if (v === '4k') return 2160;
  if (v === '2k') return 1440;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};
const ratio = (a: string) => {
  const [w, h] = a.split(':').map(Number);
  return w && h ? w / h : null;
};
function nearest<T>(options: T[], score: (o: T) => number) {
  return [...options].sort((a, b) => score(a) - score(b))[0];
}

type Wanted = { duration: number; aspectRatio: string; resolution: string; audio: boolean; seed: number | null };

/** The request one OpenRouter model gets, every setting snapped to a value it lists. */
export function buildOpenRouterInput(
  m: OpenRouterModel,
  prompt: string,
  s: Wanted,
  image?: string,
): { input: Record<string, unknown>; used: UsedSettings } {
  const input: Record<string, unknown> = { model: m.id, prompt };
  const durations = m.supported_durations ?? [];
  const duration = durations.length
    ? nearest(durations, (d) => Math.abs(d - s.duration) + (d < s.duration ? 0.01 : 0))
    : null;
  if (duration !== null) input.duration = duration;
  const resolutions = m.supported_resolutions ?? [];
  const wantRes = resNumber(s.resolution) ?? 720;
  const resolution = resolutions.length
    ? nearest(resolutions, (r) => Math.abs((resNumber(r) ?? 0) - wantRes))
    : null;
  if (resolution) input.resolution = resolution;
  let aspectRatio: string | null = null;
  if (image) {
    input.frame_images = [{ type: 'image_url', image_url: { url: image }, frame_type: 'first_frame' }];
    aspectRatio = 'from image';
  } else if (m.supported_aspect_ratios?.length) {
    const want = ratio(s.aspectRatio) ?? 9 / 16;
    aspectRatio = m.supported_aspect_ratios.includes(s.aspectRatio)
      ? s.aspectRatio
      : nearest(m.supported_aspect_ratios, (a) => Math.abs(Math.log((ratio(a) ?? 1) / want)));
    input.aspect_ratio = aspectRatio;
  }
  let audio: boolean | null = null;
  if (m.generate_audio) {
    input.generate_audio = s.audio;
    audio = s.audio;
  }
  if (m.seed && s.seed !== null) input.seed = s.seed;
  return { input, used: { duration, aspectRatio, resolution, audio } };
}

// Pixel size of a frame at a resolution and aspect ratio, for token-priced models.
function frameSize(resolution: string, aspectRatio: string) {
  const short = resNumber(resolution) ?? 720;
  const r = ratio(aspectRatio) ?? 9 / 16;
  return r >= 1 ? { w: Math.round(short * r), h: short } : { w: short, h: Math.round(short / r) };
}

const IGNORED = /reference|continuation|video_input|image_input|megapixel|minimum|output_count/;
const RES_TOKEN = /_(480p|540p|720p|768p|1024p|1080p|2k|4k)$/i;

/**
 * Prices one request from the model's published SKUs: per second in dollars ("duration_seconds"),
 * per second in cents ("cents_per_second_output"), or per video token (Seedance, about
 * width × height × fps × seconds / 1024), choosing the SKU that matches the mode, resolution and
 * sound most specifically. The bill reported when the job finishes replaces this estimate.
 */
export function priceOpenRouter(
  m: OpenRouterModel,
  used: UsedSettings,
  mode: 'text' | 'image',
  aspectRatio: string,
): { cents: number | null; note: string } {
  const skus = m.pricing_skus ?? {};
  const seconds = used.duration ?? 0;
  const res = (used.resolution ?? '').toLowerCase();
  const audio = used.audio ?? false;
  type Candidate = { key: string; value: number; unit: 'usd_s' | 'cents_s' | 'usd_token'; score: number };
  const candidates: Candidate[] = [];
  for (const [key, raw] of Object.entries(skus)) {
    const value = Number(raw);
    if (!Number.isFinite(value) || IGNORED.test(key)) continue;
    let rest = key;
    let score = 0;
    if (rest.startsWith('text_to_video_')) {
      if (mode !== 'text') continue;
      rest = rest.slice('text_to_video_'.length);
      score += 1;
    } else if (rest.startsWith('image_to_video_')) {
      if (mode !== 'image') continue;
      rest = rest.slice('image_to_video_'.length);
      score += 1;
    }
    const resMatch = rest.match(RES_TOKEN);
    if (resMatch) {
      if (resMatch[1].toLowerCase() !== res) continue;
      rest = rest.slice(0, -resMatch[0].length);
      score += 2;
    }
    if (rest.endsWith('_with_audio')) {
      if (!audio) continue;
      rest = rest.slice(0, -'_with_audio'.length);
      score += 1;
    } else if (rest.endsWith('_without_audio')) {
      if (audio) continue;
      rest = rest.slice(0, -'_without_audio'.length);
      score += 1;
    }
    const unit =
      rest === 'duration_seconds'
        ? 'usd_s'
        : rest === 'cents_per_second_output' || rest === 'cents_per_video_output_second'
          ? 'cents_s'
          : rest === 'video_tokens'
            ? 'usd_token'
            : null;
    if (unit) candidates.push({ key, value, unit, score });
  }
  // A SKU with no sound marker is the silent price when the model also lists a "with audio" one
  // (Kling: duration_seconds_with_audio beside text_to_video_duration_seconds_720p).
  const audioSpecific = candidates.some((c) => /_with_audio/.test(c.key));
  const usable = audio && audioSpecific ? candidates.filter((c) => /_with_audio/.test(c.key)) : candidates;
  const best = usable.sort((a, b) => b.score - a.score)[0];
  if (!best || !seconds) return { cents: null, note: 'OpenRouter lists no per-second price for these settings' };
  let cents: number;
  let note: string;
  if (best.unit === 'usd_s') {
    cents = best.value * seconds * 100;
    note = `OpenRouter’s listed rate, $${best.value} per second`;
  } else if (best.unit === 'cents_s') {
    cents = best.value * seconds;
    note = `OpenRouter’s listed rate, ${best.value}¢ per second`;
  } else {
    const { w, h } = frameSize(used.resolution ?? '720p', aspectRatio);
    const tokens = (w * h * 24 * seconds) / 1024;
    cents = tokens * best.value * 100;
    note = `OpenRouter’s token rate for a ${w}×${h}, 24 fps clip`;
  }
  const minimum = Number(skus.minimum_cents_per_generation);
  if (Number.isFinite(minimum) && minimum > cents) cents = minimum;
  return { cents: wholeCents(cents), note: `${note}; the bill replaces it` };
}

async function call(key: string, url: string, init: RequestInit, fetcher: typeof fetch) {
  return fetcher(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
  });
}

async function detail(response: Response) {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const e = typeof body.error === 'string' ? body.error : body.error?.message;
    return String(e ?? body.message ?? text).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

export async function submitOpenRouter(
  key: string,
  _endpoint: string,
  input: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<StudioSubmission> {
  let response: Response;
  try {
    response = await call(key, `${API}videos`, { method: 'POST', body: JSON.stringify(input) }, fetcher);
  } catch {
    throw new GateError('UNKNOWN_SUBMISSION', 'OpenRouter did not answer. Check its activity page before retrying.');
  }
  if (response.status === 401) throw new GateError('AUTH_REQUIRED', 'OpenRouter rejected the key');
  if (response.status === 402)
    throw new GateError('BUDGET_EXCEEDED', 'Your OpenRouter account is out of credits. Top up at openrouter.ai/credits.');
  if (response.status === 400 || response.status === 422)
    throw new GateError('INVALID_INPUT', `OpenRouter rejected the shot settings: ${await detail(response)}`);
  if (!response.ok) throw classifyHttp(response.status, true);
  const body = z
    .object({ id: z.string().regex(/^[\w-]{4,128}$/), polling_url: z.string().nullish() })
    .parse(await response.json());
  const statusUrl = openRouterUrl(body.polling_url ?? `${API}videos/${body.id}`).toString();
  return { requestId: body.id, statusUrl, responseUrl: statusUrl };
}

function openRouterUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== 'openrouter.ai' || url.port)
    throw new GateError('UNSAFE_MEDIA_URL', 'OpenRouter returned an unexpected URL');
  return url;
}

const pollSchema = z.object({
  status: z.string(),
  unsigned_urls: z.array(z.string()).nullish(),
  error: z.union([z.string(), z.object({ message: z.string().nullish() })]).nullish(),
  usage: z.object({ cost: z.number().nullish() }).nullish(),
});

export async function pollOpenRouter(
  key: string,
  statusUrl: string,
  _responseUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<StudioPoll> {
  const response = await call(key, openRouterUrl(statusUrl).toString(), {}, fetcher);
  if (response.status === 401) throw new GateError('AUTH_REQUIRED', 'OpenRouter rejected the key');
  if (!response.ok) throw classifyHttp(response.status);
  const body = pollSchema.parse(await response.json());
  const status = body.status.toLowerCase();
  if (status === 'pending' || status === 'queued') return { state: 'RUNNING', phase: 'queued' };
  if (status === 'in_progress' || status === 'processing') return { state: 'RUNNING', phase: 'running' };
  if (status === 'completed') {
    const videoUrl = body.unsigned_urls?.[0] ?? `${statusUrl.replace(/\/$/, '')}/content?index=0`;
    const cost = body.usage?.cost;
    return {
      state: 'COMPLETE',
      videoUrl,
      billedCents: typeof cost === 'number' && cost >= 0 ? Math.round(cost * 10000) / 100 : undefined,
    };
  }
  const message = typeof body.error === 'string' ? body.error : body.error?.message;
  return { state: 'FAILED', error: `OpenRouter: ${message || status}`.slice(0, 400) };
}

/** Downloads a finished video; OpenRouter's own links need the key, other HTTPS hosts do not. */
export async function downloadOpenRouter(key: string, raw: string, fetcher: typeof fetch = fetch) {
  const url = new URL(raw);
  const host = url.hostname;
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    isIP(host) ||
    /(^|\.)(localhost|local|internal)$/.test(host)
  )
    throw new GateError('UNSAFE_MEDIA_URL', 'OpenRouter returned an unsupported media URL');
  const response = await fetcher(url, {
    headers: host === 'openrouter.ai' ? { Authorization: `Bearer ${key}` } : {},
    redirect: 'follow',
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new GateError('MEDIA_DOWNLOAD_FAILED', 'Could not download the OpenRouter video');
  const limit = 200 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit)
    throw new GateError('MEDIA_TOO_LARGE', 'Provider output exceeds 200 MB');
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > limit) throw new GateError('MEDIA_TOO_LARGE', 'Provider output exceeds 200 MB');
  return body;
}

/** Checks a key with OpenRouter's free key-info endpoint. */
export async function verifyOpenRouterKey(key: string, fetcher: typeof fetch = fetch) {
  let response: Response;
  try {
    response = await call(key, `${API}key`, {}, fetcher);
  } catch {
    throw new GateError('RETRYABLE_NETWORK', 'OpenRouter is unreachable. Try again in a moment.');
  }
  if (response.status === 401 || response.status === 403)
    throw new GateError('AUTH_REQUIRED', 'OpenRouter rejected this key.');
  if (!response.ok) throw classifyHttp(response.status);
  return true as const;
}
