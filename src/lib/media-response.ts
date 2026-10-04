import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

export async function mediaFileResponse(
  request: Request,
  path: string,
  contentType: string,
  download?: string,
) {
  const size = (await stat(path)).size;
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
  };
  if (download) headers['Content-Disposition'] = `attachment; filename="${download}"`;
  let start = 0,
    end = size - 1,
    status = 200;
  const range = request.headers.get('range');
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    start = Number(match?.[1]);
    end = Math.min(match?.[2] ? Number(match[2]) : end, end);
    if (
      !match ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= size
    )
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${size}` },
      });
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(Math.max(0, end - start + 1));
  if (!size) return new Response(null, { headers });
  const stream = Readable.toWeb(
    createReadStream(path, { start, end }),
  ) as ReadableStream<Uint8Array>;
  return new Response(stream, { status, headers });
}

export function mediaResponse(
  request: Request,
  data: Buffer,
  contentType: string,
  download?: string,
) {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
  };
  if (download) headers['Content-Disposition'] = `attachment; filename="${download}"`;
  const range = request.headers.get('range');
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = Number(match?.[1]),
      end = Math.min(match?.[2] ? Number(match[2]) : data.length - 1, data.length - 1);
    if (
      !match ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= data.length
    )
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${data.length}` },
      });
    return new Response(new Uint8Array(data.subarray(start, end + 1)), {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${data.length}`,
        'Content-Length': String(end - start + 1),
      },
    });
  }
  return new Response(new Uint8Array(data), {
    headers: { ...headers, 'Content-Length': String(data.length) },
  });
}
