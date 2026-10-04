import type { Direction, Provider } from './studio';

// The production studio's model catalogue. Each model says which inputs it takes and how a
// provider-neutral direction becomes that provider's request body. Endpoints and parameters
// come from fal's OpenAPI schemas and Higgsfield's model docs (reviewed 3 October 2026; Seedance
// 2.5 and Wan 3.0 on fal added 4 October 2026).
// fal prices are published per second. Higgsfield quotes each request through its free estimate
// endpoint; token- and second-metered models answer with a rate description instead, so every
// Higgsfield model also carries the published rate (read from that endpoint on 4 October 2026).

export type Aspect = Direction['aspectRatio'];
export type Resolution = Direction['resolution'];
export type Mode = 'text' | 'image' | 'firstLast' | 'reference';
export type ModelInputs = {
  prompt: string;
  negative?: string;
  firstFrame?: string;
  lastFrame?: string;
  references: string[];
};

export type GenModel = {
  id: string;
  provider: Provider;
  name: string;
  maker: string;
  summary: string;
  endpoints: Partial<Record<Mode, string>>;
  durations: number[];
  /** Frames the model can produce from text or references. Image modes follow the first frame. */
  aspects: Aspect[];
  /** Empty when the model renders at one fixed resolution. */
  resolutions: Resolution[];
  fixedResolution?: string;
  audio: boolean;
  lastFrame: boolean;
  maxReferences: number;
  /** References and a first frame in the same request. */
  framesWithReferences?: boolean;
  negative: boolean;
  seed: boolean;
  /** Narrower limits for one input mode, where that endpoint's schema differs from the rest. */
  modeLimits?: Partial<Record<Mode, { durations?: number[]; negative?: boolean; seed?: boolean }>>;
  /** Cents for a direction, when the provider publishes a rate. */
  price?: (d: Pick<Direction, 'duration' | 'resolution' | 'aspectRatio' | 'audio'>) => number;
  priceNote: string;
  /** What the model or its provider refuses, shown as a tooltip on the model card. */
  safety: string;
  /** References are named "Image 1" in the prompt instead of Seedance's "@Image1". */
  plainReferences?: boolean;
  /** Superseded by a newer model; listed under Earlier models. */
  earlier?: boolean;
  build: (mode: Mode, d: Direction, inputs: ModelInputs) => Record<string, unknown>;
};

// Safety notes are the user-facing summary of each provider's published rules and of
// rejections seen in practice. They are guidance, not a guarantee of what will pass.
const SEEDANCE_SAFETY =
  'Refuses reference images and frames that show a realistic human face, including your own photos (ByteDance’s anti-deepfake rule). Illustrated or stylised people work. Prompts naming real public figures or copyrighted characters may be refused.';
const KLING_SAFETY =
  'Accepts photos of real people as frames and references. Kuaishou’s moderation may reject sexual, violent or politically sensitive content.';
const VEO_SAFETY =
  'Accepts photos of adults as frames. Google’s filters may block images of children or recognisable public figures, and sexual or violent content.';
const WAN_SAFETY = 'Accepts photos of real people. fal’s safety checker is on and blocks explicit content.';
const H3_SAFETY = 'Accepts photos of real people. MiniMax’s moderation may reject explicit or sensitive content.';
const HF_REFUND = ' On Higgsfield a moderated request ends as nsfw and the credits are refunded.';

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const cents = (dollars: number) => Math.ceil(dollars * 100 - 1e-9);
const compact = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

// fal bills Seedance 2.0 by tokens: height x width x duration x 24 / 1024 at $0.014 per 1000
// tokens ($0.0112 fast). Frames wider than 16:9 have more pixels, so estimate from the larger.
const shortSide = { '480p': 480, '720p': 720, '1080p': 1080 } as const;
const ratio = { '9:16': 16 / 9, '16:9': 16 / 9, '21:9': 21 / 9, '1:1': 1, '3:4': 4 / 3 } as const;
export function seedanceCents(d: Pick<Direction, 'resolution' | 'aspectRatio' | 'duration'>, fast = false) {
  const side = shortSide[d.resolution];
  const area = Math.max(side * side * ratio[d.aspectRatio], side * side * (16 / 9));
  const tokens = (area * d.duration * 24) / 1024;
  return Math.ceil((tokens / 1000) * (fast ? 0.0112 : 0.014) * 100);
}

// Seedance 2.5 bills the same token formula at $0.0214 per 1000 tokens up to 720p and $0.0234 at
// 1080p (about $0.47 a second at 720p and $1.16 at 1080p for a vertical frame).
export function seedance25Cents(d: Pick<Direction, 'resolution' | 'aspectRatio' | 'duration'>) {
  const side = shortSide[d.resolution];
  const area = Math.max(side * side * ratio[d.aspectRatio], side * side * (16 / 9));
  const tokens = (area * d.duration * 24) / 1024;
  return Math.ceil((tokens / 1000) * (d.resolution === '1080p' ? 0.0234 : 0.0214) * 100);
}

const falSeedance25: GenModel = {
  id: 'seedance-2.5',
  provider: 'fal',
  name: 'Seedance 2.5',
  maker: 'ByteDance',
  summary: 'The most cinematic image in our side-by-side: depth, texture, film light. Pricier. No real faces.',
  endpoints: {
    text: 'bytedance/seedance-2.5/text-to-video',
    image: 'bytedance/seedance-2.5/image-to-video',
    reference: 'bytedance/seedance-2.5/reference-to-video',
  },
  // The endpoint takes up to 30 s; the studio's shots stop at 20.
  durations: range(4, 20),
  aspects: ['9:16', '16:9', '21:9', '1:1', '3:4'],
  resolutions: ['480p', '720p', '1080p'],
  audio: true,
  lastFrame: true,
  maxReferences: 6,
  negative: false,
  seed: false,
  price: seedance25Cents,
  priceNote: 'About $0.47 a second at 720p, $1.16 at 1080p',
  safety: SEEDANCE_SAFETY,
  build: (mode, d, i) =>
    compact({
      prompt: i.prompt,
      duration: String(d.duration),
      resolution: d.resolution,
      aspect_ratio: mode === 'image' ? 'auto' : d.aspectRatio,
      generate_audio: d.audio,
      bitrate_mode: 'high',
      image_url: i.firstFrame,
      end_image_url: i.lastFrame,
      image_urls: mode === 'reference' ? i.references : undefined,
    }),
};

