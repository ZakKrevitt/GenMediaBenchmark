import { z } from 'zod';
import { localOnly, body, errorResponse } from '@/lib/http';
import { pickWinner } from '@/services/benchmark';

// Marks your pick for a benchmark, or clears it with null.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await localOnly(request);
    const id = z.string().uuid().parse((await params).id);
    const input = z.object({ winnerShotId: z.string().uuid().nullable() }).parse(await body(request, 2000));
    await pickWinner(id, input.winnerShotId);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
