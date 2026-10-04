// Elo ratings from head-to-head votes, replayed in the order they were cast. Ties score half;
// "both bad" says nothing about which is better, so it does not move either rating.
export type Vote = { left: string; right: string; outcome: 'left' | 'right' | 'tie' | 'both_bad' };

export const ELO_START = 1000;
export const ELO_K = 32;

export function eloRatings(votes: Vote[]) {
  const rating = new Map<string, number>();
  const games = new Map<string, number>();
  const get = (id: string) => rating.get(id) ?? ELO_START;
  for (const v of votes) {
    if (v.outcome === 'both_bad' || v.left === v.right) continue;
    const a = get(v.left);
    const b = get(v.right);
    const expected = 1 / (1 + 10 ** ((b - a) / 400));
    const score = v.outcome === 'left' ? 1 : v.outcome === 'right' ? 0 : 0.5;
    rating.set(v.left, a + ELO_K * (score - expected));
    rating.set(v.right, b + ELO_K * (expected - score));
    for (const id of [v.left, v.right]) games.set(id, (games.get(id) ?? 0) + 1);
  }
  return new Map([...rating].map(([id, r]) => [id, { rating: Math.round(r), games: games.get(id) ?? 0 }]));
}

// Small deterministic generator so the interval is stable between page loads.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A 95% interval for each rating: replay the votes resampled with replacement many times (the
 * usual bootstrap for arena leaderboards) and take the 2.5th and 97.5th percentiles. Few votes
 * give a wide interval, which says the ranking is not settled yet.
 */
export function eloIntervals(votes: Vote[], rounds = 200, seed = 7) {
  const counted = votes.filter((v) => v.outcome !== 'both_bad' && v.left !== v.right);
  const samples = new Map<string, number[]>();
  const random = mulberry32(seed);
  for (let r = 0; r < rounds && counted.length; r++) {
    const resampled = counted.map(() => counted[Math.floor(random() * counted.length)]);
    for (const [id, { rating }] of eloRatings(resampled)) {
      const list = samples.get(id) ?? [];
      list.push(rating);
      samples.set(id, list);
    }
  }
  const out = new Map<string, { low: number; high: number }>();
  for (const [id, list] of samples) {
    // A model missing from a resample keeps its starting rating there.
    while (list.length < rounds) list.push(ELO_START);
    list.sort((a, b) => a - b);
    out.set(id, { low: list[Math.floor(rounds * 0.025)], high: list[Math.ceil(rounds * 0.975) - 1] });
  }
  return out;
}