function falSeedance(fast: boolean): GenModel {
  const base = `bytedance/seedance-2.0/${fast ? 'fast/' : ''}`;
  return {
    id: fast ? 'seedance-2.0-fast' : 'seedance-2.0',
    provider: 'fal',
    name: fast ? 'Seedance 2.0 Fast' : 'Seedance 2.0',
    maker: 'ByteDance',
    summary: fast
      ? 'Cheaper, quicker Seedance. Good for blocking out a shot before the final render.'
      : 'Strong camera direction and up to six cast references. Native ambient sound.',
    endpoints: { text: `${base}text-to-video`, image: `${base}image-to-video`, reference: `${base}reference-to-video` },
    durations: range(4, 15),
    aspects: ['9:16', '16:9', '21:9', '1:1', '3:4'],
    resolutions: fast ? ['480p', '720p'] : ['480p', '720p', '1080p'],
    audio: true,
    lastFrame: true,
    maxReferences: 6,
    negative: false,
    seed: false,
    price: (d) => seedanceCents(d, fast),
    priceNote: fast ? 'About $0.24 a second at 720p' : 'About $0.30 a second at 720p, $0.68 at 1080p',
    safety: SEEDANCE_SAFETY,
    build: (mode, d, i) =>
      compact({
        prompt: i.prompt,
        duration: String(d.duration),
        resolution: d.resolution,
        aspect_ratio: mode === 'image' ? 'auto' : d.aspectRatio,
        generate_audio: d.audio,
        image_url: i.firstFrame,
        end_image_url: i.lastFrame,
        image_urls: mode === 'reference' ? i.references : undefined,
      }),
  };
}

const falKling3: GenModel = {
  id: 'kling-3-pro',
  provider: 'fal',
  name: 'Kling 3.0 Pro',
  maker: 'Kuaishou',
  summary: 'Lifelike motion and faces, start and end frames, negative prompt. 1080p.',
  endpoints: {
    text: 'fal-ai/kling-video/v3/pro/text-to-video',
    image: 'fal-ai/kling-video/v3/pro/image-to-video',
  },
  durations: range(3, 15),
  aspects: ['16:9', '9:16', '1:1'],
  resolutions: [],
  fixedResolution: '1080p',
  audio: true,
  lastFrame: true,
  maxReferences: 0,
  negative: true,
  seed: false,
  price: (d) => cents(d.duration * (d.audio ? 0.168 : 0.112)),
  priceNote: '$0.112 a second, $0.168 with sound',
  safety: KLING_SAFETY,
  build: (mode, d, i) =>
    compact({
      prompt: i.prompt,
      duration: String(d.duration),
      generate_audio: d.audio,
      negative_prompt: i.negative,
      aspect_ratio: mode === 'text' ? d.aspectRatio : undefined,
      start_image_url: i.firstFrame,
      end_image_url: i.lastFrame,
    }),
};

const falKlingO3: GenModel = {
  id: 'kling-o3-pro',
  provider: 'fal',
  name: 'Kling O3 Pro',
  maker: 'Kuaishou',
  summary: 'Combines cast references with start and end frames in one shot.',
  endpoints: {
    text: 'fal-ai/kling-video/o3/pro/text-to-video',
    image: 'fal-ai/kling-video/o3/pro/image-to-video',
    reference: 'fal-ai/kling-video/o3/pro/reference-to-video',
  },
  durations: range(3, 15),
  aspects: ['16:9', '9:16', '1:1'],
  resolutions: [],
  fixedResolution: '1080p',
  audio: true,
  lastFrame: true,
  maxReferences: 4,
  framesWithReferences: true,
  negative: false,
  seed: false,
  price: (d) => cents(d.duration * (d.audio ? 0.14 : 0.112)),
  priceNote: '$0.112 a second, $0.14 with sound',
  safety: KLING_SAFETY,
  build: (mode, d, i) =>
    compact({
      prompt: i.prompt,
      duration: String(d.duration),
      generate_audio: d.audio,
      aspect_ratio: mode === 'image' ? undefined : d.aspectRatio,
      ...(mode === 'reference'
        ? { image_urls: i.references, start_image_url: i.firstFrame, end_image_url: i.lastFrame }
        : { image_url: i.firstFrame, end_image_url: i.lastFrame }),
    }),
};

