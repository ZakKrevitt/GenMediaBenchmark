import { z } from 'zod';
import { localOnly, body, errorResponse } from '@/lib/http';
import { benchmarkState, createBenchmark } from '@/services/benchmark';

export const dynamic = 'force-dynamic';
// Submitting to many models runs a few at a time, so a large benchmark can take a while.
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    await localOnly(request);
    const q = new URL(request.url).searchParams;
    const scope = {
      suiteId: q.get('suite') ? z.string().uuid().parse(q.get('suite')) : null,
      setup: q.get('setup') || null,
      commonOnly: q.get('common') === 'true',
    };
    return Response.json(await benchmarkState(scope), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await localOnly(request);
    return Response.json(await createBenchmark(await body(request, 24000)));
  } catch (error) {
    return errorResponse(error);
  }
}
