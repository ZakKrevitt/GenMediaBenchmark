/**
 * The best-value frontier: walking from cheapest (or fastest) up, each point that beats every
 * cheaper point on quality. Nothing off the frontier is both cheaper and better than it.
 */
export function frontier<T>(points: T[], x: (p: T) => number, y: (p: T) => number) {
  const sorted = [...points].sort((a, b) => x(a) - x(b) || y(b) - y(a));
  const out: T[] = [];
  for (const p of sorted) if (!out.length || y(p) > y(out.at(-1)!)) out.push(p);
  return out;
}
