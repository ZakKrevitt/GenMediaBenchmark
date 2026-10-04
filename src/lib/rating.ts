// Arena ratings from blind head-to-head votes, fitted as a Bradley-Terry model (as LMArena does):
// every vote is used at once, so the order votes were cast in does not matter. Ties count half a
// win to each side; "both bad" says nothing about which is better and is left out. Each model
// also plays one virtual tie against a fixed average opponent, which keeps a model that never
// lost (or never won) finite and anchors the scale: 1000 is that average opponent, and 400
// points is ten-to-one odds, as on an Elo scale.
export type Vote = {
  left: string;
  right: string;
  outcome: 'left' | 'right' | 'tie' | 'both_bad';
  /** The prompt the pair was rendered from. Votes on one prompt are correlated. */
  group?: string;
};

export const RATING_ANCHOR = 1000;
const PRIOR_GAMES = 1;

const counted = (votes: Vote[]) => votes.filter((v) => v.outcome !== 'both_bad' && v.left !== v.right);

export function btRatings(votes: Vote[]) {
  const list = counted(votes);
  const wins = new Map<string, number>();
  const games = new Map<string, number>();
  const pairs = new Map<string, Map<string, number>>();
  const add = (a: string, b: string) => {
    const row = pairs.get(a) ?? new Map<string, number>();
    row.set(b, (row.get(b) ?? 0) + 1);
    pairs.set(a, row);
  };
  for (const v of list) {
    const score = v.outcome === 'left' ? 1 : v.outcome === 'right' ? 0 : 0.5;
    wins.set(v.left, (wins.get(v.left) ?? 0) + score);
    wins.set(v.right, (wins.get(v.right) ?? 0) + 1 - score);
    for (const id of [v.left, v.right]) games.set(id, (games.get(id) ?? 0) + 1);
    add(v.left, v.right);
    add(v.right, v.left);
  }
  const ids = [...games.keys()];
  // Minorise-maximise updates (Hunter 2004); the virtual opponent has strength 1.
  let strength = new Map(ids.map((id) => [id, 1]));
  for (let iter = 0; iter < 500; iter++) {
    const next = new Map<string, number>();
    let change = 0;
    for (const id of ids) {
      const p = strength.get(id)!;
      let denominator = PRIOR_GAMES / (p + 1);
      for (const [other, n] of pairs.get(id)!) denominator += n / (p + strength.get(other)!);
      const updated = ((wins.get(id) ?? 0) + PRIOR_GAMES / 2) / denominator;
      next.set(id, updated);
      change = Math.max(change, Math.abs(Math.log(updated / p)));
    }
    strength = next;
    if (change < 1e-9) break;
  }
  return new Map(
    ids.map((id) => [
      id,
      { rating: Math.round(RATING_ANCHOR + 400 * Math.log10(strength.get(id)!)), games: games.get(id)! },
    ]),
  );
}

// Small deterministic generator so intervals are stable between page loads.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Prompts a model's votes came from; fewer than this and its interval is not reported. */
export const MIN_PROMPTS_FOR_INTERVAL = 3;

/**
 * A 95% interval for each rating. Votes on the same prompt are correlated, so the bootstrap
 * resamples whole prompts (with all their votes) rather than single votes, refits, and takes the
 * 2.5th and 97.5th percentiles. A model absent from a resample is simply not rated in it; it is
 * never filled in with a default. Models with votes from fewer than three prompts get no
 * interval, since resampling one or two prompts cannot show how settled a rating is.
 */
export function btIntervals(votes: Vote[], rounds = 300, seed = 7) {
  const list = counted(votes);
  const groups = new Map<string, Vote[]>();
  list.forEach((v, i) => {
    const key = v.group ?? `vote-${i}`;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  });
  const prompts = new Map<string, Set<string>>();
  for (const [key, vs] of groups)
    for (const v of vs)
      for (const id of [v.left, v.right]) prompts.set(id, (prompts.get(id) ?? new Set()).add(key));
  const keys = [...groups.keys()];
  const samples = new Map<string, number[]>();
  const random = mulberry32(seed);
  for (let r = 0; r < rounds && keys.length; r++) {
    const resampled = keys.flatMap(() => groups.get(keys[Math.floor(random() * keys.length)])!);
    for (const [id, { rating }] of btRatings(resampled)) samples.set(id, [...(samples.get(id) ?? []), rating]);
  }
  const out = new Map<string, { low: number | null; high: number | null; prompts: number }>();
  for (const [id, set] of prompts) {
    const list = (samples.get(id) ?? []).sort((a, b) => a - b);
    const enough = set.size >= MIN_PROMPTS_FOR_INTERVAL && list.length >= 20;
    out.set(id, {
      low: enough ? list[Math.floor(list.length * 0.025)] : null,
      high: enough ? list[Math.ceil(list.length * 0.975) - 1] : null,
      prompts: set.size,
    });
  }
  return out;
}

/**
 * A star rating that needs evidence to rank high: the model's average pulled toward the average
 * of every rated render, as if it had `weight` extra ratings at that average. One 5-star render
 * no longer outranks twenty that average 4.6.
 */
export function shrunkRating(sum: number, n: number, overallMean: number, weight = 3) {
  return n ? (sum + weight * overallMean) / (n + weight) : null;
}
