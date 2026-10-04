import { GateError } from '../lib/contracts';

export function classifyHttp(status: number, mutation = false) {
  if (status === 429)
    return new GateError(
      'RATE_LIMITED',
      'Provider quota or rate limit reached. Resolve before resuming.',
    );
  if (status === 401 || status === 403)
    return new GateError(
      'AUTH_REQUIRED',
      'Provider rejected the credentials or account permissions',
    );
  if (status >= 500)
    return new GateError(
      mutation ? 'UNKNOWN_SUBMISSION' : 'RETRYABLE_PROVIDER',
      mutation
        ? 'Provider submission outcome is uncertain. Check the provider dashboard before retrying.'
        : 'Provider temporarily unavailable',
    );
  return new GateError(
    'TERMINAL_PROVIDER',
    `Provider rejected the operation (HTTP ${status}). Inspect its account console.`,
  );
}
