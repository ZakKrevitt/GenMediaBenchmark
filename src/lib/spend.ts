import { settings } from './config';

export function dailyCapCents() {
  const usd = settings().dailyLimitUsd;
  return Math.round((Number.isFinite(usd) && usd >= 0 ? usd : 20) * 100);
}

// Today's spend (local server day): billed cost when the provider reported it, otherwise the
// estimate, plus any AI judge reservation. Failed renders are not billed.
export const SPENT_TODAY = `SELECT coalesce(sum(coalesce(billed_cents, estimated_cents) + judge_cents),0)::int cents
  FROM renders WHERE state<>'FAILED' AND created_at >= date_trunc('day', now())`;
