import { z } from 'zod';
import { GateError } from '../lib/contracts';
import { MODELS } from '../lib/production-models';
import type { Provider } from '../lib/studio';
import { falKey, higgsfieldKey } from '../lib/fal-key';

// Browse what each provider offers. fal publishes a model search API (api.fal.ai/v1/models;
// a key only raises its rate limit) and a pricing API that needs a key. Higgsfield has no
// listing endpoint; its docs publish every model in llms-full.txt, which is parsed here.
// Results are cached in memory so browsing does not hammer either provider.

export type CatalogModel = {
  id: string;
  name: string;
  category: string;
  description: string;
  thumbnail: string | null;
  url: string;
  maker: string | null;
  price: string | null;
  /** The studio model this endpoint maps to, when it can be rendered here. */
  studioModel: string | null;
  /** Higgsfield's docs page for the endpoint, which lists its request parameters. */
  docs?: string | null;
};
export type CatalogPage = { models: CatalogModel[]; nextCursor: string | null; categories: string[] };

export const FAL_CATEGORIES = [
  'text-to-video',
  'image-to-video',
  'video-to-video',
  'text-to-image',
  'image-to-image',
  'audio-to-video',
  'text-to-audio',
  'text-to-speech',
  'audio-to-audio',
  'speech-to-text',
  'image-to-3d',
  'training',
] as const;

const studioModelFor = (provider: Provider, endpoint: string) =>
  MODELS.find((m) => m.provider === provider && Object.values(m.endpoints).includes(endpoint))?.id ?? null;

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return value;
}

const falModel = z.object({
  endpoint_id: z.string(),
  metadata: z
    .object({
      display_name: z.string().nullish(),
      category: z.string().nullish(),
      description: z.string().nullish(),
      thumbnail_url: z.string().nullish(),
      model_url: z.string().nullish(),
      status: z.string().nullish(),
      group: z.object({ label: z.string().nullish() }).nullish(),
    })
    .passthrough()
    .nullish(),
});

async function falFetch(url: string, key: string | undefined, fetcher: typeof fetch) {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: key ? { Authorization: `Key ${key}` } : {},
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new GateError('RETRYABLE_NETWORK', 'fal is unreachable. Try again in a moment.');
  }
  if (response.status === 429) throw new GateError('RATE_LIMITED', 'fal is rate limiting the catalogue. Wait a few seconds.');
  if (!response.ok) throw new GateError('RETRYABLE_PROVIDER', `fal returned ${response.status} for the catalogue`);
  return response.json();
}

function formatPrice(p: { unit_price: number; unit: string; currency?: string }) {
  const amount = p.unit_price < 0.1 ? p.unit_price.toFixed(3).replace(/0$/, '') : p.unit_price.toFixed(2);
  const unit = p.unit.replace(/^(units?|seconds?)$/, (u) => (u.startsWith('second') ? 'second' : 'unit'));
  return `$${amount} per ${unit}`;
}

async function falPrices(ids: string[], key: string | undefined, fetcher: typeof fetch) {
  if (!key || !ids.length) return new Map<string, string>();
  const query = ids.map((id) => `endpoint_id=${encodeURIComponent(id)}`).join('&');
  try {
    const body = z
      .object({ prices: z.array(z.object({ endpoint_id: z.string(), unit_price: z.number(), unit: z.string() })) })
      .parse(await cached(`fal:prices:${query}`, 6 * 3600_000, () => falFetch(`https://api.fal.ai/v1/models/pricing?${query}`, key, fetcher)));
    return new Map(body.prices.map((p) => [p.endpoint_id, formatPrice(p)]));
  } catch {
    return new Map<string, string>();
  }
}

export async function falCatalog(
  input: { category?: string; q?: string; cursor?: string },
  fetcher: typeof fetch = fetch,
): Promise<CatalogPage> {
  const key = await falKey().catch(() => undefined);
  const params = new URLSearchParams({ limit: '30', status: 'active' });
  if (input.category) params.set('category', input.category);
  if (input.q) params.set('q', input.q);
  if (input.cursor) params.set('cursor', input.cursor);
  const raw = await cached(`fal:models:${params}`, 10 * 60_000, () =>
    falFetch(`https://api.fal.ai/v1/models?${params}`, key, fetcher),
  );
  const page = z
    .object({ models: z.array(falModel), next_cursor: z.string().nullish(), has_more: z.boolean().nullish() })
    .parse(raw);
  const prices = await falPrices(page.models.map((m) => m.endpoint_id), key, fetcher);
  return {
    models: page.models.map((m) => ({
      id: m.endpoint_id,
      name: m.metadata?.display_name || m.endpoint_id,
      category: m.metadata?.category || 'other',
      description: (m.metadata?.description || '').slice(0, 400),
      thumbnail: m.metadata?.thumbnail_url?.startsWith('https://') ? m.metadata.thumbnail_url : null,
      url: m.metadata?.model_url?.startsWith('https://') ? m.metadata.model_url : `https://fal.ai/models/${m.endpoint_id}`,
      maker: m.metadata?.group?.label ?? null,
      price: prices.get(m.endpoint_id) ?? null,
      studioModel: studioModelFor('fal', m.endpoint_id),
    })),
    nextCursor: page.has_more === false ? null : (page.next_cursor ?? null),
    categories: [...FAL_CATEGORIES],
  };
}

