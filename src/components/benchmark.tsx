'use client';

import { ProgressRing } from './progress-ring/progress-ring';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleAlert,
  Download,
  Code2,
  Columns2,
  Copy,
  Eye,
  EyeOff,
  FileDown,
  Gavel,
  Pause,
  SkipBack,
  SkipForward,
  Swords,
  X,
  ImagePlus,
  CircleStop,
  Play,
  Plus,
  RotateCcw,
  Star,
  Trophy,
} from 'lucide-react';
import type { BenchModel, BenchRunSettings, BenchShot, LeaderRow } from '@/services/benchmark';
import { downsize } from '@/lib/downsize';
import { frontier } from '@/lib/frontier';
import { STANDARD_SUITES } from '@/lib/benchmark-suites';
import styles from './benchmark.module.css';

// One prompt across many fal video models. Pick models, run, then compare the renders in a grid
// with their speed, cost and what each model actually delivered. Ratings and picks feed a
// leaderboard across every benchmark.

type Bench = {
  id: string;
  prompt: string;
  settings: BenchRunSettings;
  winnerShotId: string | null;
  createdAt: string;
  suiteId: string | null;
  suiteName: string | null;
  shots: BenchShot[];
  votes: { left: string; right: string; outcome: Outcome }[];
};
type Outcome = 'left' | 'right' | 'tie' | 'both_bad';
type State = {
  benchmarks: Bench[];
  leaderboard: LeaderRow[];
  spentTodayCents: number;
  dailyCapCents: number;
  judgeCentsEach: number;
  judgeReady: boolean;
};

type Provider = BenchModel['provider'];
const PROVIDER_NAME: Record<Provider, string> = { fal: 'fal', higgsfield: 'Higgsfield' };

const ASPECTS = ['9:16', '16:9', '1:1', '3:4', '21:9'] as const;
const RESOLUTIONS = ['480p', '720p', '1080p'] as const;
const DURATIONS = [4, 5, 6, 8, 10, 15] as const;
const SORTS = [
  { id: 'order', label: 'Run order' },
  { id: 'fastest', label: 'Fastest' },
  { id: 'cheapest', label: 'Cheapest' },
  { id: 'rating', label: 'Rating' },
  { id: 'judge', label: 'Judge' },
] as const;
type Sort = (typeof SORTS)[number]['id'];

const money = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? '–' : `$${(cents / 100).toFixed(2)}`;
const secs = (s: number | null | undefined) =>
  s === null || s === undefined
    ? '–'
    : s >= 90
      ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
      : `${s.toFixed(s < 10 ? 1 : 0)}s`;
const newKey = () => crypto.randomUUID();
const running = (s: BenchShot) => ['SUBMITTING', 'RUNNING', 'DOWNLOADING'].includes(s.state);
const costOf = (s: BenchShot) => s.billedCents ?? s.estimatedCents;
const motionWord = (m: number | null) =>
  m === null
    ? 'Unknown'
    : m < 0.3
      ? 'No'
      : m < 1.5
        ? 'Low'
        : m < 5
          ? 'Steady'
          : m < 12
            ? 'High'
            : 'Very high';
const settingsQuery = (s: BenchRunSettings) =>
  new URLSearchParams({
    duration: String(s.duration),
    aspectRatio: s.aspectRatio,
    resolution: s.resolution,
    audio: String(s.audio),
    ...(s.seed !== null ? { seed: String(s.seed) } : {}),
    ...(s.firstFrameId ? { firstFrameId: s.firstFrameId } : {}),
    exactDuration: String(s.exactDuration),
  });
const usedLabel = (u: BenchModel['used'] | null) =>
  u
    ? [
        u.duration !== null ? `${u.duration} s` : null,
        u.resolution,
        // Models without a frame option render their own default frame.
        u.aspectRatio ?? 'own frame',
        u.audio === null ? null : u.audio ? 'sound' : 'silent',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    cache: 'no-store',
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? `Request failed (${res.status})`);
  return body as T;
}

