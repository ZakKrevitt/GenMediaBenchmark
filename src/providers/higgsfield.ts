import { isIP } from 'node:net';
import { z } from 'zod';
import { GateError } from '../lib/contracts';
import { classifyHttp } from './http';
import type { StudioPoll, StudioSubmission } from './studio-providers';

// Higgsfield's platform API (docs.higgsfield.ai, reviewed 3 October 2026). Auth is
// `Authorization: Key <id>:<secret>`. Submissions return a request id plus status and cancel
// URLs; the completed status carries the output. Inputs must be public URLs, so images go
// through Higgsfield's presigned upload first. Prices come from the free estimate endpoint.
export const HIGGSFIELD = 'https://api.higgsfield.ai/';
const requestId = z.string().regex(/^[a-zA-Z0-9-]{8,128}$/);
// Submissions go to api.higgsfield.ai; the status and cancel URLs it returns point at
// platform.higgsfield.ai (seen 4 October 2026). Both serve request status.
const HIGGSFIELD_HOSTS = ['https://api.higgsfield.ai/', 'https://platform.higgsfield.ai/'];
const apiUrl = z
  .string()
  .url()
  .refine((u) => HIGGSFIELD_HOSTS.some((host) => u.startsWith(host)), 'Unexpected Higgsfield URL');
export const higgsfieldKeyPattern = /^[A-Za-z0-9_-]{8,128}:[A-Za-z0-9_.-]{8,256}$/;

