import { resolve } from 'node:path';

// Everything comes from the environment (.env.local). Keys never touch the database or the browser.
export function settings() {
  const dataDir = resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR || '.data');
  return {
    dataDir,
    storageDir: resolve(dataDir, 'media'),
    falKey: process.env.FAL_KEY?.trim() || undefined,
    openrouterKey: process.env.OPENROUTER_API_KEY?.trim() || undefined,
    replicateKey: (process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY)?.trim() || undefined,
    higgsfieldKey:
      (process.env.HIGGSFIELD_KEY || process.env.HF_CREDENTIALS || process.env.HF_KEY)?.trim() ||
      undefined,
    llmKey: process.env.OPENAI_API_KEY?.trim() || undefined,
    llmModel: process.env.LLM_MODEL?.trim() || undefined,
    dailyLimitUsd: Number(process.env.DAILY_LIMIT_USD ?? 20),
  };
}
