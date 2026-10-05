import { z } from 'zod';
import { GateError } from '../lib/contracts';
import { parseInputSpec, type InputSpec, type UsedSettings } from '../lib/fal-schema';
import { classifyHttp, wholeCents } from './http';
import type { StudioPoll, StudioSubmission } from './studio-providers';

// Replicate (docs: reference/http, read 5 October 2026). Video models are listed by collection
// (text-to-video, image-to-video), each with an OpenAPI input schema, so the same snapping as fal
// applies. Replicate's API returns no prices or bills, so prices come from the billing table each
// public model page publishes: output-priced models charge per second (or per video) by resolution,
// sound and variant; community models charge GPU time. Predictions report their own queue and run
// times, and the cost after a render is computed from those published rates.

const API = 'https://api.replicate.com/v1/';
export const REPLICATE_CATEGORIES = { text: 'text-to-video', image: 'image-to-video' } as const;

const modelSchema = z.object({
  owner: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  cover_image_url: z.string().nullish(),
  latest_version: z.object({ id: z.string(), openapi_schema: z.unknown().nullish() }).nullish(),
});
export type ReplicateModel = z.infer<typeof modelSchema> & { slug: string };

// The latest version of each listed model, for community models that only run by version.
const versions = new Map<string, string>();

async function call(key: string, url: string, init: RequestInit, fetcher: typeof fetch) {
  return fetcher(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(init.body ? { 'Content-Type': 'application/json', 'Cancel-After': '45m' } : {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
  });
}

/** The models in one Replicate collection, with their input schemas. Needs a key. */
export async function replicateCollection(key: string, slug: string, fetcher: typeof fetch = fetch) {
  let response: Response;
  try {
    response = await call(key, `${API}collections/${encodeURIComponent(slug)}`, {}, fetcher);
  } catch {
    throw new GateError('RETRYABLE_NETWORK', 'Replicate is unreachable. Try again in a moment.');
  }
  if (response.status === 401) throw new GateError('AUTH_REQUIRED', 'Replicate rejected the key');
  if (!response.ok) throw classifyHttp(response.status);
  const body = z.object({ models: z.array(z.unknown()) }).parse(await response.json());
  return body.models.flatMap((m) => {
    const parsed = modelSchema.safeParse(m);
    if (!parsed.success) return [];
    const slug = `${parsed.data.owner}/${parsed.data.name}`;
    if (parsed.data.latest_version?.id) versions.set(slug, parsed.data.latest_version.id);
    return [{ ...parsed.data, slug }];
  });
}

/** Replicate's schema (components.schemas.Input) read the same way as fal's. */
export function replicateInputSpec(model: ReplicateModel): InputSpec {
  const schema = model.latest_version?.openapi_schema as { components?: { schemas?: unknown } } | undefined;
  if (!schema?.components?.schemas) return { props: {}, required: [], blocker: 'Replicate did not publish this model’s inputs' };
  return parseInputSpec({
    components: schema.components,
    paths: {
      '/predictions': {
        post: {
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Input' } } } },
        },
      },
    },
  });
}

// --- Prices, from the public model page ---------------------------------------------------

const criterion = z.object({ title: z.string().nullish(), type: z.string().nullish(), value: z.unknown() });
const tierSchema = z.object({
  criteria: z.array(criterion).nullish(),
  prices: z.array(z.object({ metric: z.string(), price: z.string() })),
});
export type ReplicatePricing = {
  tiers: z.infer<typeof tierSchema>[];
  /** GPU-time rate in dollars per second, for models billed by hardware. */
  hardwarePerSecond: number | null;
  /** Replicate's median cost per run, shown for hardware-billed models. */
  typicalUsd: number | null;
};

const dollars = (s: string | null | undefined) => {
  const m = s?.match(/\$\s*([\d.]+)/);
  return m ? Number(m[1]) : null;
};

/** Reads the billing table embedded in a model page's HTML. Pure, so it is unit tested. */
export function parseReplicatePricing(html: string): ReplicatePricing {
  const out: ReplicatePricing = { tiers: [], hardwarePerSecond: null, typicalUsd: null };
  const at = html.indexOf('"billingConfig":');
  if (at >= 0) {
    const start = html.indexOf('{', at);
    let depth = 0;
    let end = -1;
    let inString = false;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (inString) {
        if (c === '\\') i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end > start) {
      try {
        const config = JSON.parse(html.slice(start, end + 1)) as { current_tiers?: unknown[] };
        out.tiers = (config.current_tiers ?? []).flatMap((t) => {
          const parsed = tierSchema.safeParse(t);
          return parsed.success ? [parsed.data] : [];
        });
      } catch {}
    }
  }
  const price = html.match(/"price": "([^"]*)"/)?.[1];
  if (price && /per second/i.test(price) && !out.tiers.length) out.hardwarePerSecond = dollars(price);
  out.typicalUsd = dollars(html.match(/"p50price": "([^"]*)"/)?.[1]);
  return out;
}

