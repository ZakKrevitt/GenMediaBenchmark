import type { BenchProvider } from '../lib/studio';
import { pollShot, submitShot, verifyFalKey } from './fal-studio';
import { pollHiggsfield, submitHiggsfield, verifyHiggsfieldKey } from './higgsfield';
import { downloadOpenRouter, pollOpenRouter, submitOpenRouter, verifyOpenRouterKey } from './openrouter';
import { downloadReplicate, pollReplicate, submitReplicate, verifyReplicateKey } from './replicate';

// One shape for every inference provider. Submissions are recorded before the POST; polls return
// the same three states whichever provider runs.
export type StudioSubmission = { requestId: string; statusUrl: string; responseUrl: string };
export type StudioPoll =
  | { state: 'RUNNING'; position?: number; phase?: 'queued' | 'running' }
  | {
      state: 'COMPLETE';
      videoUrl: string;
      seed?: number;
      /** What the provider charged, when it says (OpenRouter). */
      billedCents?: number;
      /** The provider's own queue and run time, when it reports them (Replicate). */
      timing?: { queueSeconds: number | null; runSeconds: number | null };
    }
  | { state: 'FAILED'; error: string };

export type StudioProvider = {
  name: string;
  submit(key: string, endpoint: string, input: Record<string, unknown>, fetcher?: typeof fetch): Promise<StudioSubmission>;
  poll(key: string, statusUrl: string, responseUrl: string, fetcher?: typeof fetch): Promise<StudioPoll>;
  verify(key: string, fetcher?: typeof fetch): Promise<unknown>;
  /** Fetches a finished video when the provider's links need the key or a special host check. */
  download?(key: string, url: string, fetcher?: typeof fetch): Promise<Buffer>;
};

export const studioProviders: Record<BenchProvider, StudioProvider> = {
  fal: { name: 'fal', submit: submitShot, poll: pollShot, verify: verifyFalKey },
  higgsfield: {
    name: 'Higgsfield',
    submit: submitHiggsfield,
    poll: pollHiggsfield,
    verify: verifyHiggsfieldKey,
  },
  openrouter: {
    name: 'OpenRouter',
    submit: submitOpenRouter,
    poll: pollOpenRouter,
    verify: verifyOpenRouterKey,
    download: downloadOpenRouter,
  },
  replicate: {
    name: 'Replicate',
    submit: submitReplicate,
    poll: pollReplicate,
    verify: verifyReplicateKey,
    download: downloadReplicate,
  },
};
