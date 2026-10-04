import { z } from 'zod';
import { localOnly, errorResponse } from '@/lib/http';
import { cancelQueued } from '@/services/benchmark';

// Cancels this benchmark's renders that have not started generating yet.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await localOnly(request);
    return Response.json(await cancelQueued(z.string().uuid().parse((await params).id)));
  } catch (error) {
    return errorResponse(error);
  }
}
