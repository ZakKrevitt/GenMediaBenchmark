import { z } from 'zod';
import { localOnly, body, errorResponse } from '@/lib/http';
import { addToBenchmark } from '@/services/benchmark';

export const maxDuration = 300;

// Runs more models, a retry or another take on an existing benchmark's prompt and settings.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await localOnly(request);
    const id = z.string().uuid().parse((await params).id);
    return Response.json(await addToBenchmark(id, await body(request, 24000)));
  } catch (error) {
    return errorResponse(error);
  }
}