const pages = new Map<string, { at: number; value: Promise<ReplicatePricing> }>();
/** The model's published prices; the page is public, so no key is needed. Cached for six hours. */
export function replicatePricing(slug: string, fetcher: typeof fetch = fetch) {
  if (!/^[a-z0-9-]+\/[a-z0-9._-]+$/i.test(slug)) throw new GateError('INVALID_INPUT', 'Unexpected Replicate model');
  const hit = pages.get(slug);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.value;
  const value = fetcher(`https://replicate.com/${slug}`, {
    headers: { 'User-Agent': 'GenMediaBenchmark (+https://github.com/ZakKrevitt/GenMediaBenchmark)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  }).then(async (r) => (r.ok ? parseReplicatePricing(await r.text()) : { tiers: [], hardwarePerSecond: null, typicalUsd: null }));
  value.catch(() => pages.delete(slug));
  pages.set(slug, { at: Date.now(), value });
  if (pages.size > 400) pages.delete(pages.keys().next().value!);
  return value;
}

const norm = (v: unknown) => String(v).toLowerCase().replace(/\s+/g, '');

/**
 * Prices one request from the published tiers: the first tier whose conditions all hold for
 * these settings. Conditions name the sound, the resolution, the length, or a "model variant",
 * which is read from the sound, from video input (never, here), or from the request's own value
 * for an input that offers that variant.
 */
export function priceReplicate(
  pricing: ReplicatePricing,
  used: UsedSettings,
  input: Record<string, unknown>,
  spec: InputSpec,
): { cents: number | null; note: string } {
  const seconds = used.duration;
  const holds = (c: z.infer<typeof criterion>) => {
    const title = norm(c.title ?? '');
    const value = c.value;
    if (title === 'withaudio') return used.audio === null ? value === false : value === used.audio;
    if (title === 'targetresolution') return used.resolution !== null && norm(value) === norm(used.resolution);
    if (title === 'secondofoutputvideo') return seconds !== null && Number(value) === seconds;
    if (title === 'modelvariant') {
      const v = norm(value);
      if (v === 'with_audio') return used.audio === true;
      if (v === 'without_audio') return used.audio !== true;
      if (v === 'video_in') return false;
      if (v === 'non_video_in') return true;
      // A variant that is an option of one of the inputs: holds if this request picked it.
      const owner = Object.entries(spec.props).find(([, p]) => p.enum?.some((e) => norm(e) === v));
      return owner ? norm(input[owner[0]] ?? owner[1].default) === v : false;
    }
    return false;
  };
  for (const tier of pricing.tiers) {
    if (!(tier.criteria ?? []).every(holds)) continue;
    let cents = 0;
    for (const p of tier.prices) {
      const usd = dollars(p.price);
      if (usd === null) return { cents: null, note: 'Replicate’s price for these settings is not per second or per video' };
      if (p.metric === 'video_output_duration_seconds' && seconds) cents += usd * seconds * 100;
      else if (p.metric === 'video_output_count') cents += usd * 100;
      else return { cents: null, note: `Replicate prices this model by ${p.metric.replaceAll('_', ' ')}` };
    }
    return { cents: wholeCents(cents), note: 'Replicate’s published rate for these settings' };
  }
  if (pricing.hardwarePerSecond !== null && pricing.typicalUsd !== null)
    return {
      cents: wholeCents(pricing.typicalUsd * 100),
      note: `Billed by GPU time ($${pricing.hardwarePerSecond}/s); Replicate’s typical run, replaced by this run’s time`,
    };
  return { cents: null, note: 'Replicate publishes no price for these settings' };
}

/** What a finished run cost at Replicate's published rates. */
export function replicateRunCents(pricing: ReplicatePricing, estimate: number, predictSeconds: number | null) {
  if (pricing.hardwarePerSecond !== null && predictSeconds !== null)
    return Math.round(pricing.hardwarePerSecond * predictSeconds * 10000) / 100;
  return estimate;
}

// --- Predictions ---------------------------------------------------------------------------

const predictionSchema = z.object({
  id: z.string().regex(/^[\w-]{4,128}$/),
  status: z.string(),
  output: z.unknown().optional(),
  error: z.unknown().optional(),
  created_at: z.string().nullish(),
  started_at: z.string().nullish(),
  completed_at: z.string().nullish(),
  metrics: z.object({ predict_time: z.number().nullish() }).nullish(),
  urls: z.object({ get: z.string(), cancel: z.string().nullish() }),
});

function replicateUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== 'api.replicate.com' || url.port)
    throw new GateError('UNSAFE_MEDIA_URL', 'Replicate returned an unexpected URL');
  return url;
}

async function detail(response: Response) {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { detail?: unknown; title?: string };
    return String(body.detail ?? body.title ?? text).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/** Runs an official model by name, or a community model by its latest version. */
export async function submitReplicate(
  key: string,
  endpoint: string,
  input: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
  version = versions.get(endpoint),
): Promise<StudioSubmission> {
  const [owner, name] = endpoint.split('/');
  const attempt = (url: string, body: unknown) =>
    call(key, url, { method: 'POST', body: JSON.stringify(body) }, fetcher).catch(() => {
      throw new GateError('UNKNOWN_SUBMISSION', 'Replicate did not answer. Check its predictions page before retrying.');
    });
  let response = await attempt(`${API}models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/predictions`, { input });
  // Community models only run by version; a refused request created nothing, so retrying is safe.
  if ((response.status === 404 || response.status === 422) && version)
    response = await attempt(`${API}predictions`, { version, input });
  if (response.status === 401) throw new GateError('AUTH_REQUIRED', 'Replicate rejected the key');
  if (response.status === 402)
    throw new GateError('BUDGET_EXCEEDED', 'Your Replicate account needs billing set up or credit. See replicate.com/account/billing.');
  if (response.status === 400 || response.status === 422)
    throw new GateError('INVALID_INPUT', `Replicate rejected the shot settings: ${await detail(response)}`);
  if (!response.ok) throw classifyHttp(response.status, true);
  const p = predictionSchema.parse(await response.json());
  const statusUrl = replicateUrl(p.urls.get).toString();
  return { requestId: p.id, statusUrl, responseUrl: statusUrl };
}

const seconds = (from?: string | null, to?: string | null) =>
  from && to ? Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 100) / 10) : null;