function falVeo(fast: boolean): GenModel {
  const base = fast ? 'fal-ai/veo3.1/fast' : 'fal-ai/veo3.1';
  return {
    id: fast ? 'veo-3.1-fast' : 'veo-3.1',
    provider: 'fal',
    name: fast ? 'Veo 3.1 Fast' : 'Veo 3.1',
    maker: 'Google',
    summary: fast
      ? 'Veo at a third of the price. Dialogue and sound, exact first and last frames.'
      : 'Best for dialogue, sound design and physical realism. Exact first and last frames.',
    endpoints: {
      text: base,
      image: `${base}/image-to-video`,
      firstLast: `${base}/first-last-frame-to-video`,
      ...(fast ? {} : { reference: 'fal-ai/veo3.1/reference-to-video' }),
    },
    durations: [4, 6, 8],
    aspects: ['16:9', '9:16'],
    resolutions: ['720p', '1080p'],
    audio: true,
    lastFrame: true,
    maxReferences: fast ? 0 : 3,
    negative: true,
    seed: true,
    // fal's reference-to-video schema takes no negative prompt or seed, and only 8 seconds.
    modeLimits: { reference: { durations: [8], negative: false, seed: false } },
    price: (d) => cents(d.duration * (fast ? (d.audio ? 0.15 : 0.1) : d.audio ? 0.4 : 0.2)),
    priceNote: fast ? '$0.10 a second, $0.15 with sound' : '$0.20 a second, $0.40 with sound',
    safety: VEO_SAFETY,
    build: (mode, d, i) =>
      compact({
        prompt: i.prompt,
        duration: `${d.duration}s`,
        resolution: d.resolution,
        generate_audio: d.audio,
        aspect_ratio: mode === 'image' || mode === 'firstLast' ? 'auto' : d.aspectRatio,
        negative_prompt: mode === 'reference' ? undefined : i.negative,
        seed: mode === 'reference' ? undefined : (d.seed ?? undefined),
        image_url: mode === 'image' ? i.firstFrame : undefined,
        first_frame_url: mode === 'firstLast' ? i.firstFrame : undefined,
        last_frame_url: mode === 'firstLast' ? i.lastFrame : undefined,
        image_urls: mode === 'reference' ? i.references : undefined,
      }),
  };
}

const falWan3: GenModel = {
  id: 'wan-3.0',
  provider: 'fal',
  name: 'Wan 3.0',
  maker: 'Alibaba',
  summary: 'Alibaba’s newest open model: 1080p with sound, start and end frames, seed. Good value.',
  endpoints: { text: 'alibaba/wan-3.0/text-to-video', image: 'alibaba/wan-3.0/image-to-video' },
  durations: range(2, 20),
  aspects: ['16:9', '9:16', '1:1', '3:4'],
  resolutions: ['480p', '720p', '1080p'],
  audio: true,
  lastFrame: true,
  maxReferences: 0,
  negative: false,
  seed: true,
  price: (d) => cents(d.duration * ({ '480p': 0.05, '720p': 0.1, '1080p': 0.2 } as const)[d.resolution]),
  priceNote: '$0.10 a second at 720p, $0.20 at 1080p, sound included.',
  safety: WAN_SAFETY,
  build: (mode, d, i) =>
    compact({
      prompt: i.prompt,
      duration: d.duration,
      resolution: d.resolution,
      aspect_ratio: mode === 'text' ? d.aspectRatio : undefined,
      audio: d.audio,
      seed: d.seed ?? undefined,
      start_image_url: i.firstFrame,
      end_image_url: i.lastFrame,
    }),
};

const falWan27: GenModel = {
  id: 'wan-2.7',
  provider: 'fal',
  name: 'Wan 2.7',
  maker: 'Alibaba',
  summary: 'The budget option: 2 to 15 seconds, start and end frames, negative prompt and seed.',
  endpoints: { text: 'fal-ai/wan/v2.7/text-to-video', image: 'fal-ai/wan/v2.7/image-to-video' },
  durations: range(2, 15),
  aspects: ['16:9', '9:16', '1:1', '3:4'],
  resolutions: ['720p', '1080p'],
  audio: false,
  lastFrame: true,
  maxReferences: 0,
  negative: true,
  seed: true,
  price: (d) => cents(d.duration * (d.resolution === '1080p' ? 0.15 : 0.1)),
  priceNote: '$0.10 a second at 720p, $0.15 at 1080p. Silent.',
  safety: WAN_SAFETY,
  build: (mode, d, i) =>
    compact({
      prompt: i.prompt,
      duration: d.duration,
      resolution: d.resolution,
      aspect_ratio: mode === 'text' ? d.aspectRatio : undefined,
      negative_prompt: i.negative,
      seed: d.seed ?? undefined,
      image_url: i.firstFrame,
      end_image_url: i.lastFrame,
    }),
};

// Higgsfield hosts several of the same model families under its own credits.
const hfSeedance: GenModel = {
  id: 'hf-seedance-2.0',
  provider: 'higgsfield',
  name: 'Seedance 2.0',
  maker: 'ByteDance',
  summary: 'The same Seedance 2.0, billed to Higgsfield credits. Up to six cast references.',
  endpoints: {
    text: 'bytedance/seedance-2.0/text-to-video',
    image: 'bytedance/seedance-2.0/image-to-video',
    reference: 'bytedance/seedance-2.0/reference-to-video',
  },
  durations: range(4, 15),
  aspects: ['9:16', '16:9', '21:9', '1:1', '3:4'],
  resolutions: ['480p', '720p', '1080p'],
  audio: true,
  lastFrame: true,
  maxReferences: 6,
  negative: false,
  seed: false,
  price: seedanceCents,
  priceNote: 'Quoted by Higgsfield before each render',
  safety: SEEDANCE_SAFETY + HF_REFUND,
  build: (mode, d, i) =>
    compact({
      prompt: i.prompt,
      duration: d.duration,
      resolution: d.resolution,
      generate_audio: d.audio,
      aspect_ratio: mode === 'image' ? undefined : d.aspectRatio,
      image_url: i.firstFrame,
      end_image_url: i.lastFrame,
      image_urls: mode === 'reference' ? i.references : undefined,
    }),
};

