# GenMedia Benchmark

Run one prompt across many fal, Higgsfield, OpenRouter and Replicate video models at once, then compare the results side by side: how they look, how long they took, what they cost, and how they score.

It runs on your machine with your own provider keys. There are no accounts, no hosted service and no database to install.

![Results: the same prompt on four models, with timing, cost, output and a filmstrip for each](docs/results.webp)

![Model picker: every fal and Higgsfield video model, snapped to your settings and priced](docs/models.webp)

## What it does

- **Every model, one prompt.** Lists every active text-to-video (or image-to-video) model on fal, Higgsfield, OpenRouter and Replicate, so the same model can be compared across providers on price and speed. Tuned models use hand-written request builders; every other model is driven from its published parameters, with your settings snapped to what each model accepts.
- **Priced before you spend.** fal models are priced from fal's pricing API (or its historical average), Higgsfield models from Higgsfield's free per-request quote, OpenRouter models from the price list it publishes per model, and Replicate models from the billing table on each model's page. A daily spend limit stops a run that would go over.
- **Real timing and cost.** fal and Replicate report their own queue and generation times; fal (admin key) and OpenRouter report what they actually charged. Replicate reports no bill, so its cost is computed from its published rates and marked *est.*
- **Objective checks.** ffmpeg measures motion, hard cuts, freezes, black frames, silence and loudness on every render, plus a six-frame filmstrip.
- **Same length, same footing.** With Exact length on (the default), only models that can render exactly the duration you chose take part, so their costs compare directly.
- **Judging.** Rate and annotate renders, pick a winner, vote blind in the Arena, or let an optional AI judge score frames blind.
- **Suites and takes.** Run up to eight prompts in one go, or several takes per model to see how much a model varies. Five standard suites are built in.
- **Leaderboard.** Every model across every benchmark: reliability, median speed, cost per output second, ratings, arena rating, judge score and issue rate, each with the count behind it. Export to CSV, copy any request as cURL.

### How models are ranked

- **Arena** is a Bradley-Terry rating fitted to every blind vote at once (as LMArena does), so the order votes were cast in does not matter. 1000 is average. Its 95% range comes from resampling whole prompts, since votes on one prompt are correlated, and is only shown once a model's votes span three prompts.
- **Your star ratings** rank by an average pulled toward everyone's average until a model has several ratings, so one 5-star render cannot outrank twenty that average 4.6.
- **Compare like with like.** Every render records the settings it actually ran with (length, resolution, frame). Filter the leaderboard to one of these, and turn on *Common prompts only* to rank each model only on prompts every model finished. Models that ran at more than one setting are flagged.
- **Cost** is the provider's bill where it arrived (fal with an admin key) and an estimate otherwise, marked *est.* Cost per output second is total cost over total seconds.
- **The AI judge** sees six still frames and no sound, so its motion score is a weak signal and labelled that way.

## Requirements

- Node.js 22.12 or newer
- ffmpeg and ffprobe on your `PATH` (`brew install ffmpeg`, `apt install ffmpeg`, or [ffmpeg.org](https://ffmpeg.org/download.html))
- A key for at least one of [fal](https://fal.ai/dashboard/keys), [Higgsfield](https://cloud.higgsfield.ai/api-keys), [OpenRouter](https://openrouter.ai/settings/keys) and [Replicate](https://replicate.com/account/api-tokens)

## Quick start with Claude Code or Codex

Paste this into Claude Code, Codex or another coding agent:

> Set up https://github.com/ZakKrevitt/GenMediaBenchmark and run it

The agent follows [AGENTS.md](AGENTS.md): it installs everything, starts the app and sends you to a setup screen in your browser, where you paste your own keys. Your keys go straight into a local file and never through the chat.

## Setup by hand

```bash
git clone https://github.com/ZakKrevitt/GenMediaBenchmark.git
cd GenMediaBenchmark
npm install
npm run dev
```

Open [http://localhost:3200](http://localhost:3200). The first time, a setup screen checks Node and ffmpeg, then asks for your keys. Each key is checked with its provider for free and saved to `.env.local`.

Prefer the terminal? `npm run setup` walks through the same steps with hidden input, and `npm run setup -- --check` reports what works without printing any key. You can also copy `.env.example` to `.env.local` and fill it in yourself.

One provider is enough; models from a provider without a key are hidden. Change keys or the daily limit later with **Keys and limit** at the top of the page.

### Optional: AI judge

Add an OpenAI key and a model that accepts images in setup (or set `OPENAI_API_KEY` and `LLM_MODEL`) to enable the **AI judge** button. Each judged render reserves `JUDGE_CENTS` (default 5) against the daily limit. Set `JUDGE_USD_PER_MTOK_IN` and `JUDGE_USD_PER_MTOK_OUT` to your model's price per million tokens and each render is charged what its tokens actually cost instead.

### Daily limit

`DAILY_LIMIT_USD` resets at midnight on the computer running the app. A render that fails costs nothing, unless the provider reports billing it anyway.

### Provider notes

- **OpenRouter** lists its video models publicly, so they show up even before you add a key. It has no cancel endpoint, so a queued OpenRouter render runs to the end. Start images are sent inline.
- **Replicate** needs a token even to list models. Models billed by GPU time are estimated from Replicate's typical run and then costed from the run's actual time. Start images are shrunk to Replicate's 256 KB inline limit.

### fal billing

fal only returns billed cost to admin-scoped keys. With an ordinary key, renders keep their estimated price, and timing is still read from fal.

## Your keys stay yours

- Keys live in `.env.local` only (created owner-readable, and gitignored). They are never stored in the database, and the app never sends them back to the browser, not even to the setup screen.
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
npm run test:integration  # end to end with fake fal, Higgsfield, OpenRouter and Replicate, real ffmpeg, no keys or money
npm run check             # tests, typecheck, lint and build
```

## License

MIT, see [LICENSE](LICENSE). The UI building blocks in `src/components/arc` are free components from [Arc](https://uiarc.dev), also MIT, with their notice in [src/components/arc/LICENSE](src/components/arc/LICENSE).
