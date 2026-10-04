import { execFile } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GateError } from './contracts';
import { verifyFalKey } from '../providers/fal-studio';
import { higgsfieldKeyPattern, verifyHiggsfieldKey } from '../providers/higgsfield';

// The setup wizard (in the app and `npm run setup`) writes your keys to .env.local, which is
// gitignored. Values are only ever written there and into this process's environment, never
// returned to the browser or printed.

export const ENV_FILE = resolve(/*turbopackIgnore: true*/ process.cwd(), '.env.local');
export const SETUP_KEYS = ['FAL_KEY', 'HIGGSFIELD_KEY', 'OPENAI_API_KEY', 'LLM_MODEL', 'DAILY_LIMIT_USD'] as const;
export type SetupKey = (typeof SETUP_KEYS)[number];

/** Sets or replaces the given variables in .env.local, keeping every other line as it was. */
export async function writeEnv(values: Partial<Record<SetupKey, string>>, file = ENV_FILE) {
  const lines = (await readFile(file, 'utf8').catch(() => '')).split('\n');
  for (const [name, raw] of Object.entries(values)) {
    if (raw === undefined) continue;
    const value = raw.trim();
    if (/[\s"'`$\\#]/.test(value)) throw new GateError('INVALID_INPUT', `${name} has characters a key cannot contain`);
    const line = `${name}=${value}`;
    const at = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(l));
    if (at >= 0) lines[at] = line;
    else lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, line);
    // Takes effect immediately: settings() reads process.env on every call.
    process.env[name] = value;
  }
  const text = lines.join('\n').replace(/\n*$/, '\n');
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
}

/** Checks a key with the provider's free endpoints (a price lookup or quote). Nothing is billed. */
export async function verifyKey(provider: 'fal' | 'higgsfield', key: string, fetcher: typeof fetch = fetch) {
  const value = key.trim();
  if (provider === 'higgsfield' && !higgsfieldKeyPattern.test(value))
    throw new GateError('INVALID_HIGGSFIELD_KEY', 'Paste the Higgsfield key as KEY_ID:KEY_SECRET.');
  try {
    if (provider === 'fal') await verifyFalKey(value, fetcher);
    else await verifyHiggsfieldKey(value, fetcher);
    return { warning: null as string | null };
  } catch (error) {
    // The key works; the account just cannot pay for renders yet.
    if (error instanceof GateError && error.code === 'BUDGET_EXCEEDED') return { warning: error.message };
    if (error instanceof GateError && error.code === 'AUTH_REQUIRED')
      throw new GateError(
        provider === 'fal' ? 'INVALID_FAL_KEY' : 'INVALID_HIGGSFIELD_KEY',
        provider === 'fal'
          ? 'fal rejected this key. Copy it again from fal.ai/dashboard/keys.'
          : 'Higgsfield rejected this key. Copy it again from cloud.higgsfield.ai/api-keys.',
      );
    throw error;
  }
}

/** Checks an OpenAI key and that it can use the chosen model (a free model lookup). */
export async function verifyOpenAi(key: string, model: string, fetcher: typeof fetch = fetch) {
  if (!/^[A-Za-z0-9._:-]{2,80}$/.test(model.trim())) throw new GateError('INVALID_INPUT', 'Name an OpenAI model, for example one that accepts images.');
  let response: Response;
  try {
    response = await fetcher(`https://api.openai.com/v1/models/${encodeURIComponent(model.trim())}`, {
      headers: { Authorization: `Bearer ${key.trim()}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new GateError('RETRYABLE_NETWORK', 'OpenAI is unreachable. Try again in a moment.');
  }
  if (response.status === 401) throw new GateError('INVALID_OPENAI_KEY', 'OpenAI rejected this key.');
  if (response.status === 404) throw new GateError('INVALID_INPUT', `This key cannot use ${model.trim()}.`);
  if (!response.ok) throw new GateError('RETRYABLE_PROVIDER', `OpenAI returned ${response.status}`);
}

const which = (bin: string) =>
  new Promise<boolean>((done) =>
    execFile(process.env[bin === 'ffmpeg' ? 'FFMPEG_BIN' : 'FFPROBE_BIN'] || bin, ['-version'], (error) =>
      done(!error),
    ),
  );
/** What is set up, without revealing any value. */
export async function setupStatus() {
  const [ffmpeg, ffprobe] = await Promise.all([which('ffmpeg'), which('ffprobe')]);
  const node = Number(process.versions.node.split('.')[0]);
  return {
    fal: Boolean(process.env.FAL_KEY?.trim()),
    higgsfield: Boolean((process.env.HIGGSFIELD_KEY || process.env.HF_CREDENTIALS || process.env.HF_KEY)?.trim()),
    judge: Boolean(process.env.OPENAI_API_KEY?.trim() && process.env.LLM_MODEL?.trim()),
    llmModel: process.env.LLM_MODEL?.trim() || null,
    dailyLimitUsd: Number(process.env.DAILY_LIMIT_USD ?? 20) || 20,
    ffmpeg: ffmpeg && ffprobe,
    node: process.versions.node,
    nodeOk: node >= 22,
  };
}
export type SetupStatus = Awaited<ReturnType<typeof setupStatus>>;
