import { z } from 'zod';
import { localOnly, body, errorResponse } from '@/lib/http';
import { voteOnPair } from '@/services/benchmark';

// One blind head-to-head vote between two renders of this benchmark.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await localOnly(request);
    await voteOnPair(z.string().uuid().parse((await params).id), await body(request, 2000));
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
