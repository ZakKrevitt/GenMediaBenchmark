// Terminal setup wizard: checks this computer, asks for your keys (input is hidden), checks each
// key with its provider for free and saves it to .env.local.
//
//   npm run setup            interactive
//   npm run setup -- --check report what is set up and test saved keys; prints no key values
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { ENV_FILE, setupStatus, verifyKey, verifyOpenAi, writeEnv } from '../src/lib/env-file';

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const tty = process.stdin.isTTY && process.stdout.isTTY;
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const ok = (s: string) => console.log(`  ${tty ? '\x1b[32m✓\x1b[0m' : 'ok'} ${s}`);
const no = (s: string) => console.log(`  ${tty ? '\x1b[31m✗\x1b[0m' : 'missing'} ${s}`);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function ask(question: string, hidden = false) {
  return new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Echo nothing while a key is typed or pasted.
      const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
        if (s.startsWith(question)) write.call(rl, question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function environment() {
  const s = await setupStatus();
  console.log(bold('\nThis computer'));
  (s.nodeOk ? ok : no)(`Node.js ${s.node}${s.nodeOk ? '' : ' (22.12 or newer is needed)'}`);
  if (s.ffmpeg) ok('ffmpeg and ffprobe');
  else
    no(
      'ffmpeg and ffprobe not found. Install with `brew install ffmpeg` (macOS), `sudo apt install ffmpeg` (Linux) or `winget install ffmpeg` (Windows).',
    );
  return s;
}

async function check() {
  const s = await environment();
  console.log(bold('\nKeys in .env.local'));
  let working = 0;
  const names = { fal: 'fal', higgsfield: 'Higgsfield', openrouter: 'OpenRouter', replicate: 'Replicate' } as const;
  for (const [provider, set, value] of [
    ['fal', s.fal, process.env.FAL_KEY],
    ['higgsfield', s.higgsfield, process.env.HIGGSFIELD_KEY || process.env.HF_CREDENTIALS || process.env.HF_KEY],
    ['openrouter', s.openrouter, process.env.OPENROUTER_API_KEY],
    ['replicate', s.replicate, process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY],
  ] as const) {
    const name = names[provider];
    if (!set || !value) {
      no(`${name}: not set`);
      continue;
    }
    try {
      const { warning } = await verifyKey(provider, value);
      ok(`${name}: key works${warning ? `. ${warning}` : ''}`);
      working++;
    } catch (e) {
      no(`${name}: ${message(e)}`);
    }
  }
  if (s.judge) {
    try {
      await verifyOpenAi(process.env.OPENAI_API_KEY!, process.env.LLM_MODEL!);
      ok(`AI judge: ${s.llmModel}`);
    } catch (e) {
      no(`AI judge: ${message(e)}`);
    }
  } else console.log('  - AI judge: off (optional)');
  console.log(`  - Daily limit: $${s.dailyLimitUsd}`);
  const ready = working > 0 && s.ffmpeg && s.nodeOk;
  console.log(
    ready
      ? '\nReady. Start it with `npm run dev` and open http://localhost:3200'
      : '\nNot ready yet. Run `npm run setup`, or start `npm run dev` and use the setup screen at http://localhost:3200',
  );
  process.exit(ready ? 0 : 1);
}

async function wizard() {
  if (!tty) {
    console.log(
      'The setup wizard needs an interactive terminal. Start `npm run dev` and open http://localhost:3200 to set up in the browser, or run `npm run setup -- --check`.',
    );
    process.exit(1);
  }
  console.log(bold('GenMedia Benchmark setup'));
  console.log('Keys are checked with each provider (nothing is billed) and saved to .env.local, which git ignores.');
  const s = await environment();

  const provider = async (
    id: 'fal' | 'higgsfield' | 'openrouter' | 'replicate',
    name: string,
    url: string,
    envName: 'FAL_KEY' | 'HIGGSFIELD_KEY' | 'OPENROUTER_API_KEY' | 'REPLICATE_API_TOKEN',
    saved: boolean,
  ) => {
    console.log(bold(`\n${name}`) + ` (get a key at ${url})`);
    for (;;) {
      const key = await ask(saved ? '  Paste a new key, or press Enter to keep the saved one: ' : '  Paste your key, or press Enter to skip: ', true);
      if (!key) return;
      try {
        const { warning } = await verifyKey(id, key);
        await writeEnv({ [envName]: key });
        ok(`Saved${warning ? `. ${warning}` : ''}`);
        return;
      } catch (e) {
        no(message(e));
      }
    }
  };
  await provider('fal', 'fal', 'https://fal.ai/dashboard/keys', 'FAL_KEY', s.fal);
  await provider('higgsfield', 'Higgsfield', 'https://cloud.higgsfield.ai/api-keys, pasted as KEY_ID:KEY_SECRET', 'HIGGSFIELD_KEY', s.higgsfield);
  await provider('openrouter', 'OpenRouter', 'https://openrouter.ai/settings/keys', 'OPENROUTER_API_KEY', s.openrouter);
  await provider('replicate', 'Replicate', 'https://replicate.com/account/api-tokens', 'REPLICATE_API_TOKEN', s.replicate);

  console.log(bold('\nAI judge') + ' (optional: an OpenAI model that accepts images scores finished renders)');
  const openai = await ask(s.judge ? '  Paste a new OpenAI key, or press Enter to keep the saved one: ' : '  Paste an OpenAI key, or press Enter to skip: ', true);
  if (openai) {
    for (;;) {
      const model = await ask(`  Model name${s.llmModel ? ` [${s.llmModel}]` : ''}: `) || s.llmModel || '';
      try {
        await verifyOpenAi(openai, model);
        await writeEnv({ OPENAI_API_KEY: openai, LLM_MODEL: model });
        ok('Saved');
        break;
      } catch (e) {
        no(message(e));
        if (!(await ask('  Try another model? [Y/n] ')).toLowerCase().startsWith('n')) continue;
        break;
      }
    }
  }

  console.log(bold('\nDaily spend limit'));
  for (;;) {
    const limit = await ask(`  US dollars per day [${s.dailyLimitUsd}]: `);
    if (!limit) break;
    if (Number.isFinite(Number(limit)) && Number(limit) >= 0) {
      await writeEnv({ DAILY_LIMIT_USD: String(Number(limit)) });
      ok('Saved');
      break;
    }
    no('Enter a number of dollars');
  }

  const after = await setupStatus();
  if (!after.fal && !after.higgsfield && !after.openrouter && !after.replicate) {
    console.log('\nNo provider key saved yet. You can add one later with `npm run setup` or in the app.');
    process.exit(1);
  }
  console.log('\nDone. Start it with `npm run dev` and open http://localhost:3200');
}

await (process.argv.includes('--check') ? check() : wizard());
