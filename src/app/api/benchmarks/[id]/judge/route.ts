import { z } from 'zod';
import { localOnly, errorResponse } from '@/lib/http';
import { queueJudge } from '@/services/benchmark-judge';

// Queues the AI judge for every finished, unjudged render of this benchmark.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await localOnly(request);
    return Response.json(await queueJudge(z.string().uuid().parse((await params).id)));
  } catch (error) {
    return errorResponse(error);
  }
}
