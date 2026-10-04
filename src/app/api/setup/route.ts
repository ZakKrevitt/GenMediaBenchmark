import { z } from 'zod';
import { localOnly, body, errorResponse } from '@/lib/http';
import { setupStatus, verifyKey, verifyOpenAi, writeEnv, type SetupKey } from '@/lib/env-file';

export const dynamic = 'force-dynamic';

// The first-run wizard. GET says what is configured (never a value); POST checks each key with
// its provider's free endpoints and saves it to .env.local.
export async function GET(request: Request) {
  try {
    await localOnly(request);
    return Response.json(await setupStatus());
  } catch (error) {
    return errorResponse(error);
  }
}

const key = z.string().trim().min(8).max(400);
const input = z.object({
  falKey: key.optional(),
  higgsfieldKey: key.optional(),
  openaiKey: key.optional(),
  llmModel: z.string().trim().min(2).max(80).optional(),
  dailyLimitUsd: z.number().min(0).max(10000).optional(),
});

export async function POST(request: Request) {
  try {
    await localOnly(request);
    const v = input.parse(await body(request, 4000));
    const warnings: string[] = [];
    if (v.falKey) await verifyKey('fal', v.falKey);
    if (v.higgsfieldKey) {
      const { warning } = await verifyKey('higgsfield', v.higgsfieldKey);
      if (warning) warnings.push(warning);
    }
    const openaiKey = v.openaiKey ?? process.env.OPENAI_API_KEY;
    const llmModel = v.llmModel ?? process.env.LLM_MODEL;
    if ((v.openaiKey || v.llmModel) && openaiKey && llmModel) await verifyOpenAi(openaiKey, llmModel);
    const values: Partial<Record<SetupKey, string>> = {
      FAL_KEY: v.falKey,
      HIGGSFIELD_KEY: v.higgsfieldKey,
      OPENAI_API_KEY: v.openaiKey,
      LLM_MODEL: v.llmModel,
      DAILY_LIMIT_USD: v.dailyLimitUsd === undefined ? undefined : String(v.dailyLimitUsd),
    };
    await writeEnv(values);
    return Response.json({ ...(await setupStatus()), warnings });
  } catch (error) {
    return errorResponse(error);
  }
}
