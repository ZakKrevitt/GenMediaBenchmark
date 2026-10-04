import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Benchmarks end to end on a throwaway data directory with real ffmpeg. fal and Higgsfield are fakes:
// fal's model search, OpenAPI schemas, pricing, queue, request records and billing events, and
// Higgsfield's docs, quotes and queue are served from memory, so no key or money is involved.
const execute = promisify(execFile);
// KEEP_DATA_DIR keeps the seeded database and media, to look at the results in the app.
const kept = process.env.KEEP_DATA_DIR;
const mediaDir = kept ?? (await mkdtemp(join(tmpdir(), 'bench-it-')));
await mkdir(mediaDir, { recursive: true });
process.env.DATA_DIR = mediaDir;
process.env.DAILY_LIMIT_USD = '2';
process.env.FAL_KEY = 'test-key';
process.env.HIGGSFIELD_KEY = 'testkeyid1:testsecret123';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.LLM_MODEL = 'test-judge-model';
process.env.JUDGE_CENTS = '4';
let pool: (typeof import('../src/lib/db'))['pool'] | undefined;
let checks = 0;
const pass = (s: string) => console.log(`PASS ${++checks}: ${s}`);

const schema = (properties: Record<string, unknown>, required = ['prompt']) => ({
  paths: {
    '/m': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/In' } } } } } },
  },
  components: { schemas: { In: { properties, required } } },
});
const SCHEMAS: Record<string, unknown> = {
  'acme/clip/text-to-video': schema({
    prompt: { type: 'string' },
    duration: { type: 'integer', minimum: 2, maximum: 10, default: 5 },
    aspect_ratio: { type: 'string', enum: ['16:9', '9:16'] },
    resolution: { type: 'string', enum: ['540p', '720p'] },
    generate_audio: { type: 'boolean' },
  }),
  'acme/tokens/text-to-video': schema({ prompt: { type: 'string' }, aspect_ratio: { type: 'string', enum: ['9:16'] } }),
  'acme/broken/text-to-video': schema({ prompt: { type: 'string' } }),
  'acme/lipsync/audio-to-video': schema({ video_url: { type: 'string' } }, ['video_url']),
  'acme/animate/image-to-video': schema(
    {
      prompt: { type: 'string' },
      image_url: { type: 'string' },
      duration: { type: 'string', enum: ['5', '10'] },
      aspect_ratio: { type: 'string', enum: ['auto', '16:9', '9:16'] },
    },
    ['prompt', 'image_url'],
  ),
  'acme/endframe/image-to-video': schema(
    { prompt: { type: 'string' }, image_url: { type: 'string' }, tail_image_url: { type: 'string' } },
    ['image_url', 'tail_image_url'],
  ),
};
const I2V = ['fal-ai/veo3.1/fast/image-to-video', 'acme/animate/image-to-video', 'acme/endframe/image-to-video'];

const HF_DOCS = [
  ['Seedance 2.0 — Text to video', 'seedance-2/text-to-video', 'bytedance/seedance-2.0/text-to-video'],
  ['PixVerse V6 — Text to video', 'pixverse-v6/text-to-video', 'pixverse/v6/text-to-video'],
  ['Strict — Text to video', 'strict/text-to-video', 'acme/strict/text-to-video'],
  ['Soul — Image', 'soul/image', 'higgsfield-ai/soul/standard'],
  ['PixVerse V6 — Image to video', 'pixverse-v6/image-to-video', 'pixverse/v6/image-to-video'],
]
  .map(([title, path, id]) => `# ${title} API\nSource: https://docs.higgsfield.ai/docs/models/${path}\n\nGenerate things.\n\n**Endpoint ID:** \`${id}\`\n`)
  .join('\n');
const param = (name: string, type: string, extra: string, body = '') =>
  `<ParamField body="${name}" type="${type}"${extra}>\n  ${body}\n</ParamField>\n`;
const HF_PAGES: Record<string, string> = {
  '/docs/models/pixverse-v6/text-to-video.md':
    param('prompt', 'string', ' required', 'Write your prompt here') +
    param('duration', 'number', ' default="5"', 'Minimum: `1`.\n  Maximum: `15`.') +
    param('resolution', 'string', ' default="720p"', 'Allowed values: `"360p"`, `"540p"`, `"720p"`, `"1080p"`.') +
    param('aspect_ratio', 'string', ' default="16:9"', 'Allowed values: `"16:9"`, `"1:1"`, `"9:16"`.') +
    param('generate_audio', 'boolean', ' default="true"', 'Generate audio.'),
  '/docs/models/strict/text-to-video.md': param('prompt', 'string', ' required', 'Prompt'),
  '/docs/models/pixverse-v6/image-to-video.md':
    param('prompt', 'string', ' required', 'Prompt') +
    param('image_url', 'string', ' required', 'Start frame') +
    param('duration', 'integer', ' default="5"', 'Minimum: `1`.\n  Maximum: `15`.'),
};

