import { execFile } from 'node:child_process';

// Runs ffmpeg or ffprobe with fixed arguments (never a shell).
export function runMedia(bin: 'ffmpeg' | 'ffprobe', args: string[], timeoutMs = 120_000) {
  return new Promise<{ stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
    execFile(
      process.env[bin === 'ffmpeg' ? 'FFMPEG_BIN' : 'FFPROBE_BIN'] || bin,
      args,
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(`${bin} failed: ${stderr.toString().slice(-400) || error.message}`))
          : resolve({ stdout, stderr }),
    );
  });
}
