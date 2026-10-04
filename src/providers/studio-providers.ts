import type { Provider } from '../lib/studio';
import { pollShot, submitShot, verifyFalKey } from './fal-studio';
import { pollHiggsfield, submitHiggsfield, verifyHiggsfieldKey } from './higgsfield';

// One shape for every inference provider the production studio can render on. Submissions
// are recorded before the POST; polls return the same three states whichever provider runs.
export type StudioSubmission = { requestId: string; statusUrl: string; responseUrl: string };
export type StudioPoll =
  | { state: 'RUNNING'; position?: number; phase?: 'queued' | 'running' }
  | { state: 'COMPLETE'; videoUrl: string; seed?: number }
  | { state: 'FAILED'; error: string };

export type StudioProvider = {
  name: string;
  submit(key: string, endpoint: string, input: Record<string, unknown>, fetcher?: typeof fetch): Promise<StudioSubmission>;
  poll(key: string, statusUrl: string, responseUrl: string, fetcher?: typeof fetch): Promise<StudioPoll>;
  verify(key: string, fetcher?: typeof fetch): Promise<unknown>;
};

export const studioProviders: Record<Provider, StudioProvider> = {
  fal: { name: 'fal', submit: submitShot, poll: pollShot, verify: verifyFalKey },
  higgsfield: {
    name: 'Higgsfield',
    submit: submitHiggsfield,
    poll: pollHiggsfield,
    verify: verifyHiggsfieldKey,
  },
};
