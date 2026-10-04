import { localOnly, errorResponse } from '@/lib/http';
import { GateError } from '@/lib/contracts';
import { saveStartImage } from '@/services/renders';

// Uploads the image an image-to-video benchmark starts from (multipart field "image").
export async function POST(request: Request) {
  try {
    await localOnly(request);
    if (Number(request.headers.get('content-length')) > 11 * 1024 * 1024)
      throw new GateError('INVALID_INPUT', 'Keep the image under 10 MB');
    const image = (await request.formData()).get('image');
    if (!(image instanceof File)) throw new GateError('INVALID_INPUT', 'Attach an image');
    return Response.json(await saveStartImage(Buffer.from(await image.arrayBuffer()), image.type));
  } catch (error) {
    return errorResponse(error);
  }
}
