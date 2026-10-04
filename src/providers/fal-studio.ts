import { z } from 'zod';
import { GateError } from '../lib/contracts';
import { classifyHttp } from './http';

// fal queue adapter for the production studio. Submissions are recorded before the POST and
// never retried blindly: a lost response becomes UNKNOWN to check in the fal dashboard.
const QUEUE = 'https://queue.fal.run/';
const requestId = z.string().regex(/^[a-zA-Z0-9-]{8,128}$/);
const queueUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith(QUEUE), 'Unexpected fal queue URL');

export type FalSubmission = { requestId: string; statusUrl: string; responseUrl: string };
export type FalPoll =
  | { state: 'RUNNING'; position?: number; phase?: 'queued' | 'running' }
  | { state: 'COMPLETE'; videoUrl: string; seed?: number }
  | { state: 'FAILED'; error: string };

async function call(
  key: string,
  url: string,
  init: { method?: string; body?: unknown },
  fetcher: typeof fetch,
) {
  const mutation = init.method === 'POST';
  let response: Response;
  try {
    response = await fetcher(url, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
      body: init.body ? JSON.stringify(init.body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(mutation ? 60000 : 30000),
    });
  } catch {
    throw new GateError(
      mutation ? 'UNKNOWN_SUBMISSION' : 'RETRYABLE_NETWORK',
      mutation
        ? 'fal did not answer the submission. Check the fal dashboard before generating again.'
        : 'fal is temporarily unreachable',
    );
  }
  return { response, mutation };
}

export async function submitShot(
  key: string,
  endpoint: string,
  input: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<FalSubmission> {
  const { response } = await call(key, QUEUE + endpoint, { method: 'POST', body: input }, fetcher);
  if (response.status === 422) {
    const detail = await response.text().catch(() => '');
    const readable = readableError(detail);
    throw new GateError(
      'INVALID_INPUT',
      readable === SEEDANCE_FACE || readable.startsWith("The model's safety")
        ? readable
        : `fal rejected the shot settings${detail ? `: ${readable.slice(0, 240)}` : ''}`,
    );
  }
  if (response.status === 401 || response.status === 403)
    throw new GateError('INVALID_FAL_KEY', 'fal rejected the saved key. Replace it in the fal panel.');
  if (!response.ok) throw classifyHttp(response.status, true);
  const parsed = z
    .object({ request_id: requestId, status_url: queueUrl, response_url: queueUrl })
    .safeParse(await response.json().catch(() => null));
  if (!parsed.success)
    throw new GateError(
      'UNKNOWN_SUBMISSION',
      'fal accepted the shot but returned no usable request ID. Check the fal dashboard.',
    );
  return {
    requestId: parsed.data.request_id,
    statusUrl: parsed.data.status_url,
    responseUrl: parsed.data.response_url,
  };
}

export async function pollShot(
  key: string,
  statusUrl: string,
  responseUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<FalPoll> {
  queueUrl.parse(statusUrl);
  queueUrl.parse(responseUrl);
  const { response } = await call(key, statusUrl, {}, fetcher);
  if (!response.ok) throw classifyHttp(response.status);
  const status = z
    .object({
      status: z.string(),
      queue_position: z.number().optional(),
      error: z.string().nullish(),
    })
    .parse(await response.json());
  if (status.error) return { state: 'FAILED', error: readableError(status.error) };
  if (status.status !== 'COMPLETED')
    return {
      state: 'RUNNING',
      position: status.queue_position,
      phase: status.status === 'IN_QUEUE' ? 'queued' : 'running',
    };
  const result = await call(key, responseUrl, {}, fetcher);
  if (result.response.status === 422 || result.response.status === 400) {
    const detail = await result.response.text().catch(() => '');
    return { state: 'FAILED', error: readableError(detail) };
  }
  if (!result.response.ok) throw classifyHttp(result.response.status);
  const body = z
    .object({ video: z.object({ url: z.string().url() }), seed: z.number().optional() })
    .safeParse(await result.response.json());
  if (!body.success) return { state: 'FAILED', error: 'fal finished without returning a video' };
  return { state: 'COMPLETE', videoUrl: body.data.video.url, seed: body.data.seed };
}

// ByteDance's Seedance 2.0 refuses references that show a realistic human face, whatever
// the source, to prevent deepfakes. Other models apply their own moderation instead.
export const SEEDANCE_FACE =
  'Seedance 2.0 does not accept reference images with realistic human faces (ByteDance blocks them to prevent deepfakes). Use an illustrated or stylised reference, or switch to Kling O3, Veo 3.1 or Wan 3.0 for photos of real people.';
export function readableError(detail: string) {
  try {
    const parsed = JSON.parse(detail) as { detail?: { msg?: string; type?: string }[] | string };
    if (typeof parsed.detail === 'string') return parsed.detail.slice(0, 500);
    const first = parsed.detail?.[0];
    if (/real.{0,20}(human|person|face)|face/i.test(`${first?.msg ?? ''} ${detail}`))
      return SEEDANCE_FACE;
    if (first?.type === 'content_policy_violation')
      return "The model's safety filter rejected the prompt or an image. Rephrase it, or try another model.";
    if (first?.msg) return first.msg.slice(0, 500);
  } catch {}
  return detail.slice(0, 500) || 'fal could not render this shot';
}

// The pricing endpoint needs a valid key and costs nothing, so it verifies a key without
// starting a generation.
export async function verifyFalKey(key: string, fetcher: typeof fetch = fetch) {
  let response: Response;
  try {
    response = await fetcher(
      'https://api.fal.ai/v1/models/pricing?endpoint_id=bytedance/seedance-2.0/text-to-video',
      {
        headers: { Authorization: `Key ${key}` },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch {
    throw new GateError('RETRYABLE_NETWORK', 'fal is unreachable. Try again in a moment.');
  }
  if (response.status === 401 || response.status === 403)
    throw new GateError('INVALID_FAL_KEY', 'fal rejected this key. Copy it again from fal.ai/dashboard/keys.');
  if (!response.ok) throw classifyHttp(response.status);
  return true;
}
