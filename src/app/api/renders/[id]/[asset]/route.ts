import { z } from 'zod';
import { localOnly, errorResponse } from '@/lib/http';
import { assetResponse, withAssetPath } from '@/lib/storage';
import { mediaFileResponse } from '@/lib/media-response';
import { renderAsset } from '@/services/renders';

// A render's video, poster frame, filmstrip, or the video as a download.
export async function GET(request: Request, { params }: { params: Promise<{ id: string; asset: string }> }) {
  try {
    await localOnly(request);
    const { id, asset } = await params;
    z.string().uuid().parse(id);
    const kind = z.enum(['video', 'poster', 'strip', 'download']).parse(asset);
    const key = await renderAsset(id, kind === 'download' ? 'video' : kind);
    if (kind === 'download')
      return withAssetPath(key, (path) => mediaFileResponse(request, path, 'video/mp4', `render-${id.slice(0, 8)}.mp4`));
    return assetResponse(request, key, kind === 'video' ? 'video/mp4' : 'image/jpeg');
  } catch (error) {
    return errorResponse(error);
  }
}