const hfSeedance25: GenModel = {
  ...hfSeedance,
  id: 'hf-seedance-2.5',
  name: 'Seedance 2.5',
  summary: 'Seedance 2.5 on Higgsfield credits: the most cinematic image, film light and texture. No real faces.',
  endpoints: {
    text: 'bytedance/seedance-2.5/text-to-video',
    image: 'bytedance/seedance-2.5/image-to-video',
    reference: 'bytedance/seedance-2.5/reference-to-video',
  },
  durations: range(4, 20),
  aspects: ['9:16', '16:9', '21:9', '1:1', '3:4'],
  // Higgsfield bills Seedance 2.5 at the same token rate as fal.
  price: seedance25Cents,
  build: (mode, d, i) =>
    compact({
      prompt: i.prompt,
      duration: d.duration,
      resolution: d.resolution,
      generate_audio: d.audio,
      bitrate_mode: 'high',
      aspect_ratio: mode === 'image' ? undefined : d.aspectRatio,
      image_url: i.firstFrame,
      end_image_url: i.lastFrame,
      image_urls: mode === 'reference' ? i.references : undefined,
    }),
};

const hfKling3: GenModel = {
  id: 'hf-kling-3-pro',
  provider: 'higgsfield',
  name: 'Kling 3.0 Pro',
  maker: 'Kuaishou',
  summary: 'Kling 3.0 on Higgsfield credits. Start and end frames, native sound.',
  endpoints: {
    text: 'kling-video/v3.0/pro/text-to-video',
    image: 'kling-video/v3.0/pro/image-to-video',
  },
  durations: range(3, 15),
  aspects: ['16:9', '9:16', '1:1'],
  resolutions: [],
  fixedResolution: '1080p',
  audio: true,
  lastFrame: true,
  maxReferences: 0,
  negative: false,
  seed: false,
  // $0.714 for 5 s without sound.
  price: (d) => cents(0.1428 * d.duration),
  priceNote: 'Quoted by Higgsfield before each render',
  safety: KLING_SAFETY + HF_REFUND,
  build: (mode, d, i) =>
    compact({
      prompt: i.prompt,
      duration: d.duration,
      sound: d.audio ? 'on' : 'off',
      aspect_ratio: mode === 'text' ? d.aspectRatio : undefined,
      image_url: i.firstFrame,
      last_image_url: i.lastFrame,
    }),
};

const hfKlingO3: GenModel = {
  id: 'hf-kling-o3',
  provider: 'higgsfield',
  name: 'Kling O3 first and last frame',
  maker: 'Kuaishou',
  summary: 'Animates between your first and last frames. Needs a first frame.',
  endpoints: { image: 'kling-video/o3/first-last-frame', firstLast: 'kling-video/o3/first-last-frame' },
  durations: range(3, 15),
  aspects: ['16:9', '9:16', '1:1'],
  resolutions: [],
  fixedResolution: '1080p',
  audio: true,
  lastFrame: true,
  maxReferences: 0,
  negative: false,
  seed: false,
  // $0.476 for 5 s.
  price: (d) => cents(0.0952 * d.duration),
  priceNote: 'Quoted by Higgsfield before each render',
  safety: KLING_SAFETY + HF_REFUND,
  build: (_mode, d, i) =>
    compact({
      prompt: i.prompt,
      mode: 'pro',
      duration: d.duration,
      sound: d.audio ? 'on' : 'off',
      aspect_ratio: d.aspectRatio === '21:9' || d.aspectRatio === '3:4' ? undefined : d.aspectRatio,
      first_frame_url: i.firstFrame,
      last_frame_url: i.lastFrame,
    }),
};

const hfWan3: GenModel = {
  id: 'hf-wan-3.0',
  provider: 'higgsfield',
  name: 'Wan 3.0',
  maker: 'Alibaba',
  summary: 'Up to 20 seconds with native sound, frames or up to six references, and a seed.',
  endpoints: {
    text: 'alibaba/wan-3.0/text-to-video',
    image: 'alibaba/wan-3.0/image-to-video',
    reference: 'alibaba/wan-3.0/reference-to-video',
  },
  durations: range(2, 20),
  aspects: ['16:9', '9:16', '1:1', '3:4'],
  resolutions: ['480p', '720p', '1080p'],
  audio: true,
  lastFrame: true,
  maxReferences: 6,
  negative: false,
  seed: true,
  price: (d) => cents({ '480p': 0.05, '720p': 0.1, '1080p': 0.2 }[d.resolution] * d.duration),
  priceNote: 'Quoted by Higgsfield before each render',
  safety: 'Accepts photos of real people. Alibaba’s moderation may reject explicit content.' + HF_REFUND,
  build: (mode, d, i) =>
    compact({
      prompt: i.prompt,
      duration: d.duration,
      resolution: d.resolution,
      generate_audio: d.audio,
      aspect_ratio: mode === 'image' ? 'adaptive' : d.aspectRatio,
      seed: d.seed ?? undefined,
      image_url: i.firstFrame,
      end_image_url: i.lastFrame,
      image_urls: mode === 'reference' ? i.references : undefined,
    }),
};

const hfH3: GenModel = {
  id: 'hf-minimax-h3',
  provider: 'higgsfield',
  name: 'MiniMax H3',
  maker: 'MiniMax',
  summary: 'Renders at 2K. Frames or up to six references, 5 to 15 seconds.',
  endpoints: {
    text: 'minimax/h3/text-to-video',
    image: 'minimax/h3/image-to-video',
    reference: 'minimax/h3/reference-to-video',
  },
  durations: range(5, 15),
  aspects: ['9:16', '16:9', '21:9', '1:1', '3:4'],
  resolutions: [],
  fixedResolution: '2K',
  audio: false,
  lastFrame: true,
  maxReferences: 6,
  negative: false,
  seed: false,
  // $0.553 for 5 s at 2K.
  price: (d) => cents(0.1106 * d.duration),
  priceNote: 'Quoted by Higgsfield before each render',
  safety: H3_SAFETY + HF_REFUND,
  build: (mode, d, i) =>
    compact({
      prompt: i.prompt,
      duration: d.duration,
      resolution: '2K',
      aspect_ratio: mode === 'image' ? 'auto' : d.aspectRatio,
      image_url: i.firstFrame,
      end_image_url: i.lastFrame,
      image_urls: mode === 'reference' ? i.references : undefined,
    }),
};


