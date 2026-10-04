import { z } from 'zod';
import { localOnly, body, errorResponse } from '@/lib/http';
import { benchmarkState, createBenchmark } from '@/services/benchmark';

export const dynamic = 'force-dynamic';
// Submitting to many models runs a few at a time, so a large benchmark can take a while.
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    await localOnly(request);
    const suite = new URL(request.url).searchParams.get('suite');
    return Response.json(await benchmarkState(suite ? z.string().uuid().parse(suite) : null), { headers: { 'Cache-Control': 'private, no-store' } });
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