// Higgsfield's docs list each endpoint as a "# Family — Variant API" section with a Source
// line, a one-line summary and "**Endpoint ID:** `path`".
export function parseHiggsfieldDocs(text: string): CatalogModel[] {
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  const re = /\*\*Endpoint ID:\*\* `([^`]+)`/g;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const before = text.slice(Math.max(0, match.index - 3000), match.index);
    const heading = [...before.matchAll(/^# (.+?) API\s*$/gm)].at(-1);
    const source = [...before.matchAll(/^Source: (https:\/\/docs\.higgsfield\.ai\/\S+)/gm)].at(-1);
    const summary = heading
      ? before
          .slice(heading.index! + heading[0].length)
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith('Source:') && !l.startsWith('<') && !l.startsWith('['))
      : undefined;
    out.push({
      id,
      name: heading?.[1].replace(/\s+/g, ' ').replace(/ — /g, ' · ').trim() ?? id,
      category: higgsfieldCategory(id),
      // Docs summaries end with boilerplate about the page itself; keep the part about the model.
      description: (summary ?? '').replace(/:\s*request parameters.*$/i, '.').replace(/\.\.$/, '.').slice(0, 400),
      thumbnail: null,
      url: `https://console.higgsfield.ai/models/${encodeURIComponent(id)}/playground`,
      maker: id.split('/')[0].replace(/-ai$/, ''),
      price: null,
      studioModel: studioModelFor('higgsfield', id),
      docs: source?.[1] ?? null,
    });
  }
  return out;
}

export function higgsfieldCategory(id: string) {
  if (/motion-control|motion-transfer/.test(id)) return 'motion-control';
  if (/first-last-frame|image-to-video|image-reference/.test(id)) return 'image-to-video';
  if (/reference-to-video|video-reference/.test(id)) return 'reference-to-video';
  if (/text-to-video|cinema-studio/.test(id)) return 'text-to-video';
  if (/video-edit|video-extend|restyle|object-swap|genjutsu/.test(id)) return 'video-to-video';
  if (id === 'soul-id') return 'training';
  if (/soul|image|recraft|ideogram|qwen|marketing-studio/.test(id)) return 'image';
  return 'other';
}

const hfAccountModel = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  operation_type: z.array(z.string()).nullish(),
  output_type: z.string().nullish(),
  base_credits: z.union([z.string(), z.number()]).transform(Number).nullish(),
});
/**
 * The models this Higgsfield account can call, from the authenticated GET /models (84 on
 * 4 October 2026). It lists models the docs leave out, such as Soul 2 image-to-image and Soul ID.
 */
