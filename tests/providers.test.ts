import { describe, expect, it } from 'vitest';
import {
  buildOpenRouterInput,
  openRouterBlocker,
  priceOpenRouter,
  type OpenRouterModel,
} from '../src/providers/openrouter';
import { parseReplicatePricing, priceReplicate, replicateInputSpec, type ReplicateModel } from '../src/providers/replicate';
import { buildGenericInput } from '../src/lib/fal-schema';

// Shapes copied from OpenRouter's public /api/v1/videos/models (5 October 2026).
const veo: OpenRouterModel = {
  id: 'google/veo-3.1-fast',
  name: 'Google: Veo 3.1 Fast',
  supported_resolutions: ['720p', '1080p', '4K'],
  supported_aspect_ratios: ['16:9', '9:16'],
  supported_durations: [4, 6, 8],
  supported_frame_images: ['first_frame', 'last_frame'],
  generate_audio: true,
  seed: true,
  pricing_skus: {
    duration_seconds_with_audio: '0.12',
    duration_seconds_with_audio_4k: '0.30',
    duration_seconds_without_audio: '0.10',
    duration_seconds_with_audio_720p: '0.10',
    duration_seconds_without_audio_720p: '0.08',
  },
};
const seedance: OpenRouterModel = {
  id: 'bytedance/seedance-2.0',
  name: 'ByteDance: Seedance 2.0',
  supported_resolutions: ['480p', '720p', '1080p'],
  supported_aspect_ratios: ['16:9', '9:16'],
  supported_durations: [4, 5, 6, 8, 10],
  supported_frame_images: ['first_frame'],
  generate_audio: true,
  seed: true,
  pricing_skus: { video_tokens: '0.000007', video_tokens_1080p: '0.0000077', video_tokens_with_video_input: '0.0000043' },
};
const s = { duration: 5, aspectRatio: '9:16', resolution: '720p', audio: true, seed: 7 };

describe('OpenRouter', () => {
  it('snaps each setting to a value the model lists', () => {
    const { input, used } = buildOpenRouterInput(veo, 'a lake', s);
    expect(input).toEqual({
      model: 'google/veo-3.1-fast',
      prompt: 'a lake',
      duration: 6,
      resolution: '720p',
      aspect_ratio: '9:16',
      generate_audio: true,
      seed: 7,
    });
    expect(used).toEqual({ duration: 6, aspectRatio: '9:16', resolution: '720p', audio: true });
    const image = buildOpenRouterInput(veo, 'a lake', s, 'data:image/jpeg;base64,AAAA');
    expect(image.input.frame_images).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' }, frame_type: 'first_frame' },
    ]);
    expect(image.input.aspect_ratio).toBeUndefined();
  });

  it('prices from the most specific SKU for the resolution and sound', () => {
    const used = buildOpenRouterInput(veo, '', s).used;
    expect(priceOpenRouter(veo, used, 'text', '9:16').cents).toBe(60); // $0.10 × 6 s at 720p with audio
    expect(priceOpenRouter(veo, { ...used, audio: false }, 'text', '9:16').cents).toBe(48);
    // Token-priced: 720 × 1280 × 24 fps × 5 s / 1024 tokens at $0.000007.
    const sd = buildOpenRouterInput(seedance, '', s).used;
    expect(priceOpenRouter(seedance, sd, 'text', '9:16').cents).toBe(Math.ceil(((720 * 1280 * 24 * 5) / 1024) * 0.000007 * 100));
    const cents = priceOpenRouter(
      { ...veo, pricing_skus: { cents_per_second_output_720p: '17', minimum_cents_per_generation: '200' } },
      used,
      'text',
      '9:16',
    );
    expect(cents.cents).toBe(200); // 17¢ × 6 s, raised to the minimum
    expect(priceOpenRouter({ ...veo, pricing_skus: { reference_images: '0.04' } }, used, 'text', '9:16').cents).toBeNull();
    // Kling lists a sound rate beside per-resolution silent rates: sound on must use the sound rate.
    const kling = {
      ...veo,
      supported_durations: [5, 10],
      pricing_skus: {
        duration_seconds: '0.112',
        duration_seconds_with_audio: '0.168',
        text_to_video_duration_seconds_720p: '0.112',
      },
    };
    const k = buildOpenRouterInput(kling, '', s).used;
    expect(priceOpenRouter(kling, k, 'text', '9:16').cents).toBe(84);
    expect(priceOpenRouter(kling, { ...k, audio: false }, 'text', '9:16').cents).toBe(56);
  });

  it('blocks models that need a source video, and image mode without a start frame', () => {
    expect(openRouterBlocker({ ...veo, supported_durations: null }, 'text')).toMatch(/existing video/);
    expect(openRouterBlocker({ ...veo, supported_frame_images: null }, 'image')).toBe('Takes no start image');
    expect(openRouterBlocker(veo, 'image')).toBeNull();
  });
});

