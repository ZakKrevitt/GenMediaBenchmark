'use client';

import { useEffect, useState } from 'react';
import { Check, CircleAlert, ExternalLink, KeyRound, X } from 'lucide-react';
import { ProgressRing } from './progress-ring/progress-ring';
import type { SetupStatus } from '@/lib/env-file';
import styles from './setup.module.css';

type Saved = SetupStatus & { warnings?: string[] };

async function api<T>(init?: RequestInit) {
  const res = await fetch('/api/setup', {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? 'Setup failed');
  return data as T;
}

/** Loads setup status and shows the wizard on first run, or the app once a provider is connected. */
export function SetupGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api<SetupStatus>()
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error)
    return (
      <p className={styles.error} role="alert">
        <CircleAlert size={16} aria-hidden="true" /> {error}
      </p>
    );
  if (!status)
    return (
      <div className="loading-panel" role="status">
        <ProgressRing label="Loading" /> Checking setup
      </div>
    );
  const firstRun = !status.fal && !status.higgsfield && !status.openrouter && !status.replicate;
  return (
    <>
      <div className={styles.keysBar}>
        <span>
          <Dot on={status.fal} /> fal
        </span>
        <span>
          <Dot on={status.higgsfield} /> Higgsfield
        </span>
        <span>
          <Dot on={status.openrouter} /> OpenRouter
        </span>
        <span>
          <Dot on={status.replicate} /> Replicate
        </span>
        <span>
          <Dot on={status.judge} /> AI judge
        </span>
        {!firstRun && (
          <button className="text-button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <KeyRound size={14} /> {open ? 'Close keys' : 'Keys and limit'}
          </button>
        )}
      </div>
      {(firstRun || open) && (
        <Wizard
          status={status}
          firstRun={firstRun}
          onClose={firstRun ? undefined : () => setOpen(false)}
          onSaved={() => window.location.reload()}
        />
      )}
      {!firstRun && children}
    </>
  );
}

const Dot = ({ on }: { on: boolean }) => (
  <i className={on ? styles.on : styles.off} aria-label={on ? 'connected' : 'not connected'} />
);