export async function higgsfieldAccountModels(key: string, fetcher: typeof fetch = fetch) {
  return cached(`higgsfield:models:${key.slice(0, 8)}`, 6 * 3600_000, async () => {
    let response: Response;
    try {
      response = await fetcher('https://platform.higgsfield.ai/models', {
        headers: { Authorization: `Key ${key}` },
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new GateError('RETRYABLE_NETWORK', 'Higgsfield is unreachable');
    }
    if (!response.ok) throw new GateError('RETRYABLE_PROVIDER', `Higgsfield returned ${response.status} for its model list`);
    return z.object({ items: z.array(hfAccountModel) }).parse(await response.json()).items;
  });
}

function accountCategory(m: z.infer<typeof hfAccountModel>) {
  const fromId = higgsfieldCategory(m.slug);
  if (fromId !== 'other') return fromId;
  if (m.output_type === 'image') return 'image';
  if (m.operation_type?.includes('character')) return 'training';
  return m.output_type === 'video' ? 'video-to-video' : 'other';
}

export async function higgsfieldCatalog(
  input: { category?: string; q?: string },
  fetcher: typeof fetch = fetch,
): Promise<CatalogPage> {
  const docs = await higgsfieldDocsCatalog(fetcher);
  // The account's own list adds what the docs leave out.
  const key = await higgsfieldKey().catch(() => undefined);
  const account = key ? await higgsfieldAccountModels(key, fetcher).catch(() => []) : [];
  const ids = new Set(docs.map((m) => m.id));
  const all = [
    ...docs,
    ...account
      .filter((m) => !ids.has(m.slug))
      .map((m) => ({
        id: m.slug,
        name: m.title,
        category: accountCategory(m),
        description: (m.description ?? '').slice(0, 400),
        thumbnail: null,
        url: `https://open.higgsfield.ai/models/${m.slug}/playground`,
        maker: 'Higgsfield',
        price: m.base_credits ? `$${(m.base_credits * 0.0625).toFixed(2)} per request` : null,
        studioModel: studioModelFor('higgsfield', m.slug),
        docs: null,
      })),
  ];
  const q = input.q?.trim().toLowerCase();
  const models = all.filter(
    (m) =>
      (!input.category || m.category === input.category) &&
      (!q || `${m.name} ${m.id} ${m.description}`.toLowerCase().includes(q)),
  );
  return {
    models,
    nextCursor: null,
    categories: [...new Set(all.map((m) => m.category))].sort(),
  };
}

function higgsfieldDocsCatalog(fetcher: typeof fetch): Promise<CatalogModel[]> {
  return cached('higgsfield:docs', 6 * 3600_000, async () => {
    try {
      const response = await fetcher('https://docs.higgsfield.ai/docs/llms-full.txt', {
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(String(response.status));
      const parsed = parseHiggsfieldDocs(await response.text());
      if (parsed.length) return parsed;
    } catch {}
    // Offline fallback: the models the studio can render on Higgsfield.
    return MODELS.filter((m) => m.provider === 'higgsfield').flatMap((m) =>
      [...new Set(Object.values(m.endpoints))].map((id) => ({
        id,
        name: m.name,
        category: higgsfieldCategory(id),
        description: m.summary,
        thumbnail: null,
        url: `https://console.higgsfield.ai/models/${encodeURIComponent(id)}/playground`,
        maker: m.maker,
        price: null,
        studioModel: m.id,
      })),
    );
  });
}

export const catalogQuery = z.object({
  provider: z.enum(['fal', 'higgsfield']),
  category: z.string().regex(/^[a-z0-9-]{0,40}$/).optional(),
  q: z.string().trim().max(80).optional(),
  cursor: z.string().regex(/^[A-Za-z0-9+/=_-]{0,64}$/).optional(),
});

// Artwork for the studio's models, from the thumbnails fal publishes for each endpoint. A
// Higgsfield model borrows the fal thumbnail of the same endpoint path when fal hosts it, or of
// the fal model with the same name. Keyed by studio model id; models without art are left out.
export async function modelArt(fetcher: typeof fetch = fetch): Promise<Record<string, string>> {
  // A failed lookup throws inside the loader so it is not cached; Home just shows icons.
  return cached('fal:art', 6 * 3600_000, async () => {
    const key = await falKey().catch(() => undefined);
    // One request for every fal endpoint the studio uses (fal rate-limits keyless lookups
    // hard). fal answers 404 for the whole request when any id is unknown, so Higgsfield ids
    // stay out; those models borrow a fal twin's artwork below.
    const ids = [...new Set(MODELS.filter((m) => m.provider === 'fal').flatMap((m) => Object.values(m.endpoints)))];
    const query = ids.map((id) => `endpoint_id=${encodeURIComponent(id)}`).join('&');
    const page = z
      .object({ models: z.array(falModel) })
      .parse(await falFetch(`https://api.fal.ai/v1/models?limit=${ids.length}&${query}`, key, fetcher));
    const thumbs = new Map(
      page.models.flatMap((m) =>
        m.metadata?.thumbnail_url?.startsWith('https://') ? [[m.endpoint_id, m.metadata.thumbnail_url] as const] : [],
      ),
    );
    const art: Record<string, string> = {};
    for (const m of MODELS) {
      const own = Object.values(m.endpoints)
        .map((id) => thumbs.get(id))
        .find(Boolean);
      if (own) art[m.id] = own;
    }
    if (!Object.keys(art).length) throw new Error('fal published no artwork');
    for (const m of MODELS) {
      if (art[m.id]) continue;
      const twin = MODELS.find((x) => x.provider === 'fal' && art[x.id] && x.name.split(' ').slice(0, 2).join(' ') === m.name.split(' ').slice(0, 2).join(' '));
      if (twin) art[m.id] = art[twin.id];
    }
    // Higgsfield-only models (Cinema Studio) use the preview Higgsfield's public catalogue shows.
    const orphans = MODELS.filter((m) => !art[m.id] && m.provider === 'higgsfield');
    if (orphans.length) {
      const previews = await higgsfieldPreviews(fetcher).catch(() => new Map<string, string>());
      for (const m of orphans) {
        const found = Object.values(m.endpoints)
          .map((e) => previews.get(e))
          .find(Boolean);
        if (found) art[m.id] = found;
      }
    }
    return art;
  }).catch(() => ({}));
}

const hfCatalogPage = z.object({
  next: z.string().nullish(),
  results: z.array(
    z.object({
      default_mode_id: z.string().nullish(),
      entry_points: z.array(z.object({ mode_id: z.string() })).nullish(),
      preview_image: z.string().nullish(),
      preview_video: z.object({ thumbnail_url: z.string().nullish() }).nullish(),
    }),
  ),
});
/** Preview images from Higgsfield's public model catalogue, keyed by endpoint. */
async function higgsfieldPreviews(fetcher: typeof fetch) {
  const response = await fetcher('https://dash.higgsfield.ai/api/v2/catalog-models/?page_size=50', {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(String(response.status));
  const out = new Map<string, string>();
  for (const family of hfCatalogPage.parse(await response.json()).results) {
    const image = family.preview_video?.thumbnail_url ?? family.preview_image;
    if (!image?.startsWith('https://')) continue;
    for (const id of [family.default_mode_id, ...(family.entry_points ?? []).map((e) => e.mode_id)])
      if (id && !out.has(id)) out.set(id, image);
  }
  return out;
}
