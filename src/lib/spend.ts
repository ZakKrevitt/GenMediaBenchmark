import { one, pool, type DB } from './db';
import { settings } from './config';

export function dailyCapCents() {
  const usd = settings().dailyLimitUsd;
  return Math.round((Number.isFinite(usd) && usd >= 0 ? usd : 20) * 100);
}

/** Midnight at the start of today on this computer's clock (the database itself runs on UTC). */
export function startOfLocalDay(now = new Date()) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.toISOString();
}

// Today's spend: billed cost when the provider reported it, otherwise the estimate, plus any AI
// judge cost. A failed render costs nothing unless the provider billed it anyway (for example one
// that finished after this app gave up waiting).
export const SPENT_TODAY = `SELECT coalesce(sum(
    CASE WHEN state<>'FAILED' THEN coalesce(billed_cents, estimated_cents) ELSE coalesce(billed_cents, 0) END
    + judge_cents),0)::int cents
  FROM renders WHERE created_at >= $1`;

export async function spentTodayCents(db: DB = pool) {
  return (await one<{ cents: number }>(SPENT_TODAY, [startOfLocalDay()], db)).cents;
}