try {
  const db = await import('../src/lib/db');
  pool = db.pool;
  const bench = await import('../src/services/benchmark');
  const renders = await import('../src/services/renders');
  const { spentTodayCents } = await import('../src/lib/spend');

  const video = join(mediaDir, 'out.mp4');
  await execute(process.env.FFMPEG_BIN ?? 'ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24:duration=4', '-f', 'lavfi', '-i', 'sine=duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video,
  ]);
  const mp4 = await readFile(video);

  const submitted = new Map<string, { endpoint: string; input: Record<string, unknown> }>();
  const statusChecks = new Map<string, number>();
  let seq = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const canceled: string[] = [];
  let billingForbidden = false;
  const uploads: string[] = [];
  const hfSubmitted = new Map<string, { endpoint: string; input: Record<string, unknown>; idempotency: string }>();
  const fake: typeof fetch = async (raw, init) => {
    const url = new URL(String(raw));
    const method = init?.method ?? 'GET';
    if (url.hostname === 'docs.higgsfield.ai') {
      if (url.pathname === '/docs/llms-full.txt') return new Response(HF_DOCS);
      const page = HF_PAGES[url.pathname];
      return page ? new Response(page) : new Response('missing', { status: 404 });
    }
    if (url.hostname === 'api.higgsfield.ai') {
      const path = url.pathname.slice(1);
      if (path === 'files/generate-upload-url') {
        uploads.push(JSON.parse(String(init?.body)).content_type);
        return json({ public_url: 'https://cdn.hf-test.dev/uploads/frame.jpg', upload_url: 'https://upload.hf-test.dev/put', upload_headers: {} });
      }
      if (/^requests\/[^/]+\/cancel$/.test(path)) {
        canceled.push(path.split('/')[1]);
        return new Response(null, { status: 202 });
      }
      if (path === 'estimate/alibaba/wan-3.0/text-to-video')
        return json({
          type: 'description',
          pricing_description:
            'Priced per generated second by resolution: 480p $0.05, 720p $0.10, or 1080p $0.20. Rates shown are before any applicable customer discount.',
        });
      if (path.startsWith('estimate/'))
        return path === 'estimate/acme/strict/text-to-video'
          ? json({ detail: 'duration is required' }, 422)
          : json({ usd: '0.25', credits: 4 });
      if (method === 'POST') {
        const id = `hf-${String(++seq).padStart(8, '0')}`;
        const headers = new Headers(init?.headers);
        hfSubmitted.set(id, { endpoint: path, input: JSON.parse(String(init?.body)), idempotency: headers.get('Idempotency-Key') ?? '' });
        return json({ status: 'queued', request_id: id, status_url: `https://api.higgsfield.ai/requests/${id}/status` });
      }
      const id = path.split('/')[1];
      const n = (statusChecks.get(id) ?? 0) + 1;
      statusChecks.set(id, n);
      if (n === 1) return json({ status: 'queued', request_id: id });
      if (n === 2) return json({ status: 'in_progress', request_id: id });
      return json({ status: 'completed', request_id: id, video: { url: `https://cdn.hf-test.dev/${id}.mp4` } });
    }
    if (url.hostname === 'upload.hf-test.dev' && method === 'PUT') return new Response(null, { status: 200 });
    if (url.hostname === 'cdn.hf-test.dev') return new Response(mp4, { headers: { 'Content-Type': 'video/mp4' } });
    if (url.hostname === 'api.fal.ai' && url.pathname === '/v1/models' && url.searchParams.get('category') === 'image-to-video')
      return json({ models: I2V.map((id) => ({ endpoint_id: id, metadata: { display_name: id } })), has_more: false });
    if (url.hostname === 'api.fal.ai' && url.pathname === '/v1/models')
      return json({
        models: [
          { endpoint_id: 'fal-ai/veo3.1/fast', metadata: { display_name: 'Veo 3.1 Fast' } },
          ...Object.keys(SCHEMAS)
            .filter((id) => !I2V.includes(id))
            .map((id) => ({ endpoint_id: id, metadata: { display_name: id.split('/')[1] } })),
        ],
        has_more: false,
      });
    if (url.hostname === 'fal.ai' && url.pathname === '/api/openapi/queue/openapi.json') {
      const s = SCHEMAS[url.searchParams.get('endpoint_id')!];
      return s ? json(s) : json({}, 404);
    }
    if (url.pathname === '/v1/models/pricing')
      return json({
        prices: [
          { endpoint_id: 'acme/clip/text-to-video', unit_price: 0.1, unit: 'second' },
          { endpoint_id: 'acme/tokens/text-to-video', unit_price: 0.5, unit: '1M tokens' },
          { endpoint_id: 'acme/broken/text-to-video', unit_price: 0.2, unit: 'video' },
          { endpoint_id: 'acme/animate/image-to-video', unit_price: 0.2, unit: 'video' },
        ].filter((p) => url.searchParams.getAll('endpoint_id').includes(p.endpoint_id)),
      });
    if (url.pathname === '/v1/models/pricing/estimate') return json({ estimate_type: 'historical_api_price', total_cost: 0.3, currency: 'USD' });
    if (url.hostname === 'queue.fal.run' && method === 'PUT' && url.pathname.endsWith('/cancel')) {
      canceled.push(url.pathname.split('/requests/')[1].split('/')[0]);
      return json({ status: 'CANCELLATION_REQUESTED' }, 202);
    }
    if (url.hostname === 'queue.fal.run' && method === 'POST') {
      const endpoint = url.pathname.slice(1);
      if (endpoint === 'acme/broken/text-to-video') return json({ detail: [{ msg: 'prompt is too vague' }] }, 422);
      const id = `req-${String(++seq).padStart(8, '0')}`;
      submitted.set(id, { endpoint, input: JSON.parse(String(init?.body)) });
      const app = endpoint.split('/').slice(0, 2).join('/');
      return json({
        request_id: id,
        status_url: `https://queue.fal.run/${app}/requests/${id}/status`,
        response_url: `https://queue.fal.run/${app}/requests/${id}`,
      });
    }
    if (url.hostname === 'queue.fal.run') {
      const id = url.pathname.split('/requests/')[1].split('/')[0];
      if (url.pathname.endsWith('/status')) {
        const n = (statusChecks.get(id) ?? 0) + 1;
        statusChecks.set(id, n);
        return json({ status: n > 1 ? 'COMPLETED' : 'IN_PROGRESS' });
      }
      return json({ video: { url: `https://v3b.fal.media/files/${id}.mp4` }, seed: 42 });
    }
    if (url.hostname === 'v3b.fal.media') return new Response(mp4, { headers: { 'Content-Type': 'video/mp4' } });
    if (url.pathname === '/v1/models/requests/by-endpoint') {
      const id = url.searchParams.get('request_id')!;
      return json({
        items: [{ request_id: id, sent_at: '2026-10-04T10:00:00Z', started_at: '2026-10-04T10:00:03.5Z', ended_at: '2026-10-04T10:01:05Z' }],
        has_more: false,
        next_cursor: null,
      });
    }
    if (url.pathname === '/v1/models/billing-events' && billingForbidden)
      return json({ error: { type: 'authorization_error', message: 'This API key is not permitted to perform this action.' } }, 403);
    if (url.pathname === '/v1/models/billing-events') {
      const id = url.searchParams.get('request_id')!;
      return json({ billing_events: [{ request_id: id, cost_total: 0.4321 }], has_more: false, next_cursor: null });
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };
  globalThis.fetch = fake;

  // Most checks below let each model round to its nearest length; exact length is checked on its own.
  const settings = { duration: 5, aspectRatio: '9:16', resolution: '720p', audio: true, seed: null, exactDuration: false };

  const exact = (await bench.benchmarkModels({ ...settings, exactDuration: true }, fake)).models;
  const exactBy = (e: string) => exact.find((m) => m.id === `fal:${e}`)!;
  assert.equal(exactBy('acme/clip/text-to-video').blocker, null, 'a model that takes 5 s stays runnable');
  assert.equal(exactBy('fal-ai/veo3.1/fast').blocker, 'Can’t make exactly 5 s (nearest is 4 s)');
  assert.equal(exactBy('fal-ai/veo3.1/fast').lengthMismatch, true);
  assert.equal(exactBy('acme/tokens/text-to-video').blocker, 'Sets its own length, not exactly 5 s');
  assert.equal(exactBy('acme/lipsync/audio-to-video').lengthMismatch, undefined, 'other blockers keep their reason');
  assert.ok(
    exact.filter((m) => !m.blocker).every((m) => m.used.duration === 5),
    'every runnable model renders exactly 5 s',
  );
  const sixSeconds = (await bench.benchmarkModels({ ...settings, duration: 6, exactDuration: true }, fake)).models;
  assert.equal(sixSeconds.find((m) => m.id === 'fal:fal-ai/veo3.1/fast')!.blocker, null, 'Veo makes 6 s exactly');
  await assert.rejects(
    bench.createBenchmark(
      { key: 'bench-key-exact-length-01', prompt: 'A lighthouse beam sweeps over waves', settings: { ...settings, exactDuration: true }, models: ['fal:fal-ai/veo3.1/fast'] },
      fake,
    ),
    /can’t make exactly 5 s/,
  );
  pass('exact length: only models that render exactly the chosen duration can run, so costs compare');

  const listing = await bench.benchmarkModels(settings, fake);
  const models = listing.models;
  assert.ok(listing.falConnected && listing.higgsfieldConnected);
  const by = (e: string, provider = 'fal') => models.find((m) => m.id === `${provider}:${e}`)!;
  assert.equal(by('fal-ai/veo3.1/fast').studioModel, 'veo-3.1-fast');
  assert.equal(by('fal-ai/veo3.1/fast').used.duration, 4, 'Veo snaps 5 s to 4 s');
  assert.equal(by('acme/clip/text-to-video').cents, 50, 'per-second price × 5 s');
  assert.equal(by('acme/tokens/text-to-video').cents, 30, 'token-priced model uses fal’s historical average');
  assert.equal(by('acme/lipsync/audio-to-video').blocker, 'Takes no text prompt');
  assert.ok(models.findIndex((m) => m.blocker) > models.findIndex((m) => m.endpoint === 'acme/tokens/text-to-video'));
  assert.ok(models.every((m) => m.isNew === false), 'the first listing is the baseline');
  pass('lists studio and catalogue models, snapped and priced, blocked ones last');

  assert.equal(by('bytedance/seedance-2.0/text-to-video', 'higgsfield').studioModel, 'hf-seedance-2.0');
  assert.equal(by('bytedance/seedance-2.0/text-to-video').studioModel, 'seedance-2.0', 'the same model on fal is a separate entry');
  assert.equal(by('pixverse/v6/text-to-video', 'higgsfield').cents, 25, 'Higgsfield quote');
  assert.deepEqual(by('pixverse/v6/text-to-video', 'higgsfield').used, { duration: 5, aspectRatio: '9:16', resolution: '720p', audio: true });
  assert.match(by('acme/strict/text-to-video', 'higgsfield').blocker!, /Rejects these settings: duration is required/);
  assert.equal(models.some((m) => m.endpoint === 'higgsfield-ai/soul/standard'), false, 'image endpoints are not listed');
  const wanHf = by('alibaba/wan-3.0/text-to-video', 'higgsfield');
  assert.equal(wanHf.cents, 50, 'a pricing rule instead of a figure is priced for 5 s at 720p');
  assert.match(wanHf.priceNote, /listed rate/);
  pass('lists Higgsfield models from its docs, quoted per request, with rejected settings blocked');

  const prompt = 'A DJ lowers the crossfader as the crowd lifts their hands';
  const all = ['fal-ai/veo3.1/fast', 'acme/clip/text-to-video', 'acme/tokens/text-to-video', 'acme/broken/text-to-video'];
  await assert.rejects(
    bench.createBenchmark({ key: 'bench-key-over-cap-0001', prompt, settings: { ...settings, resolution: '1080p', duration: 10 }, endpoints: all }, fake),
    /DAILY_LIMIT_USD/,
  );
  assert.equal(Number(((await pool.query('SELECT count(*) FROM renders')).rows[0] as { count: number }).count), 0);
  pass('refuses a benchmark that would pass the daily limit before recording anything');

  await assert.rejects(
    bench.createBenchmark({ key: 'bench-key-blocked-00001', prompt, settings, endpoints: ['acme/lipsync/audio-to-video'] }, fake),
    /takes no text prompt/,
  );
  pass('refuses models that cannot run from a prompt');

  const key = 'bench-key-main-run-0001';
  const created = await bench.createBenchmark({ key, prompt, settings, endpoints: all }, fake);
  const again = await bench.createBenchmark({ key, prompt, settings, endpoints: all }, fake);
  assert.equal(again.id, created.id);
  assert.equal(submitted.size, 3, 'three submissions; the broken model is rejected by fal');
  const generic = [...submitted.values()].find((s) => s.endpoint === 'acme/clip/text-to-video')!;
  assert.deepEqual(generic.input, { prompt, aspect_ratio: '9:16', duration: 5, resolution: '720p', generate_audio: true });
  const veo = [...submitted.values()].find((s) => s.endpoint === 'fal-ai/veo3.1/fast')!;
  assert.equal(veo.input.duration, '4s');
  assert.equal(veo.input.prompt, prompt);
  pass('submits each model once with its own request shape; retries are idempotent');

  for (let i = 0; i < 3; i++) await renders.pollRenders(fake);
  await pool.query("UPDATE renders SET polled_at=NULL");
  for (let i = 0; i < 3; i++) {
    await renders.pollRenders(fake);
    await pool.query('UPDATE renders SET polled_at=NULL');
  }
  await bench.reconcileBenchmarkShots(fake);
  const state = await bench.benchmarkState();
  const run = state.benchmarks.find((b) => b.id === created.id)!;
  assert.equal(run.shots.length, 4);
  const failed = run.shots.find((s) => s.endpoint === 'acme/broken/text-to-video')!;
  assert.equal(failed.state, 'FAILED');
  assert.match(failed.error!, /prompt is too vague/);
  const done = run.shots.filter((s) => s.state === 'COMPLETE');
  assert.equal(done.length, 3);
  for (const s of done) {
    assert.ok(s.hasVideo && s.hasPoster);
    assert.equal(s.output?.width, 360);
    assert.equal(s.output?.height, 640);
    assert.ok(Math.abs((s.output?.seconds ?? 0) - 4) < 0.2);
    assert.equal(s.output?.audio, true);
    assert.equal(s.queueSeconds, 3.5);
    assert.equal(s.runSeconds, 61.5);
    assert.equal(s.billedCents, 43.21);
    assert.ok(s.totalSeconds !== null && s.totalSeconds >= 0);
    assert.ok(s.reconciled);
  }
  pass('renders download, probe, and reconcile fal’s timing and billed cost');

  const spent = await spentTodayCents();
  assert.equal(spent, 130, 'three billed renders at $0.4321 count as billed, the failed one not at all');
  pass('the daily limit counts billed cost once known');

  const hfRun = await bench.createBenchmark(
    {
      key: 'bench-key-higgsfield-01',
      prompt,
      settings,
      models: ['higgsfield:bytedance/seedance-2.0/text-to-video', 'higgsfield:pixverse/v6/text-to-video'],
    },
    fake,
  );
  assert.equal(hfSubmitted.size, 2);
  const pix = [...hfSubmitted.values()].find((s) => s.endpoint === 'pixverse/v6/text-to-video')!;
  assert.deepEqual(pix.input, { prompt, aspect_ratio: '9:16', duration: 5, resolution: '720p', generate_audio: true });
  assert.ok([...hfSubmitted.values()].every((s) => s.idempotency.startsWith('benchmark-')));
  for (let i = 0; i < 4; i++) {
    await renders.pollRenders(fake);
    await pool.query('UPDATE renders SET polled_at=NULL');
  }
  await bench.reconcileBenchmarkShots(fake);
  const hfState = (await bench.benchmarkState()).benchmarks.find((b) => b.id === hfRun.id)!;
  for (const s of hfState.shots) {
    assert.equal(s.provider, 'higgsfield');
    assert.equal(s.state, 'COMPLETE');
    assert.ok(s.hasVideo && s.output?.width === 360);
    assert.equal(s.estimatedCents, 25);
    assert.equal(s.billedCents, null);
    assert.equal(s.timing, 'measured');
    assert.ok(s.queueSeconds !== null && s.runSeconds !== null, 'queue and generation split from the poller');
    assert.ok(s.reconciled);
  }
  const spentAfter = await spentTodayCents();
  assert.equal(spentAfter, 180, 'Higgsfield quotes count toward the same daily limit');
  pass('runs Higgsfield models, downloads and probes them, and splits queue from generation');

  while ((await bench.analyzeBenchmarkShots()) > 0);
  const analysed = (await bench.benchmarkState()).benchmarks.flatMap((b) => b.shots).filter((s) => s.state === 'COMPLETE');
  assert.equal(analysed.length, 5);
  for (const s of analysed) {
    assert.ok(s.analysis, `analysed ${s.endpoint}`);
    assert.ok(s.analysis!.motion! > 0.3, 'the test pattern moves');
    assert.deepEqual(s.analysis!.issues, []);
    assert.ok(s.analysis!.loudness! > -40, 'the sine tone is audible');
  }
  // A clip with a hard cut at 2 s, a 1.5 s freeze, 0.6 s of black and a 1.6 s silent gap.
  const { analysisArgs, parseAnalysis } = await import('../src/media/video-analysis');
  const { runMedia } = await import('../src/lib/media');
  const flawed = join(mediaDir, 'flawed.mp4');
  await execute(process.env.FFMPEG_BIN ?? 'ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24:duration=2',
    '-f', 'lavfi', '-i', 'color=c=red:size=360x640:rate=24:duration=1.5',
    '-f', 'lavfi', '-i', 'color=c=black:size=360x640:rate=24:duration=0.6',
    '-f', 'lavfi', '-i', 'mandelbrot=size=360x640:rate=24,trim=duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.5',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono,atrim=duration=1.6',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
    '-filter_complex',
    '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v];[4:a]aformat=channel_layouts=mono:sample_rates=44100[a0];[6:a]aformat=channel_layouts=mono:sample_rates=44100[a2];[a0][5:a][a2]concat=n=3:v=0:a=1[a]',
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', flawed,
  ]);
  const { stderr } = await runMedia('ffmpeg', analysisArgs(flawed, true));
  const flaws = parseAnalysis(stderr.toString(), { seconds: 6.1, hasAudio: true, soundRequested: true });
  assert.ok(flaws.cuts.some((t) => Math.abs(t - 2) < 0.1), `cut at 2 s: ${flaws.cuts}`);
  assert.ok(flaws.frozenSeconds >= 1.4, `freeze: ${flaws.frozenSeconds}`);
  assert.ok(flaws.blackSeconds >= 0.5, `black: ${flaws.blackSeconds}`);
  assert.ok(flaws.silentSeconds! >= 1.5, `silence: ${flaws.silentSeconds}`);
  assert.deepEqual(flaws.issues.map((i) => i.split(' ')[0]), ['Freezes', 'Black']);
  for (const s of analysed) assert.ok(s.hasStrip, `filmstrip for ${s.endpoint}`);
  const stripKey = ((await pool.query('SELECT strip_key FROM renders WHERE strip_key IS NOT NULL LIMIT 1')).rows[0] as { strip_key: string }).strip_key;
  const stripFile = join(mediaDir, 'strip-check.jpg');
  await (await import('node:fs/promises')).writeFile(stripFile, await (await import('../src/lib/storage')).getAsset(stripKey));
  const { stdout: stripProbe } = await execute(process.env.FFPROBE_BIN ?? 'ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', stripFile]);
  assert.equal(stripProbe.trim().split(',')[0], String(6 * 240), 'six 240 px frames side by side');
  pass('checks each render for motion, cuts, freezes, black frames and silence with real ffmpeg');

  process.env.DAILY_LIMIT_USD = '10';
  const before = submitted.size;
  const addKey = 'bench-key-add-models-01';
  await bench.addToBenchmark(created.id, { key: addKey, models: ['fal:acme/clip/text-to-video', 'fal:acme/broken/text-to-video'] }, fake);
  await bench.addToBenchmark(created.id, { key: addKey, models: ['fal:acme/clip/text-to-video', 'fal:acme/broken/text-to-video'] }, fake);
  assert.equal(submitted.size, before + 1, 'one new fal submission; the retried broken model fails again; the repeat press is free');
  const grown = (await bench.benchmarkState()).benchmarks.find((b) => b.id === created.id)!;
  assert.equal(grown.shots.length, 6);
  assert.equal(grown.shots.filter((s) => s.endpoint === 'acme/clip/text-to-video').length, 2, 'a second take of the same model');
  assert.equal(grown.prompt, prompt);
  pass('adds models, retries and second takes to an existing benchmark, once per press');

  // A benchmark saved before exact length existed keeps rounding each model to its nearest length.
  await pool.query("UPDATE benchmarks SET settings = settings - 'exactDuration' WHERE id=$1", [created.id]);
  const beforeLegacy = submitted.size;
  await bench.addToBenchmark(created.id, { key: 'bench-key-legacy-add-01', models: ['fal:fal-ai/veo3.1/fast'] }, fake);
  assert.equal(submitted.size, beforeLegacy + 1, 'Veo (4 s) still runs on an older 5 s benchmark');
  pass('older benchmarks keep their rounding when models are added');

  const queued = await bench.createBenchmark(
    { key: 'bench-key-cancel-run-01', prompt, settings, models: ['fal:acme/clip/text-to-video', 'higgsfield:pixverse/v6/text-to-video'] },
    fake,
  );
  const result = await bench.cancelQueued(queued.id, fake);
  assert.deepEqual(result, { canceled: 2, generating: 0, refused: 0 });
  assert.equal(canceled.length, 2);
  const after = (await bench.benchmarkState()).benchmarks.find((b) => b.id === queued.id)!;
  assert.ok(after.shots.every((s) => s.state === 'FAILED' && /Canceled before it started/.test(s.error!)));
  pass('cancels queued renders on fal and Higgsfield, and they stop counting toward the limit');

  const frameFile = join(mediaDir, 'frame.png');
  await execute(process.env.FFMPEG_BIN ?? 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=360x640', '-frames:v', '1', frameFile]);
  const frame = await renders.saveStartImage(await readFile(frameFile), 'image/png');
  const imageSettings = { ...settings, firstFrameId: frame.id };
  const i2v = (await bench.benchmarkModels(imageSettings, fake)).models;
  const iby = (e: string, provider = 'fal') => i2v.find((m) => m.id === `${provider}:${e}`)!;
  assert.equal(iby('fal-ai/veo3.1/fast/image-to-video').studioModel, 'veo-3.1-fast');
  assert.equal(iby('acme/animate/image-to-video').blocker, null);
  assert.deepEqual(iby('acme/animate/image-to-video').used, { duration: 5, aspectRatio: 'from image', resolution: null, audio: null });
  assert.equal(iby('acme/endframe/image-to-video').blocker, 'Needs tail image url');
  assert.equal(iby('pixverse/v6/image-to-video', 'higgsfield').cents, 25);
  assert.ok(i2v.every((m) => !m.endpoint.includes('text-to-video')), 'only image-to-video endpoints are listed');
  const before2 = submitted.size;
  const imageRun = await bench.createBenchmark(
    {
      key: 'bench-key-image-run-001',
      prompt,
      settings: imageSettings,
      models: ['fal:acme/animate/image-to-video', 'fal:fal-ai/veo3.1/fast/image-to-video', 'higgsfield:pixverse/v6/image-to-video'],
    },
    fake,
  );
  const falInputs = [...submitted.values()].slice(before2);
  assert.equal(falInputs.length, 2);
  for (const f of falInputs) assert.match(String(f.input.image_url), /^data:image\/png;base64,/);
  assert.equal(falInputs.find((f) => f.endpoint === 'acme/animate/image-to-video')!.input.aspect_ratio, 'auto');
  const hfImage = [...hfSubmitted.values()].find((h) => h.endpoint === 'pixverse/v6/image-to-video')!;
  assert.equal(hfImage.input.image_url, 'https://cdn.hf-test.dev/uploads/frame.jpg');
  assert.equal(uploads.length, 1, 'one Higgsfield upload serves the quotes and the render');
  const stored = (await pool.query("SELECT request_settings FROM renders WHERE benchmark_id=$1", [imageRun.id])).rows;
  assert.ok((stored as { request_settings: unknown }[]).every((r) => !JSON.stringify(r.request_settings).includes('base64')), 'inline images are not stored');
  const imageBench = (await bench.benchmarkState()).benchmarks.find((b) => b.id === imageRun.id)!;
  assert.equal(imageBench.settings.firstFrameId, frame.id);
  pass('benchmarks image-to-video: start image inline for fal, uploaded once for Higgsfield, frame follows the image');

  const judgeMod = await import('../src/services/benchmark-judge');
  const spentBeforeJudge = await spentTodayCents();
  const queuedJudge = await judgeMod.queueJudge(created.id);
  assert.equal(queuedJudge.queued, 3, 'the three finished renders; failed and running ones are skipped');
  assert.equal(queuedJudge.cents, 12);
  const again2 = await judgeMod.queueJudge(created.id);
  assert.equal(again2.queued, 0, 'queueing twice does not reserve twice');
  const spentQueued = await spentTodayCents();
  assert.equal(spentQueued - spentBeforeJudge, 12, 'judge reservations count toward the daily limit');
  const seen: { frames: number; prompt: string; startImage: boolean }[] = [];
  let calls = 0;
  const fakeJudge = {
    async judge(input: { prompt: string; frames: string[]; startImage: string | null }) {
      seen.push({ frames: input.frames.length, prompt: input.prompt, startImage: Boolean(input.startImage) });
      if (++calls === 3) throw new Error('model refused');
      return {
        verdict: { adherence: 8, visual: 7, motion: 6, artifacts: 9, overall: 12, summary: 'Clean test pattern.', problems: [] },
        usage: { input_tokens: 900, output_tokens: 80 },
      };
    },
  };
  while ((await judgeMod.judgeBenchmarkShots(fakeJudge)) > 0);
  assert.ok(seen.every((s) => s.frames >= 5 && s.prompt === prompt && !s.startImage));
  const judgedRun = (await bench.benchmarkState()).benchmarks.find((b) => b.id === created.id)!;
  const judgedShots = judgedRun.shots.filter((s) => s.judgeState);
  assert.equal(judgedShots.filter((s) => s.judgeState === 'DONE').length, 2);
  const failedJudge = judgedShots.find((s) => s.judgeState === 'FAILED')!;
  assert.match(failedJudge.judgeError!, /model refused/);
  assert.equal(failedJudge.judgeCents, 0, 'a failed judgement releases its reservation');
  const okJudge = judgedShots.find((s) => s.judgeState === 'DONE')!;
  assert.equal(okJudge.judge!.overall, 10, 'scores are clamped to 10');
  assert.equal(okJudge.judge!.model, 'test-judge-model');
  // Image-to-video renders send the start image along with the frames.
  for (let i = 0; i < 4; i++) {
    await renders.pollRenders(fake);
    await pool.query('UPDATE renders SET polled_at=NULL');
  }
  while ((await bench.analyzeBenchmarkShots()) > 0);
  await judgeMod.queueJudge(imageRun.id);
  seen.length = 0;
  while ((await judgeMod.judgeBenchmarkShots(fakeJudge)) > 0);
  assert.ok(seen.length >= 1 && seen.every((s) => s.startImage), 'start image goes to the judge');
  assert.equal(okJudge.judgeCents, 4, 'without token prices the flat reservation stays');
  // With the model's token prices set, a scored render is charged what its tokens cost.
  process.env.JUDGE_USD_PER_MTOK_IN = '2.5';
  process.env.JUDGE_USD_PER_MTOK_OUT = '10';
  await pool.query("UPDATE renders SET judge_state=NULL, judge=NULL, judge_cents=0 WHERE id=$1", [okJudge.id]);
  await judgeMod.queueJudge(created.id);
  calls = 0;
  while ((await judgeMod.judgeBenchmarkShots(fakeJudge)) > 0);
  const repriced = (await bench.benchmarkState()).benchmarks.find((b) => b.id === created.id)!.shots.find((x) => x.id === okJudge.id)!;
  // 900 input and 80 output tokens: 0.00225 + 0.0008 dollars, rounded up to one cent.
  assert.equal(repriced.judgeCents, 1);
  assert.equal(judgeMod.judgeTokenCents({ input_tokens: 1_000_000, output_tokens: 100_000 }), 350);
  delete process.env.JUDGE_USD_PER_MTOK_IN;
  delete process.env.JUDGE_USD_PER_MTOK_OUT;
  pass('AI judge: priced per render under the daily limit, blind frames to the model, clamped scores, failures refunded, token cost when priced');

  const beforeSuite = submitted.size;
  const suiteRun = await bench.createBenchmark(
    {
      key: 'bench-key-suite-run-0001',
      prompts: [prompt, 'A crowd in a dark club raises phone lights in slow motion'],
      suiteName: 'Club scenes',
      settings: { ...settings, takes: 2 },
      models: ['fal:acme/clip/text-to-video'],
    },
    fake,
  );
  assert.equal(submitted.size - beforeSuite, 4, 'two prompts × two takes');
  const suiteState = await bench.benchmarkState();
  const members = suiteState.benchmarks.filter((b) => b.suiteId && b.suiteName === 'Club scenes');
  assert.equal(members.length, 2);
  assert.ok(members.some((b) => b.id === suiteRun.id));
  assert.deepEqual(members.map((b) => b.shots.map((s) => s.take).sort()), [[1, 2], [1, 2]]);
  assert.deepEqual(members.map((b) => b.prompt).sort(), [prompt, 'A crowd in a dark club raises phone lights in slow motion'].sort());
  const scoped = await bench.benchmarkState({ suiteId: members[0].suiteId });
  assert.deepEqual(scoped.leaderboard.map((r) => r.endpoint), ['acme/clip/text-to-video'], 'the suite leaderboard only ranks its own renders');
  assert.equal(scoped.leaderboard[0].runs, 4);
  pass('suites run several prompts with several takes per model, and the leaderboard can rank one suite');

  await bench.voteOnPair(run.id, { left: done[0].id, right: done[1].id, outcome: 'left' });
  await bench.voteOnPair(run.id, { left: done[2].id, right: done[0].id, outcome: 'right' });
  await bench.voteOnPair(run.id, { left: done[1].id, right: done[2].id, outcome: 'both_bad' });
  await assert.rejects(bench.voteOnPair(run.id, { left: done[0].id, right: done[0].id, outcome: 'tie' }), /two different/);
  const otherShot = (await bench.benchmarkState()).benchmarks.find((b) => b.id === hfRun.id)!.shots[0].id;
  await assert.rejects(bench.voteOnPair(run.id, { left: done[0].id, right: otherShot, outcome: 'tie' }), /from this benchmark/);
  const voted = (await bench.benchmarkState()).benchmarks.find((b) => b.id === run.id)!;
  assert.equal(voted.votes.length, 3);
  await bench.rateBenchShot(done[0].id, { rating: 5, note: 'Best motion' });
  await bench.rateBenchShot(done[1].id, { rating: 2 });
  await bench.pickWinner(run.id, done[0].id);
  await assert.rejects(bench.pickWinner(run.id, '00000000-0000-4000-8000-000000000000'), /another benchmark/);
  const board = await bench.benchmarkState();
  assert.equal(board.benchmarks.find((b) => b.id === run.id)!.winnerShotId, done[0].id);
  assert.ok(board.leaderboard.some((r) => r.provider === 'higgsfield' && r.endpoint === 'bytedance/seedance-2.0/text-to-video'));
  assert.ok(board.leaderboard.some((r) => r.provider === 'fal' && r.endpoint === 'fal-ai/veo3.1/fast'));
  const top = board.leaderboard[0];
  assert.equal(top.endpoint, done[0].endpoint);
  assert.equal(top.avgRating, 5);
  assert.equal(top.wins, 1);
  assert.equal(top.medianRunSeconds, 61.5);
  assert.equal(top.issueRate, 0);
  assert.ok(board.leaderboard.some((r) => r.judgeScore !== null && r.judged > 0), 'judge scores reach the leaderboard');
  assert.ok(top.arena! > 1000 && top.arenaVotes === 2, 'two wins lift the Elo; "both bad" is not counted');
  assert.ok(board.leaderboard.find((r) => r.endpoint === done[1].endpoint)!.arena! < 1000);
  assert.ok(top.medianMotion! > 0.3);
  const broken = board.leaderboard.find((r) => r.endpoint === 'acme/broken/text-to-video')!;
  assert.equal(broken.failed, 2, 'the first attempt and the retry');
  // Every vote so far is on one prompt, so there is a rating but no interval yet.
  assert.equal(top.arenaPrompts, 1);
  assert.equal(top.arenaLow, null, 'one prompt cannot show how settled a rating is');
  assert.ok(top.billed >= 1 && top.billed < top.done, `billed and estimated renders are counted apart: ${top.billed} of ${top.done}`);

  // Effective settings: Veo ran at 4 s, the others at 5 s, so they are separate groups.
  const info = board.leaderboardInfo;
  const fiveSecond = info.setups.find((x) => x.setup === '5 s · 720p · 9:16');
  assert.ok(fiveSecond && fiveSecond.models >= 2, `5 s group: ${JSON.stringify(info.setups)}`);
  assert.ok(info.setups.some((x) => x.setup.startsWith('4 s')), 'Veo’s 4 s renders form their own group');
  const matched = await bench.benchmarkState({ setup: '5 s · 720p · 9:16' });
  assert.ok(matched.leaderboard.length > 0);
  assert.ok(!matched.leaderboard.some((r) => r.endpoint === 'fal-ai/veo3.1/fast'), 'a 4 s model is not ranked among 5 s ones');
  assert.ok(matched.leaderboard.every((r) => r.setups <= 1), 'one set of settings per model inside a group');

  // Cost per second is total cost over total delivered seconds.
  const clipRow = board.leaderboard.find((r) => r.endpoint === 'acme/clip/text-to-video')!;
  const clipTotals = (
    await pool.query(
      `SELECT sum(coalesce(billed_cents, estimated_cents)) c, sum((output->>'seconds')::numeric) s
       FROM renders WHERE endpoint='acme/clip/text-to-video' AND provider='fal' AND state='COMPLETE'`,
    )
  ).rows[0] as { c: string; s: string };
  assert.equal(clipRow.centsPerSecond, Math.round((Number(clipTotals.c) / Number(clipTotals.s)) * 10) / 10);

  // Common prompts: inside the suite every model finished both prompts. Across everything, only
  // the first prompt was finished by every model, so each model is ranked on that one alone.
  for (let i = 0; i < 4; i++) {
    await renders.pollRenders(fake);
    await pool.query('UPDATE renders SET polled_at=NULL');
  }
  const suiteCommon = await bench.benchmarkState({ suiteId: members[0].suiteId, commonOnly: true });
  assert.equal(suiteCommon.leaderboardInfo.commonPrompts, 2);
  assert.equal(suiteCommon.leaderboard[0].prompts, 2);
  const allCommon = await bench.benchmarkState({ commonOnly: true });
  assert.equal(allCommon.leaderboardInfo.commonPrompts, 1);
  assert.equal((await bench.benchmarkState()).leaderboard.find((r) => r.endpoint === 'acme/clip/text-to-video')!.prompts, 2, 'the main prompt and the suite’s second prompt');
  assert.ok(allCommon.leaderboard.some((r) => r.endpoint === 'acme/clip/text-to-video' && r.prompts === 1));
  assert.ok(allCommon.leaderboard.every((r) => r.prompts <= 1), 'every model ranked on the shared prompt only');

  const history = await bench.modelHistory('fal:acme/broken/text-to-video');
  assert.equal(history.renders.length, 2);
  assert.deepEqual(history.failures, [{ reason: 'fal rejected the shot settings: prompt is too vague', count: 2 }]);
  const clipHistory = await bench.modelHistory('fal:acme/clip/text-to-video');
  assert.ok(clipHistory.renders.length >= 5, 'renders from every benchmark, suites and takes included');
  const req = clipHistory.renders.find((r) => r.request)!.request!;
  assert.equal(req.prompt, clipHistory.renders.find((r) => r.request)!.prompt);
  assert.equal(req.duration, 5);
  await assert.rejects(bench.modelHistory('nope'), /Invalid|invalid/);
  pass('ratings, picks and blind votes (Bradley-Terry) feed a leaderboard that groups by effective settings and common prompts');

  // A failed render still counts toward the limit once the provider reports billing it.
  const { startOfLocalDay } = await import('../src/lib/spend');
  const midnight = new Date(startOfLocalDay());
  assert.ok(midnight.getHours() === 0 && midnight.getMinutes() === 0 && midnight <= new Date(), 'the day starts at local midnight');
  const beforeBilledFailure = await spentTodayCents();
  await pool.query(`UPDATE renders SET billed_cents=10 WHERE id=$1`, [failed.id]);
  assert.equal(await spentTodayCents(), beforeBilledFailure + 10);
  await pool.query(`UPDATE renders SET billed_cents=NULL WHERE id=$1`, [failed.id]);
  pass('the daily limit uses the local day and counts failed renders the provider billed anyway');

  // A model the benchmark has not seen before, listed more than a day after the first listing, is new.
  await pool.query("UPDATE benchmark_models_seen SET first_seen = now() - interval '3 days'");
  await pool.query("DELETE FROM benchmark_models_seen WHERE provider='fal' AND endpoint='acme/tokens/text-to-video'");
  const relisted = (await bench.benchmarkModels(settings, fake)).models;
  assert.equal(relisted.find((m) => m.endpoint === 'acme/tokens/text-to-video')!.isNew, true);
  assert.equal(relisted.find((m) => m.endpoint === 'acme/clip/text-to-video')!.isNew, false);
  pass('model history with failure reasons, the exact request per render, Elo intervals and new-model flags');

  // A fal key without billing access (403, seen in production): timing still reconciles and the
  // render keeps its estimate instead of being re-checked for six hours.
  billingForbidden = true;
  const noBill = await bench.createBenchmark(
    { key: 'bench-key-no-billing-001', prompt, settings, models: ['fal:acme/clip/text-to-video'] },
    fake,
  );
  for (let i = 0; i < 4; i++) {
    await renders.pollRenders(fake);
    await pool.query('UPDATE renders SET polled_at=NULL');
  }
  await bench.reconcileBenchmarkShots(fake);
  const unbilled = (await bench.benchmarkState()).benchmarks.find((b) => b.id === noBill.id)!.shots[0];
  assert.equal(unbilled.state, 'COMPLETE');
  assert.equal(unbilled.billedCents, null);
  assert.equal(unbilled.runSeconds, 61.5);
  assert.ok(unbilled.reconciled, 'reconciled on timing alone when billing is refused');
  pass('a fal key without billing access keeps the estimate and stops asking');

  console.log(`\n${checks} benchmark checks passed`);
} finally {
  if (!kept) await rm(mediaDir, { recursive: true, force: true });
}
