import { describe, expect, it } from 'vitest';
import {
  blockerFor,
  buildGenericInput,
  centsForUnit,
  centsFromRateDescription,
  parseHiggsfieldParams,
  parseInputSpec,
} from '../src/lib/fal-schema';
import { parseAnalysis } from '../src/media/video-analysis';
import { eloIntervals, eloRatings } from '../src/lib/elo';
import { STANDARD_SUITES } from '../src/lib/benchmark-suites';
import { frontier } from '../src/lib/frontier';
import { cleanVerdict } from '../src/services/benchmark-judge';

// Minimal OpenAPI documents shaped like fal's queue schemas.
function doc(input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    paths: {
      '/x/text-to-video': {
        post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Input' } } } } },
      },
      '/x/requests/{request_id}': { get: {} },
    },
    components: { schemas: { Input: input, ...extra } },
  };
}
const settings = { prompt: 'a dj', duration: 5, aspectRatio: '9:16', resolution: '720p', audio: true, seed: 7 };

describe('benchmark schema mapping', () => {
  it('snaps string-enum durations and keeps their format (Veo style)', () => {
    const spec = parseInputSpec(
      doc({
        required: ['prompt'],
        properties: {
          prompt: { type: 'string' },
          duration: { type: 'string', enum: ['4s', '6s', '8s'], default: '8s' },
          resolution: { type: 'string', enum: ['720p', '1080p', '4k'] },
          aspect_ratio: { type: 'string', enum: ['16:9', '9:16'] },
          generate_audio: { type: 'boolean', default: true },
          seed: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        },
      }),
    );
    expect(spec.blocker).toBeNull();
    const { input, used } = buildGenericInput(spec, settings);
    expect(input).toMatchObject({ prompt: 'a dj', duration: '4s', resolution: '720p', aspect_ratio: '9:16', generate_audio: true, seed: 7 });
    expect(used).toEqual({ duration: 4, aspectRatio: '9:16', resolution: '720p', audio: true });
  });

  it('clamps numeric durations, matches resolution case and fills required enums (MiniMax style)', () => {
    const spec = parseInputSpec(
      doc(
        {
          required: ['prompt', 'prompt_expansion_mode'],
          properties: {
            prompt: { type: 'string' },
            prompt_expansion_mode: { $ref: '#/components/schemas/Mode' },
            duration: { type: 'number', minimum: 0.92, maximum: 15, default: 5 },
            resolution: { type: 'string', enum: ['480P', '768P', '1080P'] },
            aspect_ratio: { type: 'string', enum: ['21:9', '16:9', '4:3', '1:1', '3:4'] },
          },
        },
        { Mode: { type: 'string', enum: ['auto', 'off'] } },
      ),
    );
    const { input, used } = buildGenericInput(spec, { ...settings, duration: 20 });
    expect(input.prompt_expansion_mode).toBe('auto');
    expect(input.duration).toBe(15);
    expect(input.resolution).toBe('768P');
    // 9:16 is not offered, so the nearest portrait frame is used.
    expect(input.aspect_ratio).toBe('3:4');
    expect(used.audio).toBeNull();
  });

  it('converts duration to frame counts for frame-based models (Wan 2.2 style)', () => {
    const spec = parseInputSpec(
      doc({
        properties: {
          prompt: { type: 'string' },
          num_frames: { type: 'integer', minimum: 17, maximum: 161, default: 81 },
          frames_per_second: { default: 16, anyOf: [{ type: 'integer' }, { type: 'null' }] },
        },
      }),
    );
    const { input, used } = buildGenericInput(spec, settings);
    expect(input.num_frames).toBe(81);
    expect(used.duration).toBe(5);
  });

  it('blocks endpoints that need more than a prompt', () => {
    expect(parseInputSpec(doc({ required: ['video_url'], properties: { video_url: { type: 'string' } } })).blocker).toBe(
      'Takes no text prompt',
    );
    expect(
      parseInputSpec(
        doc({ required: ['prompt', 'image_url'], properties: { prompt: { type: 'string' }, image_url: { type: 'string' } } }),
      ).blocker,
    ).toBe('Needs image url');
  });

  it('prices per second, per video, and refuses units it cannot predict', () => {
    expect(centsForUnit('second', 0.112, 5)).toBe(56);
    expect(centsForUnit('seconds', 0.1, null)).toBe(50);
    expect(centsForUnit('video', 0.35, 8)).toBe(35);
    expect(centsForUnit('5 seconds', 0.2, 8)).toBe(40);
    expect(centsForUnit('megapixel', 0.02, 5)).toBeNull();
  });

  it('reads Higgsfield docs parameters, skipping nested fields, and maps sound on/off (Kling style)', () => {
    const md = `
<ParamField body="sound" type="string" default="on">
  Enable sound for the output video.
  Allowed values: \`"on"\`, \`"off"\`.
</ParamField>
<ParamField body="prompt" type="string" required>
  Write your prompt here
</ParamField>
<ParamField body="duration" type="integer" default="5">
  Minimum: \`3\`.
  Maximum: \`15\`.
</ParamField>
<ParamField body="aspect_ratio" type="string" default="16:9">
  Allowed values: \`"16:9"\`, \`"9:16"\`, \`"1:1"\`.
</ParamField>
<ParamField body="multi_prompt" type="array">
  <Expandable title="Nested fields">
    <ParamField body="multi_prompt[].duration" type="integer">
      Minimum: \`1\`.
    </ParamField>
  </Expandable>
</ParamField>`;
    const spec = parseHiggsfieldParams(md);
    expect(spec.blocker).toBeNull();
    expect(spec.props.duration).toMatchObject({ type: 'integer', default: 5, minimum: 3, maximum: 15 });
    expect(spec.props['multi_prompt[].duration']).toBeUndefined();
    const { input, used } = buildGenericInput(spec, { ...settings, audio: false, duration: 20 });
    expect(input).toMatchObject({ prompt: 'a dj', sound: 'off', duration: 15, aspect_ratio: '9:16' });
    expect(used.audio).toBe(false);
  });

  it('blocks Higgsfield endpoints whose page has no prompt or no parameters', () => {
    expect(parseHiggsfieldParams('no params here').blocker).toBe('Higgsfield did not publish this model’s parameters');
    expect(
      parseHiggsfieldParams('<ParamField body="video_url" type="string" required>\n  url\n</ParamField>').blocker,
    ).toBe('Takes no text prompt');
  });

  it('reads motion, cuts, freezes, black frames, silence and loudness from ffmpeg’s log', () => {
    // Lines as ffmpeg 7 prints them for a clip with a cut at 2 s, a freeze, black and a silent gap.
    const log = [
      '[Parsed_metadata_2 @ 0x1] lavfi.signalstats.YDIF=0',
      '[Parsed_metadata_2 @ 0x1] lavfi.signalstats.YDIF=2.5',
      '[Parsed_metadata_2 @ 0x1] lavfi.signalstats.YDIF=3.5',
      '[Parsed_showinfo_6 @ 0x2] n:   0 pts:  24576 pts_time:2       duration:    512',
      '[Parsed_freezedetect_3 @ 0x3] lavfi.freezedetect.freeze_start: 2',
      '[Parsed_freezedetect_3 @ 0x3] lavfi.freezedetect.freeze_duration: 1.5',
      '[Parsed_freezedetect_3 @ 0x3] lavfi.freezedetect.freeze_start: 3.5',
      '[Parsed_freezedetect_3 @ 0x3] lavfi.freezedetect.freeze_duration: 0.625',
      '[Parsed_blackdetect_4 @ 0x4] black_start:3.5 black_end:4.125 black_duration:0.625',
      '[Parsed_showinfo_6 @ 0x2] n:   1 pts:  43008 pts_time:3.5     duration:    512',
      '[Parsed_silencedetect_0 @ 0x5] silence_start: 2.5',
      '[Parsed_silencedetect_0 @ 0x5] silence_end: 4.100023 | silence_duration: 1.600023',
      '[Parsed_silencedetect_0 @ 0x5] silence_start: 5.5',
      '[Parsed_ebur128_1 @ 0x6] Summary:',
      '',
      '  Integrated loudness:',
      '    I:         -21.9 LUFS',
    ].join('\n');
    const a = parseAnalysis(log, { seconds: 6, hasAudio: true, soundRequested: true });
    expect(a).toEqual({
      motion: 3,
      cuts: [2, 3.5],
      frozenSeconds: 1.5,
      longestFreeze: 1.5,
      blackSeconds: 0.63,
      silentSeconds: 2.1,
      loudness: -21.9,
      issues: ['Freezes for 1.5 s', 'Black for 0.6 s'],
    });
    expect(parseAnalysis('', { seconds: 5, hasAudio: false, soundRequested: true }).issues).toEqual(['No audio track']);
  });

  it('puts the start image where each image-to-video endpoint takes it and follows its frame', () => {
    const spec = parseInputSpec(
      doc({
        required: ['prompt', 'image_url'],
        properties: {
          prompt: { type: 'string' },
          image_url: { type: 'string' },
          aspect_ratio: { type: 'string', enum: ['auto', '16:9', '9:16'] },
          duration: { type: 'string', enum: ['5', '10'] },
        },
      }),
    );
    expect(spec.blocker).toBe('Needs image url');
    expect(blockerFor(spec, 'image')).toBeNull();
    const { input, used } = buildGenericInput(spec, settings, 'https://cdn.example/frame.jpg');
    expect(input).toMatchObject({ image_url: 'https://cdn.example/frame.jpg', aspect_ratio: 'auto', duration: '5' });
    expect(used.aspectRatio).toBe('from image');
    const list = parseInputSpec(
      doc({ properties: { prompt: { type: 'string' }, image_urls: { type: 'array' } }, required: ['prompt'] }),
    );
    expect(buildGenericInput(list, settings, 'x.jpg').input.image_urls).toEqual(['x.jpg']);
    const textOnly = parseInputSpec(doc({ properties: { prompt: { type: 'string' } } }));
    expect(blockerFor(textOnly, 'image')).toBe('Takes no start image');
    const endFrame = parseInputSpec(
      doc({
        required: ['image_url', 'tail_image_url'],
        properties: { prompt: { type: 'string' }, image_url: { type: 'string' }, tail_image_url: { type: 'string' } },
      }),
    );
    expect(blockerFor(endFrame, 'image')).toBe('Needs tail image url');
  });

  it('turns head-to-head votes into Elo, with ties at half and "both bad" ignored', () => {
    const r = eloRatings([
      { left: 'fal:a', right: 'fal:b', outcome: 'left' },
      { left: 'fal:b', right: 'higgsfield:c', outcome: 'tie' },
      { left: 'fal:a', right: 'higgsfield:c', outcome: 'both_bad' },
    ]);
    expect(r.get('fal:a')).toEqual({ rating: 1016, games: 1 });
    // b lost to a (984), then tied c: a tie against a lower-rated model costs c and lifts b.
    expect(r.get('fal:b')).toEqual({ rating: 985, games: 2 });
    expect(r.get('higgsfield:c')).toEqual({ rating: 999, games: 1 });
    const total = [...r.values()].reduce((sum, x) => sum + x.rating, 0);
    expect(Math.abs(total - 3000)).toBeLessThanOrEqual(1);
  });

  it('keeps judge scores between 1 and 10 and trims its text', () => {
    const v = cleanVerdict({
      adherence: 14,
      visual: 0,
      motion: 6.6,
      artifacts: 9,
      overall: 7,
      summary: ` ${'x'.repeat(300)} `,
      problems: ['a', ' ', 'b', 'c', 'd', 'e', 'f'],
    });
    expect([v.adherence, v.visual, v.motion]).toEqual([10, 1, 7]);
    expect(v.summary).toHaveLength(240);
    expect(v.problems).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('finds the best-value frontier: nothing off it is both cheaper and better', () => {
    const pts = [
      { id: 'cheap-bad', cost: 10, q: 4 },
      { id: 'cheap-ok', cost: 10, q: 6 },
      { id: 'mid-worse', cost: 50, q: 5 },
      { id: 'mid-good', cost: 60, q: 8 },
      { id: 'pricey-same', cost: 200, q: 8 },
      { id: 'pricey-best', cost: 300, q: 9 },
    ];
    expect(frontier(pts, (p) => p.cost, (p) => p.q).map((p) => p.id)).toEqual(['cheap-ok', 'mid-good', 'pricey-best']);
  });

  it('gives wide Elo intervals on few votes and narrower ones on many', () => {
    const few = eloIntervals([{ left: 'a', right: 'b', outcome: 'left' }]);
    const many = eloIntervals(
      Array.from({ length: 60 }, (_, i) => ({ left: 'a', right: 'b', outcome: i % 5 === 0 ? ('right' as const) : ('left' as const) })),
    );
    const width = (m: Map<string, { low: number; high: number }>) => m.get('a')!.high - m.get('a')!.low;
    expect(many.get('a')!.low).toBeGreaterThan(1000);
    expect(width(many)).toBeLessThan(width(few) + 200);
    expect(eloIntervals([{ left: 'a', right: 'b', outcome: 'left' }])).toEqual(few);
  });

  it('ships standard suites that fit a benchmark run', () => {
    for (const s of STANDARD_SUITES) {
      expect(s.prompts.length).toBeGreaterThanOrEqual(3);
      expect(s.prompts.length).toBeLessThanOrEqual(8);
      for (const p of s.prompts) expect(p.length).toBeGreaterThan(20);
    }
    expect(new Set(STANDARD_SUITES.map((s) => s.id)).size).toBe(STANDARD_SUITES.length);
  });

  it('prices Higgsfield rate descriptions for the exact request (texts as returned on 4 October 2026)', () => {
    const wan = 'Priced per generated second by resolution: 480p $0.05, 720p $0.10, or 1080p $0.20. Rates shown are before any applicable customer discount.';
    const seedance20 = 'Token-metered pricing. Billable video tokens = ceil(generated video seconds × output width × output height × 24 fps / 1024). Image and audio references do not count as video input. Per 1,000 video tokens: 480p/720p/1080p $0.014, 4K $0.008. Rates shown are before any applicable customer discount.';
    const seedance25 = 'For 16:9 video without video input, your request costs roughly $0.2056 per second of generated video at 480p, $0.4622 at 720p, and $1.1372 at 1080p. Each 1,000 video tokens costs $0.0214 at 480p or 720p and $0.0234 at 1080p. Billable video tokens = ceil(output height × output width × (input video duration + generated video duration) × 24 / 1024). Image and audio references do not count as video input. Actual pricing depends on output dimensions and billable duration. Rates shown are before any applicable customer discount.';
    const d = { duration: 4, resolution: '720p', aspectRatio: '9:16' };
    expect(centsFromRateDescription(wan, d)).toBe(40);
    expect(centsFromRateDescription(wan, { ...d, resolution: '1080p' })).toBe(80);
    // 4 s × 720 × 1280 × 24 / 1024 = 86,400 tokens.
    expect(centsFromRateDescription(seedance20, d)).toBe(121);
    expect(centsFromRateDescription(seedance25, d)).toBe(185);
    expect(centsFromRateDescription(seedance25, { ...d, resolution: '1080p' })).toBe(Math.ceil((Math.ceil((4 * 1080 * 1920 * 24) / 1024) / 1000) * 0.0234 * 100));
    expect(centsFromRateDescription('Contact sales for pricing.', d)).toBeNull();
  });
});
