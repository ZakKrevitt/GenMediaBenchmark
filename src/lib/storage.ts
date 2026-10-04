import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { settings } from './config';
import { GateError } from './contracts';
import { mediaFileResponse } from './media-response';

// Media lives on local disk under DATA_DIR/media.
function pathFor(key: string) {
  if (!/^(renders|start-images)\/[a-f0-9-]+\/[a-z0-9-]+\.(mp4|jpg|png|webp)$/.test(key))
    throw new GateError('INVALID_ASSET', 'Invalid media reference');
  return resolve(settings().storageDir, key);
}
export async function putAsset(key: string, body: Buffer) {
  const path = pathFor(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, { mode: 0o600 });
  return key;
}
export function getAsset(key: string) {
  return readFile(pathFor(key));
}
export function assetResponse(request: Request, key: string, contentType: string) {
  return mediaFileResponse(request, pathFor(key), contentType);
}
// Runs fn with a readable file path for the asset.
export function withAssetPath<T>(key: string, fn: (path: string) => Promise<T>) {
  return fn(pathFor(key));
}
export function allowedMediaUrl(raw: string) {
  const url = new URL(raw);
  const fal = url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media');
  const google =
    url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/falserverless/');
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !(fal || google))
    throw new GateError('UNSAFE_MEDIA_URL', 'Provider returned an unsupported media host');
  return url;
}
// Downloads a provider's output, capped at 200 MB.
export async function downloadMedia(url: URL, fetcher: typeof fetch = fetch) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body)
    throw new GateError('MEDIA_DOWNLOAD_FAILED', 'Could not download the provider output');
  const limit = 200 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit)
    throw new GateError('MEDIA_TOO_LARGE', 'Provider output exceeds 200 MB');
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > limit) throw new GateError('MEDIA_TOO_LARGE', 'Provider output exceeds 200 MB');
  return body;
}