export function Benchmark({ active }: { active: boolean }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [settings, setSettings] = useState<BenchRunSettings>({
    duration: 5,
    aspectRatio: '9:16',
    resolution: '720p',
    audio: true,
    seed: null,
    firstFrameId: null,
    takes: 1,
    exactDuration: true,
  });
  const [extraPrompts, setExtraPrompts] = useState<string[]>([]);
  const [suiteName, setSuiteName] = useState('');
  const [suite, setSuite] = useState<string | null>(null);
  const prompts = [prompt, ...extraPrompts].map((p) => p.trim()).filter((p) => p.length >= 3);
  const [uploading, setUploading] = useState(false);
  const [imageMode, setImageMode] = useState(false);
  const switchMode = (next: boolean) => {
    setImageMode(next);
    // Text and image endpoints differ, so the default selection is rebuilt for the new mode.
    setChosen(null);
    setModels(null);
    if (!next) setSettings((s) => ({ ...s, firstFrameId: null }));
  };
  const uploadFrame = async (file: File) => {
    setUploading(true);
    setRunError('');
    try {
      const form = new FormData();
      form.set('image', await downsize(file), 'frame.jpg');
      const res = await fetch('/api/start-images', { method: 'POST', body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message ?? 'Upload failed');
      setChosen(null);
      setModels(null);
      setSettings((s) => ({ ...s, firstFrameId: body.id }));
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };
  const [models, setModels] = useState<BenchModel[] | null>(null);
  const [modelsError, setModelsError] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [filter, setFilter] = useState('');
  const [newOnly, setNewOnly] = useState(false);
  const [provider, setProvider] = useState<'all' | Provider>('all');
  const [connected, setConnected] = useState<Record<Provider, boolean>>({
    fal: true,
    higgsfield: true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [runError, setRunError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const runKey = useRef(newKey());
  // Started from this page, so its finish is worth a notification.
  const launched = useRef(false);
  const wasRendering = useRef(0);
  const baseTitle = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api<State>(`/api/benchmarks${suite ? `?suite=${suite}` : ''}`));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load benchmarks');
    }
  }, [suite]);
  const anyRunning =
    state?.benchmarks.some((b) =>
      b.shots.some(
        (s) =>
          running(s) ||
          s.judgeState === 'QUEUED' ||
          s.judgeState === 'RUNNING' ||
          (s.state === 'COMPLETE' && !s.analysis),
      ),
    ) ?? false;
  useEffect(() => {
    if (!active) return;
    const first = setTimeout(() => void load(), 0);
    const id = setInterval(() => !document.hidden && void load(), anyRunning ? 4000 : 30000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [active, load, anyRunning]);

  useEffect(() => {
    if (!active) return;
    // Image mode waits for its start image before listing image-to-video models.
    if (imageMode && !settings.firstFrameId) return;
    const q = settingsQuery(settings);
    let gone = false;
    const id = setTimeout(async () => {
      try {
        const next = await api<{
          models: BenchModel[];
          falConnected: boolean;
          higgsfieldConnected: boolean;
          notes: string[];
        }>(`/api/benchmarks/models?${q}`);
        if (gone) return;
        setNotes(next.notes ?? []);
        const live = { fal: next.falConnected, higgsfield: next.higgsfieldConnected };
        setModels(next.models);
        setConnected(live);
        setModelsError('');
        // Start with the tuned models on every connected provider.
        setChosen(
          (c) =>
            c ??
            new Set(
              next.models
                .filter((m) => m.studioModel && !m.blocker && live[m.provider])
                .map((m) => m.id),
            ),
        );
      } catch (e) {
        if (!gone) setModelsError(e instanceof Error ? e.message : 'Could not list video models');
      }
    }, 250);
    return () => {
      gone = true;
      clearTimeout(id);
    };
  }, [active, settings, imageMode]);

  const runnable = useMemo(
    () => (models ?? []).filter((m) => !m.blocker && connected[m.provider]),
    [models, connected],
  );
  const blocked = useMemo(
    () => (models ?? []).filter((m) => m.blocker && !m.lengthMismatch),
    [models],
  );
  const wrongLength = useMemo(
    () => (models ?? []).filter((m) => m.lengthMismatch && connected[m.provider]),
    [models, connected],
  );
  const offline = (Object.keys(connected) as Provider[]).filter(
    (p) => !connected[p] && (models ?? []).some((m) => m.provider === p),
  );
  const picked = runnable.filter((m) => chosen?.has(m.id));
  const counts = { fal: 0, higgsfield: 0 };
  for (const m of runnable) counts[m.provider]++;
  // Prices do not depend on the prompt, so a suite costs the same per prompt and per take.
  const runs = Math.max(1, prompts.length) * settings.takes;
  const total = picked.reduce((sum, m) => sum + (m.cents ?? 200), 0) * runs;
  const unpriced = picked.filter((m) => m.cents === null).length;
  const renders = picked.length * runs;
  const left = state ? Math.max(0, state.dailyCapCents - state.spentTodayCents) : null;
  const shown = runnable.filter(
    (m) =>
      (provider === 'all' || m.provider === provider) &&
      (!newOnly || m.isNew) &&
      `${m.name} ${m.maker ?? ''} ${m.endpoint} ${PROVIDER_NAME[m.provider]}`
        .toLowerCase()
        .includes(filter.trim().toLowerCase()),
  );
  const toggle = (id: string) =>
    setChosen((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = async () => {
    if (!picked.length || !prompts.length) return;
    if (
      total > 1000 &&
      !window.confirm(
        `Run ${renders} renders for about ${money(total)}? fal and Higgsfield bill this.`,
      )
    )
      return;
    setSubmitting(true);
    setRunError('');
    // Ask once, on the click, so the finish can be announced if the tab is in the background.
    if (typeof Notification !== 'undefined' && Notification.permission === 'default')
      void Notification.requestPermission().catch(() => {});
    try {
      const { id } = await api<{ id: string }>('/api/benchmarks', {
        method: 'POST',
        body: JSON.stringify({
          key: runKey.current,
          prompts,
          suiteName: prompts.length > 1 ? suiteName.trim() || undefined : undefined,
          settings,
          models: picked.map((m) => m.id),
        }),
      });
      runKey.current = newKey();
      launched.current = true;
      setOpenId(id);
      await load();
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'The benchmark did not start');
    } finally {
      setSubmitting(false);
    }
  };

  const again = (b: Bench) => {
    const suiteMates = b.suiteId
      ? (state?.benchmarks ?? [])
          .filter((x) => x.suiteId === b.suiteId)
          .map((x) => x.prompt)
          .reverse()
      : [b.prompt];
    setPrompt(suiteMates[0] ?? b.prompt);
    setExtraPrompts(suiteMates.slice(1));
    setSuiteName(b.suiteName ?? '');
    setSettings({
      ...b.settings,
      firstFrameId: b.settings.firstFrameId ?? null,
      exactDuration: b.settings.exactDuration ?? false,
    });
    setImageMode(Boolean(b.settings.firstFrameId));
    setModels(null);
    setChosen(new Set(b.shots.map((s) => s.modelId)));
    runKey.current = newKey();
    document.getElementById('benchmark-setup')?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (!state) return;
    const rendering = state.benchmarks.flatMap((b) => b.shots).filter(running).length;
    if (baseTitle.current === null) baseTitle.current = document.title;
    document.title =
      active && rendering ? `(${rendering} rendering) ${baseTitle.current}` : baseTitle.current;
    if (wasRendering.current > 0 && rendering === 0 && launched.current) {
      launched.current = false;
      const latest = state.benchmarks[0];
      const done = latest?.shots.filter((x) => x.state === 'COMPLETE').length ?? 0;
      if (
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted' &&
        document.hidden
      )
        new Notification('Benchmark finished', {
          body: `${done} of ${latest?.shots.length ?? 0} renders done${latest ? `: ${latest.prompt.slice(0, 80)}` : ''}`,
          tag: 'genmedia-benchmark',
        });
    }
    wasRendering.current = rendering;
  }, [state, active]);
  useEffect(
    () => () => {
      if (baseTitle.current !== null) document.title = baseTitle.current;
    },
    [],
  );

  const current = state?.benchmarks.find((b) => b.id === openId) ?? state?.benchmarks[0] ?? null;

  return (
    <div className={styles.page}>
      {error && (
        <p className={styles.error} role="alert">
          <CircleAlert size={16} aria-hidden="true" /> {error}
        </p>
      )}

      <section className={`panel ${styles.setup}`} id="benchmark-setup">
        <div className="panel-heading">
          <div>
            <h2>New benchmark</h2>
            <p>
              One prompt, rendered on every model you tick. Each model snaps to its nearest
              supported settings.
            </p>
          </div>
        </div>
        <div className={styles.modeRow}>
          <div role="group" aria-label="Benchmark type" className={styles.segments}>
            <button aria-pressed={!imageMode} onClick={() => switchMode(false)}>
              Text to video
            </button>
            <button aria-pressed={imageMode} onClick={() => switchMode(true)}>
              Image to video
            </button>
          </div>
          {imageMode && (
            <div className={styles.frame0}>
              {settings.firstFrameId ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/start-images/${settings.firstFrameId}`} alt="Start image" />
                  <button
                    className="text-button"
                    onClick={() => {
                      setChosen(null);
                      setModels(null);
                      setSettings((s) => ({ ...s, firstFrameId: null }));
                    }}
                  >
                    Change image
                  </button>
                </>
              ) : (
                <label className={styles.upload}>
                  {uploading ? (
                    <ProgressRing size="sm" label="Loading" />
                  ) : (
                    <ImagePlus size={16} />
                  )}
                  {uploading ? 'Uploading' : 'Choose a start image'}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    hidden
                    disabled={uploading}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void uploadFrame(file);
                      e.target.value = '';
                    }}
                  />
                </label>
              )}
              <span className={styles.hintInline}>
                Every model starts from this image. Its shape sets the frame.
              </span>
            </div>
          )}
        </div>
        <textarea
          className={styles.prompt}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="A DJ in a sunlit warehouse lowers the crossfader as the crowd lifts their hands, handheld camera, 35mm film grain"
          rows={3}
          maxLength={3500}
          aria-label="Prompt"
        />
        {extraPrompts.map((p, i) => (
          <div key={i} className={styles.extraPrompt}>
            <textarea
              className={styles.prompt}
              value={p}
              onChange={(e) =>
                setExtraPrompts((list) => list.map((x, j) => (j === i ? e.target.value : x)))
              }
              placeholder="Another prompt for the same models and settings"
              rows={2}
              maxLength={3500}
              aria-label={`Prompt ${i + 2}`}
            />
            <button
              className="text-button"
              onClick={() => setExtraPrompts((list) => list.filter((_, j) => j !== i))}
              aria-label={`Remove prompt ${i + 2}`}
            >
              <X size={16} />
            </button>
          </div>
        ))}
        <div className={styles.suiteRow}>
          <select
            value=""
            onChange={(e) => {
              const suite = STANDARD_SUITES.find((x) => x.id === e.target.value);
              if (!suite) return;
              setPrompt(suite.prompts[0]);
              setExtraPrompts(suite.prompts.slice(1));
              setSuiteName(suite.name);
            }}
            aria-label="Load a standard suite"
            title="Ready-made prompt sets that each test one weakness of video models"
          >
            <option value="">Load a standard suite</option>
            {STANDARD_SUITES.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} · {x.prompts.length} prompts · {x.tests}
              </option>
            ))}
          </select>
          {extraPrompts.length < 7 && (
            <button className="text-button" onClick={() => setExtraPrompts((l) => [...l, ''])}>
              <Plus size={14} /> Add a prompt
            </button>
          )}
          {extraPrompts.length > 0 && (
            <input
              value={suiteName}
              onChange={(e) => setSuiteName(e.target.value)}
              placeholder="Suite name, like DJ booth scenes"
              maxLength={80}
              aria-label="Suite name"
            />
          )}
          {extraPrompts.length > 0 && (
            <span className={styles.hintInline}>
              Each prompt becomes its own benchmark; the leaderboard can rank the whole suite.
            </span>
          )}
        </div>
        <div className={styles.settings}>
          <label>
            <span>Duration</span>
            <select
              value={settings.duration}
              onChange={(e) => setSettings({ ...settings, duration: Number(e.target.value) })}
            >
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {d} seconds
                </option>
              ))}
            </select>
          </label>
          <div className={styles.field}>
            <span>Frame</span>
            <div role="group" aria-label="Aspect ratio" className={styles.segments}>
              {ASPECTS.map((a) => (
                <button
                  key={a}
                  aria-pressed={settings.aspectRatio === a}
                  onClick={() => setSettings({ ...settings, aspectRatio: a })}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.field}>
            <span>Resolution</span>
            <div role="group" aria-label="Resolution" className={styles.segments}>
              {RESOLUTIONS.map((r) => (
                <button
                  key={r}
                  aria-pressed={settings.resolution === r}
                  onClick={() => setSettings({ ...settings, resolution: r })}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
          <label
            className={styles.check}
            title="Only models that make exactly this length, so costs compare like for like"
          >
            <input
              type="checkbox"
              checked={settings.exactDuration}
              onChange={(e) => setSettings({ ...settings, exactDuration: e.target.checked })}
            />
            <span>Exact length</span>
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={settings.audio}
              onChange={(e) => setSettings({ ...settings, audio: e.target.checked })}
            />
            <span>With sound</span>
          </label>
          <div className={styles.field}>
            <span>Takes</span>
            <div role="group" aria-label="Takes per model" className={styles.segments}>
              {[1, 2, 3].map((t) => (
                <button
                  key={t}
                  aria-pressed={settings.takes === t}
                  onClick={() => setSettings({ ...settings, takes: t })}
                  title="Renders per model per prompt, to see how much each model varies"
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <label>
            <span>Seed</span>
            <input
              inputMode="numeric"
              placeholder="Random"
              value={settings.seed ?? ''}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, 9);
                setSettings({ ...settings, seed: v ? Number(v) : null });
              }}
              className={styles.seed}
            />
          </label>
        </div>

        <div className={styles.pickerBar}>
          <div role="group" aria-label="Provider" className={styles.segments}>
            {(['all', 'fal', 'higgsfield'] as const).map((p) => (
              <button key={p} aria-pressed={provider === p} onClick={() => setProvider(p)}>
                {p === 'all' ? 'All' : PROVIDER_NAME[p]}
                {models && p !== 'all' ? ` ${counts[p]}` : ''}
              </button>
            ))}
          </div>
          <input
            type="search"
            placeholder={models ? `Filter ${runnable.length} models` : 'Filter models'}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter models"
          />
          <button
            className="text-button"
            onClick={() => setChosen(new Set(shown.filter((m) => m.studioModel).map((m) => m.id)))}
          >
            Tuned models
          </button>
          <button
            className="text-button"
            onClick={() => setChosen(new Set(shown.map((m) => m.id)))}
          >
            {filter || provider !== 'all' ? 'All shown' : 'All'}
          </button>
          {runnable.some((m) => m.isNew) && (
            <button
              className="text-button"
              aria-pressed={newOnly}
              onClick={() => setNewOnly(!newOnly)}
              title="Models first listed in the last two weeks"
            >
              {newOnly ? 'Show all' : `New (${runnable.filter((m) => m.isNew).length})`}
            </button>
          )}
          <button className="text-button" onClick={() => setChosen(new Set())}>
            None
          </button>
        </div>
        {!models ? (
          <div className="loading-panel" role="status">
            {modelsError || (
              <>
                <ProgressRing label="Loading" />
                Reading every fal and Higgsfield video model’s settings and price
              </>
            )}
          </div>
        ) : (
          <ul className={styles.models}>
            {shown.map((m) => (
              <li key={m.id}>
                <label className={styles.model} data-on={chosen?.has(m.id) || undefined}>
                  <input
                    type="checkbox"
                    checked={chosen?.has(m.id) ?? false}
                    onChange={() => toggle(m.id)}
                  />
                  <span className={styles.modelName}>
                    <strong>{m.name}</strong>
                    <em className={styles.tag} data-provider={m.provider}>
                      {PROVIDER_NAME[m.provider]}
                    </em>
                    {m.studioModel && <em className={styles.tag}>Tuned</em>}
                    {m.isNew && (
                      <em
                        className={styles.newTag}
                        title={
                          m.firstSeen
                            ? `First listed ${new Date(m.firstSeen).toLocaleDateString()}`
                            : undefined
                        }
                      >
                        New
                      </em>
                    )}
                    <small>{m.endpoint}</small>
                  </span>
                  <span className={styles.modelUsed}>{usedLabel(m.used)}</span>
                  <span className={styles.modelPrice} title={m.priceNote}>
                    {m.cents === null ? 'Unpriced' : money(m.cents)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {models &&
          notes.map((note) => (
            <p key={note} className={styles.hint}>
              {note}
            </p>
          ))}
        {offline.length > 0 && models && (
          <p className={styles.hint}>
            {offline.map((p) => PROVIDER_NAME[p]).join(' and ')} {offline.length > 1 ? 'are' : 'is'}{' '}
            not connected, so {offline.length > 1 ? 'their' : 'its'} models are hidden. Add{' '}
            {offline.length > 1 ? 'the keys' : 'the key'} under <strong>Keys and limit</strong> at the
            top of the page.
          </p>
        )}
        {wrongLength.length > 0 && (
          <details className={styles.blocked}>
            <summary>
              {wrongLength.length} {wrongLength.length === 1 ? 'model can’t' : 'models can’t'} make
              exactly {settings.duration} s, so they are left out to keep costs comparable. Try
              another length, or untick Exact length to round each model to its nearest.
            </summary>
            <ul>
              {wrongLength.map((m) => (
                <li key={m.id}>
                  {m.name} · {PROVIDER_NAME[m.provider]} <small>{m.endpoint}</small> · {m.blocker}
                </li>
              ))}
            </ul>
          </details>
        )}
        {blocked.length > 0 && (
          <details className={styles.blocked}>
            <summary>
              {blocked.length} models need more than a prompt or reject these settings
            </summary>
            <ul>
              {blocked.map((m) => (
                <li key={m.id}>
                  {m.name} · {PROVIDER_NAME[m.provider]} <small>{m.endpoint}</small> · {m.blocker}
                </li>
              ))}
            </ul>
          </details>
        )}
        {runError && (
          <p className={styles.error} role="alert">
            <CircleAlert size={16} aria-hidden="true" /> {runError}
          </p>
        )}
        <div className={styles.runBar}>
          <span>
            <strong>
              {picked.length} {picked.length === 1 ? 'model' : 'models'}
            </strong>
            {runs > 1 &&
              ` × ${prompts.length > 1 ? `${prompts.length} prompts` : '1 prompt'}${
                settings.takes > 1 ? ` × ${settings.takes} takes` : ''
              } = ${renders} renders`}{' '}
            · about {money(total)}
            {unpriced > 0 && ` (${unpriced} unpriced, $2.00 held each)`}
            {left !== null && <> · {money(left)} left today</>}
          </span>
          <button
            className="primary"
            disabled={
              submitting || !picked.length || !prompts.length || (left !== null && total > left)
            }
            onClick={() => void run()}
          >
            {submitting ? <ProgressRing size="sm" label="Loading" /> : <Play size={16} />}
            {submitting ? 'Submitting' : 'Run benchmark'}
          </button>
        </div>
      </section>

      {!state ? (
        <div className="loading-panel" role="status">
          <ProgressRing label="Loading" /> Loading benchmarks
        </div>
      ) : current ? (
        <Results
          key={current.id}
          bench={current}
          all={state.benchmarks}
          open={setOpenId}
          again={again}
          reload={load}
          judgeCentsEach={state.judgeCentsEach}
          judgeReady={state.judgeReady}
        />
      ) : (
        <section className={`panel ${styles.empty}`}>
          <h2>No benchmarks yet</h2>
          <p>
            Write a prompt, tick the models to compare and run it. Results land here as each model
            finishes.
          </p>
        </section>
      )}

      {state && (state.leaderboard.length > 0 || suite) && (
        <Leaderboard
          rows={state.leaderboard}
          suites={suitesOf(state.benchmarks)}
          suite={suite}
          setSuite={setSuite}
        />
      )}
    </div>
  );
}

function Results({
  bench,
  all,
  open,
  again,
  reload,
  judgeCentsEach,
  judgeReady,
}: {
  bench: Bench;
  all: Bench[];
  open: (id: string) => void;
  again: (b: Bench) => void;
  reload: () => Promise<void>;
  judgeCentsEach: number;
  judgeReady: boolean;
}) {
  const [sort, setSort] = useState<Sort>('order');
  const [blind, setBlind] = useState(false);
  const [adding, setAdding] = useState(false);
  const [comparing, setComparing] = useState<string[]>([]);
  const [stage, setStage] = useState<'compare' | 'arena' | null>(null);
  const finished = bench.shots.filter((s) => s.state === 'COMPLETE' && s.hasVideo);
  const toggleCompare = (id: string) =>
    setComparing((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id].slice(-4)));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const live = bench.shots.some(running);
  // More models, a retry or another take on this benchmark's prompt and settings.
  const runMore = async (models: string[]) => {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/benchmarks/${bench.id}/models`, {
        method: 'POST',
        body: JSON.stringify({ key: newKey(), models }),
      });
      await reload();
      return true;
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : 'That did not start' });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const unjudged = bench.shots.filter(
    (s) => s.state === 'COMPLETE' && s.hasVideo && (!s.judgeState || s.judgeState === 'FAILED'),
  ).length;
  const judging = bench.shots.some((s) => s.judgeState === 'QUEUED' || s.judgeState === 'RUNNING');
  const runJudge = async () => {
    const cost = unjudged * judgeCentsEach;
    if (
      !window.confirm(
        `Score ${unjudged} ${unjudged === 1 ? 'render' : 'renders'} with the AI judge for about ${money(cost)}?`,
      )
    )
      return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ queued: number }>(`/api/benchmarks/${bench.id}/judge`, {
        method: 'POST',
      });
      setMessage({
        tone: 'info',
        text: `Judging ${r.queued} ${r.queued === 1 ? 'render' : 'renders'}. Scores appear as each finishes.`,
      });
      await reload();
    } catch (e) {
      setMessage({
        tone: 'error',
        text: e instanceof Error ? e.message : 'The judge did not start',
      });
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      const r = await api<{ canceled: number; generating: number; refused: number }>(
        `/api/benchmarks/${bench.id}/cancel`,
        { method: 'POST' },
      );
      setMessage({
        tone: 'info',
        text: `Canceled ${r.canceled} queued ${r.canceled === 1 ? 'render' : 'renders'}${
          r.generating ? `; ${r.generating} already generating will finish` : ''
        }${r.refused ? `; the provider would not cancel ${r.refused}, which may have just started` : ''}.`,
      });
      await reload();
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : 'Could not cancel' });
    } finally {
      setBusy(false);
    }
  };
  const grid = useRef<HTMLDivElement>(null);
  const done = bench.shots.filter((s) => s.state === 'COMPLETE').length;
  const failed = bench.shots.filter((s) => s.state === 'FAILED' || s.state === 'UNKNOWN').length;
  const spent = bench.shots
    .filter((s) => s.state !== 'FAILED')
    .reduce((sum, s) => sum + costOf(s), 0);
  const billed = bench.shots.every((s) => s.state === 'FAILED' || s.billedCents !== null);
  // Blind labels follow a fixed shuffle so the same render keeps its letter between refreshes.
  const letters = useMemo(() => {
    const order = [...bench.shots].sort((a, b) => a.id.localeCompare(b.id));
    return new Map(
      order.map((s, i) => [
        s.id,
        `Model ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}`,
      ]),
    );
  }, [bench.shots]);
  const sorted = useMemo(() => {
    const list = [...bench.shots];
    const late = (v: number | null) => v ?? Number.POSITIVE_INFINITY;
    if (sort === 'fastest') list.sort((a, b) => late(a.totalSeconds) - late(b.totalSeconds));
    if (sort === 'cheapest') list.sort((a, b) => costOf(a) - costOf(b));
    if (sort === 'rating') list.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    if (sort === 'judge') list.sort((a, b) => (b.judge?.overall ?? 0) - (a.judge?.overall ?? 0));
    return list;
  }, [bench.shots, sort]);
  const labelFor = (s: BenchShot) => (blind && !s.rating ? letters.get(s.id)! : s.name);
  const playAll = () => {
    const videos = [...(grid.current?.querySelectorAll('video') ?? [])];
    videos.forEach((v) => {
      v.currentTime = 0;
      void v.play().catch(() => {});
    });
  };
  const winner = async (shotId: string | null) => {
    await api(`/api/benchmarks/${bench.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ winnerShotId: shotId }),
    });
    await reload();
  };

  return (
    <section className={`panel ${styles.results}`}>
      <div className="panel-heading">
        <div>
          <h2>Results</h2>
          <p>
            {done} of {bench.shots.length} done{failed ? `, ${failed} failed` : ''} · {money(spent)}{' '}
            {billed ? 'billed' : 'estimated'} · {bench.settings.duration} s,{' '}
            {bench.settings.resolution}, {bench.settings.aspectRatio}
            {bench.settings.seed !== null ? `, seed ${bench.settings.seed}` : ''}
          </p>
        </div>
        <select
          className={styles.history}
          value={bench.id}
          onChange={(e) => open(e.target.value)}
          aria-label="Benchmark"
        >
          {all.map((b) => (
            <option key={b.id} value={b.id}>
              {new Date(b.createdAt).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}{' '}
              · {b.suiteName ? `${b.suiteName} · ` : ''}
              {b.prompt.slice(0, 60)}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.quoteRow}>
        {bench.settings.firstFrameId && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className={styles.startThumb}
            src={`/api/start-images/${bench.settings.firstFrameId}`}
            alt="Start image"
          />
        )}
        <blockquote className={styles.quote}>{bench.prompt}</blockquote>
      </div>
      <div className={styles.toolbar}>
        <div role="group" aria-label="Sort" className={styles.segments}>
          {SORTS.map((s) => (
            <button key={s.id} aria-pressed={sort === s.id} onClick={() => setSort(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <button onClick={playAll} disabled={!done}>
          <Play size={16} /> Play all from the start
        </button>
        <button
          aria-pressed={blind}
          onClick={() => setBlind(!blind)}
          title="Hide model names while you rate"
        >
          {blind ? <EyeOff size={16} /> : <Eye size={16} />} {blind ? 'Blind' : 'Names shown'}
        </button>
        <button aria-expanded={adding} onClick={() => setAdding(!adding)}>
          <Plus size={16} /> Add models
        </button>
        <button onClick={() => again(bench)}>
          <RotateCcw size={16} /> Run again
        </button>
        {live && (
          <button
            disabled={busy}
            onClick={() => void cancel()}
            title="Stops renders that are still waiting in a provider queue. Ones already generating finish."
          >
            <CircleStop size={16} /> Cancel queued
          </button>
        )}
        <button
          disabled={comparing.length < 2}
          onClick={() => setStage('compare')}
          title="Tick Compare on two to four renders, then play them in sync"
        >
          <Columns2 size={16} /> Compare{comparing.length ? ` ${comparing.length}` : ''}
        </button>
        <button
          disabled={finished.length < 2}
          onClick={() => setStage('arena')}
          title="Two renders at a time, names hidden. Your picks build an Elo rating per model."
        >
          <Swords size={16} /> Arena
        </button>
        <button
          disabled={busy || !judgeReady || !unjudged}
          onClick={() => void runJudge()}
          title={
            judgeReady
              ? 'A vision model scores prompt adherence, image quality, motion and artefacts from six frames of each render, without seeing model names'
              : 'Set OPENAI_API_KEY and LLM_MODEL to use the AI judge'
          }
        >
          {judging ? <ProgressRing size="sm" label="Loading" /> : <Gavel size={16} />}
          {judging
            ? 'Judging'
            : unjudged
              ? `AI judge · ${money(unjudged * judgeCentsEach)}`
              : 'AI judge'}
        </button>
        <button
          onClick={() => downloadCsv(`benchmark-${bench.id.slice(0, 8)}.csv`, benchmarkCsv(bench))}
        >
          <FileDown size={16} /> CSV
        </button>
      </div>
      {stage === 'compare' && (
        <Stage
          title="Compare"
          items={finished
            .filter((s) => comparing.includes(s.id))
            .map((s) => ({ shot: s, label: labelFor(s) }))}
          onClose={() => setStage(null)}
        />
      )}
      {stage === 'arena' && (
        <Arena bench={bench} shots={finished} onClose={() => setStage(null)} reload={reload} />
      )}
      {message && (
        <p className={message.tone === 'error' ? styles.error : styles.hint} role="status">
          {message.text}
        </p>
      )}
      {adding && (
        <AddModels
          bench={bench}
          busy={busy}
          run={async (ids) => {
            if (await runMore(ids)) setAdding(false);
          }}
        />
      )}
      <div
        className={styles.grid}
        ref={grid}
        style={{ ['--frame' as string]: bench.settings.aspectRatio.replace(':', ' / ') }}
      >
        {sorted.map((s) => (
          <Cell
            key={s.id}
            shot={s}
            label={blind && !s.rating ? letters.get(s.id)! : s.name}
            requested={bench.settings}
            isWinner={bench.winnerShotId === s.id}
            pick={() => void winner(bench.winnerShotId === s.id ? null : s.id)}
            retake={() => void runMore([s.modelId])}
            busy={busy}
            compared={comparing.includes(s.id)}
            toggleCompare={() => toggleCompare(s.id)}
            reload={reload}
          />
        ))}
      </div>
    </section>
  );
}

// Picks more models for an existing benchmark, priced at that benchmark's settings.
function AddModels({
  bench,
  busy,
  run,
}: {
  bench: Bench;
  busy: boolean;
  run: (ids: string[]) => Promise<void>;
}) {
  const [list, setList] = useState<BenchModel[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  useEffect(() => {
    const q = settingsQuery(bench.settings);
    let gone = false;
    api<{ models: BenchModel[]; falConnected: boolean; higgsfieldConnected: boolean }>(
      `/api/benchmarks/models?${q}`,
    )
      .then((r) => {
        if (gone) return;
        const live = { fal: r.falConnected, higgsfield: r.higgsfieldConnected };
        setList(r.models.filter((m) => !m.blocker && live[m.provider]));
      })
      .catch((e) => !gone && setError(e instanceof Error ? e.message : 'Could not list models'));
    return () => {
      gone = true;
    };
  }, [bench.settings]);
  const ran = new Set(bench.shots.map((s) => s.modelId));
  const shown = (list ?? []).filter((m) =>
    `${m.name} ${m.endpoint} ${PROVIDER_NAME[m.provider]}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase()),
  );
  const picked = (list ?? []).filter((m) => chosen.has(m.id));
  const total = picked.reduce((sum, m) => sum + (m.cents ?? 200), 0);
  return (
    <div className={styles.addPanel}>
      <div className={styles.pickerBar}>
        <input
          type="search"
          placeholder="Filter models"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter models to add"
        />
        <button
          className="text-button"
          onClick={() => setChosen(new Set(shown.filter((m) => !ran.has(m.id)).map((m) => m.id)))}
        >
          All not yet run
        </button>
        <button className="text-button" onClick={() => setChosen(new Set())}>
          None
        </button>
      </div>
      {!list ? (
        <div className="loading-panel" role="status">
          {error || (
            <>
              <ProgressRing label="Loading" /> Pricing models at this benchmark’s
              settings
            </>
          )}
        </div>
      ) : (
        <ul className={styles.models}>
          {shown.map((m) => (
            <li key={m.id}>
              <label className={styles.model} data-on={chosen.has(m.id) || undefined}>
                <input
                  type="checkbox"
                  checked={chosen.has(m.id)}
                  onChange={() =>
                    setChosen((c) => {
                      const next = new Set(c);
                      if (next.has(m.id)) next.delete(m.id);
                      else next.add(m.id);
                      return next;
                    })
                  }
                />
                <span className={styles.modelName}>
                  <strong>{m.name}</strong>
                  <em className={styles.tag} data-provider={m.provider}>
                    {PROVIDER_NAME[m.provider]}
                  </em>
                  {ran.has(m.id) && <em className={styles.tag}>In this run</em>}
                  <small>{m.endpoint}</small>
                </span>
                <span className={styles.modelUsed}>{usedLabel(m.used)}</span>
                <span className={styles.modelPrice} title={m.priceNote}>
                  {m.cents === null ? 'Unpriced' : money(m.cents)}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.runBar}>
        <span>
          <strong>{picked.length} more</strong> · about {money(total)}
        </span>
        <button
          className="primary"
          disabled={busy || !picked.length}
          onClick={() => void run(picked.map((m) => m.id))}
        >
          {busy ? <ProgressRing size="sm" label="Loading" /> : <Play size={16} />} Run on this
          prompt
        </button>
      </div>
    </div>
  );
}

function useElapsed(since: string | null, live: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);
  return since ? Math.max(0, (now - new Date(since).getTime()) / 1000) : null;
}

function Cell({
  shot,
  label,
  requested,
  isWinner,
  pick,
  retake,
  busy,
  compared,
  toggleCompare,
  reload,
}: {
  shot: BenchShot;
  label: string;
  requested: BenchRunSettings;
  isWinner: boolean;
  pick: () => void;
  retake: () => void;
  busy: boolean;
  compared: boolean;
  toggleCompare: () => void;
  reload: () => Promise<void>;
}) {
  const live = running(shot);
  const elapsed = useElapsed(shot.submittedAt, live);
  const [note, setNote] = useState(shot.note ?? '');
  const [saving, setSaving] = useState(false);
  const rate = async (body: { rating?: number | null; note?: string }) => {
    setSaving(true);
    try {
      await api(`/api/benchmarks/shots/${shot.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      await reload();
    } finally {
      setSaving(false);
    }
  };
  const out = shot.output;
  const a = shot.analysis;
  const wantRatio = (() => {
    const [w, h] = requested.aspectRatio.split(':').map(Number);
    return w / h;
  })();
  const gotRatio = out?.width && out?.height ? out.width / out.height : null;
  const offRatio = gotRatio !== null && Math.abs(Math.log(gotRatio / wantRatio)) > 0.05;
  // Compared with what this model was asked for after snapping, so Veo's 4 s for a 5 s run is not flagged.
  const offLength =
    out?.seconds && Math.abs(out.seconds - (shot.used?.duration ?? requested.duration)) >= 1;
  const status =
    shot.state === 'COMPLETE'
      ? null
      : shot.state === 'FAILED' || shot.state === 'UNKNOWN'
        ? 'failed'
        : shot.state === 'SUBMITTING'
          ? 'Submitting'
          : shot.state === 'DOWNLOADING'
            ? 'Saving'
            : 'Rendering';

  return (
    <article className={styles.cell} data-winner={isWinner || undefined}>
      <div className={styles.frame}>
        {shot.hasVideo ? (
          <video
            src={`/api/renders/${shot.id}/video`}
            poster={shot.hasPoster ? `/api/renders/${shot.id}/poster` : undefined}
            controls
            loop
            muted
            playsInline
            preload="none"
          />
        ) : status === 'failed' ? (
          <div className={styles.failed}>
            <CircleAlert size={20} aria-hidden="true" />
            <p>{shot.error ?? 'The provider could not render this'}</p>
            <button disabled={busy} onClick={retake}>
              <RotateCcw size={14} /> Try again
            </button>
          </div>
        ) : (
          <div className={styles.pending} role="status">
            <ProgressRing label="Loading" />
            <span>
              {status} {elapsed !== null && secs(elapsed)}
            </span>
          </div>
        )}
        {isWinner && (
          <span className={styles.winnerBadge}>
            <Trophy size={14} aria-hidden="true" /> Pick
          </span>
        )}
      </div>
      {shot.hasStrip && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className={styles.strip}
          src={`/api/benchmarks/shots/${shot.id}/strip`}
          alt="Six frames across the render"
          loading="lazy"
        />
      )}
      <header className={styles.cellHead}>
        {shot.hasVideo && (
          <label className={styles.compareBox}>
            <input type="checkbox" checked={compared} onChange={toggleCompare} /> Compare
          </label>
        )}
        <strong>
          {label}
          {shot.take > 1 && <em className={styles.tag}> Take {shot.take}</em>}
        </strong>
        {label === shot.name && (
          <small>
            {PROVIDER_NAME[shot.provider]} · {shot.endpoint}
          </small>
        )}
      </header>
      <dl className={styles.metrics}>
        <div>
          <dt>Total</dt>
          <dd>{live ? secs(elapsed) : secs(shot.totalSeconds)}</dd>
        </div>
        <div>
          <dt
            title={
              shot.timing === 'provider'
                ? 'fal’s own record of time spent generating'
                : 'Measured by the poller from when the render started, to about 6 seconds'
            }
          >
            Generating{shot.timing === 'measured' && shot.runSeconds !== null ? ' ≈' : ''}
          </dt>
          <dd>{secs(shot.runSeconds)}</dd>
        </div>
        <div>
          <dt
            title={
              shot.timing === 'provider'
                ? 'Time waiting for a fal runner, from fal’s record'
                : 'Time before the provider started generating, measured by the poller'
            }
          >
            Queue{shot.timing === 'measured' && shot.queueSeconds !== null ? ' ≈' : ''}
          </dt>
          <dd>{secs(shot.queueSeconds)}</dd>
        </div>
        <div>
          <dt>
            {shot.state === 'FAILED'
              ? 'Cost'
              : shot.billedCents !== null
                ? 'Billed'
                : shot.provider === 'higgsfield' && shot.priced
                  ? 'Quoted'
                  : 'Estimate'}
          </dt>
          <dd>
            {shot.state === 'FAILED' ? 'Not billed' : money(costOf(shot))}
            {!shot.priced && shot.billedCents === null && shot.state !== 'FAILED' ? ' held' : ''}
          </dd>
        </div>
        <div>
          <dt>Per second</dt>
          <dd>{out?.seconds ? money(costOf(shot) / out.seconds) : '–'}</dd>
        </div>
        <div className={styles.wide}>
          <dt>Output</dt>
          <dd>
            {out ? (
              <>
                <span data-off={offRatio || undefined}>
                  {out.width}×{out.height}
                </span>{' '}
                <span data-off={offLength || undefined}>{out.seconds?.toFixed(1)} s</span>
                {out.fps ? ` ${Math.round(out.fps)} fps` : ''}
                {out.audio ? ' · sound' : ' · silent'}
              </>
            ) : (
              usedLabel(shot.used) || '–'
            )}
          </dd>
        </div>
        {shot.state === 'COMPLETE' && (
          <div className={styles.wide}>
            <dt title="Measured from the delivered file: motion, hard cuts, freezes, black frames and sound">
              Checks
            </dt>
            <dd>
              {a ? (
                <>
                  <span title="Average change between frames. Under 0.3 is a still image.">
                    {motionWord(a.motion)} motion
                  </span>
                  {' · '}
                  <span
                    title={
                      a.cuts.length
                        ? `Hard cuts at ${a.cuts.map((t) => `${t} s`).join(', ')}`
                        : undefined
                    }
                  >
                    {a.cuts.length
                      ? `${a.cuts.length} ${a.cuts.length === 1 ? 'cut' : 'cuts'}`
                      : 'one take'}
                  </span>
                  {a.loudness !== null && ` · ${Math.round(a.loudness)} LUFS`}
                  {a.issues.map((issue) => (
                    <span key={issue} className={styles.issue}>
                      {issue}
                    </span>
                  ))}
                </>
              ) : (
                'Checking the file'
              )}
            </dd>
          </div>
        )}
        {shot.judgeState && (
          <div className={styles.wide}>
            <dt
              title={
                shot.judge?.model
                  ? `Scored blind by ${shot.judge.model} from six frames`
                  : 'AI judge'
              }
            >
              AI judge
            </dt>
            <dd>
              {shot.judge ? (
                <>
                  <strong className={styles.judgeScore}>{shot.judge.overall}/10</strong> · prompt{' '}
                  {shot.judge.adherence} · look {shot.judge.visual} · motion {shot.judge.motion} ·
                  clean {shot.judge.artifacts}
                  <span className={styles.judgeSummary}>{shot.judge.summary}</span>
                  {shot.judge.problems.map((p) => (
                    <span key={p} className={styles.flag}>
                      {p}
                    </span>
                  ))}
                </>
              ) : shot.judgeState === 'FAILED' ? (
                <span className={styles.issue}>
                  {shot.judgeError ?? 'The judge could not score this'}
                </span>
              ) : (
                'Judging'
              )}
            </dd>
          </div>
        )}
      </dl>
      {shot.state === 'COMPLETE' && (
        <footer className={styles.cellFoot}>
          <div className={styles.stars} role="radiogroup" aria-label="Rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                role="radio"
                aria-checked={shot.rating === n}
                aria-label={`${n} of 5`}
                disabled={saving}
                data-on={(shot.rating ?? 0) >= n || undefined}
                onClick={() => void rate({ rating: shot.rating === n ? null : n })}
              >
                <Star size={16} />
              </button>
            ))}
          </div>
          <button className="text-button" aria-pressed={isWinner} onClick={pick}>
            <Trophy size={14} /> {isWinner ? 'Picked' : 'Pick'}
          </button>
          <a
            className="text-button"
            href={`/api/renders/${shot.id}/download`}
            aria-label="Download"
          >
            <Download size={14} />
          </a>
          <button
            className="text-button"
            disabled={busy}
            onClick={retake}
            title="Render this model again with the same prompt and settings"
          >
            <RotateCcw size={14} /> Another take
          </button>
          {shot.request && <RequestView shot={shot} />}
          <input
            className={styles.note}
            value={note}
            placeholder="Note: prompt adherence, artefacts, motion"
            maxLength={600}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note !== (shot.note ?? '') && void rate({ note })}
            aria-label="Note"
          />
        </footer>
      )}
    </article>
  );
}

/** Votes before an Elo's ± interval means anything. */
const ARENA_SETTLED = 10;

const COLUMNS: { id: keyof LeaderRow; label: string; low?: boolean }[] = [
  { id: 'arena', label: 'Arena Elo' },
  { id: 'judgeScore', label: 'Judge' },
  { id: 'avgRating', label: 'Rating' },
  { id: 'wins', label: 'Picks' },
  { id: 'done', label: 'Done' },
  { id: 'medianTotalSeconds', label: 'Median total', low: true },
  { id: 'medianRunSeconds', label: 'Generating', low: true },
  { id: 'medianQueueSeconds', label: 'Queue', low: true },
  { id: 'avgCents', label: 'Avg cost', low: true },
  { id: 'centsPerSecond', label: 'Per output second', low: true },
  { id: 'medianMotion', label: 'Motion' },
  { id: 'issueRate', label: 'With problems', low: true },
];

const suitesOf = (list: Bench[]) => {
  const out = new Map<string, { name: string; prompts: number }>();
  for (const b of list)
    if (b.suiteId)
      out.set(b.suiteId, {
        name: b.suiteName ?? 'Suite',
        prompts: (out.get(b.suiteId)?.prompts ?? 0) + 1,
      });
  return [...out].map(([id, v]) => ({ id, ...v }));
};

function Leaderboard({
  rows,
  suites,
  suite,
  setSuite,
}: {
  rows: LeaderRow[];
  suites: { id: string; name: string; prompts: number }[];
  suite: string | null;
  setSuite: (id: string | null) => void;
}) {
  const [openModel, setOpenModel] = useState<LeaderRow | null>(null);
  const [by, setBy] = useState<keyof LeaderRow>('avgRating');
  const col = COLUMNS.find((c) => c.id === by);
  const sorted = [...rows].sort((a, b) => {
    const x = a[by] as number | null;
    const y = b[by] as number | null;
    if (x === null) return 1;
    if (y === null) return -1;
    return col?.low ? x - y : y - x;
  });
  const cell = (r: LeaderRow, id: keyof LeaderRow) => {
    const v = r[id] as number | null;
    if (id === 'done') return `${r.done} of ${r.runs}`;
    if (v === null) return '–';
    if (id === 'avgRating') return `${v.toFixed(1)} (${r.ratings})`;
    if (id === 'arena')
      // Resampling a handful of votes understates the doubt, so small counts say so instead.
      return r.arenaVotes < ARENA_SETTLED
        ? `${v} (${r.arenaVotes}, provisional)`
        : `${v} ±${Math.round(((r.arenaHigh ?? v) - (r.arenaLow ?? v)) / 2)} (${r.arenaVotes})`;
    if (id === 'judgeScore') return `${v}/10 (${r.judged})`;
    if (id === 'avgCents' || id === 'centsPerSecond') return money(v);
    if (id.endsWith('Seconds')) return secs(v);
    if (id === 'issueRate') return `${v}%`;
    if (id === 'medianMotion') return `${motionWord(v)} (${v})`;
    return String(v);
  };
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Leaderboard</h2>
          <p>
            Every benchmark so far, by model and provider. Arena Elo comes from blind head-to-head
            votes. Times are medians of finished renders; cost is fal’s bill once it arrives, or
            Higgsfield’s quote.
          </p>
        </div>
        {suites.length > 0 && (
          <select
            value={suite ?? ''}
            onChange={(e) => setSuite(e.target.value || null)}
            aria-label="Leaderboard scope"
          >
            <option value="">Every benchmark</option>
            {suites.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} ({x.prompts} prompts)
              </option>
            ))}
          </select>
        )}
        <button onClick={() => downloadCsv('benchmark-leaderboard.csv', leaderboardCsv(sorted))}>
          <FileDown size={16} /> CSV
        </button>
      </div>
      <div className="table-scroll">
        <table className={styles.board}>
          <thead>
            <tr>
              <th>Model</th>
              {COLUMNS.map((c) => (
                <th
                  key={c.id}
                  aria-sort={by === c.id ? (c.low ? 'ascending' : 'descending') : undefined}
                >
                  <button className={styles.sortHead} onClick={() => setBy(c.id)}>
                    {c.label}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id}>
                <td>
                  <button className={styles.modelLink} onClick={() => setOpenModel(r)}>
                    {r.name}
                  </button>
                  <small>
                    {PROVIDER_NAME[r.provider]} · {r.endpoint}
                  </small>
                </td>
                {COLUMNS.map((c) => (
                  <td key={c.id}>{cell(r, c.id)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {openModel && <ModelPanel row={openModel} onClose={() => setOpenModel(null)} />}
      <ValueChart rows={rows} />
    </section>
  );
}

// One clock for several videos: play, pause, scrub, step a frame and slow down together, so
// motion and timing can be compared exactly.
function Stage({
  title,
  items,
  onClose,
  children,
}: {
  title: string;
  items: { shot: BenchShot; label: string }[];
  onClose: () => void;
  children?: React.ReactNode;
}) {
  const videos = useRef<(HTMLVideoElement | null)[]>([]);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);
  const [rate, setRate] = useState(1);
  const all = () => videos.current.filter((v): v is HTMLVideoElement => Boolean(v));
  const seek = (t: number) => {
    for (const v of all()) v.currentTime = Math.min(t, Math.max(0, (v.duration || t) - 0.01));
    setTime(t);
  };
  const play = () => {
    const t = all()[0]?.currentTime ?? 0;
    for (const v of all()) {
      v.currentTime = Math.min(t, v.duration || t);
      v.playbackRate = rate;
      void v.play().catch(() => {});
    }
    setPlaying(true);
  };
  const pause = () => {
    for (const v of all()) v.pause();
    setPlaying(false);
  };
  useEffect(() => {
    for (const v of all()) v.playbackRate = rate;
  }, [rate]);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const lead = all()[0];
      if (lead) setTime(lead.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === ' ' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        if (playing) pause();
        else play();
      }
    };
    window.addEventListener('keydown', key);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', key);
    };
  });
  const step = (frames: number) => {
    pause();
    // The lead video's own position, not the painted clock, which lags or stops in a hidden tab.
    seek(Math.max(0, (all()[0]?.currentTime ?? time) + frames / 24));
  };
  return (
    <div className={styles.stageBackdrop} role="dialog" aria-modal="true" aria-label={title}>
      <div className={styles.stage}>
        <header className={styles.stageHead}>
          <h2>{title}</h2>
          <button className="text-button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className={styles.stageVideos} data-count={items.length}>
          {items.map((item, i) => (
            <figure key={item.shot.id}>
              <video
                ref={(el) => {
                  videos.current[i] = el;
                }}
                src={`/api/renders/${item.shot.id}/video`}
                poster={
                  item.shot.hasPoster ? `/api/renders/${item.shot.id}/poster` : undefined
                }
                muted={i > 0}
                playsInline
                preload="auto"
                onLoadedMetadata={(e) => {
                  // Read now: React clears currentTarget before a state updater runs.
                  const seconds = e.currentTarget.duration || 0;
                  setLength((l) => Math.max(l, seconds));
                }}
                onEnded={() => i === 0 && pause()}
              />
              <figcaption>{item.label}</figcaption>
            </figure>
          ))}
        </div>
        <div className={styles.transport}>
          <button onClick={() => step(-1)} aria-label="Back one frame" title="Back one frame">
            <SkipBack size={16} />
          </button>
          <button
            className="primary"
            onClick={playing ? pause : play}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button onClick={() => step(1)} aria-label="Forward one frame" title="Forward one frame">
            <SkipForward size={16} />
          </button>
          <input
            type="range"
            min={0}
            max={length || 1}
            step={1 / 24}
            value={Math.min(time, length || 1)}
            onChange={(e) => {
              pause();
              seek(Number(e.target.value));
            }}
            aria-label="Position"
          />
          <span className={styles.clock}>
            {time.toFixed(2)} / {length.toFixed(2)} s
          </span>
          <div role="group" aria-label="Speed" className={styles.segments}>
            {[0.25, 0.5, 1].map((r) => (
              <button key={r} aria-pressed={rate === r} onClick={() => setRate(r)}>
                {r === 1 ? '1×' : `${r}×`}
              </button>
            ))}
          </div>
        </div>
        <p className={styles.hint}>
          Only the first video plays sound. Space plays or pauses, Esc closes.
        </p>
        {children}
      </div>
    </div>
  );
}

// Blind head-to-head: the least-compared pair comes next, sides are shuffled, and the names are
// shown only after the vote.
function Arena({
  bench,
  shots,
  onClose,
  reload,
}: {
  bench: Bench;
  shots: BenchShot[];
  onClose: () => void;
  reload: () => Promise<void>;
}) {
  const pairKey = (a: string, b: string) => [a, b].sort().join(':');
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of bench.votes)
      m.set(pairKey(v.left, v.right), (m.get(pairKey(v.left, v.right)) ?? 0) + 1);
    return m;
  }, [bench.votes]);
  const pick = useCallback(
    (skip?: string) => {
      const pairs: [BenchShot, BenchShot][] = [];
      for (let i = 0; i < shots.length; i++)
        for (let j = i + 1; j < shots.length; j++) pairs.push([shots[i], shots[j]]);
      const open = pairs.filter(([a, b]) => pairKey(a.id, b.id) !== skip);
      const pool = open.length ? open : pairs;
      const least = Math.min(...pool.map(([a, b]) => counts.get(pairKey(a.id, b.id)) ?? 0));
      const choices = pool.filter(([a, b]) => (counts.get(pairKey(a.id, b.id)) ?? 0) === least);
      const pair = choices[Math.floor(Math.random() * choices.length)];
      return Math.random() < 0.5 ? pair : ([pair[1], pair[0]] as [BenchShot, BenchShot]);
    },
    [shots, counts],
  );
  const [pair, setPair] = useState(() => pick());
  const [round, setRound] = useState(0);
  const [reveal, setReveal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const voted = bench.votes.length;
  const vote = async (outcome: Outcome) => {
    if (saving || reveal) return;
    setSaving(true);
    setError('');
    try {
      await api(`/api/benchmarks/${bench.id}/votes`, {
        method: 'POST',
        body: JSON.stringify({ left: pair[0].id, right: pair[1].id, outcome }),
      });
      setReveal(`A was ${pair[0].name}. B was ${pair[1].name}.`);
      void reload();
      setTimeout(() => {
        setReveal(null);
        setPair(pick(pairKey(pair[0].id, pair[1].id)));
        setRound((r) => r + 1);
      }, 1600);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The vote was not saved');
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'ArrowLeft') void vote('left');
      if (e.key === 'ArrowRight') void vote('right');
      if (e.key === 'ArrowDown' || e.key.toLowerCase() === 't') void vote('tie');
      if (e.key.toLowerCase() === 'x') void vote('both_bad');
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  return (
    <Stage
      key={round}
      title={`Arena · ${voted} ${voted === 1 ? 'vote' : 'votes'} on this benchmark`}
      items={[
        { shot: pair[0], label: 'A' },
        { shot: pair[1], label: 'B' },
      ]}
      onClose={onClose}
    >
      <div className={styles.votes}>
        <button disabled={saving || Boolean(reveal)} onClick={() => void vote('left')}>
          A is better <kbd>←</kbd>
        </button>
        <button disabled={saving || Boolean(reveal)} onClick={() => void vote('tie')}>
          Tie <kbd>↓</kbd>
        </button>
        <button disabled={saving || Boolean(reveal)} onClick={() => void vote('right')}>
          B is better <kbd>→</kbd>
        </button>
        <button disabled={saving || Boolean(reveal)} onClick={() => void vote('both_bad')}>
          Both bad <kbd>X</kbd>
        </button>
        <button
          className="text-button"
          disabled={Boolean(reveal)}
          onClick={() => {
            setPair(pick(pairKey(pair[0].id, pair[1].id)));
            setRound((r) => r + 1);
          }}
        >
          Skip
        </button>
      </div>
      {reveal && (
        <p className={styles.reveal} role="status">
          {reveal}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </Stage>
  );
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const toCsv = (rows: Record<string, unknown>[]) =>
  rows.length
    ? [
        Object.keys(rows[0]).join(','),
        ...rows.map((r) => Object.values(r).map(csvCell).join(',')),
      ].join('\n')
    : '';
function downloadCsv(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const benchmarkCsv = (b: Bench) =>
  toCsv(
    b.shots.map((s) => ({
      prompt: b.prompt,
      provider: s.provider,
      model: s.name,
      endpoint: s.endpoint,
      state: s.state,
      error: s.error,
      requested_seconds: s.used?.duration,
      requested_resolution: s.used?.resolution,
      requested_frame: s.used?.aspectRatio,
      total_seconds: s.totalSeconds,
      queue_seconds: s.queueSeconds,
      generating_seconds: s.runSeconds,
      timing: s.timing,
      cost_usd: s.state === 'FAILED' ? 0 : costOf(s) / 100,
      cost_source:
        s.billedCents !== null
          ? 'billed'
          : s.provider === 'higgsfield' && s.priced
            ? 'quoted'
            : 'estimate',
      width: s.output?.width,
      height: s.output?.height,
      output_seconds: s.output?.seconds,
      fps: s.output?.fps,
      audio: s.output?.audio,
      motion: s.analysis?.motion,
      cuts: s.analysis?.cuts.length,
      frozen_seconds: s.analysis?.frozenSeconds,
      black_seconds: s.analysis?.blackSeconds,
      loudness_lufs: s.analysis?.loudness,
      problems: s.analysis?.issues.join('; '),
      judge_overall: s.judge?.overall,
      judge_prompt: s.judge?.adherence,
      judge_look: s.judge?.visual,
      judge_motion: s.judge?.motion,
      judge_clean: s.judge?.artifacts,
      judge_summary: s.judge?.summary,
      judge_model: s.judge?.model,
      rating: s.rating,
      picked: b.winnerShotId === s.id,
      note: s.note,
      seed: s.seed,
    })),
  );
const leaderboardCsv = (rows: LeaderRow[]) =>
  toCsv(
    rows.map((r) => ({
      provider: r.provider,
      model: r.name,
      endpoint: r.endpoint,
      arena_elo: r.arena,
      arena_votes: r.arenaVotes,
      avg_rating: r.avgRating,
      ratings: r.ratings,
      picks: r.wins,
      runs: r.runs,
      done: r.done,
      failed: r.failed,
      median_total_seconds: r.medianTotalSeconds,
      median_generating_seconds: r.medianRunSeconds,
      median_queue_seconds: r.medianQueueSeconds,
      avg_cost_usd: r.avgCents === null ? null : r.avgCents / 100,
      cost_per_output_second_usd: r.centsPerSecond === null ? null : r.centsPerSecond / 100,
      median_motion: r.medianMotion,
      problem_rate_percent: r.issueRate,
      judge_score: r.judgeScore,
      judged: r.judged,
    })),
  );

// Quality against cost or speed, one dot per model. The frontier joins the models nothing else
// beats on both axes: the best value at each price or speed.
const QUALITY = [
  { id: 'judgeScore', label: 'AI judge', fmt: (v: number) => `${v}/10` },
  { id: 'arena', label: 'Arena Elo', fmt: (v: number) => String(v) },
  { id: 'avgRating', label: 'Your rating', fmt: (v: number) => v.toFixed(1) },
] as const;
const AGAINST = [
  { id: 'avgCents', label: 'Cost per render', fmt: (v: number) => money(v) },
  { id: 'medianTotalSeconds', label: 'Time to render', fmt: (v: number) => secs(v) },
] as const;

const niceTicks = (lo: number, hi: number, n = 4) => {
  const span = hi - lo || 1;
  const step = 10 ** Math.floor(Math.log10(span / n));
  const unit = [1, 2, 2.5, 5, 10].map((m) => m * step).find((u) => span / u <= n) ?? step * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / unit) * unit; v <= hi + 1e-9; v += unit)
    out.push(Math.round(v * 1000) / 1000);
  return out;
};

function ValueChart({ rows }: { rows: LeaderRow[] }) {
  const [q, setQ] = useState<(typeof QUALITY)[number]['id']>('judgeScore');
  const [x, setX] = useState<(typeof AGAINST)[number]['id']>('avgCents');
  const [hover, setHover] = useState<string | null>(null);
  const qMeta = QUALITY.find((m) => m.id === q)!;
  const xMeta = AGAINST.find((m) => m.id === x)!;
  const points = rows.filter((r) => r[q] !== null && r[x] !== null) as (LeaderRow &
    Record<string, number>)[];
  const available = QUALITY.filter((m) => rows.some((r) => r[m.id] !== null));
  if (!available.length) return null;
  const W = 760;
  const H = 320;
  const pad = { l: 56, r: 24, t: 16, b: 44 };
  const xs = points.map((p) => p[x] as number);
  const ys = points.map((p) => p[q] as number);
  const x0 = 0;
  const x1 = Math.max(...xs, 1) * 1.08;
  const yLo = Math.min(...ys);
  const yHi = Math.max(...ys);
  const y0 = q === 'arena' ? Math.floor((yLo - 20) / 50) * 50 : 0;
  const y1 = q === 'arena' ? Math.ceil((yHi + 20) / 50) * 50 : q === 'judgeScore' ? 10 : 5;
  const sx = (v: number) => pad.l + ((v - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const sy = (v: number) => H - pad.b - ((v - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);
  const best = frontier(
    points,
    (p) => p[x] as number,
    (p) => p[q] as number,
  );
  const bestIds = new Set(best.map((p) => p.id));
  const hovered = points.find((p) => p.id === hover);
  return (
    <div className={styles.valueChart}>
      <div className={styles.chartControls}>
        <div role="group" aria-label="Quality measure" className={styles.segments}>
          {available.map((m) => (
            <button key={m.id} aria-pressed={q === m.id} onClick={() => setQ(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <span className={styles.hintInline}>against</span>
        <div role="group" aria-label="Compared with" className={styles.segments}>
          {AGAINST.map((m) => (
            <button key={m.id} aria-pressed={x === m.id} onClick={() => setX(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <ul className={styles.chartLegend} aria-label="Legend">
          <li>
            <svg width="12" height="12" aria-hidden="true">
              <circle cx="6" cy="6" r="5" className={styles.dotFal} />
            </svg>
            fal
          </li>
          <li>
            <svg width="12" height="12" aria-hidden="true">
              <rect x="1" y="1" width="10" height="10" rx="2" className={styles.dotHf} />
            </svg>
            Higgsfield
          </li>
          <li>
            <svg width="18" height="12" aria-hidden="true">
              <line x1="1" y1="6" x2="17" y2="6" className={styles.frontierLine} />
            </svg>
            Best value
          </li>
        </ul>
      </div>
      {points.length < 2 ? (
        <p className={styles.hint}>
          Needs two models with {qMeta.label.toLowerCase()} and {xMeta.label.toLowerCase()} to plot.
        </p>
      ) : (
        <div className={styles.chartWrap} onMouseLeave={() => setHover(null)}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className={styles.chart}
            role="img"
            aria-label={`${qMeta.label} against ${xMeta.label}`}
          >
            {niceTicks(y0, y1).map((t) => (
              <g key={`y${t}`}>
                <line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} className={styles.grid} />
                <text x={pad.l - 8} y={sy(t)} className={styles.tickY}>
                  {qMeta.fmt(t)}
                </text>
              </g>
            ))}
            {niceTicks(x0, x1).map((t) => (
              <text key={`x${t}`} x={sx(t)} y={H - pad.b + 18} className={styles.tickX}>
                {xMeta.fmt(t)}
              </text>
            ))}
            <text x={(pad.l + W - pad.r) / 2} y={H - 6} className={styles.axisTitle}>
              {xMeta.label} (lower is better)
            </text>
            <polyline
              points={best.map((p) => `${sx(p[x] as number)},${sy(p[q] as number)}`).join(' ')}
              className={styles.frontierLine}
            />
            {points.map((p) => {
              const cx = sx(p[x] as number);
              const cy = sy(p[q] as number);
              const on = hover === p.id;
              return (
                <g
                  key={p.id}
                  onMouseEnter={() => setHover(p.id)}
                  onFocus={() => setHover(p.id)}
                  tabIndex={0}
                >
                  <circle cx={cx} cy={cy} r={14} className={styles.hit} />
                  {p.provider === 'fal' ? (
                    <circle cx={cx} cy={cy} r={on ? 6.5 : 5} className={styles.dotFal} />
                  ) : (
                    <rect
                      x={cx - (on ? 6 : 5)}
                      y={cy - (on ? 6 : 5)}
                      width={on ? 12 : 10}
                      height={on ? 12 : 10}
                      rx={2}
                      className={styles.dotHf}
                    />
                  )}
                  {bestIds.has(p.id) && !on && (
                    <text x={cx + 9} y={cy - 8} className={styles.pointLabel}>
                      {p.name.length > 22 ? `${p.name.slice(0, 21)}…` : p.name}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {hovered && (
            <div
              className={styles.chartTip}
              style={{
                left: `${(sx(hovered[x] as number) / W) * 100}%`,
                top: `${(sy(hovered[q] as number) / H) * 100}%`,
              }}
              role="status"
            >
              <strong>{hovered.name}</strong>
              <span>{PROVIDER_NAME[hovered.provider]}</span>
              <span>
                {qMeta.label} <b>{qMeta.fmt(hovered[q] as number)}</b>
              </span>
              <span>
                {xMeta.label} <b>{xMeta.fmt(hovered[x] as number)}</b>
              </span>
              {bestIds.has(hovered.id) && (
                <span>Best value at this {x === 'avgCents' ? 'price' : 'speed'}</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const curlFor = (shot: BenchShot) => {
  const body = JSON.stringify(shot.request).replaceAll("'", "'\\''");
  return shot.provider === 'fal'
    ? `curl -X POST 'https://queue.fal.run/${shot.endpoint}' \\\n  -H "Authorization: Key $FAL_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -d '${body}'`
    : `curl -X POST 'https://api.higgsfield.ai/${shot.endpoint}' \\\n  -H "Authorization: Key $HF_API_KEY_ID:$HF_API_KEY_SECRET" \\\n  -H 'Content-Type: application/json' \\\n  -d '${body}'`;
};

// The exact request a render was made from, to reproduce or debug it outside the app.
function RequestView({ shot }: { shot: BenchShot }) {
  const [copied, setCopied] = useState(false);
  return (
    <details className={styles.request}>
      <summary>
        <Code2 size={14} aria-hidden="true" /> Request
      </summary>
      <pre>{JSON.stringify(shot.request, null, 2)}</pre>
      <button
        className="text-button"
        onClick={() => {
          void navigator.clipboard.writeText(curlFor(shot)).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        <Copy size={14} /> {copied ? 'Copied' : 'Copy as cURL'}
      </button>
      {JSON.stringify(shot.request).includes('[start image]') && (
        <p className={styles.hintInline}>Add the start image where it says [start image].</p>
      )}
    </details>
  );
}

type History = {
  id: string;
  renders: (BenchShot & { benchmarkId: string; benchmarkCreatedAt: string })[];
  failures: { reason: string; count: number }[];
};

// One model across every benchmark: its numbers, why it failed, and every render it made.
function ModelPanel({ row, onClose }: { row: LeaderRow; onClose: () => void }) {
  const [data, setData] = useState<History | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let gone = false;
    api<History>(`/api/benchmarks/model?id=${encodeURIComponent(row.id)}`)
      .then((d) => !gone && setData(d))
      .catch(
        (e) => !gone && setError(e instanceof Error ? e.message : 'Could not load this model'),
      );
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => {
      gone = true;
      window.removeEventListener('keydown', key);
    };
  }, [row.id, onClose]);
  const stats: [string, string][] = [
    ['Done', `${row.done} of ${row.runs}`],
    [
      'Arena Elo',
      row.arena === null
        ? '–'
        : `${row.arena} (${row.arenaVotes} ${row.arenaVotes === 1 ? 'vote' : 'votes'}${
            row.arenaVotes < ARENA_SETTLED ? ', provisional' : ''
          })`,
    ],
    ['AI judge', row.judgeScore === null ? '–' : `${row.judgeScore}/10`],
    ['Your rating', row.avgRating === null ? '–' : row.avgRating.toFixed(1)],
    ['Median total', secs(row.medianTotalSeconds)],
    ['Generating', secs(row.medianRunSeconds)],
    ['Avg cost', money(row.avgCents)],
    ['With problems', row.issueRate === null ? '–' : `${row.issueRate}%`],
  ];
  return (
    <div className={styles.stageBackdrop} role="dialog" aria-modal="true" aria-label={row.name}>
      <div className={styles.stage}>
        <header className={styles.stageHead}>
          <div>
            <h2>{row.name}</h2>
            <small className={styles.hintInline}>
              {PROVIDER_NAME[row.provider]} · {row.endpoint}
            </small>
          </div>
          <button className="text-button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <dl className={styles.modelStats}>
          {stats.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {!data ? (
          <div className="loading-panel" role="status">
            {error || (
              <>
                <ProgressRing label="Loading" /> Loading every render
              </>
            )}
          </div>
        ) : (
          <>
            {data.failures.length > 0 && (
              <div>
                <h3 className={styles.subhead}>Why it failed</h3>
                <ul className={styles.failures}>
                  {data.failures.map((f) => (
                    <li key={f.reason}>
                      <b>{f.count}×</b> {f.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <h3 className={styles.subhead}>
              {data.renders.length} {data.renders.length === 1 ? 'render' : 'renders'}, newest first
            </h3>
            <div className={styles.historyGrid}>
              {data.renders.map((r) => (
                <figure key={r.id}>
                  {r.hasVideo ? (
                    <video
                      src={`/api/renders/${r.id}/video`}
                      poster={r.hasPoster ? `/api/renders/${r.id}/poster` : undefined}
                      controls
                      muted
                      playsInline
                      preload="none"
                    />
                  ) : (
                    <div className={styles.historyEmpty}>
                      {r.state === 'FAILED' ? 'Failed' : 'No video'}
                    </div>
                  )}
                  <figcaption>
                    <span title={r.prompt}>{r.prompt.slice(0, 80)}</span>
                    <small>
                      {new Date(r.benchmarkCreatedAt).toLocaleDateString()} · {secs(r.totalSeconds)}{' '}
                      · {r.state === 'FAILED' ? 'not billed' : money(costOf(r))}
                      {r.judge ? ` · judge ${r.judge.overall}/10` : ''}
                      {r.rating ? ` · ${r.rating}★` : ''}
                    </small>
                  </figcaption>
                </figure>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
