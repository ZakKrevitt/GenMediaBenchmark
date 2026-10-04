import { localOnly, errorResponse } from '@/lib/http';
import { benchmarkModels } from '@/services/benchmark';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Every fal and Higgsfield text-to-video model, snapped to the run settings and priced, without spending.
export async function GET(request: Request) {
  try {
    await localOnly(request);
    const q = new URL(request.url).searchParams;
    const seed = q.get('seed');
    const result = await benchmarkModels({
      duration: Number(q.get('duration') ?? 5),
      aspectRatio: q.get('aspectRatio') ?? undefined,
      resolution: q.get('resolution') ?? undefined,
      audio: q.get('audio') !== 'false',
      seed: seed ? Number(seed) : null,
      firstFrameId: q.get('firstFrameId') || null,
    });
    return Response.json(result, { headers: { 'Cache-Control': 'private, max-age=60' } });
  } catch (error) {
    return errorResponse(error);
  }
}