// The current generation (reviewed 4 October 2026 against fal's model pages and a side-by-side
// render of the same dolly shot). Prices are fal's list rates; promotional discounts are ignored
// so the estimate stays honest after they end.
const h3Res = { '480p': '480P', '720p': '768P', '1080p': '1080P' } as const;
const falH3Max: GenModel = {
  id: 'h3-max',
  provider: 'fal',
  name: 'MiniMax H3 Max',
  maker: 'MiniMax',
  summary: 'fal’s tuned H3: strong prompt adherence, first, middle and last frames plus references, 1080p.',
  endpoints: {
    text: 'minimax/h3-max/text-to-video',
    image: 'minimax/h3-max/image-to-video',
    firstLast: 'minimax/h3-max/image-to-video',
    reference: 'minimax/h3-max/reference-to-video',
  },
  durations: range(2, 15),
  aspects: ['9:16', '16:9', '21:9', '1:1', '3:4'],
  resolutions: ['480p', '720p', '1080p'],
  audio: true,
  lastFrame: true,
  maxReferences: 6,
  framesWithReferences: true,
  negative: false,
  seed: true,
  price: (d) => cents(d.duration * ({ '480p': 0.05, '720p': 0.08, '1080p': 0.16 } as const)[d.resolution]),
  priceNote: '$0.08 a second at 768p, $0.16 at 1080p, sound included.',
  safety: H3_SAFETY,
  plainReferences: true,
  build: (mode, d, i) =>
    compact({
      prompt: i.prompt,
      duration: d.duration,
      resolution: h3Res[d.resolution],
      aspect_ratio: mode === 'text' || (mode === 'reference' && !i.firstFrame) ? d.aspectRatio : undefined,
      prompt_expansion_mode: 'balanced',
      seed: d.seed ?? undefined,
      image_url: i.firstFrame,
      end_image_url: i.lastFrame,
      reference_image_urls: mode === 'reference' && i.references.length ? i.references : undefined,
    }),
};

const falGeminiOmni: GenModel = {
  id: 'gemini-omni-flash-1.1',
  provider: 'fal',
  name: 'Gemini Omni Flash 1.1',
  maker: 'Google',
  summary: 'Best at following a camera move and its beats in our side-by-side, with natural motion. Google’s newest. Vertical or wide.',
  endpoints: {
    text: 'google/gemini-omni-flash/v1.1/text-to-video',
    image: 'google/gemini-omni-flash/v1.1/image-to-video',
    firstLast: 'google/gemini-omni-flash/v1.1/image-to-video',
    reference: 'google/gemini-omni-flash/v1.1/reference-to-video',
  },
  durations: range(3, 10),
  aspects: ['9:16', '16:9'],
  resolutions: ['720p', '1080p'],
  audio: true,
  lastFrame: true,
  maxReferences: 6,
  negative: false,
  seed: false,
  price: (d) => cents(d.duration * (d.resolution === '1080p' ? 0.15 : 0.1)),
  priceNote: '$0.10 a second at 720p, $0.15 at 1080p, sound included.',
  safety: VEO_SAFETY,
  build: (mode, d, i) =>
    compact({
      prompt: i.prompt,
      duration: d.duration,
      resolution: d.resolution,
      aspect_ratio: d.aspectRatio === '16:9' ? '16:9' : '9:16',
      image_url: i.firstFrame,
      end_image_url: i.lastFrame,
      image_urls: mode === 'reference' ? i.references : undefined,
    }),
};

const falWan3Prime: GenModel = {
  id: 'wan-3.0-prime',
  provider: 'fal',
  name: 'Wan 3.0 Prime',
  maker: 'Alibaba',
  summary: 'Alibaba’s top tier: 1080p with sound, up to ten references, takes up to 20 s.',
  endpoints: {
    text: 'alibaba/wan-3.0-prime/text-to-video',
    image: 'alibaba/wan-3.0-prime/image-to-video',
    firstLast: 'alibaba/wan-3.0-prime/image-to-video',
    reference: 'alibaba/wan-3.0-prime/reference-to-video',
  },
  durations: range(2, 20),
  aspects: ['9:16', '16:9', '1:1', '3:4'],
  resolutions: ['480p', '720p', '1080p'],
  audio: true,
  lastFrame: true,
  maxReferences: 6,
  negative: false,
  seed: true,
  price: (d) => cents(d.duration * ({ '480p': 0.068, '720p': 0.14, '1080p': 0.28 } as const)[d.resolution]),
  priceNote: '$0.14 a second at 720p, $0.28 at 1080p, sound included.',
  safety: WAN_SAFETY,
  plainReferences: true,
  build: (mode, d, i) =>
    compact({
      prompt: i.prompt,
      duration: d.duration,
      resolution: d.resolution,
      aspect_ratio: mode === 'text' || mode === 'reference' ? d.aspectRatio : undefined,
      audio: d.audio,
      seed: d.seed ?? undefined,
      start_image_url: i.firstFrame,
      end_image_url: i.lastFrame,
      reference_image_urls: mode === 'reference' ? i.references : undefined,
    }),
};

