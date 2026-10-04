import { analyzeBenchmarkShots, reconcileBenchmarkShots } from './benchmark';
import { judgeBenchmarkShots } from './benchmark-judge';
import { pollRenders } from './renders';

// The work a separate worker process did in the original app, run on timers inside the web
// server so `npm run dev` is the only command. Each loop waits for its previous tick.
function every(ms: number, name: string, tick: () => Promise<unknown>) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (error) {
      console.error(JSON.stringify({ event: `${name}.error`, message: String(error).slice(0, 300) }));
    } finally {
      running = false;
    }
  }, ms);
  timer.unref?.();
}

export function startBackground() {
  const g = globalThis as unknown as { benchBackground?: boolean };
  if (g.benchBackground) return;
  g.benchBackground = true;
  every(3000, 'poll', async () => {
    await pollRenders();
    await reconcileBenchmarkShots();
  });
  every(5000, 'analysis', async () => {
    await analyzeBenchmarkShots();
    await judgeBenchmarkShots();
  });
}