function Wizard({
  status,
  firstRun,
  onClose,
  onSaved,
}: {
  status: SetupStatus;
  firstRun: boolean;
  onClose?: () => void;
  onSaved: () => void;
}) {
  const [fal, setFal] = useState('');
  const [hf, setHf] = useState('');
  const [or, setOr] = useState('');
  const [rep, setRep] = useState('');
  const [openai, setOpenai] = useState('');
  const [model, setModel] = useState(status.llmModel ?? '');
  const [limit, setLimit] = useState(String(status.dailyLimitUsd));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);

  const nothing =
    !fal.trim() &&
    !hf.trim() &&
    !or.trim() &&
    !rep.trim() &&
    !openai.trim() &&
    model.trim() === (status.llmModel ?? '') &&
    Number(limit) === status.dailyLimitUsd;
  const limitOk = limit.trim() !== '' && Number(limit) >= 0;
  // The judge needs both a key and a model; one alone cannot be checked.
  const judgeIncomplete = Boolean(openai.trim()) !== Boolean(model.trim()) && !status.judge;
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const saved = await api<Saved>({
        method: 'POST',
        body: JSON.stringify({
          falKey: fal.trim() || undefined,
          higgsfieldKey: hf.trim() || undefined,
          openrouterKey: or.trim() || undefined,
          replicateKey: rep.trim() || undefined,
          openaiKey: openai.trim() || undefined,
          llmModel: model.trim() && model.trim() !== status.llmModel ? model.trim() : undefined,
          dailyLimitUsd: Number(limit) !== status.dailyLimitUsd ? Number(limit) : undefined,
        }),
      });
      if (saved.warnings?.length) {
        setWarnings(saved.warnings);
        setFal('');
        setHf('');
        setOr('');
        setRep('');
        setOpenai('');
      } else onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Setup failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`panel ${styles.wizard}`} aria-labelledby="setup-title">
      <div className="panel-heading">
        <div>
          <h2 id="setup-title">{firstRun ? 'Set up the benchmark' : 'Keys and limit'}</h2>
          <p>
            Add a key for any of fal, Higgsfield, OpenRouter and Replicate; one is enough to start.
            Each key is checked with the provider (nothing is billed) and saved to{' '}
            <code>.env.local</code> on this computer. It never leaves your machine except to call
            that provider.
          </p>
        </div>
        {onClose && (
          <button className="text-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        )}
      </div>

      <ol className={styles.steps}>
        <li>
          <h3>Check this computer</h3>
          <ul className={styles.checks}>
            <li>
              <Mark ok={status.nodeOk} /> Node.js {status.node}
              {!status.nodeOk && <span> · version 22.12 or newer is needed</span>}
            </li>
            <li>
              <Mark ok={status.ffmpeg} /> ffmpeg and ffprobe
              {!status.ffmpeg && (
                <span>
                  {' '}
                  · not found. Install with <code>brew install ffmpeg</code> (macOS),{' '}
                  <code>sudo apt install ffmpeg</code> (Linux) or <code>winget install ffmpeg</code>{' '}
                  (Windows), then restart the server. Renders need it for previews and checks.
                </span>
              )}
            </li>
          </ul>
        </li>

        <li>
          <h3>Connect your providers</h3>
          <label className={styles.field}>
            <span>
              fal key {status.fal && <em className={styles.saved}>Saved</em>}
              <a href="https://fal.ai/dashboard/keys" target="_blank" rel="noreferrer">
                Get a key <ExternalLink size={12} />
              </a>
            </span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={status.fal ? 'Paste a new key to replace it' : 'Paste your fal key'}
              value={fal}
              onChange={(e) => setFal(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>
              Higgsfield key {status.higgsfield && <em className={styles.saved}>Saved</em>}
              <a href="https://cloud.higgsfield.ai/api-keys" target="_blank" rel="noreferrer">
                Get a key <ExternalLink size={12} />
              </a>
            </span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={status.higgsfield ? 'Paste a new key to replace it' : 'KEY_ID:KEY_SECRET'}
              value={hf}
              onChange={(e) => setHf(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>
              OpenRouter key {status.openrouter && <em className={styles.saved}>Saved</em>}
              <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">
                Get a key <ExternalLink size={12} />
              </a>
            </span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={status.openrouter ? 'Paste a new key to replace it' : 'sk-or-…'}
              value={or}
              onChange={(e) => setOr(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>
              Replicate token {status.replicate && <em className={styles.saved}>Saved</em>}
              <a href="https://replicate.com/account/api-tokens" target="_blank" rel="noreferrer">
                Get a token <ExternalLink size={12} />
              </a>
            </span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={status.replicate ? 'Paste a new token to replace it' : 'r8_…'}
              value={rep}
              onChange={(e) => setRep(e.target.value)}
            />
          </label>
        </li>

        <li>
          <h3>
            AI judge <small>Optional</small>
          </h3>
          <p className={styles.hint}>
            Scores finished renders from sampled frames with an OpenAI model that accepts images.
            Each scored render reserves 5¢ of the daily limit.
          </p>
          <div className={styles.pair}>
            <label className={styles.field}>
              <span>
                OpenAI key {status.judge && <em className={styles.saved}>Saved</em>}
              </span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={status.judge ? 'Paste a new key to replace it' : 'sk-…'}
                value={openai}
                onChange={(e) => setOpenai(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span>Model</span>
              <input
                spellCheck={false}
                placeholder="Model name"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </label>
          </div>
        </li>

        <li>
          <h3>Daily spend limit</h3>
          <label className={`${styles.field} ${styles.limit}`}>
            <span>US dollars per day across all renders</span>
            <input
              inputMode="decimal"
              value={limit}
              onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, '').slice(0, 7))}
            />
          </label>
        </li>
      </ol>

      {error && (
        <p className={styles.error} role="alert">
          <CircleAlert size={16} aria-hidden="true" /> {error}
        </p>
      )}
      {warnings.map((w) => (
        <p key={w} className={styles.warning} role="status">
          <CircleAlert size={16} aria-hidden="true" /> Saved. {w}
        </p>
      ))}
      <div className={styles.footer}>
        {warnings.length > 0 ? (
          <button className="primary" onClick={onSaved}>
            Continue
          </button>
        ) : (
          <button
            className="primary"
            disabled={busy || nothing || !limitOk || judgeIncomplete}
            onClick={() => void save()}
          >
            {busy ? <ProgressRing size="sm" label="Checking" /> : <Check size={16} />}
            {busy ? 'Checking keys' : firstRun ? 'Check and save' : 'Save'}
          </button>
        )}
      </div>
    </section>
  );
}

const Mark = ({ ok }: { ok: boolean }) =>
  ok ? (
    <Check size={14} className={styles.ok} aria-label="ok" />
  ) : (
    <X size={14} className={styles.bad} aria-label="missing" />
  );