// The billing table shape embedded in replicate.com model pages (5 October 2026).
const page = (config: unknown, extra = '') =>
  `<script>{"x":1,"billingConfig": ${JSON.stringify(config)}, "price": "$0.10", "p50price": "$0.02"${extra}}</script>`;
const kling: ReplicateModel = {
  owner: 'kwaivgi',
  name: 'kling-v3-video',
  slug: 'kwaivgi/kling-v3-video',
  latest_version: {
    id: 'v1',
    openapi_schema: {
      components: {
        schemas: {
          Input: {
            properties: {
              prompt: { type: 'string' },
              duration: { type: 'integer', minimum: 3, maximum: 15, default: 5 },
              mode: { allOf: [{ $ref: '#/components/schemas/mode' }], default: 'standard' },
              generate_audio: { type: 'boolean', default: false },
              start_image: { type: 'string', format: 'uri' },
            },
            required: ['prompt'],
          },
          mode: { type: 'string', enum: ['standard', 'pro', '4k'] },
        },
      },
    },
  },
};

describe('Replicate', () => {
  it('reads input schemas like fal’s, including the start image', () => {
    const spec = replicateInputSpec(kling);
    expect(spec.blocker).toBeNull();
    expect(spec.props.mode.enum).toEqual(['standard', 'pro', '4k']);
    const built = buildGenericInput(spec, { prompt: 'x', ...s }, 'data:image/jpeg;base64,AAAA');
    expect(built.input.start_image).toBe('data:image/jpeg;base64,AAAA');
    expect(built.used.duration).toBe(5);
  });

  it('prices from the first tier whose conditions hold', () => {
    const tiers = [
      { criteria: [{ title: 'with audio', type: 'equals', value: false }, { title: 'model variant', type: 'equals', value: 'standard' }], prices: [{ metric: 'video_output_duration_seconds', price: '$0.168' }] },
      { criteria: [{ title: 'with audio', type: 'equals', value: true }, { title: 'model variant', type: 'equals', value: 'standard' }], prices: [{ metric: 'video_output_duration_seconds', price: '$0.252' }] },
      { criteria: [{ title: 'with audio', type: 'equals', value: true }, { title: 'model variant', type: 'equals', value: 'pro' }], prices: [{ metric: 'video_output_duration_seconds', price: '$0.336' }] },
    ];
    const pricing = parseReplicatePricing(page({ current_tiers: tiers }));
    expect(pricing.tiers).toHaveLength(3);
    expect(pricing.hardwarePerSecond).toBeNull();
    const spec = replicateInputSpec(kling);
    const built = buildGenericInput(spec, { prompt: 'x', ...s });
    // Sound on and the default "standard" mode: $0.252 × 5 s.
    expect(priceReplicate(pricing, built.used, built.input, spec).cents).toBe(126);
    expect(priceReplicate(pricing, { ...built.used, audio: false }, built.input, spec).cents).toBe(84);
    expect(priceReplicate(pricing, built.used, { ...built.input, mode: 'pro' }, spec).cents).toBe(168);
  });

  it('prices by resolution, by video, and by typical GPU run', () => {
    const byRes = parseReplicatePricing(
      page({
        current_tiers: [
          { criteria: [{ title: 'model variant', value: 'video_in' }, { title: 'target resolution', value: '720p' }], prices: [{ metric: 'video_output_duration_seconds', price: '$0.22' }] },
          { criteria: [{ title: 'model variant', value: 'non_video_in' }, { title: 'target resolution', value: '720p' }], prices: [{ metric: 'video_output_duration_seconds', price: '$0.18' }] },
        ],
      }),
    );
    const used = { duration: 5, aspectRatio: '9:16', resolution: '720p', audio: true };
    expect(priceReplicate(byRes, used, {}, { props: {}, required: [], blocker: null }).cents).toBe(90);
    const perVideo = parseReplicatePricing(
      page({
        current_tiers: [
          { criteria: [{ title: 'target resolution', value: '768P' }, { title: 'second of output video', value: 6 }], prices: [{ metric: 'video_output_count', price: '$0.28' }] },
        ],
      }),
    );
    expect(priceReplicate(perVideo, { ...used, duration: 6, resolution: '768p' }, {}, { props: {}, required: [], blocker: null }).cents).toBe(28);
    const gpu = parseReplicatePricing('{"price": "$0.000975 per second", "p50price": "$0.059"}');
    expect(gpu).toEqual({ tiers: [], hardwarePerSecond: 0.000975, typicalUsd: 0.059 });
    const est = priceReplicate(gpu, used, {}, { props: {}, required: [], blocker: null });
    expect(est.cents).toBe(6);
    expect(est.note).toMatch(/GPU time/);
  });
});
