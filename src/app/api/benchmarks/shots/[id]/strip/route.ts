import { z } from 'zod';
import { localOnly, errorResponse } from '@/lib/http';
import { assetResponse } from '@/lib/storage';
import { renderAsset } from '@/services/renders';

// Six frames of a benchmark render in one image.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await localOnly(request);
    const id = z.string().uuid().parse((await params).id);
    return assetResponse(request, await renderAsset(id, 'strip'), 'image/jpeg');
  } catch (error) {
    return errorResponse(error);
  }
}