async function call(
  key: string,
  url: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string },
  fetcher: typeof fetch,
) {
  const mutation = init.method === 'POST';
  try {
    return await fetcher(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Key ${key}`,
        'Content-Type': 'application/json',
        ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(mutation ? 60000 : 30000),
    });
  } catch {
    throw new GateError(
      mutation && init.idempotencyKey ? 'UNKNOWN_SUBMISSION' : 'RETRYABLE_NETWORK',
      mutation && init.idempotencyKey
        ? 'Higgsfield did not answer the submission. Check the Higgsfield console before generating again.'
        : 'Higgsfield is temporarily unreachable',
    );
  }
}

async function detail(response: Response) {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    if (typeof parsed.detail === 'string') return parsed.detail.slice(0, 400);
    if (Array.isArray(parsed.detail))
      return parsed.detail
        .map((d: { msg?: string; loc?: unknown[] }) => [d.loc?.slice(1).join('.'), d.msg].filter(Boolean).join(': '))
        .join('; ')
        .slice(0, 400);
  } catch {}
  return text.slice(0, 400);
}

async function rejected(response: Response, mutation: boolean): Promise<never> {
  if (response.status === 401)
    throw new GateError('INVALID_HIGGSFIELD_KEY', 'Higgsfield rejected the key. Copy it again from cloud.higgsfield.ai/api-keys and run setup.');
  // Higgsfield reports an empty balance as 403 not_enough_credits as well as 402.
  const reason = response.status === 403 ? await detail(response.clone()) : '';
  if (response.status === 402 || /not_enough_credits/i.test(reason))
    throw new GateError('BUDGET_EXCEEDED', 'Your Higgsfield account is out of credits. Top up at console.higgsfield.ai.');
  if (response.status === 400 || response.status === 422)
    throw new GateError('INVALID_INPUT', `Higgsfield rejected the shot settings: ${await detail(response)}`);
  if ([404, 423].includes(response.status))
    throw new GateError('TERMINAL_PROVIDER', 'This model is not available on your Higgsfield account right now.');
  throw classifyHttp(response.status, mutation);
}

export async function submitHiggsfield(
  key: string,
  endpoint: string,
  input: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
  idempotencyKey?: string,
): Promise<StudioSubmission> {
  const response = await call(
    key,
    HIGGSFIELD + endpoint,
    { method: 'POST', body: input, idempotencyKey: idempotencyKey ?? crypto.randomUUID() },
    fetcher,
  );
  if (!response.ok) return rejected(response, true);
  const parsed = z
    .object({ request_id: requestId, status_url: apiUrl })
    .safeParse(await response.json().catch(() => null));
  if (!parsed.success)
    throw new GateError(
      'UNKNOWN_SUBMISSION',
      'Higgsfield accepted the shot but returned no usable request ID. Check the Higgsfield console.',
    );
  return { requestId: parsed.data.request_id, statusUrl: parsed.data.status_url, responseUrl: parsed.data.status_url };
}

export async function pollHiggsfield(
  key: string,
  statusUrl: string,
  _responseUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<StudioPoll> {
  apiUrl.parse(statusUrl);
  const response = await call(key, statusUrl, {}, fetcher);
  if (response.status === 401)
    throw new GateError('AUTH_REQUIRED', 'Higgsfield rejected the key. Copy it again from cloud.higgsfield.ai/api-keys and run setup.');
  if (!response.ok) throw classifyHttp(response.status);
  const body = z
    .object({
      status: z.string(),
      error: z.string().nullish(),
      video: z.object({ url: z.string().url() }).nullish(),
      images: z.array(z.object({ url: z.string().url() })).nullish(),
      seed: z.number().nullish(),
    })
    .passthrough()
    .parse(await response.json());
  if (body.status === 'nsfw')
    return { state: 'FAILED', error: 'Higgsfield moderation rejected the prompt or an image. Credits were refunded.' };
  if (body.status === 'failed' || body.status === 'canceled')
    return { state: 'FAILED', error: body.error?.slice(0, 500) || `Higgsfield ${body.status} this request` };
  if (body.status !== 'completed')
    return { state: 'RUNNING', phase: body.status === 'queued' ? 'queued' : 'running' };
  const url = body.video?.url ?? body.images?.[0]?.url;
  if (!url) return { state: 'FAILED', error: 'Higgsfield finished without returning a file' };
  return { state: 'COMPLETE', videoUrl: url, seed: body.seed ?? undefined };
}

// Output lives on Higgsfield's CDN, whose host is not documented. Accept public HTTPS hosts
// only: no IP literals, ports, credentials or internal names.
export function allowedHiggsfieldMediaUrl(raw: string) {
  const url = new URL(raw);
  const host = url.hostname;
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    isIP(host.replace(/^\[|\]$/g, '')) ||
    !host.includes('.') ||
    /(^|\.)(localhost|local|internal|railway\.internal)$/.test(host)
  )
    throw new GateError('UNSAFE_MEDIA_URL', 'Higgsfield returned an unsupported media host');
  return url;
}

// Inputs must be public URLs: ask for a presigned slot, PUT the bytes, pass the public URL.
export async function uploadHiggsfield(
  key: string,
  data: Buffer,
  contentType: string,
  fetcher: typeof fetch = fetch,
) {
  const slot = await call(key, `${HIGGSFIELD}files/generate-upload-url`, { method: 'POST', body: { content_type: contentType } }, fetcher);
  if (!slot.ok) return rejected(slot, false);
  const parsed = z
    .object({
      public_url: z.string().url(),
      upload_url: z.string().url().refine((u) => u.startsWith('https://')),
      upload_headers: z.record(z.string(), z.string()).default({}),
    })
    .parse(await slot.json());
  let put: Response;
  try {
    put = await fetcher(parsed.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType, ...parsed.upload_headers },
      body: new Uint8Array(data),
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new GateError('RETRYABLE_NETWORK', 'Could not upload an image to Higgsfield');
  }
  if (!put.ok) throw new GateError('RETRYABLE_PROVIDER', `Higgsfield storage refused the image (${put.status})`);
  return parsed.public_url;
}

// The estimate endpoint is free and authoritative for the account, so it both prices a shot
// and verifies a key.
export async function estimateHiggsfield(
  key: string,
  endpoint: string,
  input: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
) {
  const response = await call(key, `${HIGGSFIELD}estimate/${endpoint}`, { method: 'POST', body: input }, fetcher);
  if (!response.ok) return rejected(response, false);
  // Token- and second-metered models (Seedance, Wan) answer with a rate description instead of
  // a number; callers then price from the model's published rates (cents is null).
  const body = z
    .object({
      type: z.string().optional(),
      usd: z.union([z.string(), z.number()]).optional(),
      credits: z.union([z.string(), z.number()]).optional(),
      pricing_description: z.string().optional(),
    })
    .parse(await response.json());
  if (body.usd === undefined) {
    if (body.pricing_description) return { cents: null, credits: null, description: body.pricing_description.slice(0, 600) };
    throw new GateError('RETRYABLE_PROVIDER', 'Higgsfield returned an unreadable price');
  }
  const usd = Number(body.usd);
  if (!Number.isFinite(usd) || usd < 0) throw new GateError('RETRYABLE_PROVIDER', 'Higgsfield returned an unreadable price');
  return { cents: Math.max(1, Math.ceil(usd * 100)), credits: body.credits === undefined ? null : Number(body.credits) };
}

export async function verifyHiggsfieldKey(key: string, fetcher: typeof fetch = fetch): Promise<true> {
  if (!higgsfieldKeyPattern.test(key))
    throw new GateError('INVALID_HIGGSFIELD_KEY', 'Paste the key as KEY_ID:KEY_SECRET from console.higgsfield.ai.');
  try {
    await estimateHiggsfield(key, 'bytedance/seedance-2.0/text-to-video', { prompt: 'A calm lake at dawn', duration: 4 }, fetcher);
  } catch (error) {
    if (error instanceof GateError && error.code === 'INVALID_INPUT') return true; // authenticated, schema quibble
    throw error;
  }
  return true;
}