const falFlux3Video: GenModel = {
  id: 'flux-3-video',
  provider: 'fal',
  name: 'FLUX 3 Video',
  maker: 'Black Forest Labs',
  summary: 'Black Forest Labs’ frontier video model: photographic texture, sound, start and end frames.',
  endpoints: {
    text: 'blackforestlabs/flux-3/text-to-video',
    image: 'blackforestlabs/flux-3/image-to-video',
    firstLast: 'blackforestlabs/flux-3/first-last-frame-to-video',
  },
  durations: range(5, 20),
  aspects: ['9:16', '16:9', '21:9', '1:1', '3:4'],
  resolutions: ['720p', '1080p'],
  audio: true,
  lastFrame: true,
  maxReferences: 0,
  negative: false,
  seed: false,
  price: (d) => cents(d.duration * (d.resolution === '1080p' ? 0.29 : 0.17)),
  priceNote: '$0.17 a second at 720p, $0.29 at 1080p, sound included.',
  safety: 'Real people in frames are accepted. Black Forest Labs’ moderation runs at its default tolerance and blocks explicit content.',
  build: (mode, d, i) =>
    compact({
      prompt: i.prompt,
      duration: d.duration,
      resolution: d.resolution,
      aspect_ratio: mode === 'text' ? d.aspectRatio : 'auto',
      generate_audio: d.audio,
      image_url: mode === 'image' ? i.firstFrame : undefined,
      start_image_url: mode === 'firstLast' ? i.firstFrame : undefined,
      end_image_url: mode === 'firstLast' ? i.lastFrame : undefined,
    }),
};

// Higgsfield's own director model (released 18 September 2026). It is the one model here that
// takes the camera move as a parameter instead of prompt text, and it reads the start frame and
// cast as image references. Billed by the Seedance 2.5 token rate: $0.21 to $0.46 a second.
const cinemaMove = { in: 'dolly-in', out: 'dolly-out', left: 'truck-left', right: 'truck-right', static: 'static-shot' } as const;
const hfCinemaStudio: GenModel = {
  id: 'hf-cinema-studio-4',
  provider: 'higgsfield',
  name: 'Cinema Studio 4.0',
  maker: 'Higgsfield',
  summary: 'Higgsfield’s director model: real camera moves, automatic scene direction and sound, 4 to 20 s.',
  endpoints: {
    text: 'higgsfield/cinema-studio/4.0',
    image: 'higgsfield/cinema-studio/4.0',
    reference: 'higgsfield/cinema-studio/4.0',
  },
  durations: range(4, 20),
  aspects: ['9:16', '16:9', '21:9', '1:1', '3:4'],
  resolutions: ['480p', '720p'],
  audio: true,
  lastFrame: false,
  maxReferences: 9,
  framesWithReferences: true,
  negative: false,
  seed: false,
  price: seedance25Cents,
  priceNote: 'About $0.21 a second at 480p, $0.46 at 720p, sound included',
  safety: 'Accepts photos of real people as references. Higgsfield’s moderation may reject explicit content.' + HF_REFUND,
  plainReferences: true,
  build: (_mode, d, i) => {
    const images = [i.firstFrame, ...i.references].filter((u): u is string => Boolean(u));
    return compact({
      prompt: i.prompt,
      duration: d.duration,
      resolution: d.resolution === '1080p' ? '720p' : d.resolution,
      aspect_ratio: d.aspectRatio,
      generate_audio: d.audio,
      camera_movement: d.move === 'free' ? undefined : cinemaMove[d.move],
      image_urls: images.length ? images : undefined,
    });
  },
};

// Newest first. The first model of a provider is its default.
const EARLIER = new Set(['seedance-2.0', 'seedance-2.0-fast', 'kling-3-pro', 'veo-3.1', 'veo-3.1-fast', 'wan-2.7', 'hf-seedance-2.0', 'hf-kling-3-pro']);
export const MODELS: GenModel[] = [
  falGeminiOmni,
  falSeedance25,
  falH3Max,
  falWan3Prime,
  falFlux3Video,
  falKlingO3,
  falWan3,
  falSeedance(false),
  falSeedance(true),
  falKling3,
  falVeo(false),
  falVeo(true),
  falWan27,
  hfSeedance25,
  hfCinemaStudio,
  hfH3,
  hfWan3,
  hfKlingO3,
  hfSeedance,
  hfKling3,
].map((m) => (EARLIER.has(m.id) ? { ...m, earlier: true } : m));

export const modelById = (id: string) => MODELS.find((m) => m.id === id);
export const modelsFor = (provider: Provider) => MODELS.filter((m) => m.provider === provider);
export const defaultModel = (provider: Provider) => modelsFor(provider)[0];

export function modeFor(model: GenModel, d: Pick<Direction, 'firstFrameId' | 'lastFrameId' | 'referenceIds'>): Mode {
  if (d.referenceIds.length && model.framesWithReferences) return 'reference';
  if (d.firstFrameId) return d.lastFrameId && model.endpoints.firstLast ? 'firstLast' : 'image';
  if (d.referenceIds.length) return 'reference';
  return 'text';
}

// Problems with a direction on a model, in the words the user sees. Empty means valid.
/** What the model accepts for this direction's input mode. */
export function capsFor(model: GenModel, d: Pick<Direction, 'firstFrameId' | 'lastFrameId' | 'referenceIds'>) {
  const limits = model.modeLimits?.[modeFor(model, d)] ?? {};
  return {
    durations: limits.durations ?? model.durations,
    negative: limits.negative ?? model.negative,
    seed: limits.seed ?? model.seed,
  };
}

