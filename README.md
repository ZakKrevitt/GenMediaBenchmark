# GenMedia Benchmark

Run one prompt across many fal and Higgsfield video models at once, then compare the results side by side: how they look, how long they took, what they cost, and how they score.

It runs on your machine with your own provider keys. There are no accounts, no hosted service and no database to install.

## What it does

- **Every model, one prompt.** Lists every active text-to-video (or image-to-video) model on fal and Higgsfield. Tuned models use hand-written request builders; every other model is driven from its published parameters, with your settings snapped to what each model accepts.
- **Priced before you spend.** fal models are priced from fal's pricing API (or its historical average), Higgsfield models from Higgsfield's free per-request quote. A daily spend limit stops a run that would go over.
- **Real timing and cost.** Queue time, generation time and, for fal, the billed cost are read back from the provider after each render.
- **Objective checks.** ffmpeg measures motion, hard cuts, freezes, black frames, silence and loudness on every render, plus a six-frame filmstrip.
- **Judging.** Rate and annotate renders, pick a winner, vote blind in the Arena (turned into Elo with confidence intervals), or let an optional AI judge score frames blind.
- **Suites and takes.** Run up to eight prompts in one go, or several takes per model to see how much a model varies. Five standard suites are built in.
- **Leaderboard.** Every model across every benchmark: reliability, median speed, cost per output second, ratings, Elo, judge score and issue rate. Export to CSV, copy any request as cURL.

## Requirements

- Node.js 22.12 or newer
- ffmpeg and ffprobe on your `PATH` (`brew install ffmpeg`, `apt install ffmpeg`, or [ffmpeg.org](https://ffmpeg.org/download.html))
- A [fal](https://fal.ai/dashboard/keys) key, a [Higgsfield](https://cloud.higgsfield.ai/api-keys) key, or both

## Setup

```bash
git clone https://github.com/ZakKrevitt/GenMediaBenchmark.git
cd GenMediaBenchmark
npm install
cp .env.example .env.local
```

Open `.env.local` and add your keys:

```bash
FAL_KEY=your-fal-key
HIGGSFIELD_KEY=your-key-id:your-key-secret
DAILY_LIMIT_USD=20
```

Then start it:

```bash
npm run dev
```

and open [http://localhost:3200](http://localhost:3200).

A provider without a key is hidden from the model list. Restart the server after changing `.env.local`.

### Optional: AI judge

Set `OPENAI_API_KEY` and `LLM_MODEL` (any OpenAI model that accepts images) to enable the **AI judge** button. Each judged render reserves `JUDGE_CENTS` (default 5) against the daily limit.

### fal billing

fal only returns billed cost to admin-scoped keys. With an ordinary key, renders keep their estimated price, and timing is still read from fal.

## Your keys stay yours

- Keys are read from `.env.local` only. They are never stored in the database or sent to the browser, and `.env*` files are gitignored.
- The server only answers requests made to `localhost` and only accepts changes from its own page, so other websites cannot drive it.
- Everything you generate (database and videos) lives in `.data/`, also gitignored. Delete it to start over.
- `npm run check:secrets` scans the repository for anything that looks like a key. Run it before you push a fork.

## How it works

A Next.js app with an embedded Postgres ([PGlite](https://pglite.dev)) stored in `.data/db`. Each render is recorded before the provider is called, so a repeated click never pays twice. A background loop inside the server polls providers, downloads finished videos, runs the ffmpeg checks and the judge, and reconciles fal's timing and billing.

| Path | What it holds |
| --- | --- |
| `src/services/benchmark.ts` | Model listing, pricing, launching, leaderboard |
| `src/services/renders.ts` | Polling, download, probe, start images |
| `src/services/benchmark-judge.ts` | Optional AI judge |
| `src/lib/fal-schema.ts` | Turns a model's published parameters into a request |
| `src/lib/production-models.ts` | Tuned request builders and prices for well-known models |
| `src/media/video-analysis.ts` | ffmpeg checks |
| `src/components/benchmark.tsx` | The page |

## Tests

```bash
npm test                  # unit tests
npm run test:integration  # end to end with fake fal and Higgsfield, real ffmpeg, no keys or money
npm run check             # tests, typecheck, lint and build
```

## License

MIT
