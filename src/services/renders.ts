import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audit, one, pool, rows, transaction } from '../lib/db';
import { GateError } from '../lib/contracts';
import { falKey, higgsfieldKey, openrouterKey, replicateKey } from '../lib/fal-key';
import { allowedMediaUrl, downloadMedia, putAsset, withAssetPath } from '../lib/storage';
import { runMedia } from '../lib/media';
import type { BenchProvider } from '../lib/studio';
import { studioProviders } from '../providers/studio-providers';
import { allowedHiggsfieldMediaUrl } from '../providers/higgsfield';

// Collects submitted renders: polls each provider, downloads the finished video, probes it and
// grabs a poster frame. Runs in the background loop started by src/instrumentation.ts.

type RenderRow = {
  id: string;
  provider: BenchProvider;
  request_id: string | null;
  status_url: string | null;
  response_url: string | null;
  duration_seconds: number;
  created_at: string;
  submitted_at: string | null;
  started_at: string | null;
  request_settings: { gpuPerSecond?: number } | null;
};

const TIMEOUT_MINUTES = 45;
const busy = new Set<string>();
const KEY: Record<BenchProvider, () => Promise<string | undefined>> = {
  fal: falKey,
  higgsfield: higgsfieldKey,
  openrouter: openrouterKey,
  replicate: replicateKey,
};
const keyFor = (provider: BenchProvider) => KEY[provider]();

export async function pollRenders(fetcher: typeof fetch = fetch) {
  const open = await rows<RenderRow>(
    `SELECT id,provider,request_id,status_url,response_url,duration_seconds,created_at,submitted_at,started_at,request_settings
     FROM renders WHERE state IN ('RUNNING','DOWNLOADING')
       AND (polled_at IS NULL OR polled_at < now() - interval '6 seconds') ORDER BY created_at LIMIT 16`,
  );
  await Promise.all(
    open.map(async (render) => {
      // One process owns the database, so an in-memory guard keeps a slow download from being
      // picked up twice.
      if (busy.has(render.id)) return;
      busy.add(render.id);
      try {
        await advance(render, await keyFor(render.provider), fetcher);
      } catch (error) {
        console.error(JSON.stringify({ event: 'render.poll_error', id: render.id, message: String(error).slice(0, 300) }));
      } finally {
        busy.delete(render.id);
      }
    }),
  );
  return open.length;
}

async function advance(render: RenderRow, key: string | undefined, fetcher: typeof fetch) {
  await pool.query('UPDATE renders SET polled_at=now() WHERE id=$1', [render.id]);
  const age = (Date.now() - new Date(render.submitted_at ?? render.created_at).getTime()) / 60000;
  const provider = studioProviders[render.provider];
  if (age > TIMEOUT_MINUTES) {
    await fail(
      render.id,
      `${provider.name} did not finish within ${TIMEOUT_MINUTES} minutes. Request ${render.request_id} can be checked in the ${provider.name} dashboard.`,
    );
    return;
  }
  if (!key || !render.status_url || !render.response_url) return;
  let result;
  try {
    result = await provider.poll(key, render.status_url, render.response_url, fetcher);
  } catch (error) {
    if (error instanceof GateError && ['AUTH_REQUIRED', 'TERMINAL_PROVIDER'].includes(error.code))
      await pool.query('UPDATE renders SET error=$2 WHERE id=$1', [render.id, error.message]);
    return;
  }
  if (result.state === 'RUNNING') {
    // First poll that sees generation under way: splits queue time from generation time.
    if (result.phase === 'running' && !render.started_at)
      await pool.query('UPDATE renders SET started_at=now() WHERE id=$1 AND started_at IS NULL', [render.id]);
    return;
  }
  if (result.state === 'FAILED') return fail(render.id, result.error);
  await pool.query("UPDATE renders SET state='DOWNLOADING',finished_at=coalesce(finished_at,now()) WHERE id=$1", [
    render.id,
  ]);
  const video = provider.download
    ? await provider.download(key, result.videoUrl, fetcher)
    : await downloadMedia(
        render.provider === 'higgsfield' ? allowedHiggsfieldMediaUrl(result.videoUrl) : allowedMediaUrl(result.videoUrl),
        fetcher,
      );
  const videoKey = `renders/${render.id}/video.mp4`;
  await putAsset(videoKey, video);
  const posterKey = await extractPoster(render.id, videoKey, render.duration_seconds).catch((error) => {
    console.error(JSON.stringify({ event: 'render.poster_failed', id: render.id, message: String(error).slice(0, 300) }));
    return null;
  });
  const output = await probeOutput(videoKey, video.length).catch(() => null);
  // OpenRouter reports its bill; Replicate reports its own queue and run time, and a GPU-billed
  // Replicate model costs its rate times that run time.
  const runSeconds = result.timing?.runSeconds ?? null;
  const gpu = render.request_settings?.gpuPerSecond;
  const runCents = gpu && runSeconds !== null ? Math.max(1, Math.round(gpu * runSeconds * 100)) : null;
  await transaction(async (db) => {
    await db.query(
      `UPDATE renders SET state='COMPLETE',video_key=$2,poster_key=$3,seed=$4,output=$5,error=NULL,completed_at=now(),
         billed_cents=coalesce($6,billed_cents),
         queue_seconds=coalesce($7,queue_seconds), run_seconds=coalesce($8,run_seconds),
         estimated_cents=coalesce($9,estimated_cents),
         reconciled_at=CASE WHEN $10 THEN now() ELSE reconciled_at END
       WHERE id=$1`,
      [
        render.id,
        videoKey,
        posterKey,
        result.seed ?? null,
        output && JSON.stringify(output),
        result.billedCents ?? null,
        result.timing?.queueSeconds ?? null,
        runSeconds,
        runCents,
        Boolean(result.timing),
      ],
    );
    await audit(db, 'render.complete', render.id, { requestId: render.request_id });
  });
}