export function modelProblems(model: GenModel | undefined, d: Direction): string[] {
  if (!model) return ['Choose a model'];
  const out: string[] = [];
  if (model.provider !== d.provider) out.push(`${model.name} is not offered on this provider`);
  const mode = modeFor(model, d);
  if (!model.endpoints[mode]) {
    if (mode === 'text') out.push(`${model.name} needs a first frame`);
    else if (mode === 'reference') out.push(`${model.name} does not take cast references. Clear the cast or pick another model.`);
    else out.push(`${model.name} cannot start from a first frame`);
  }
  if (d.referenceIds.length && d.firstFrameId && !model.framesWithReferences)
    out.push(`${model.name} takes either a first frame or cast references, not both`);
  if (d.referenceIds.length > model.maxReferences && model.maxReferences > 0)
    out.push(`${model.name} takes up to ${model.maxReferences} references`);
  if (d.lastFrameId && !model.lastFrame) out.push(`${model.name} cannot end on a last frame`);
  const { durations } = capsFor(model, d);
  if (!durations.includes(d.duration))
    out.push(
      `${model.name} renders ${
        durations.length > 4
          ? `${durations[0]} to ${durations.at(-1)} seconds`
          : `${durations.join(', ')} seconds`
      }${durations !== model.durations ? ' with cast references' : ''}`,
    );
  if (model.resolutions.length && !model.resolutions.includes(d.resolution))
    out.push(`${model.name} renders at ${model.resolutions.join(' or ')}`);
  if (!d.firstFrameId && !model.aspects.includes(d.aspectRatio))
    out.push(`${model.name} renders ${model.aspects.join(', ')} frames`);
  return out;
}

// Snap a direction onto a model's nearest valid settings when the user switches models.
export function fitToModel(model: GenModel, d: Direction): Direction {
  const duration = capsFor(model, d).durations.reduce((best, x) =>
    Math.abs(x - d.duration) < Math.abs(best - d.duration) ? x : best,
  );
  const resolution = model.resolutions.length
    ? model.resolutions.includes(d.resolution)
      ? d.resolution
      : model.resolutions.includes('1080p')
        ? '1080p'
        : model.resolutions.at(-1)!
    : d.resolution;
  const aspectRatio = model.aspects.includes(d.aspectRatio) ? d.aspectRatio : model.aspects.includes('9:16') ? '9:16' : model.aspects[0];
  return {
    ...d,
    provider: model.provider,
    model: model.id,
    duration,
    resolution,
    aspectRatio,
    audio: model.audio ? d.audio : false,
    referenceIds: model.maxReferences ? d.referenceIds.slice(0, model.maxReferences) : d.referenceIds,
  };
}

// Image models for creating cast references, frames, scene stills and covers. "edit" endpoints
// take reference images so a frame can include the selected cast.
export type ImageModel = {
  id: string;
  provider: Provider;
  name: string;
  maker: string;
  summary: string;
  safety: string;
  text: string;
  /** Missing when the model only generates from text. */
  edit?: string;
  /** Reference images the edit endpoint accepts, when it caps them (0 for text only). */
  maxImages?: number;
  /** Takes a trained Higgsfield Soul ID (custom_reference_id) for one cast member. */
  soulId?: boolean;
  /** Cents for one image with this many reference images attached. */
  cents: (references: number) => number;
  build: (prompt: string, aspect: Aspect | '3:4', images: string[]) => Record<string, unknown>;
};

const fluxSize = { '9:16': 'portrait_16_9', '3:4': 'portrait_4_3', '1:1': 'square_hd', '16:9': 'landscape_16_9', '21:9': 'landscape_16_9' } as const;
// Soul has no 21:9 frame; it falls back to the widest it makes.
const soulAspect = { '9:16': '9:16', '3:4': '3:4', '1:1': '1:1', '16:9': '16:9', '21:9': '16:9' } as const;
const gptSize = { '9:16': '1024x1536', '3:4': '1024x1536', '1:1': '1024x1024', '16:9': '1536x1024', '21:9': '1536x1024' } as const;

