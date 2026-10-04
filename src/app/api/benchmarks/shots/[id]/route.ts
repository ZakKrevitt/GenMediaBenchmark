import { z } from 'zod';
import { localOnly, body, errorResponse } from '@/lib/http';
import { rateBenchShot } from '@/services/benchmark';

// Rates one benchmark render from 1 to 5 and keeps a short note about it.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await localOnly(request);
    await rateBenchShot(z.string().uuid().parse((await params).id), await body(request, 4000));
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
