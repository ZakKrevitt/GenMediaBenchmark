// Objective checks on a rendered video from one ffmpeg pass at 320 px: motion (mean luma change
// between frames), hard cuts, frozen and black stretches, silence and integrated loudness. The
// parser is pure so it is tested against real ffmpeg log lines.

export type VideoAnalysis = {
  /** Mean per-frame luma difference (signalstats YDIF). 0 is a still image; above 6 is busy. */
  motion: number | null;
  /** Seconds at which a hard cut (scene change above the threshold) happens. */
  cuts: number[];
  /** Frozen seconds that are not black. */
  frozenSeconds: number;
  longestFreeze: number;
  blackSeconds: number;
  silentSeconds: number | null;
  /** Integrated loudness in LUFS; null without an audio track. */
  loudness: number | null;
  /** Problems worth flagging, in plain words. */
  issues: string[];
};

export const CUT_THRESHOLD = 0.4;

export function analysisArgs(path: string, hasAudio: boolean) {
  return [
    '-hide_banner',
    '-nostats',
    '-i',
    path,
    '-vf',
    `scale=320:-2,signalstats,metadata=mode=print:key=lavfi.signalstats.YDIF,freezedetect=n=-60dB:d=0.5,blackdetect=d=0.2:pix_th=0.10,select='gt(scene\\,${CUT_THRESHOLD})',showinfo`,
    ...(hasAudio ? ['-af', 'silencedetect=n=-50dB:d=0.5,ebur128=framelog=quiet'] : ['-an']),
    '-f',
    'null',
    '-',
  ];
}

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const numbers = (log: string, re: RegExp) => [...log.matchAll(re)].map((m) => Number(m[1])).filter(Number.isFinite);

export function parseAnalysis(
  log: string,
  opts: { seconds: number | null; hasAudio: boolean; soundRequested: boolean | null },
): VideoAnalysis {
  const diffs = numbers(log, /lavfi\.signalstats\.YDIF=([\d.]+)/g).slice(1);
  const motion = diffs.length ? round(diffs.reduce((a, b) => a + b, 0) / diffs.length) : null;
  const cuts = numbers(log, /Parsed_showinfo[^\n]*pts_time:([\d.]+)/g)
    .filter((t) => t > 0.1)
    .map((t) => round(t));
  const freezes = numbers(log, /freeze_duration:\s*([\d.]+)/g);
  const black = numbers(log, /black_duration:([\d.]+)/g).reduce((a, b) => a + b, 0);
  const frozenTotal = freezes.reduce((a, b) => a + b, 0);
  let silent: number | null = null;
  if (opts.hasAudio) {
    silent = numbers(log, /silence_duration:\s*([\d.]+)/g).reduce((a, b) => a + b, 0);
    // Silence that runs to the end has a start and no end.
    const starts = numbers(log, /silence_start:\s*(-?[\d.]+)/g);
    const ends = numbers(log, /silence_end:\s*([\d.]+)/g);
    if (starts.length > ends.length && opts.seconds !== null) silent += Math.max(0, opts.seconds - starts.at(-1)!);
    silent = round(silent);
  }
  const loudnessMatch = /^\s*I:\s+(-?[\d.]+) LUFS/m.exec(log.slice(log.lastIndexOf('Summary:') >= 0 ? log.lastIndexOf('Summary:') : 0));
  const loudness = opts.hasAudio && loudnessMatch ? round(Number(loudnessMatch[1]), 1) : null;

  const frozenSeconds = round(Math.max(0, frozenTotal - black));
  const blackSeconds = round(black);
  const issues: string[] = [];
  if (frozenSeconds >= 0.5) issues.push(`Freezes for ${frozenSeconds.toFixed(1)} s`);
  if (blackSeconds >= 0.3) issues.push(`Black for ${blackSeconds.toFixed(1)} s`);
  if (motion !== null && motion < 0.3) issues.push('Barely moves');
  if (opts.soundRequested) {
    if (!opts.hasAudio) issues.push('No audio track');
    else if ((loudness !== null && loudness < -50) || (opts.seconds && silent !== null && silent >= opts.seconds * 0.8))
      issues.push('Silent');
  }
  return {
    motion,
    cuts,
    frozenSeconds,
    longestFreeze: round(freezes.length ? Math.max(...freezes) : 0),
    blackSeconds,
    silentSeconds: silent,
    loudness,
    issues,
  };
}

/** Six evenly spaced frames tiled side by side, for scanning a render without playing it. */
export function stripArgs(path: string, seconds: number | null, out: string, frames = 6) {
  const span = Math.max(0.5, seconds ?? 5);
  return ['-y', '-v', 'error', '-i', path, '-vf', `fps=${frames}/${span},scale=240:-2,tile=${frames}x1`, '-frames:v', '1', '-q:v', '4', out];
}

/** The same evenly spaced frames as separate JPEGs, for the AI judge. */
export function frameArgs(path: string, seconds: number | null, pattern: string, frames = 6) {
  const span = Math.max(0.5, seconds ?? 5);
  return ['-y', '-v', 'error', '-i', path, '-vf', `fps=${frames}/${span},scale=512:-2`, '-frames:v', String(frames), '-q:v', '4', pattern];
}