export const IMAGE_MODELS: ImageModel[] = [
  {
    id: 'nano-banana-pro',
    provider: 'fal',
    name: 'Nano Banana Pro',
    maker: 'Google',
    summary: 'Best at keeping a likeness and composing several cast members into one frame.',
    safety: 'Google’s filters may refuse realistic images of children or public figures, and edits that put real people in sensitive situations.',
    text: 'fal-ai/nano-banana-pro',
    edit: 'fal-ai/nano-banana-pro/edit',
    // $0.15 at 1K and 2K alike; 4K is double. Frames are made at 2K so 1080p video starts sharp.
    cents: () => 15,
    build: (prompt, aspect, images) =>
      compact({ prompt, aspect_ratio: aspect, resolution: '2K', output_format: 'jpeg', num_images: 1, image_urls: images.length ? images : undefined }),
  },
  {
    id: 'flux-3',
    provider: 'fal',
    name: 'FLUX 3',
    maker: 'Black Forest Labs',
    summary: 'Black Forest Labs’ newest model: sharp photographic frames and up to ten references.',
    safety: 'Real people in reference images are accepted. Black Forest Labs’ moderation runs at its default tolerance and blocks explicit content.',
    text: 'blackforestlabs/flux-3/text-to-image',
    edit: 'blackforestlabs/flux-3/edit-image',
    // Billed per megapixel: $0.048 a megapixel at the list price ($0.024 during the launch
    // discount that ends 8 October 2026). A 2K 9:16 frame is about 2.4 MP.
    cents: () => 12,
    build: (prompt, aspect, images) =>
      compact({ prompt, aspect_ratio: aspect, resolution: '2k', output_format: 'jpeg', image_urls: images.length ? images : undefined }),
  },
  {
    id: 'flux-2-pro',
    provider: 'fal',
    name: 'FLUX.2 Pro',
    maker: 'Black Forest Labs',
    summary: 'Photographic detail and texture at a fraction of the price.',
    safety: 'fal’s safety checker is on and blocks explicit content. Real people in reference images are accepted.',
    text: 'fal-ai/flux-2-pro',
    edit: 'fal-ai/flux-2-pro/edit',
    // $0.03 for the first megapixel, $0.015 per extra megapixel of output and input (a 9:16
    // frame is about 2 MP; a downsized reference about 2.5 MP).
    cents: (references) => 6 + 5 * references,
    build: (prompt, aspect, images) =>
      compact({ prompt, image_size: fluxSize[aspect], output_format: 'jpeg', image_urls: images.length ? images : undefined }),
  },
  {
    id: 'gpt-image-1.5',
    provider: 'fal',
    name: 'GPT Image 1.5',
    maker: 'OpenAI',
    summary: 'Follows long, specific descriptions closely. Frames come out 2:3 or 3:2.',
    safety: 'OpenAI’s policy is strict: it often refuses to edit photos of real people and anything involving public figures.',
    text: 'fal-ai/gpt-image-1.5',
    edit: 'fal-ai/gpt-image-1.5/edit',
    // High quality is $0.13 to $0.20 per image plus a little for prompt and image tokens.
    cents: (references) => 22 + 2 * references,
    build: (prompt, aspect, images) =>
      compact({
        prompt,
        image_size: gptSize[aspect],
        quality: 'high',
        output_format: 'jpeg',
        num_images: 1,
        ...(images.length ? { image_urls: images, input_fidelity: 'high' } : {}),
      }),
  },
  {
    id: 'hf-qwen-image-3',
    provider: 'higgsfield',
    name: 'Qwen Image 3',
    maker: 'Alibaba',
    summary: 'Higgsfield’s image model: clean 2K frames and edits from up to three references, on Higgsfield credits.',
    safety: 'Accepts photos of real people. Alibaba’s moderation may reject explicit content; on Higgsfield a moderated request is refunded.',
    text: 'alibaba/qwen-image-3/text-to-image',
    edit: 'alibaba/qwen-image-3/edit',
    maxImages: 3,
    // Higgsfield's estimate: $0.08 at 2K with or without references (4 October 2026).
    cents: () => 8,
    build: (prompt, aspect, images) =>
      compact({ prompt, aspect_ratio: aspect, resolution: '2k', image_urls: images.length ? images : undefined }),
  },
  // Higgsfield's own image models. Prices are Higgsfield's quotes at these settings (4 October
  // 2026); Flare and Sunburst bill by tokens, so theirs are estimates from a 2K high-quality frame.
  ...(['', 'flare', 'sunburst'] as const).map(
    (variant): ImageModel => ({
      id: variant ? `hf-marketing-studio-${variant}` : 'hf-marketing-studio',
      provider: 'higgsfield',
      name: variant ? `Marketing Studio Image 2.5 ${variant === 'flare' ? 'Flare' : 'Sunburst'}` : 'Marketing Studio Image 2.0',
      maker: 'Higgsfield',
      summary: variant
        ? `Higgsfield’s campaign image model on GPT Image 2.5 ${variant === 'flare' ? 'Flare' : 'Sunburst'}: polished 2K frames and edits from your references.`
        : 'Higgsfield’s campaign image model: polished 2K frames and edits from your references, up to 4K.',
      safety: 'Moderation runs at Higgsfield’s default level and blocks explicit content; on Higgsfield a moderated request is refunded.',
      text: variant ? `marketing-studio/image/${variant}` : 'marketing-studio/image',
      edit: variant ? `marketing-studio/image/${variant}` : 'marketing-studio/image',
      maxImages: 10,
      cents: (references) => (variant ? 25 : 21) + 2 * references,
      build: (prompt, aspect, images) =>
        compact({ prompt, aspect_ratio: aspect, resolution: '2k', quality: 'high', image_urls: images.length ? images : undefined }),
    }),
  ),
  {
    id: 'hf-soul-2',
    provider: 'higgsfield',
    name: 'Soul 2',
    maker: 'Higgsfield',
    summary: 'Higgsfield’s realistic portrait and fashion model, under a cent a frame. Draws a cast member trained with Soul ID as the same person; edits take one photo.',
    safety: 'Accepts photos of real people. Higgsfield’s moderation blocks explicit content; a moderated request is refunded.',
    text: 'higgsfield-ai/soul/v2/standard',
    edit: 'higgsfield-ai/soul/v2/image-to-image',
    maxImages: 1,
    soulId: true,
    // $0.006 at 1080p with or without the reference.
    cents: () => 1,
    build: (prompt, aspect, images) =>
      compact({ prompt, aspect_ratio: soulAspect[aspect], resolution: '1080p', batch_size: 1, image_url: images[0] }),
  },
  {
    id: 'hf-soul',
    provider: 'higgsfield',
    name: 'Soul Standard',
    maker: 'Higgsfield',
    summary: 'The original Soul: fashion and lifestyle photos from text with Higgsfield’s style presets. Text only.',
    safety: 'Higgsfield’s moderation blocks explicit content; a moderated request is refunded.',
    text: 'higgsfield-ai/soul/standard',
    maxImages: 0,
    // $0.19 at 1080p.
    cents: () => 19,
    build: (prompt, aspect) => compact({ prompt, aspect_ratio: soulAspect[aspect], resolution: '1080p', batch_size: 1 }),
  },
];
export const imageModelById = (id: string) => IMAGE_MODELS.find((m) => m.id === id) ?? IMAGE_MODELS[0];
export const imageModelsFor = (provider: Provider) => IMAGE_MODELS.filter((m) => m.provider === provider);
/** Problem with sending this many reference images to the model, or null. */
export const imageLimitProblem = (m: ImageModel, images: number) =>
  m.maxImages !== undefined && images > m.maxImages
    ? m.maxImages === 0
      ? `${m.name} only makes images from text. Remove the references or choose another image model.`
      : `${m.name} takes up to ${m.maxImages} reference image${m.maxImages > 1 ? 's' : ''}. Choose fewer or another image model.`
    : null;
/** Image models that can edit, for surfaces that always send reference images. */
export const EDIT_IMAGE_MODELS = IMAGE_MODELS.filter((m): m is ImageModel & { edit: string } => Boolean(m.edit));
