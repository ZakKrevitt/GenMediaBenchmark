import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit, one, pool, rows, transaction } from '../lib/db';
import { GateError } from '../lib/contracts';
import { dailyCapCents, spentTodayCents } from '../lib/spend';
import {
  ASPECTS,
  RESOLUTIONS,
  directionSchema,
  type BenchProvider,
  type Direction,
} from '../lib/studio';
import { MODELS, fitToModel, modeFor, type GenModel } from '../lib/production-models';
import {
  blockerFor,
  buildGenericInput,
  centsForUnit,
  centsFromRateDescription,
  parseHiggsfieldParams,
  parseInputSpec,
  type InputSpec,
  type UsedSettings,
} from '../lib/fal-schema';
import { studioProviders } from '../providers/studio-providers';
import { estimateHiggsfield, submitHiggsfield, uploadHiggsfield } from '../providers/higgsfield';
import { falKey, higgsfieldKey, openrouterKey, replicateKey } from '../lib/fal-key';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAsset, putAsset, withAssetPath } from '../lib/storage';
import { btIntervals, btRatings, shrunkRating, type Vote } from '../lib/rating';
import { judgeCents, type Verdict } from './benchmark-judge';
import { settings } from '../lib/config';
import { runMedia } from '../lib/media';
import {
  analysisArgs,
  parseAnalysis,
  stripArgs,
  type VideoAnalysis,
} from '../media/video-analysis';
import { higgsfieldCatalog } from './model-catalog';
import {
  buildOpenRouterInput,
  openRouterBlocker,
  openRouterVideoModels,
  priceOpenRouter,
  type OpenRouterModel,
} from '../providers/openrouter';
import {
  REPLICATE_CATEGORIES,
  priceReplicate,
  replicateCollection,
  replicateInputSpec,
  replicatePricing,
  type ReplicateModel,
} from '../providers/replicate';

// Benchmarks render one prompt on many fal, Higgsfield, OpenRouter and Replicate video models. Curated models use their
// tuned request builders; every other text-to-video endpoint is driven from its published
// parameters (fal's OpenAPI schema, Higgsfield's docs page). fal is priced from its pricing API,
// Higgsfield from its free per-request quote. Every render is recorded before submission and
// counts toward the daily spend limit. After a fal render ends, its request record and billing
// event supply exact queue time, run time and the billed cost; Higgsfield's split comes from the
// poller seeing the render start.

export const benchSettingsSchema = z.object({
  duration: z.number().int().min(2).max(20).default(5),
  aspectRatio: z.enum(ASPECTS).default('9:16'),
  resolution: z.enum(RESOLUTIONS).default('720p'),
  audio: z.boolean().default(true),
  seed: z.number().int().min(0).max(2147483647).nullable().default(null),
  /** Renders per model per prompt, to see how much a model varies. */
  takes: z.number().int().min(1).max(3).default(1),
  /** Only models that render exactly this duration, so costs compare like for like. */
  exactDuration: z.boolean().default(true),
  /** A start image turns the benchmark into image-to-video. */
  firstFrameId: z.string().uuid().nullable().default(null),
});
export type BenchRunSettings = z.infer<typeof benchSettingsSchema>;

export type BenchModel = {
  /** provider:endpoint, since the same endpoint can exist on both providers. */
  id: string;
  provider: BenchProvider;
  endpoint: string;
  name: string;
  maker: string | null;
  /** A production studio model with a tuned request and a published price. */
  studioModel: string | null;
  thumbnail: string | null;
  blocker: string | null;
  used: UsedSettings;
  cents: number | null;
  priceNote: string;
  /** First listed within the last two weeks, after the benchmark's first look at the catalogue. */
  isNew?: boolean;
  firstSeen?: string | null;
  /** Blocked only because it cannot render exactly the requested duration. */
  lengthMismatch?: boolean;
};

// Renders whose price fal cannot predict hold this much of the daily limit until the billing
// event arrives.
export const UNPRICED_HOLD_CENTS = 200;

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 600) cache.delete(cache.keys().next().value!);
  return value;
}

