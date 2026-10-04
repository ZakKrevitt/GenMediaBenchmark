import { localOnly, errorResponse } from '@/lib/http';
import { modelHistory } from '@/services/benchmark';

export const dynamic = 'force-dynamic';

// Every render one model (provider:endpoint) has made across benchmarks.
export async function GET(request: Request) {
  try {
    await localOnly(request);
    const id = new URL(request.url).searchParams.get('id') ?? '';
    return Response.json(await modelHistory(id), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}