export async function pollReplicate(
  key: string,
  statusUrl: string,
  _responseUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<StudioPoll> {
  const response = await call(key, replicateUrl(statusUrl).toString(), {}, fetcher);
  if (response.status === 401) throw new GateError('AUTH_REQUIRED', 'Replicate rejected the key');
  if (!response.ok) throw classifyHttp(response.status);
  const p = predictionSchema.parse(await response.json());
  if (p.status === 'starting') return { state: 'RUNNING', phase: 'queued' };
  if (p.status === 'processing') return { state: 'RUNNING', phase: 'running' };
  if (p.status === 'succeeded') {
    const out = Array.isArray(p.output) ? p.output.find((o) => typeof o === 'string') : p.output;
    if (typeof out !== 'string') return { state: 'FAILED', error: 'Replicate returned no video' };
    return {
      state: 'COMPLETE',
      videoUrl: out,
      timing: {
        queueSeconds: seconds(p.created_at, p.started_at),
        runSeconds: p.metrics?.predict_time ?? seconds(p.started_at, p.completed_at),
      },
    };
  }
  const error = typeof p.error === 'string' ? p.error : p.status === 'canceled' ? 'Canceled' : 'failed';
  return { state: 'FAILED', error: `Replicate: ${error}`.slice(0, 400) };
}

/** Replicate serves outputs from its delivery CDN without a key. */
export async function downloadReplicate(_key: string, raw: string, fetcher: typeof fetch = fetch) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.port || !/(^|\.)replicate\.delivery$/.test(url.hostname))
    throw new GateError('UNSAFE_MEDIA_URL', 'Replicate returned an unsupported media host');
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new GateError('MEDIA_DOWNLOAD_FAILED', 'Could not download the Replicate video');
  const limit = 200 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit)
    throw new GateError('MEDIA_TOO_LARGE', 'Provider output exceeds 200 MB');
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > limit) throw new GateError('MEDIA_TOO_LARGE', 'Provider output exceeds 200 MB');
  return body;
}

export async function verifyReplicateKey(key: string, fetcher: typeof fetch = fetch) {
  let response: Response;
  try {
    response = await call(key, `${API}account`, {}, fetcher);
  } catch {
    throw new GateError('RETRYABLE_NETWORK', 'Replicate is unreachable. Try again in a moment.');
  }
  if (response.status === 401 || response.status === 403)
    throw new GateError('AUTH_REQUIRED', 'Replicate rejected this key.');
  if (!response.ok) throw classifyHttp(response.status);
  return true as const;
}