async function getJson(
  url: string,
  key: string | undefined,
  fetcher: typeof fetch,
  init: RequestInit = {},
) {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      headers: {
        ...(key ? { Authorization: `Key ${key}` } : {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new GateError('RETRYABLE_NETWORK', 'fal is unreachable. Try again in a moment.');
  }
  if (response.status === 429)
    throw new GateError('RATE_LIMITED', 'fal is rate limiting. Wait a few seconds.');
  if (!response.ok) throw new GateError('RETRYABLE_PROVIDER', `fal returned ${response.status}`);
  return response.json() as Promise<unknown>;
}

const catalogPage = z.object({
  models: z.array(
    z.object({
      endpoint_id: z.string(),
      metadata: z
        .object({
          display_name: z.string().nullish(),
          thumbnail_url: z.string().nullish(),
          group: z.object({ label: z.string().nullish() }).nullish(),
        })
        .passthrough()
        .nullish(),
    }),
  ),
  next_cursor: z.string().nullish(),
  has_more: z.boolean().nullish(),
});
type CatalogEntry = {
  endpoint: string;
  name: string;
  maker: string | null;
  thumbnail: string | null;
};

type Mode = 'text' | 'image';
const modeOf = (s: Pick<BenchRunSettings, 'firstFrameId'>): Mode =>
  s.firstFrameId ? 'image' : 'text';
const CATEGORY: Record<Mode, string> = { text: 'text-to-video', image: 'image-to-video' };

// The last full list per category, served when fal's search is briefly unavailable or rate limited.
const lastCatalog = new Map<string, CatalogEntry[]>();

/** Every active fal text-to-video (or image-to-video) endpoint. */
export async function falVideoCatalog(fetcher: typeof fetch = fetch, category = 'text-to-video') {
  try {
    const list = await loadFalCatalog(fetcher, category);
    lastCatalog.set(category, list);
    return { list, stale: false };
  } catch (error) {
    const last = lastCatalog.get(category);
    if (last) return { list: last, stale: true };
    throw error;
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
function loadFalCatalog(fetcher: typeof fetch, category: string) {
  return cached(`bench:catalog:${category}`, 30 * 60_000, async () => {
    const key = await falKey().catch(() => undefined);
    const out: CatalogEntry[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page++) {
      const params = new URLSearchParams({ category, status: 'active', limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const url = `https://api.fal.ai/v1/models?${params}`;
      // The search is public; a key only raises the rate limit, so a rejected key falls back.
      // A rate limit gets one short retry.
      const get = () =>
        getJson(url, key, fetcher).catch((error) =>
          key && !(error instanceof GateError && error.code === 'RATE_LIMITED')
            ? getJson(url, undefined, fetcher)
            : Promise.reject(error),
        );
      const body = catalogPage.parse(
        await get().catch(async (error) => {
          if (!(error instanceof GateError && error.code === 'RATE_LIMITED')) throw error;
          await pause(fetcher === fetch ? 2000 : 0);
          return get();
        }),
      );
      for (const m of body.models)
        out.push({
          endpoint: m.endpoint_id,
          name: m.metadata?.display_name || m.endpoint_id,
          maker: m.metadata?.group?.label ?? null,
          thumbnail: m.metadata?.thumbnail_url?.startsWith('https://')
            ? m.metadata.thumbnail_url
            : null,
        });
      cursor = body.has_more === false ? null : (body.next_cursor ?? null);
      if (!cursor) break;
    }
    return out;
  });
}

const endpointId = z.string().regex(/^[a-z0-9][a-z0-9._/-]{2,159}$/i);

export function falInputSpec(endpoint: string, fetcher: typeof fetch = fetch): Promise<InputSpec> {
  endpointId.parse(endpoint);
  return cached(`bench:schema:${endpoint}`, 6 * 3600_000, async () =>
    parseInputSpec(
      await getJson(
        `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${encodeURIComponent(endpoint)}`,
        undefined,
        fetcher,
      ),
    ),
  );
}

const pricing = z.object({
  prices: z.array(z.object({ endpoint_id: z.string(), unit_price: z.number(), unit: z.string() })),
});
async function falUnitPrices(ids: string[], fetcher: typeof fetch) {
  const key = await falKey().catch(() => undefined);
  const out = new Map<string, { unitPrice: number; unit: string }>();
  if (!key) return out;
  for (let i = 0; i < ids.length; i += 40) {
    const batch = ids.slice(i, i + 40).sort();
    const query = batch.map((id) => `endpoint_id=${encodeURIComponent(id)}`).join('&');
    try {
      const body = pricing.parse(
        await cached(`bench:prices:${query}`, 6 * 3600_000, () =>
          getJson(`https://api.fal.ai/v1/models/pricing?${query}`, key, fetcher),
        ),
      );
      for (const p of body.prices)
        out.set(p.endpoint_id, { unitPrice: p.unit_price, unit: p.unit });
    } catch {}
  }
  return out;
}

// fal's average billed cost per call for an endpoint, for units the request cannot predict
// (tokens, megapixels, compute seconds). It reflects typical use, not these exact settings.
async function falHistoricalCents(endpoint: string, fetcher: typeof fetch) {
  const key = await falKey().catch(() => undefined);
  if (!key) return null;
  try {
    const body = z.object({ total_cost: z.number() }).parse(
      await cached(`bench:estimate:${endpoint}`, 6 * 3600_000, () =>
        getJson('https://api.fal.ai/v1/models/pricing/estimate', key, fetcher, {
          method: 'POST',
          body: JSON.stringify({
            estimate_type: 'historical_api_price',
            endpoints: { [endpoint]: { call_quantity: 1 } },
          }),
        }),
      ),
    );
    return body.total_cost > 0 ? Math.max(1, Math.ceil(body.total_cost * 100)) : null;
  } catch {
    return null;
  }
}

async function inBatches<T, R>(
  items: T[],
  size: number,
  fn: (item: T, index: number) => Promise<R>,
) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const studioEndpoint = (m: GenModel, mode: Mode) => m.endpoints[mode];
const studioModels = (provider: BenchProvider, mode: Mode) =>
  MODELS.filter((m) => m.provider === provider && studioEndpoint(m, mode));
// Listing builds requests without sending them; only Higgsfield quotes need a real image URL.
const PLACEHOLDER_IMAGE = 'https://placeholder.invalid/start-frame.jpg';

// The start image as each provider takes it: inline for fal, an upload slot for Higgsfield (made
// once per image and reused for quotes and renders).
const hfFrames = new Map<string, Promise<string>>();
async function startImage(provider: BenchProvider, frameId: string, hfKey?: string) {
  const ref = await one<{ image_key: string; content_type: string }>(
    'SELECT image_key,content_type FROM start_images WHERE id=$1',
    [frameId],
  ).catch(() => {
    throw new GateError('INVALID_INPUT', 'The start image was removed. Add it again.');
  });
  if (provider === 'fal' || provider === 'openrouter')
    return `data:${ref.content_type};base64,${(await getAsset(ref.image_key)).toString('base64')}`;
  // Replicate takes inline images up to 256 KB, so the frame is shrunk to fit.
  if (provider === 'replicate') return smallJpeg(frameId, ref.image_key);
  const cachedUrl = hfFrames.get(frameId);
  if (cachedUrl) return cachedUrl;
  const upload = getAsset(ref.image_key).then((data) =>
    uploadHiggsfield(hfKey!, data, ref.content_type),
  );
  hfFrames.set(frameId, upload);
  upload.catch(() => hfFrames.delete(frameId));
  setTimeout(() => hfFrames.delete(frameId), 3600_000).unref?.();
  return upload;
}
const smallFrames = new Map<string, Promise<string>>();
function smallJpeg(frameId: string, imageKey: string) {
  const hit = smallFrames.get(frameId);
  if (hit) return hit;
  const made = (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-frame-'));
    try {
      for (const [width, quality] of [[1280, 4], [1024, 6], [768, 9]] as const) {
        const out = join(dir, `frame-${width}.jpg`);
        await withAssetPath(imageKey, (path) =>
          runMedia('ffmpeg', ['-y', '-v', 'error', '-i', path, '-vf', `scale='min(${width},iw)':-2`, '-q:v', String(quality), out]),
        );
        const data = await readFile(out);
        if (data.length <= 250 * 1024 || width === 768) return `data:image/jpeg;base64,${data.toString('base64')}`;
      }
      throw new GateError('INVALID_INPUT', 'The start image could not be made small enough for Replicate');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  smallFrames.set(frameId, made);
  made.catch(() => smallFrames.delete(frameId));
  return made;
}
// Inline images stay out of the stored request record.
const withoutInlineImages = (input: Record<string, unknown>) =>
  JSON.parse(
    JSON.stringify(input, (_k, v) =>
      typeof v === 'string' && v.startsWith('data:') ? '[start image]' : v,
    ),
  ) as Record<string, unknown>;
// Higgsfield quotes need a non-empty prompt; the price does not depend on its words.
const QUOTE_PROMPT = 'A calm lake at dawn';

function studioDirection(model: GenModel, prompt: string, s: BenchRunSettings): Direction {
  const base = directionSchema.parse({
    move: 'free',
    promptOverride: prompt || QUOTE_PROMPT,
    duration: s.duration,
    aspectRatio: s.aspectRatio,
    resolution: s.resolution,
    audio: s.audio,
    seed: s.seed,
    provider: model.provider,
    model: model.id,
    firstFrameId: s.firstFrameId,
  });
  const fitted = fitToModel(model, base);
  return { ...fitted, seed: model.seed ? s.seed : null };
}
const studioUsed = (m: GenModel, d: Direction): UsedSettings => ({
  duration: d.duration,
  aspectRatio: d.aspectRatio,
  resolution: m.fixedResolution ?? d.resolution,
  audio: d.audio,
});

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const modelKey = (provider: BenchProvider, endpoint: string) => `${provider}:${endpoint}`;

/** Higgsfield's request parameters for one endpoint, read from its docs page. */
export function higgsfieldInputSpec(
  docsUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<InputSpec> {
  const url = new URL(docsUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'docs.higgsfield.ai')
    throw new GateError('INVALID_INPUT', 'Unexpected Higgsfield docs URL');
  return cached(`bench:hf-spec:${url.pathname}`, 6 * 3600_000, async () => {
    let response: Response;
    try {
      response = await fetcher(
        `https://docs.higgsfield.ai${url.pathname.replace(/\.md$/, '')}.md`,
        {
          redirect: 'follow',
          signal: AbortSignal.timeout(20000),
        },
      );
    } catch {
      throw new GateError('RETRYABLE_NETWORK', 'Higgsfield docs are unreachable');
    }
    if (!response.ok)
      throw new GateError('RETRYABLE_PROVIDER', `Higgsfield docs returned ${response.status}`);
    return parseHiggsfieldParams(await response.text());
  });
}

// Higgsfield's estimate endpoint is free and prices the exact request for the account. A 400 or
// 422 means it would reject these settings, which is worth knowing before spending anything.
// Some models answer with a pricing rule instead of a figure; those are priced from the rule for
// this request's length, resolution and frame.
async function higgsfieldQuote(
  key: string,
  endpoint: string,
  input: Record<string, unknown>,
  shape: { duration: number; resolution: string; aspectRatio: string },
  fetcher: typeof fetch,
) {
  try {
    const quote = await cached(
      `bench:hf-quote:${endpoint}:${JSON.stringify(input)}`,
      30 * 60_000,
      () => estimateHiggsfield(key, endpoint, { ...input, prompt: QUOTE_PROMPT }, fetcher),
    );
    if (quote.cents === null && 'description' in quote && quote.description) {
      const cents = centsFromRateDescription(quote.description, shape);
      return {
        cents,
        credits: null,
        rejected: null as string | null,
        rule: cents === null ? null : quote.description,
      };
    }
    return {
      cents: quote.cents,
      credits: quote.credits,
      rejected: null as string | null,
      rule: null as string | null,
    };
  } catch (error) {
    if (error instanceof GateError && ['INVALID_INPUT', 'TERMINAL_PROVIDER'].includes(error.code))
      return { cents: null, credits: null, rejected: error.message, rule: null };
    return { cents: null, credits: null, rejected: null, rule: null };
  }
}

type Built = {
  input: Record<string, unknown>;
  used: UsedSettings;
  direction: Direction;
  model: string;
};

// The request one model gets for a prompt: the studio builder when the studio knows the model,
// otherwise its published parameters with every setting snapped to what it accepts.
function buildFor(
  provider: BenchProvider,
  endpoint: string,
  spec: InputSpec | null,
  prompt: string,
  s: BenchRunSettings,
  image?: string,
  openrouter?: OpenRouterModel,
): Built {
  const mode = modeOf(s);
  const studio = studioModels(provider, mode).find((m) => studioEndpoint(m, mode) === endpoint);
  if (studio) {
    const direction = studioDirection(studio, prompt, s);
    const used = studioUsed(studio, direction);
    return {
      input: studio.build(modeFor(studio, direction), direction, {
        prompt: prompt || QUOTE_PROMPT,
        firstFrame: mode === 'image' ? image : undefined,
        references: [],
      }),
      used: mode === 'image' ? { ...used, aspectRatio: 'from image' } : used,
      direction,
      model: studio.id,
    };
  }
  const built = openrouter
    ? buildOpenRouterInput(openrouter, prompt || QUOTE_PROMPT, s, mode === 'image' ? image : undefined)
    : buildGenericInput(spec!, { prompt: prompt || QUOTE_PROMPT, ...s }, mode === 'image' ? image : undefined);
  // The shot direction is stored as a record of what was asked; catalogue models have no studio
  // provider of their own there, so the benchmark provider is set after validation.
  const direction = {
    ...directionSchema.parse({
      move: 'free',
      promptOverride: prompt || QUOTE_PROMPT,
      duration: Math.min(20, Math.max(2, Math.round(built.used.duration ?? s.duration))),
      aspectRatio: s.aspectRatio,
      resolution: s.resolution,
      audio: built.used.audio ?? false,
      seed: s.seed,
      model: `${provider}-catalog`,
      firstFrameId: s.firstFrameId,
    }),
    provider,
  } as unknown as Direction;
  return { input: built.input, used: built.used, direction, model: endpoint };
}

async function falModels(
  s: BenchRunSettings,
  fetcher: typeof fetch,
  notes: string[],
): Promise<BenchModel[]> {
  const mode = modeOf(s);
  const catalog = await falVideoCatalog(fetcher, CATEGORY[mode])
    .then((r) => {
      if (r.stale)
        notes.push(
          'fal’s model list could not be refreshed, so this is the last list it returned.',
        );
      return r.list;
    })
    .catch((error) => {
      notes.push(
        error instanceof GateError && error.code === 'RATE_LIMITED'
          ? 'fal is rate limiting its model list, so only the curated fal models are shown. Try again in a minute.'
          : 'fal’s model list did not load, so only the curated fal models are shown. Try again in a minute.',
      );
      return [] as CatalogEntry[];
    });
  const studioFal = studioModels('fal', mode);
  const studioEndpoints = new Set(studioFal.map((m) => studioEndpoint(m, mode)!));
  const studio: BenchModel[] = studioFal.map((m) => {
    const endpoint = studioEndpoint(m, mode)!;
    const built = buildFor('fal', endpoint, null, '', s, PLACEHOLDER_IMAGE);
    const listed = catalog.find((c) => c.endpoint === endpoint);
    return {
      id: modelKey('fal', endpoint),
      provider: 'fal',
      endpoint,
      name: m.name,
      maker: m.maker,
      studioModel: m.id,
      thumbnail: listed?.thumbnail ?? null,
      blocker: null,
      used: built.used,
      cents: m.price ? m.price(built.direction) : null,
      priceNote: m.priceNote,
    };
  });
  const others = catalog.filter((c) => !studioEndpoints.has(c.endpoint));
  const [specs, prices] = await Promise.all([
    inBatches(others, 10, (c) => falInputSpec(c.endpoint, fetcher).catch(() => null)),
    falUnitPrices(
      others.map((c) => c.endpoint),
      fetcher,
    ),
  ]);
  const blockers = specs.map((spec) =>
    spec ? blockerFor(spec, mode) : 'fal did not return this model’s input schema',
  );
  const usedAll = specs.map((spec, i) =>
    spec && !blockers[i]
      ? buildGenericInput(
          spec,
          { prompt: '', ...s },
          mode === 'image' ? PLACEHOLDER_IMAGE : undefined,
        ).used
      : emptyUsed,
  );
  const unitCents = others.map((c, i) => {
    const price = prices.get(c.endpoint);
    return price ? centsForUnit(price.unit, price.unitPrice, usedAll[i].duration) : null;
  });
  const historical = await inBatches(others, 10, (c, i) =>
    unitCents[i] === null && !blockers[i]
      ? falHistoricalCents(c.endpoint, fetcher)
      : Promise.resolve(null),
  );
  return [
    ...studio,
    ...others.map((c, i): BenchModel => {
      const price = prices.get(c.endpoint);
      return {
        id: modelKey('fal', c.endpoint),
        provider: 'fal',
        endpoint: c.endpoint,
        name: c.name,
        maker: c.maker,
        studioModel: null,
        thumbnail: c.thumbnail,
        blocker: blockers[i],
        used: usedAll[i],
        cents: unitCents[i] ?? historical[i],
        priceNote:
          unitCents[i] !== null && price
            ? `$${price.unitPrice} per ${price.unit.replace(/s$/, '')}`
            : historical[i] !== null
              ? `fal’s average per call${price ? ` ($${price.unitPrice} per ${price.unit.replace(/s$/, '')})` : ''}; billed cost replaces it`
              : `Price unknown until billed; holds ${money(UNPRICED_HOLD_CENTS)} of the daily limit`,
      };
    }),
  ];
}

async function higgsfieldModels(
  s: BenchRunSettings,
  fetcher: typeof fetch,
  notes: string[],
): Promise<BenchModel[]> {
  const mode = modeOf(s);
  const key = await higgsfieldKey();
  const image =
    mode === 'image' && key
      ? await startImage('higgsfield', s.firstFrameId!, key).catch(() => PLACEHOLDER_IMAGE)
      : PLACEHOLDER_IMAGE;
  const catalog = (
    await higgsfieldCatalog({ category: CATEGORY[mode] }, fetcher).catch(() => {
      notes.push(
        'Higgsfield’s model list did not load, so only the curated Higgsfield models are shown.',
      );
      return { models: [] };
    })
  ).models;
  const studioHf = studioModels('higgsfield', mode);
  const entries = [
    ...studioHf.map((m) => ({
      endpoint: studioEndpoint(m, mode)!,
      name: m.name,
      maker: m.maker as string | null,
      docs: null as string | null,
      studio: m,
    })),
    ...catalog
      .filter((c) => !studioHf.some((m) => studioEndpoint(m, mode) === c.id))
      .map((c) => ({
        endpoint: c.id,
        name: c.name,
        maker: c.maker,
        docs: c.docs ?? null,
        studio: null as GenModel | null,
      })),
  ];
  const specs = await inBatches(entries, 8, (e) =>
    e.studio
      ? Promise.resolve(null)
      : e.docs
        ? higgsfieldInputSpec(e.docs, fetcher).catch(() => null)
        : Promise.resolve(null),
  );
  const built = entries.map((e, i) => {
    if (e.studio)
      return {
        built: buildFor('higgsfield', e.endpoint, null, '', s, image),
        blocker: null as string | null,
      };
    const spec = specs[i];
    if (!spec)
      return { built: null, blocker: 'Higgsfield did not publish this model’s parameters' };
    const blocker = blockerFor(spec, mode);
    if (blocker) return { built: null, blocker };
    return { built: buildFor('higgsfield', e.endpoint, spec, '', s, image), blocker: null };
  });
  const quotes = await inBatches(entries, 6, (e, i) =>
    key && built[i].built && (mode === 'text' || image !== PLACEHOLDER_IMAGE)
      ? higgsfieldQuote(
          key,
          e.endpoint,
          built[i].built!.input,
          {
            duration: built[i].built!.used.duration ?? s.duration,
            resolution: built[i].built!.used.resolution ?? s.resolution,
            aspectRatio:
              built[i].built!.used.aspectRatio &&
              /^\d+:\d+$/.test(built[i].built!.used.aspectRatio!)
                ? built[i].built!.used.aspectRatio!
                : s.aspectRatio,
          },
          fetcher,
        )
      : Promise.resolve(null),
  );
  return entries.map((e, i): BenchModel => {
    const quote = quotes[i];
    const blocker =
      built[i].blocker ??
      (quote?.rejected
        ? quote.rejected.replace(
            /^Higgsfield rejected the shot settings: /,
            'Rejects these settings: ',
          )
        : null);
    return {
      id: modelKey('higgsfield', e.endpoint),
      provider: 'higgsfield',
      endpoint: e.endpoint,
      name: e.name,
      maker: e.maker,
      studioModel: e.studio?.id ?? null,
      thumbnail: null,
      blocker,
      used: built[i].built?.used ?? emptyUsed,
      cents: quote?.cents ?? null,
      priceNote: !key
        ? 'Add HIGGSFIELD_KEY to .env.local to price and run this model'
        : quote?.cents != null && quote.rule
          ? `Higgsfield’s listed rate for these settings: ${quote.rule.split('. ')[0]}`
          : quote?.cents != null
            ? `Higgsfield’s quote for these settings${quote.credits != null ? ` (${quote.credits} credits)` : ''}`
            : `No quote from Higgsfield; holds ${money(UNPRICED_HOLD_CENTS)} of the daily limit`,
    };
  });
}

// The last good list per provider and mode, served when a provider's list briefly fails.
const lastLists = new Map<string, unknown>();
async function lastGood<T>(key: string, load: () => Promise<T>) {
  try {
    const value = await cached(key, 30 * 60_000, load);
    lastLists.set(key, value);
    return { value, stale: false };
  } catch (error) {
    if (lastLists.has(key)) return { value: lastLists.get(key) as T, stale: true };
    throw error;
  }
}

/** OpenRouter's video models, snapped and priced from the capabilities and SKUs it publishes. */
async function openRouterModels(s: BenchRunSettings, fetcher: typeof fetch, notes: string[]): Promise<BenchModel[]> {
  const mode = modeOf(s);
  const list = await lastGood('bench:openrouter:models', () => openRouterVideoModels(fetcher))
    .then((r) => {
      if (r.stale) notes.push('OpenRouter’s model list could not be refreshed, so this is the last list it returned.');
      return r.value;
    })
    .catch(() => {
      notes.push('OpenRouter’s model list did not load. Try again in a minute.');
      return [] as OpenRouterModel[];
    });
  return list.map((m): BenchModel => {
    const blocker = openRouterBlocker(m, mode);
    const built = blocker ? null : buildFor('openrouter', m.id, null, '', s, PLACEHOLDER_IMAGE, m);
    const price = built ? priceOpenRouter(m, built.used, mode, s.aspectRatio) : null;
    const [maker, ...rest] = m.name.split(': ');
    return {
      id: modelKey('openrouter', m.id),
      provider: 'openrouter',
      endpoint: m.id,
      // "Kling: Video v3.0 Pro" keeps its brand; "Google: Veo 3.1" reads as "Veo 3.1".
      name: rest.length ? (/^video\b/i.test(rest.join(': ')) ? `${maker} ${rest.join(': ')}` : rest.join(': ')) : m.name,
      maker: rest.length ? maker : (m.id.split('/')[0] ?? null),
      studioModel: null,
      thumbnail: null,
      blocker,
      used: built?.used ?? emptyUsed,
      cents: price?.cents ?? null,
      priceNote: price?.note ?? '',
    };
  });
}

export async function replicateModelsFor(key: string, mode: Mode, fetcher: typeof fetch) {
  return (await lastGood(`bench:replicate:${mode}`, () => replicateCollection(key, REPLICATE_CATEGORIES[mode], fetcher))).value;
}

/** Replicate's video models (its API needs a key even to list), priced from each model's page. */
async function replicateModels(s: BenchRunSettings, fetcher: typeof fetch, notes: string[]): Promise<BenchModel[]> {
  const mode = modeOf(s);
  const key = await replicateKey();
  if (!key) return [];
  const list = await replicateModelsFor(key, mode, fetcher).catch(() => {
    notes.push('Replicate’s model list did not load. Check the key, or try again in a minute.');
    return [] as ReplicateModel[];
  });
  return inBatches(list, 8, async (m): Promise<BenchModel> => {
    const spec = replicateInputSpec(m);
    const blocker = spec.blocker && !Object.keys(spec.props).length ? spec.blocker : blockerFor(spec, mode);
    const built = blocker ? null : buildFor('replicate', m.slug, spec, '', s, PLACEHOLDER_IMAGE);
    const price = built
      ? priceReplicate(await replicatePricing(m.slug, fetcher).catch(() => ({ tiers: [], hardwarePerSecond: null, typicalUsd: null })), built.used, built.input, spec)
      : null;
    return {
      id: modelKey('replicate', m.slug),
      provider: 'replicate',
      endpoint: m.slug,
      name: m.name,
      maker: m.owner,
      studioModel: null,
      thumbnail: m.cover_image_url?.startsWith('https://') && /\.(jpe?g|png|webp)$/i.test(m.cover_image_url) ? m.cover_image_url : null,
      blocker,
      used: built?.used ?? emptyUsed,
      cents: price?.cents ?? null,
      priceNote: price ? `${price.note}${price.cents === null ? `; holds ${money(UNPRICED_HOLD_CENTS)} of the daily limit` : ''}` : '',
    };
  });
}

const blockedLast = (list: BenchModel[]) =>
  [...list].sort(
    (a, b) =>
      Number(Boolean(a.blocker)) - Number(Boolean(b.blocker)) ||
      Number(!a.studioModel) - Number(!b.studioModel),
  );

const has = (key: () => Promise<string | undefined>) => key().then(Boolean).catch(() => false);

/** Every fal, Higgsfield, OpenRouter and Replicate video model a benchmark can run, priced and snapped to these settings. */
export async function benchmarkModels(raw: unknown, fetcher: typeof fetch = fetch) {
  const s = benchSettingsSchema.parse(raw ?? {});
  const notes: string[] = [];
  const [fal, hf, or, rep, falConnected, higgsfieldConnected, openrouterConnected, replicateConnected] =
    await Promise.all([
      falModels(s, fetcher, notes),
      higgsfieldModels(s, fetcher, notes),
      openRouterModels(s, fetcher, notes),
      replicateModels(s, fetcher, notes),
      has(falKey),
      has(higgsfieldKey),
      has(openrouterKey),
      has(replicateKey),
    ]);
  if (s.exactDuration)
    for (const m of [...fal, ...hf, ...or, ...rep]) {
      const blocker = durationBlocker(m, s.duration);
      if (blocker !== m.blocker) Object.assign(m, { blocker, lengthMismatch: true });
    }
  const models = [...blockedLast(fal), ...blockedLast(hf), ...blockedLast(or), ...blockedLast(rep)];
  const seen = await markSeen(models).catch(
    () => new Map<string, { firstSeen: string; isNew: boolean }>(),
  );
  for (const m of models) Object.assign(m, seen.get(m.id) ?? { isNew: false, firstSeen: null });
  const connected: Record<BenchProvider, boolean> = {
    fal: falConnected,
    higgsfield: higgsfieldConnected,
    openrouter: openrouterConnected,
    replicate: replicateConnected,
  };
  return { models, falConnected, higgsfieldConnected, connected, notes };
}
// With exact duration on, a model that would snap to another length (or picks its own) cannot run,
// so every render in the benchmark is the same length and their costs compare directly.
function durationBlocker(m: BenchModel, duration: number) {
  if (m.blocker || m.used.duration === duration) return m.blocker;
  return m.used.duration === null
    ? `Sets its own length, not exactly ${duration} s`
    : `Can’t make exactly ${duration} s (nearest is ${m.used.duration} s)`;
}
// Records the first sighting of each listed model. Anything first seen within a day of the
// provider's first listing is the baseline; later arrivals are new for two weeks.
async function markSeen(models: BenchModel[]) {
  const out = new Map<string, { firstSeen: string; isNew: boolean }>();
  for (const provider of ['fal', 'higgsfield', 'openrouter', 'replicate'] as const) {
    const list = models.filter((m) => m.provider === provider);
    if (!list.length) continue;
    await pool.query(
      `INSERT INTO benchmark_models_seen(provider,endpoint) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
      [provider, list.map((m) => m.endpoint)],
    );
    const rowsSeen = await rows<{ endpoint: string; first_seen: string; fresh: boolean }>(
      `SELECT endpoint, first_seen,
         (first_seen > now() - interval '14 days'
          AND first_seen > (SELECT min(first_seen) FROM benchmark_models_seen WHERE provider=$1) + interval '1 day') fresh
       FROM benchmark_models_seen WHERE provider=$1 AND endpoint = ANY($2::text[])`,
      [provider, list.map((m) => m.endpoint)],
    );
    for (const r of rowsSeen)
      out.set(modelKey(provider, r.endpoint), { firstSeen: r.first_seen, isNew: r.fresh });
  }
  return out;
}

const emptyUsed: UsedSettings = {
  duration: null,
  aspectRatio: null,
  resolution: null,
  audio: null,
};

const modelId = z.string().regex(/^(fal|higgsfield|openrouter|replicate):[a-z0-9][a-z0-9._/-]{2,159}$/i);
const createSchema = z
  .object({
    key: z.string().regex(/^[a-zA-Z0-9-]{16,64}$/),
    prompt: z.string().trim().min(3).max(3500).optional(),
    /** Several prompts make a suite: one benchmark per prompt, same models and settings. */
    prompts: z.array(z.string().trim().min(3).max(3500)).min(1).max(8).optional(),
    suiteName: z.string().trim().max(80).optional(),
    settings: benchSettingsSchema,
    models: z.array(modelId).min(1).max(200).optional(),
    /** Earlier pages sent bare fal endpoints. */
    endpoints: z.array(endpointId).min(1).max(150).optional(),
  })
  .transform(({ endpoints, models, prompt, prompts, ...rest }) => ({
    ...rest,
    prompts: [...new Set(prompts ?? (prompt ? [prompt] : []))],
    models: [...new Set(models ?? (endpoints ?? []).map((e) => modelKey('fal', e)))],
  }))
  .refine((v) => v.models.length > 0, 'Choose at least one model')
  .refine((v) => v.prompts.length > 0, 'Write a prompt');

type Planned = Built & {
  prompt: string;
  take: number;
  provider: BenchProvider;
  endpoint: string;
  name: string;
  cents: number;
  priced: boolean;
  /** Replicate's GPU rate for hardware-billed models, to cost the run from its time. */
  gpuPerSecond: number | null;
};

async function plan(
  input: z.infer<typeof createSchema>,
  keys: Partial<Record<BenchProvider, string>>,
  fetcher: typeof fetch,
): Promise<Planned[]> {
  const { models: listed } = await benchmarkModels(input.settings, fetcher);
  const frame = input.settings.firstFrameId;
  const images: Partial<Record<BenchProvider, string>> = {};
  if (frame)
    for (const provider of ['fal', 'higgsfield', 'openrouter', 'replicate'] as const)
      if (keys[provider]) images[provider] = await startImage(provider, frame, keys.higgsfield);
  const mode = modeOf(input.settings);
  const openRouterList = input.models.some((m) => m.startsWith('openrouter:'))
    ? await openRouterVideoModels(fetcher)
    : [];
  const perModel = await Promise.all(
    input.models.map(async (id) => {
      const entry = listed.find((m) => m.id === id);
      if (!entry)
        throw new GateError('INVALID_INPUT', `${id} is not available for this kind of benchmark`);
      if (entry.blocker)
        throw new GateError('INVALID_INPUT', `${entry.name}: ${entry.blocker.toLowerCase()}`);
      let spec: InputSpec | null = null;
      let openrouter: OpenRouterModel | undefined;
      let gpuPerSecond: number | null = null;
      if (entry.provider === 'openrouter') {
        openrouter = openRouterList.find((m) => m.id === entry.endpoint);
        if (!openrouter) throw new GateError('INVALID_INPUT', `${entry.name} is no longer listed by OpenRouter`);
      } else if (entry.provider === 'replicate') {
        const model = (await replicateModelsFor(keys.replicate!, mode, fetcher)).find((m) => m.slug === entry.endpoint);
        if (!model) throw new GateError('INVALID_INPUT', `${entry.name} is no longer listed by Replicate`);
        spec = replicateInputSpec(model);
        gpuPerSecond = (await replicatePricing(entry.endpoint, fetcher).catch(() => null))?.hardwarePerSecond ?? null;
      } else if (!entry.studioModel) {
        if (entry.provider === 'fal') spec = await falInputSpec(entry.endpoint, fetcher);
        else {
          const docs = (
            await higgsfieldCatalog({ category: CATEGORY[modeOf(input.settings)] }, fetcher)
          ).models.find((c) => c.id === entry.endpoint)?.docs;
          if (!docs)
            throw new GateError(
              'INVALID_INPUT',
              `${entry.name}: Higgsfield did not publish its parameters`,
            );
          spec = await higgsfieldInputSpec(docs, fetcher);
        }
      }
      return { entry, spec, openrouter, gpuPerSecond };
    }),
  );
  // Every prompt, then every model, then every take: renders of one prompt sit together.
  return input.prompts.flatMap((prompt) =>
    perModel.flatMap(({ entry, spec, openrouter, gpuPerSecond }) =>
      Array.from({ length: input.settings.takes }, (_, t) => ({
        ...buildFor(
          entry.provider,
          entry.endpoint,
          spec,
          prompt,
          input.settings,
          images[entry.provider],
          openrouter,
        ),
        prompt,
        take: t + 1,
        provider: entry.provider,
        endpoint: entry.endpoint,
        name: entry.name,
        cents: entry.cents ?? UNPRICED_HOLD_CENTS,
        priced: entry.cents !== null,
        gpuPerSecond,
      })),
    ),
  );
}

const KEYS: Record<BenchProvider, { load: () => Promise<string | undefined>; name: string }> = {
  fal: { load: falKey, name: 'fal' },
  higgsfield: { load: higgsfieldKey, name: 'Higgsfield' },
  openrouter: { load: openrouterKey, name: 'OpenRouter' },
  replicate: { load: replicateKey, name: 'Replicate' },
};

const pending = new Map<string, Promise<{ id: string }>>();
export function createBenchmark(raw: unknown, fetcher: typeof fetch = fetch) {
  const input = createSchema.parse(raw);
  return once(input.key, () => launch(input, null, fetcher));
}

const addSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9-]{16,64}$/),
  models: z.array(modelId).min(1).max(200),
});
/** Runs more models, a retry or another take on an existing benchmark's prompt and settings. */
export async function addToBenchmark(
  benchmarkId: string,
  raw: unknown,
  fetcher: typeof fetch = fetch,
) {
  const input = addSchema.parse(raw);
  const bench = await rows<{ prompt: string; settings: unknown }>(
    'SELECT prompt,settings FROM benchmarks WHERE id=$1',
    [benchmarkId],
  );
  if (!bench[0]) throw new GateError('INVALID_INPUT', 'That benchmark no longer exists');
  return once(input.key, () =>
    launch(
      {
        key: input.key,
        prompts: [bench[0].prompt],
        suiteName: undefined,
        settings: {
          ...benchSettingsSchema.parse(bench[0].settings),
          takes: 1,
          // Benchmarks from before exact duration existed keep snapping to each model's nearest length.
          exactDuration: (bench[0].settings as { exactDuration?: boolean }).exactDuration ?? false,
        },
        models: input.models,
      },
      benchmarkId,
      fetcher,
    ),
  );
}

function once(key: string, run: () => Promise<{ id: string }>) {
  const running = pending.get(key);
  if (running) return running;
  const job = run().finally(() => setTimeout(() => pending.delete(key), 10 * 60_000).unref?.());
  pending.set(key, job);
  return job;
}

// Records every render before any provider call, under the spend lock, then submits a few at a
// time. The request key makes a repeated press return the same benchmark instead of paying twice.
async function launch(
  input: z.infer<typeof createSchema>,
  benchmarkId: string | null,
  fetcher: typeof fetch,
) {
  const done = async (db: Pick<typeof pool, 'query'> = pool) =>
    benchmarkId
      ? (
          await rows<{ id: string }>(
            'SELECT benchmark_id id FROM renders WHERE idempotency_key LIKE $1 LIMIT 1',
            [`bench:${benchmarkId}:${input.key}:%`],
            db,
          )
        )[0]
      : (
          await rows<{ id: string }>(
            'SELECT id FROM benchmarks WHERE idempotency_key=$1',
            [input.key],
            db,
          )
        )[0];
  const existing = await done();
  if (existing) return { id: existing.id };
  const providers = new Set(input.models.map((m) => m.split(':')[0] as BenchProvider));
  const keys: Partial<Record<BenchProvider, string>> = {};
  for (const provider of providers) {
    const { load, name } = KEYS[provider];
    keys[provider] = await load();
    if (!keys[provider])
      throw new GateError(
        `${provider.toUpperCase()}_REQUIRED`,
        `Add your ${name} key under Keys and limit before running ${name} models`,
      );
  }
  const planned = await plan(input, keys, fetcher);
  const total = planned.reduce((sum, p) => sum + p.cents, 0);

  const created = await transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('bench:spend'))");
    const again = await done(db);
    if (again) return { id: again.id, shots: [] as { id: string; p: Planned }[] };
    const spent = { cents: await spentTodayCents(db) };
    const cap = dailyCapCents();
    if (spent.cents + total > cap)
      throw new GateError(
        'BUDGET_EXCEEDED',
        `This would cost about ${money(total)} and pass today's ${money(cap)} limit (DAILY_LIMIT_USD); ${money(Math.max(0, cap - spent.cents))} is left. Untick some models, shorten the duration or lower the resolution.`,
      );
    // One benchmark per prompt; several prompts share a suite. The first keeps the request key.
    const suiteId = !benchmarkId && input.prompts.length > 1 ? randomUUID() : null;
    const benchIds = new Map<string, string>();
    for (const [i, prompt] of input.prompts.entries())
      benchIds.set(
        prompt,
        benchmarkId ??
          (
            await one<{ id: string }>(
              'INSERT INTO benchmarks(idempotency_key,prompt,settings,suite_id,suite_name) VALUES($1,$2,$3,$4,$5) RETURNING id',
              [
                i === 0 ? input.key : `${input.key}#${i}`,
                prompt,
                JSON.stringify(input.settings),
                suiteId,
                suiteId ? input.suiteName || `Suite of ${input.prompts.length} prompts` : null,
              ],
              db,
            )
          ).id,
      );
    const benchId = benchIds.get(input.prompts[0])!;
    const shots: { id: string; p: Planned }[] = [];
    for (const [i, p] of planned.entries()) {
      const shotBench = benchIds.get(p.prompt)!;
      const shot = await one<{ id: string }>(
        `INSERT INTO renders(idempotency_key,direction,prompt,endpoint,provider,model,aspect_ratio,resolution,
           duration_seconds,estimated_cents,state,benchmark_id,request_settings)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'SUBMITTING',$11,$12) RETURNING id`,
        [
          `bench:${shotBench}:${input.key}:${i}`,
          JSON.stringify(p.direction),
          p.prompt,
          p.endpoint,
          p.provider,
          p.model,
          p.used.aspectRatio ?? input.settings.aspectRatio,
          p.used.resolution ?? input.settings.resolution,
          p.direction.duration,
          p.cents,
          shotBench,
          JSON.stringify({
            name: p.name,
            take: p.take,
            input: withoutInlineImages({ ...p.input, prompt: undefined }),
            used: p.used,
            priced: p.priced,
            ...(p.gpuPerSecond !== null ? { gpuPerSecond: p.gpuPerSecond } : {}),
          }),
        ],
        db,
      );
      shots.push({ id: shot.id, p });
    }
    await audit(db, benchmarkId ? 'benchmark.models_added' : 'benchmark.created', benchId, {
      renders: planned.length,
      prompts: input.prompts.length,
      takes: input.settings.takes,
      suiteId,
      estimate: total,
    });
    return { id: benchId, shots };
  });

  await inBatches(created.shots, 6, async ({ id, p }) => {
    try {
      const submitted =
        p.provider === 'higgsfield'
          ? await submitHiggsfield(
              keys.higgsfield!,
              p.endpoint,
              p.input,
              fetcher,
              `benchmark-${id}`,
            )
          : await studioProviders[p.provider].submit(keys[p.provider]!, p.endpoint, p.input, fetcher);
      await pool.query(
        "UPDATE renders SET state='RUNNING',request_id=$2,status_url=$3,response_url=$4,submitted_at=now() WHERE id=$1",
        [id, submitted.requestId, submitted.statusUrl, submitted.responseUrl],
      );
    } catch (error) {
      const unknown = error instanceof GateError && error.code === 'UNKNOWN_SUBMISSION';
      await pool.query('UPDATE renders SET state=$2,error=$3,completed_at=now() WHERE id=$1', [
        id,
        unknown ? 'UNKNOWN' : 'FAILED',
        error instanceof GateError ? error.message : `${p.provider} could not start this render`,
      ]);
    }
  });
  return { id: created.id };
}

// Cancels renders the poller last saw waiting in a provider queue. Both providers only cancel
// before generation starts (Higgsfield refunds; fal may still finish one that just started), so
// renders already generating are left to finish and reported.
export async function cancelQueued(benchmarkId: string, fetcher: typeof fetch = fetch) {
  const open = await rows<{
    id: string;
    provider: BenchProvider;
    request_id: string;
    status_url: string;
    started_at: string | null;
  }>(
    `SELECT id,provider,request_id,status_url,started_at FROM renders
     WHERE benchmark_id=$1 AND state='RUNNING' AND request_id IS NOT NULL`,
    [benchmarkId],
  );
  const keys: Partial<Record<BenchProvider, string>> = {};
  for (const provider of new Set(open.map((s) => s.provider)))
    keys[provider] = await KEYS[provider].load().catch(() => undefined);
  let canceled = 0;
  let refused = 0;
  const queued = open.filter((s) => !s.started_at);
  for (const shot of queued) {
    const key = keys[shot.provider];
    if (!key) {
      refused++;
      continue;
    }
    // OpenRouter has no cancel endpoint, so its queued renders are left to finish.
    if (shot.provider === 'openrouter') {
      refused++;
      continue;
    }
    const url =
      shot.provider === 'fal'
        ? shot.status_url.replace(/\/status$/, '/cancel')
        : shot.provider === 'replicate'
          ? `${shot.status_url.replace(/\/$/, '')}/cancel`
          : `https://api.higgsfield.ai/requests/${encodeURIComponent(shot.request_id)}/cancel`;
    if (!/^https:\/\/(queue\.fal\.run|api\.higgsfield\.ai|api\.replicate\.com)\//.test(url)) continue;
    let ok = false;
    try {
      const response = await fetcher(url, {
        method: shot.provider === 'fal' ? 'PUT' : 'POST',
        headers: { Authorization: shot.provider === 'replicate' ? `Bearer ${key}` : `Key ${key}` },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      ok = response.status === 202 || response.status === 200 || response.status === 204;
    } catch {}
    if (!ok) {
      refused++;
      continue;
    }
    const updated = await rows(
      `UPDATE renders SET state='FAILED',error='Canceled before it started. Not billed.',completed_at=now()
       WHERE id=$1 AND state='RUNNING' AND started_at IS NULL RETURNING id`,
      [shot.id],
    );
    canceled += updated.length;
  }
  await transaction((db) =>
    audit(db, 'benchmark.canceled', benchmarkId, { canceled, refused }),
  );
  return { canceled, generating: open.length - queued.length, refused };
}

type BenchShotRow = {
  id: string;
  benchmark_id: string;
  endpoint: string;
  provider: BenchProvider;
  model: string;
  state: string;
  estimated_cents: number;
  billed_cents: string | null;
  request_settings: {
    name?: string;
    used?: UsedSettings;
    priced?: boolean;
    take?: number;
    input?: Record<string, unknown>;
  } | null;
  prompt: string;
  output: {
    width?: number;
    height?: number;
    seconds?: number;
    fps?: number;
    audio?: boolean;
    bytes?: number;
  } | null;
  analysis: (VideoAnalysis & { error?: undefined }) | { error: string } | null;
  strip_key: string | null;
  judge_state: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | null;
  judge: (Verdict & { model?: string; error?: undefined }) | { error: string } | null;
  judge_cents: number;
  error: string | null;
  rating: number | null;
  note: string | null;
  seed: string | null;
  poster_key: string | null;
  video_key: string | null;
  created_at: string;
  submitted_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  completed_at: string | null;
  queue_seconds: string | null;
  run_seconds: string | null;
  reconciled_at: string | null;
};

const seconds = (from: string | null, to: string | null) =>
  from && to
    ? Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 100) / 10)
    : null;
const num = (v: string | null) => (v === null ? null : Number(v));

function publicBenchShot(r: BenchShotRow) {
  return {
    id: r.id,
    modelId: modelKey(r.provider, r.endpoint),
    provider: r.provider,
    endpoint: r.endpoint,
    name: r.request_settings?.name ?? r.model,
    studioModel: MODELS.some((m) => m.id === r.model) ? r.model : null,
    state: r.state,
    estimatedCents: r.estimated_cents,
    priced: r.request_settings?.priced ?? true,
    take: r.request_settings?.take ?? 1,
    prompt: r.prompt,
    /** The request body sent to the provider, prompt restored, inline images shown as a placeholder. */
    request: r.request_settings?.input
      ? ({ ...r.request_settings.input, prompt: r.prompt } as Record<string, unknown>)
      : null,
    billedCents: num(r.billed_cents),
    used: r.request_settings?.used ?? null,
    output: r.output,
    analysis: r.analysis && !r.analysis.error ? (r.analysis as VideoAnalysis) : null,
    hasStrip: Boolean(r.strip_key),
    judgeState: r.judge_state,
    judge: r.judge && !r.judge.error ? (r.judge as Verdict & { model?: string }) : null,
    judgeError: r.judge?.error ?? null,
    judgeCents: r.judge_cents,
    error: r.error,
    rating: r.rating,
    note: r.note,
    seed: r.seed === null ? null : Number(r.seed),
    hasVideo: Boolean(r.video_key),
    hasPoster: Boolean(r.poster_key),
    submittedAt: r.submitted_at,
    // Wall clock from our submission to the provider reporting the render done.
    totalSeconds: seconds(r.submitted_at, r.finished_at),
    // fal's own record, or for Higgsfield the poller seeing the render start (about ±6 s).
    queueSeconds: num(r.queue_seconds) ?? seconds(r.submitted_at, r.started_at),
    runSeconds: num(r.run_seconds) ?? (r.finished_at ? seconds(r.started_at, r.finished_at) : null),
    timing:
      (r.provider === 'fal' || r.provider === 'replicate') && r.reconciled_at && r.run_seconds !== null
        ? ('provider' as const)
        : ('measured' as const),
    reconciled: Boolean(r.reconciled_at),
  };
}
export type BenchShot = ReturnType<typeof publicBenchShot>;

export async function benchmarkState(scope: Partial<LeaderboardScope> = {}) {
  const [benches, shots, spent, votes] = await Promise.all([
    rows<{
      id: string;
      prompt: string;
      settings: BenchRunSettings;
      winner_shot_id: string | null;
      created_at: string;
      suite_id: string | null;
      suite_name: string | null;
    }>(
      'SELECT id,prompt,settings,winner_shot_id,created_at,suite_id,suite_name FROM benchmarks ORDER BY created_at DESC LIMIT 40',
    ),
    rows<BenchShotRow>(
      `SELECT s.* FROM renders s JOIN (SELECT id FROM benchmarks ORDER BY created_at DESC LIMIT 40) b
         ON b.id = s.benchmark_id ORDER BY s.created_at`,
    ),
    spentTodayCents().then((cents) => ({ cents })),
    rows<{
      benchmark_id: string;
      left_shot_id: string;
      right_shot_id: string;
      outcome: Vote['outcome'];
    }>(
      `SELECT v.benchmark_id,v.left_shot_id,v.right_shot_id,v.outcome FROM benchmark_votes v
       JOIN (SELECT id FROM benchmarks ORDER BY created_at DESC LIMIT 40) b ON b.id = v.benchmark_id`,
    ),
  ]);
  return {
    benchmarks: benches.map((b) => ({
      id: b.id,
      prompt: b.prompt,
      settings: b.settings,
      winnerShotId: b.winner_shot_id,
      suiteId: b.suite_id,
      suiteName: b.suite_name,
      createdAt: b.created_at,
      shots: shots.filter((s) => s.benchmark_id === b.id).map(publicBenchShot),
      votes: votes
        .filter((v) => v.benchmark_id === b.id)
        .map((v) => ({ left: v.left_shot_id, right: v.right_shot_id, outcome: v.outcome })),
    })),
    ...(await leaderboard(scope).then(({ rows, ...info }) => ({ leaderboard: rows, leaderboardInfo: info }))),
    leaderboardSuite: scope.suiteId ?? null,
    spentTodayCents: spent.cents,
    dailyCapCents: dailyCapCents(),
    judgeCentsEach: judgeCents(),
    judgeReady: Boolean(settings().llmKey && settings().llmModel),
  };
}

// The settings a render actually ran with after snapping, e.g. "5 s · 720p · 9:16". Renders only
// compare fairly within one of these.
const SETUP = `concat_ws(' · ', coalesce((s.request_settings->'used'->>'duration') || ' s', 'own length'), s.request_settings->'used'->>'resolution', s.request_settings->'used'->>'aspectRatio')`;

export const leaderboardScope = z.object({
  suiteId: z.string().uuid().nullable().default(null),
  /** Only renders made at these effective settings. */
  setup: z.string().max(80).nullable().default(null),
  /** Only prompts that every ranked model has a finished render of. */
  commonOnly: z.boolean().default(false),
});
export type LeaderboardScope = z.infer<typeof leaderboardScope>;

// Renders in scope. $1 suite, $2 effective settings, $3 common prompts only.
const SCOPED = `WITH scope AS (
    SELECT s.*, b.prompt AS bench_prompt, ${SETUP} AS setup
    FROM renders s JOIN benchmarks b ON b.id = s.benchmark_id
    WHERE ($1::uuid IS NULL OR b.suite_id = $1) AND ($2::text IS NULL OR ${SETUP} = $2)
  ),
  finishers AS (SELECT count(DISTINCT provider || ':' || endpoint) n FROM scope WHERE state='COMPLETE'),
  common AS (
    SELECT bench_prompt FROM scope WHERE state='COMPLETE' GROUP BY bench_prompt
    HAVING count(DISTINCT provider || ':' || endpoint) = (SELECT n FROM finishers)
  ),
  ranked AS (SELECT * FROM scope WHERE NOT $3::boolean OR bench_prompt IN (SELECT bench_prompt FROM common))`;

// One row per model: reliability, speed, cost, ratings and arena strength, each with the number
// of renders or votes behind it. Scoped to a suite, one set of effective settings, and optionally
// the prompts every model finished, so models are compared on the same work.
async function leaderboard(raw: Partial<LeaderboardScope> = {}) {
  const scope = leaderboardScope.parse(raw);
  const params = [scope.suiteId, scope.setup, scope.commonOnly];
  const [list, cast, setups, common] = await Promise.all([
    rows<{
      endpoint: string;
      provider: BenchProvider;
      name: string;
      runs: number;
      done: number;
      failed: number;
      median_total: string | null;
      median_run: string | null;
      median_queue: string | null;
      avg_cents: string | null;
      billed: number;
      cost_cents: string | null;
      output_seconds: string | null;
      rating_sum: string | null;
      ratings: number;
      median_motion: string | null;
      avg_judge: string | null;
      judged: number;
      analysed: number;
      with_issues: number;
      wins: number;
      setups: number;
      prompts: number;
    }>(
      `${SCOPED}
       SELECT s.endpoint, s.provider,
         (array_agg(coalesce(s.request_settings->>'name', s.model) ORDER BY s.created_at DESC))[1] AS name,
         count(*)::int runs,
         count(*) FILTER (WHERE s.state='COMPLETE')::int done,
         count(*) FILTER (WHERE s.state IN ('FAILED','UNKNOWN'))::int failed,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM s.finished_at - s.submitted_at))
           FILTER (WHERE s.state='COMPLETE' AND s.finished_at IS NOT NULL) median_total,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY s.run_seconds) FILTER (WHERE s.state='COMPLETE') median_run,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY s.queue_seconds) FILTER (WHERE s.state='COMPLETE') median_queue,
         avg(coalesce(s.billed_cents, s.estimated_cents)) FILTER (WHERE s.state='COMPLETE') avg_cents,
         count(*) FILTER (WHERE s.state='COMPLETE' AND s.billed_cents IS NOT NULL)::int billed,
         sum(coalesce(s.billed_cents, s.estimated_cents))
           FILTER (WHERE s.state='COMPLETE' AND (s.output->>'seconds')::numeric > 0) cost_cents,
         sum((s.output->>'seconds')::numeric)
           FILTER (WHERE s.state='COMPLETE' AND (s.output->>'seconds')::numeric > 0) output_seconds,
         sum(s.rating) rating_sum,
         count(s.rating)::int ratings,
         avg((s.judge->>'overall')::numeric) FILTER (WHERE s.judge_state='DONE') avg_judge,
         count(*) FILTER (WHERE s.judge_state='DONE')::int judged,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY (s.analysis->>'motion')::numeric)
           FILTER (WHERE s.analysis ? 'motion') median_motion,
         count(*) FILTER (WHERE s.analysis ? 'issues')::int analysed,
         count(*) FILTER (WHERE jsonb_array_length(coalesce(s.analysis->'issues','[]'::jsonb)) > 0)::int with_issues,
         count(w.id)::int wins,
         count(DISTINCT s.setup) FILTER (WHERE s.state='COMPLETE')::int setups,
         count(DISTINCT s.bench_prompt) FILTER (WHERE s.state='COMPLETE')::int prompts
       FROM ranked s LEFT JOIN benchmarks w ON w.winner_shot_id = s.id
       GROUP BY s.provider, s.endpoint`,
      params,
    ),
    rows<{ left: string; right: string; outcome: Vote['outcome']; grp: string }>(
      `${SCOPED}
       SELECT l.provider || ':' || l.endpoint AS left, r.provider || ':' || r.endpoint AS right, v.outcome, l.bench_prompt grp
       FROM benchmark_votes v JOIN ranked l ON l.id = v.left_shot_id JOIN ranked r ON r.id = v.right_shot_id`,
      params,
    ),
    rows<{ setup: string; renders: number; models: number }>(
      `${SCOPED}
       SELECT setup, count(*)::int renders, count(DISTINCT provider || ':' || endpoint)::int models
       FROM scope WHERE state='COMPLETE' AND setup <> '' GROUP BY setup ORDER BY count(*) DESC`,
      [scope.suiteId, null, false],
    ),
    one<{ prompts: number }>(`${SCOPED} SELECT count(*)::int prompts FROM common`, params),
  ]);
  const n = (v: string | null) => (v === null ? null : Math.round(Number(v) * 10) / 10);
  const votes = cast.map((v) => ({ left: v.left, right: v.right, outcome: v.outcome, group: v.grp }));
  const strength = btRatings(votes);
  const spread = btIntervals(votes);
  const ratingTotal = list.reduce((a, r) => a + Number(r.rating_sum ?? 0), 0);
  const ratingCount = list.reduce((a, r) => a + r.ratings, 0);
  const overall = ratingCount ? ratingTotal / ratingCount : 3;
  const rowsOut = list.map((r) => {
    const id = modelKey(r.provider, r.endpoint);
    const arena = strength.get(id);
    const interval = spread.get(id);
    return {
      id,
      provider: r.provider,
      endpoint: r.endpoint,
      name: r.name,
      runs: r.runs,
      done: r.done,
      failed: r.failed,
      medianTotalSeconds: n(r.median_total),
      medianRunSeconds: n(r.median_run),
      medianQueueSeconds: n(r.median_queue),
      avgCents: n(r.avg_cents),
      /** Finished renders whose cost is the provider's bill; the rest are estimates. */
      billed: r.billed,
      /** Total cost over total delivered seconds, so long and short clips weigh by length. */
      centsPerSecond:
        r.cost_cents !== null && Number(r.output_seconds) > 0
          ? Math.round((Number(r.cost_cents) / Number(r.output_seconds)) * 10) / 10
          : null,
      avgRating: r.ratings ? Math.round((Number(r.rating_sum) / r.ratings) * 10) / 10 : null,
      /** The average pulled toward everyone's average until enough ratings back it; used to rank. */
      ratingScore: (() => {
        const v = shrunkRating(Number(r.rating_sum ?? 0), r.ratings, overall);
        return v === null ? null : Math.round(v * 100) / 100;
      })(),
      ratings: r.ratings,
      medianMotion: n(r.median_motion),
      /** The AI judge's average overall score out of 10, and how many renders it scored. */
      judgeScore: n(r.avg_judge),
      judged: r.judged,
      /** Bradley-Terry strength from blind votes (1000 is average), and the votes behind it. */
      arena: arena?.rating ?? null,
      arenaVotes: arena?.games ?? 0,
      /** Prompts those votes came from; the interval needs at least three. */
      arenaPrompts: interval?.prompts ?? 0,
      arenaLow: interval?.low ?? null,
      arenaHigh: interval?.high ?? null,
      /** Share of analysed renders with a freeze, black frames, no motion or missing sound. */
      issueRate: r.analysed ? Math.round((r.with_issues / r.analysed) * 100) : null,
      analysed: r.analysed,
      wins: r.wins,
      /** Distinct effective settings among finished renders; more than one is not like for like. */
      setups: r.setups,
      prompts: r.prompts,
    };
  });
  rowsOut.sort(
    (a, b) => (b.ratingScore ?? -1) - (a.ratingScore ?? -1) || b.wins - a.wins || b.done - a.done,
  );
  return { rows: rowsOut, scope, setups, commonPrompts: common.prompts };
}
export type LeaderRow = Awaited<ReturnType<typeof leaderboard>>['rows'][number];
export type LeaderboardInfo = Omit<Awaited<ReturnType<typeof leaderboard>>, 'rows'>;

/** Every render one model has made across benchmarks, newest first, with its failure reasons. */
export async function modelHistory(id: string) {
  const parsed = modelId.parse(id);
  const [provider, ...rest] = parsed.split(':');
  const endpoint = rest.join(':');
  const list = await rows<BenchShotRow & { bench_prompt: string; bench_created: string }>(
    `SELECT s.*, b.prompt bench_prompt, b.created_at bench_created FROM renders s
     JOIN benchmarks b ON b.id = s.benchmark_id
     WHERE s.provider=$1 AND s.endpoint=$2 ORDER BY s.created_at DESC LIMIT 60`,
    [provider, endpoint],
  );
  const reasons = new Map<string, number>();
  for (const r of list)
    if ((r.state === 'FAILED' || r.state === 'UNKNOWN') && r.error) {
      const key = r.error.replace(/request [\w-]+/gi, 'request').slice(0, 160);
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
  return {
    id: parsed,
    provider: provider as BenchProvider,
    endpoint,
    renders: list.map((r) => ({
      ...publicBenchShot(r),
      benchmarkId: r.benchmark_id,
      benchmarkCreatedAt: r.bench_created,
    })),
    failures: [...reasons]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
  };
}

const rateSchema = z.object({
  rating: z.number().int().min(1).max(5).nullable().optional(),
  note: z.string().trim().max(600).optional(),
});
export async function rateBenchShot(id: string, raw: unknown) {
  const input = rateSchema.parse(raw);
  const updated = await rows(
    `UPDATE renders SET rating = CASE WHEN $2 THEN $3::smallint ELSE rating END,
       note = coalesce($4, note) WHERE id=$1 AND benchmark_id IS NOT NULL RETURNING id`,
    [id, input.rating !== undefined, input.rating ?? null, input.note ?? null],
  );
  if (!updated.length)
    throw new GateError('INVALID_INPUT', 'That render is not part of a benchmark');
}

const voteSchema = z.object({
  left: z.string().uuid(),
  right: z.string().uuid(),
  outcome: z.enum(['left', 'right', 'tie', 'both_bad']),
});
/** Records one blind head-to-head vote between two finished renders of the same benchmark. */
export async function voteOnPair(benchmarkId: string, raw: unknown) {
  const v = voteSchema.parse(raw);
  if (v.left === v.right) throw new GateError('INVALID_INPUT', 'Pick two different renders');
  const ok = await rows(
    `SELECT id FROM renders WHERE id = ANY($1::uuid[]) AND benchmark_id=$2 AND state='COMPLETE'`,
    [[v.left, v.right], benchmarkId],
  );
  if (ok.length !== 2)
    throw new GateError('INVALID_INPUT', 'Both renders must be finished and from this benchmark');
  await pool.query(
    'INSERT INTO benchmark_votes(benchmark_id,left_shot_id,right_shot_id,outcome) VALUES($1,$2,$3,$4)',
    [benchmarkId, v.left, v.right, v.outcome],
  );
}

export async function pickWinner(benchmarkId: string, shotId: string | null) {
  if (shotId) {
    const ok = await rows('SELECT 1 FROM renders WHERE id=$1 AND benchmark_id=$2', [
      shotId,
      benchmarkId,
    ]);
    if (!ok.length)
      throw new GateError('INVALID_INPUT', 'That render belongs to another benchmark');
  }
  await transaction(async (db) => {
    await db.query('UPDATE benchmarks SET winner_shot_id=$2 WHERE id=$1', [benchmarkId, shotId]);
    await audit(db, 'benchmark.winner', benchmarkId, { shotId });
  });
}

const requestRecord = z.object({
  items: z.array(
    z.object({
      request_id: z.string(),
      sent_at: z.string().nullish(),
      started_at: z.string().nullish(),
      ended_at: z.string().nullish(),
    }),
  ),
});
const billing = z.object({
  billing_events: z.array(z.object({ request_id: z.string(), cost_total: z.number().nullish() })),
});

async function makeStrip(id: string, videoKey: string, seconds: number | null) {
  const dir = await mkdtemp(join(tmpdir(), 'bench-strip-'));
  try {
    const out = join(dir, 'strip.jpg');
    await withAssetPath(videoKey, (path) => runMedia('ffmpeg', stripArgs(path, seconds, out)));
    const key = `renders/${id}/strip.jpg`;
    await putAsset(key, await readFile(out));
    return key;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Called by the background loop after polling: runs the objective checks on up to two finished
// benchmark renders per tick. A file that cannot be analysed records the error, so it is not retried.
export async function analyzeBenchmarkShots() {
  const due = await rows<{
    id: string;
    video_key: string;
    output: { seconds?: number; audio?: boolean } | null;
    request_settings: { used?: UsedSettings } | null;
  }>(
    `SELECT id,video_key,output,request_settings FROM renders
     WHERE benchmark_id IS NOT NULL AND state='COMPLETE' AND analysis IS NULL AND video_key IS NOT NULL
     ORDER BY completed_at LIMIT 2`,
  );
  for (const shot of due) {
    let analysis: VideoAnalysis | { error: string };
    try {
      const hasAudio = shot.output?.audio ?? true;
      const { stderr } = await withAssetPath(shot.video_key, (path) =>
        runMedia('ffmpeg', analysisArgs(path, hasAudio)),
      );
      analysis = parseAnalysis(stderr.toString(), {
        seconds: shot.output?.seconds ?? null,
        hasAudio,
        soundRequested: shot.request_settings?.used?.audio ?? null,
      });
    } catch (error) {
      analysis = { error: String(error instanceof Error ? error.message : error).slice(0, 300) };
    }
    const stripKey = await makeStrip(shot.id, shot.video_key, shot.output?.seconds ?? null).catch(
      () => null,
    );
    await pool.query('UPDATE renders SET analysis=$2,strip_key=$3 WHERE id=$1', [
      shot.id,
      JSON.stringify(analysis),
      stripKey,
    ]);
  }
  return due.length;
}

let billingRefusedUntil = 0;

// Called by the background loop. Reads fal's request timing and billed cost for finished benchmark
// renders. Billing events can lag, so a render is re-checked every minute for up to six hours.
export async function reconcileBenchmarkShots(fetcher: typeof fetch = fetch) {
  await pool.query(
    `UPDATE renders SET state='UNKNOWN',error='The submission did not finish. Check the fal dashboard for this prompt.'
     WHERE benchmark_id IS NOT NULL AND state='SUBMITTING' AND request_id IS NULL AND created_at < now() - interval '15 minutes'`,
  );
  // Higgsfield and OpenRouter have no request history: keep the poller's split once a render ends.
  // (OpenRouter's bill and Replicate's own timing are stored by the poller as each render finishes.)
  await pool.query(
    `UPDATE renders SET
       queue_seconds = CASE WHEN started_at IS NOT NULL THEN extract(epoch FROM started_at - submitted_at) END,
       run_seconds = CASE WHEN started_at IS NOT NULL AND finished_at IS NOT NULL THEN extract(epoch FROM finished_at - started_at) END,
       reconciled_at = now()
     WHERE benchmark_id IS NOT NULL AND provider IN ('higgsfield','openrouter') AND reconciled_at IS NULL AND state IN ('COMPLETE','FAILED')`,
  );
  const due = await rows<{
    id: string;
    endpoint: string;
    request_id: string;
    state: string;
    completed_at: string;
    created_at: string;
  }>(
    `SELECT id,endpoint,request_id,state,completed_at,created_at FROM renders
     WHERE benchmark_id IS NOT NULL AND reconciled_at IS NULL AND request_id IS NOT NULL AND provider='fal'
       AND state IN ('COMPLETE','FAILED')
       AND (reconcile_checked_at IS NULL OR reconcile_checked_at < now() - interval '60 seconds')
     ORDER BY completed_at LIMIT 12`,
  );
  if (!due.length) return 0;
  const key = await falKey().catch(() => undefined);
  if (!key) return 0;
  for (const shot of due) {
    const start = new Date(new Date(shot.created_at).getTime() - 3600_000).toISOString();
    const [timing, bill] = await Promise.all([
      getJson(
        `https://api.fal.ai/v1/models/requests/by-endpoint?endpoint_id=${encodeURIComponent(shot.endpoint)}&request_id=${encodeURIComponent(shot.request_id)}&start=${start}`,
        key,
        fetcher,
      )
        .then(
          (b) => requestRecord.parse(b).items.find((i) => i.request_id === shot.request_id) ?? null,
        )
        .catch(() => null),
      Date.now() < billingRefusedUntil
        ? Promise.resolve(null)
        : getJson(
            `https://api.fal.ai/v1/models/billing-events?request_id=${encodeURIComponent(shot.request_id)}&start=${start}`,
            key,
            fetcher,
          )
            .then(
              (b) =>
                billing.parse(b).billing_events.find((e) => e.request_id === shot.request_id) ??
                null,
            )
            .catch((error) => {
              // Billing events need an admin-scoped fal key; an ordinary key gets 403. Stop asking
              // for an hour and keep the published-rate estimate.
              if (error instanceof GateError && /returned 40[13]/.test(error.message))
                billingRefusedUntil = Date.now() + 3600_000;
              return null;
            }),
    ]);
    const queue =
      timing?.sent_at && timing.started_at ? seconds(timing.sent_at, timing.started_at) : null;
    const run =
      timing?.started_at && timing.ended_at ? seconds(timing.started_at, timing.ended_at) : null;
    const billed =
      typeof bill?.cost_total === 'number' ? Math.round(bill.cost_total * 10000) / 100 : null;
    const ageHours =
      (Date.now() - new Date(shot.completed_at ?? shot.created_at).getTime()) / 3600_000;
    const done =
      (run !== null &&
        (billed !== null || shot.state === 'FAILED' || Date.now() < billingRefusedUntil)) ||
      ageHours > 6;
    await pool.query(
      `UPDATE renders SET queue_seconds=coalesce($2,queue_seconds), run_seconds=coalesce($3,run_seconds),
         billed_cents=coalesce($4,billed_cents), reconcile_checked_at=now(),
         reconciled_at=CASE WHEN $5 THEN now() ELSE NULL END WHERE id=$1`,
      [shot.id, queue, run, billed, done],
    );
  }
  return due.length;
}
