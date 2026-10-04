// Fails if anything about to be committed looks like a real key. Run before every push:
//   npm run check:secrets
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);
const PATTERNS = [
  ['fal key', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}\b/i],
  ['OpenAI key', /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/],
  ['key assignment', /^(FAL_KEY|HIGGSFIELD_KEY|HF_CREDENTIALS|HF_KEY|OPENAI_API_KEY)=(?!your-)\S+/m],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
const problems = [];
for (const file of files) {
  if (/(^|\/)\.env(\.|$)/.test(file) && file !== '.env.example')
    problems.push(`${file}: env files must not be committed`);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const [name, re] of PATTERNS) if (re.test(text)) problems.push(`${file}: looks like a ${name}`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`No secrets found in ${files.length} files.`);
