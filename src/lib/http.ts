import { GateError } from './contracts';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The app has no accounts: it is meant to run on your own machine. Requests must reach it by a
 * loopback host name (which blocks DNS rebinding from a web page), and changes must come from
 * the app's own pages (which blocks cross-site form posts). Set BENCH_ALLOW_REMOTE=true only
 * behind your own authentication.
 */
export async function localOnly(request?: Request) {
  if (!request || process.env.BENCH_ALLOW_REMOTE === 'true') return;
  const host = request.headers.get('host') ?? '';
  const hostname = host.replace(/:\d+$/, '');
  if (!LOOPBACK.has(hostname))
    throw new GateError('FORBIDDEN', 'Open the benchmark at http://localhost');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('origin');
    if (!origin || new URL(origin).host !== host)
      throw new GateError('CSRF_BLOCKED', 'This action must come from the benchmark page');
  }
}

export function safeError(error: unknown) {
  if (error instanceof GateError) return { code: error.code, message: error.message };
  if (error instanceof Error && error.name === 'ZodError')
    return { code: 'INVALID_INPUT', message: 'Check the required fields and allowed values.' };
  console.error(error);
  return {
    code: 'OPERATION_FAILED',
    message: 'The operation stopped. Check the server log for details.',
  };
}
export function errorResponse(error: unknown) {
  const result = safeError(error);
  return Response.json(result, {
    status: ['CSRF_BLOCKED', 'FORBIDDEN'].includes(result.code)
      ? 403
      : result.code === 'NOT_FOUND'
        ? 404
        : result.code === 'OPERATION_FAILED'
          ? 500
          : 400,
  });
}
export async function body(request: Request, limit = 32000) {
  if (Number(request.headers.get('content-length')) > limit)
    throw new GateError('INVALID_INPUT', 'Request is too large');
  const text = await request.text();
  if (text.length > limit) throw new GateError('INVALID_INPUT', 'Request is too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new GateError('INVALID_INPUT', 'Request must be valid JSON');
  }
}
