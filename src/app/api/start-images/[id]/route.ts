import { z } from 'zod';
import { localOnly, errorResponse } from '@/lib/http';
import { assetResponse } from '@/lib/storage';
import { startImage } from '@/services/renders';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await localOnly(request);
    const image = await startImage(z.string().uuid().parse((await params).id));
    return assetResponse(request, image.image_key, image.content_type);
  } catch (error) {
    return errorResponse(error);
  }
}