async function fail(id: string, error: string) {
  await transaction(async (db) => {
    await db.query("UPDATE renders SET state='FAILED',error=$2,completed_at=now() WHERE id=$1", [id, error]);
    await audit(db, 'render.failed', id, { error });
  });
}

// What the provider actually delivered, which can differ from what was asked for.
async function probeOutput(videoKey: string, bytes: number) {
  const { stdout } = await withAssetPath(videoKey, (path) =>
    runMedia('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,width,height,avg_frame_rate:format=duration',
      '-of',
      'json',
      path,
    ]),
  );
  const info = JSON.parse(stdout.toString()) as {
    streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string }[];
    format?: { duration?: string };
  };
  const video = info.streams?.find((s) => s.codec_type === 'video');
  const [n, d] = (video?.avg_frame_rate ?? '0/1').split('/').map(Number);
  return {
    width: video?.width ?? null,
    height: video?.height ?? null,
    seconds: info.format?.duration ? Math.round(Number(info.format.duration) * 100) / 100 : null,
    fps: d ? Math.round((n / d) * 100) / 100 : null,
    audio: Boolean(info.streams?.some((s) => s.codec_type === 'audio')),
    bytes,
  };
}

async function extractPoster(id: string, videoKey: string, duration: number) {
  const dir = await mkdtemp(join(tmpdir(), 'bench-poster-'));
  try {
    const out = join(dir, 'poster.jpg');
    await withAssetPath(videoKey, (path) =>
      runMedia('ffmpeg', ['-y', '-ss', String(Math.max(0.2, duration / 2)), '-i', path, '-frames:v', '1', '-q:v', '3', out]),
    );
    const key = `renders/${id}/poster.jpg`;
    await putAsset(key, await readFile(out));
    return key;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function renderAsset(id: string, kind: 'video' | 'poster' | 'strip') {
  const render = await one<{ video_key: string | null; poster_key: string | null; strip_key: string | null }>(
    'SELECT video_key,poster_key,strip_key FROM renders WHERE id=$1',
    [id],
  ).catch(() => {
    throw new GateError('NOT_FOUND', 'That render does not exist');
  });
  const key = { video: render.video_key, poster: render.poster_key, strip: render.strip_key }[kind];
  if (!key) throw new GateError('NOT_READY', 'This render has no file yet');
  return key;
}

const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
/** Saves the image every model of an image-to-video benchmark starts from. */
export async function saveStartImage(data: Buffer, contentType: string) {
  const ext = IMAGE_TYPES[contentType];
  if (!ext) throw new GateError('INVALID_INPUT', 'Use a JPEG, PNG or WebP image');
  if (data.length > 10 * 1024 * 1024) throw new GateError('INVALID_INPUT', 'Keep the image under 10 MB');
  const id = randomUUID();
  const key = `start-images/${id}/image.${ext}`;
  await putAsset(key, data);
  await pool.query('INSERT INTO start_images(id,image_key,content_type) VALUES($1,$2,$3)', [id, key, contentType]);
  return { id };
}
export function startImage(id: string) {
  return one<{ image_key: string; content_type: string }>(
    'SELECT image_key,content_type FROM start_images WHERE id=$1',
    [id],
  ).catch(() => {
    throw new GateError('NOT_FOUND', 'That start image does not exist');
  });
}
