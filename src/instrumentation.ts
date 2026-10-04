// Starts the background loops (polling, analysis, judging) once the Node server is up.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.BENCH_BACKGROUND === 'off') return;
  const { startBackground } = await import('./services/background');
  startBackground();
}
