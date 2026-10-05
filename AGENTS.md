# Setting up GenMedia Benchmark (for AI coding agents)

If someone gives you this repository's URL and asks you to set it up or run it, do this.

## Set it up

1. Clone it if it is not already here: `git clone https://github.com/ZakKrevitt/GenMediaBenchmark.git && cd GenMediaBenchmark`
2. Check Node.js is 22.12 or newer (`node -v`). If it is older, tell the person how to update it and stop.
3. Check ffmpeg (`ffmpeg -version` and `ffprobe -version`). If either is missing, install it with the platform's package manager (`brew install ffmpeg` on macOS, `sudo apt install ffmpeg` on Debian or Ubuntu, `winget install ffmpeg` on Windows) or tell the person the command if you cannot.
4. `npm install`
5. Start the app with `npm run dev` as a long-running background process. It serves http://localhost:3200.
6. Tell the person to open http://localhost:3200. A setup screen asks for their provider keys, checks each one with the provider for free, and saves it. Links to every key page are on that screen:
   - fal: https://fal.ai/dashboard/keys
   - Higgsfield: https://cloud.higgsfield.ai/api-keys (pasted as `KEY_ID:KEY_SECRET`)
   - OpenRouter: https://openrouter.ai/settings/keys
   - Replicate: https://replicate.com/account/api-tokens
   One provider is enough. The AI judge (an OpenAI key plus a model that accepts images) and the daily spend limit are optional.
7. When they say they are done, run `npm run setup -- --check`. It reports what works without printing any key. Exit code 0 means ready.

## Keys

- Prefer the setup screen (or `npm run setup` in the person's own terminal) so keys never pass through this conversation.
- If the person pastes a key to you anyway, write it to `.env.local` as `FAL_KEY=...`, `HIGGSFIELD_KEY=...`, `OPENROUTER_API_KEY=...`, `REPLICATE_API_TOKEN=...`, `OPENAI_API_KEY=...`, `LLM_MODEL=...` or `DAILY_LIMIT_USD=...`, never echo it back, then run `npm run setup -- --check`.
- Never commit `.env.local` or `.data/`, never put a key in a command you show the person, and run `npm run check:secrets` before any commit or push.

## Spending

Running a benchmark spends money on the person's fal, Higgsfield, OpenRouter and Replicate accounts. Listing and pricing models is free. Do not start a benchmark, a retry or the AI judge unless the person asks for that run.

## Working on the code

- `npm run check` runs unit tests, typecheck, lint and build. `npm run test:integration` runs everything end to end against fake providers with real ffmpeg, without keys or cost.
- The database is embedded Postgres (PGlite) in `.data/db`, opened by one process. Stop `npm run dev` before running scripts that open the same `DATA_DIR`.
- Schema changes go in `src/lib/migrations.ts` as a new entry; never edit an applied one.
