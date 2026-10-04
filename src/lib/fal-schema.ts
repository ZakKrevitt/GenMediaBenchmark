// Turns any fal or Higgsfield text-to-video endpoint's published inputs into a request for one benchmark
// prompt. Models name and type the same settings differently ("5", 5 or "5s"; "720p" or "768P";
// duration or num_frames), so each requested setting snaps to the nearest value the endpoint
// accepts and the request records what was actually asked for. Pure, so it is unit tested.

export type SchemaProp = {
  type?: string;
  enum?: (string | number)[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
};
export type InputSpec = {
  props: Record<string, SchemaProp>;
  required: string[];
  /** Why the endpoint cannot run from a prompt alone, when it cannot. */
  blocker: string | null;
};
export type BenchSettings = {
  prompt: string;
  duration: number;
  aspectRatio: string;
  resolution: string;
  audio: boolean;
  seed: number | null;
};
export type UsedSettings = {
  duration: number | null;
  aspectRatio: string | null;
  resolution: string | null;
  audio: boolean | null;
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function deref(node: unknown, schemas: Json, depth = 0): Json {
  if (!isObj(node) || depth > 6) return {};
  const ref = typeof node.$ref === 'string' ? node.$ref : null;
  if (ref)
    return { ...deref(schemas[ref.split('/').at(-1)!], schemas, depth + 1), ...omit(node, '$ref') };
  if (Array.isArray(node.allOf) && node.allOf.length)
    return { ...deref(node.allOf[0], schemas, depth + 1), ...omit(node, 'allOf') };
  if (Array.isArray(node.anyOf)) {
    const branch = node.anyOf
      .map((b) => deref(b, schemas, depth + 1))
      .find((b) => b.type !== 'null');
    return { ...(branch ?? {}), ...omit(node, 'anyOf') };
  }
  return node;
}
const omit = (o: Json, key: string) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

export function parseInputSpec(openapi: unknown): InputSpec {
  const doc = isObj(openapi) ? openapi : {};
  const schemas = (
    isObj(doc.components) && isObj(doc.components.schemas) ? doc.components.schemas : {}
  ) as Json;
  const paths = isObj(doc.paths) ? doc.paths : {};
  const submit = Object.entries(paths).find(
    ([path, v]) => !path.includes('/requests/') && isObj(v) && isObj(v.post),
  );
  const post = submit && isObj(submit[1]) ? (submit[1].post as Json) : null;
  const body = post && isObj(post.requestBody) ? post.requestBody : null;
  const content =
    body && isObj(body.content) && isObj(body.content['application/json'])
      ? body.content['application/json']
      : null;
  const input = deref(content?.schema, schemas);
  const rawProps = isObj(input.properties) ? input.properties : {};
  const props: Record<string, SchemaProp> = {};
  for (const [name, raw] of Object.entries(rawProps)) {
    const p = deref(raw, schemas);
    props[name] = {
      type: typeof p.type === 'string' ? p.type : undefined,
      enum: Array.isArray(p.enum) ? (p.enum as (string | number)[]) : undefined,
      default: p.default,
      minimum: typeof p.minimum === 'number' ? p.minimum : undefined,
      maximum: typeof p.maximum === 'number' ? p.maximum : undefined,
    };
  }
  const required = Array.isArray(input.required) ? input.required.map(String) : [];
  let blocker: string | null = null;
  if (!props.prompt) blocker = 'Takes no text prompt';
  else {
    const missing = required.find((r) => r !== 'prompt' && !fillable(props[r]));
    if (missing) blocker = `Needs ${missing.replaceAll('_', ' ')}`;
  }
  return { props, required, blocker };
}

// Where image-to-video endpoints take their start frame, in order of preference.
const IMAGE_KEYS = [
  'image_url',
  'start_image_url',
  'first_frame_url',
  'first_frame_image',
  'image',
  'input_image_url',
  'reference_image_url',
  'image_urls',
];
export const imageKeyOf = (spec: InputSpec) => IMAGE_KEYS.find((k) => spec.props[k]) ?? null;

/** Why an endpoint cannot run in this mode from a prompt (and, for image mode, one start image). */
export function blockerFor(spec: InputSpec, mode: 'text' | 'image'): string | null {
  if (!Object.keys(spec.props).length) return spec.blocker;
  const image = mode === 'image' ? imageKeyOf(spec) : null;
  if (mode === 'image' && !image) return 'Takes no start image';
  if (mode === 'text' && !spec.props.prompt) return 'Takes no text prompt';
  const missing = spec.required.find(
    (r) => r !== 'prompt' && r !== image && !fillable(spec.props[r]),
  );
  return missing ? `Needs ${missing.replaceAll('_', ' ')}` : null;
}

const fillable = (p: SchemaProp | undefined) =>
  Boolean(p && (p.default !== undefined || p.enum?.length || p.type === 'boolean'));

const numberIn = (v: string | number) => {
  if (typeof v === 'number') return v;
  const m = /^(\d+(?:\.\d+)?)\s*s?$/i.exec(v.trim());
  return m ? Number(m[1]) : null;
};
const nearest = <T>(options: T[], score: (o: T) => number) =>
  options.reduce((best, o) => (score(o) < score(best) ? o : best));

const ratioOf = (a: string) => {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(a);
  return m ? Number(m[1]) / Number(m[2]) : null;
};
const pixelsOf = (r: string) => {
  const k = /^(\d)k$/i.exec(r);
  if (k) return { 1: 1080, 2: 1440, 4: 2160 }[Number(k[1])] ?? Number(k[1]) * 540;
  const p = /(\d{3,4})/.exec(r);
  return p ? Number(p[1]) : null;
};

const AUDIO_KEYS = ['generate_audio', 'audio', 'enable_audio', 'with_audio'];

export function buildGenericInput(spec: InputSpec, s: BenchSettings, image?: string) {
  const { props } = spec;
  const input: Json = props.prompt || !image ? { prompt: s.prompt } : {};
  const used: UsedSettings = { duration: null, aspectRatio: null, resolution: null, audio: null };
  const imageKey = image ? imageKeyOf(spec) : null;
  if (image && imageKey) input[imageKey] = imageKey === 'image_urls' ? [image] : image;

  for (const name of spec.required) {
    if (name === 'prompt' || name === imageKey || !props[name]) continue;
    const p = props[name];
    input[name] = p.default !== undefined ? p.default : p.enum?.length ? p.enum[0] : false;
  }

  const aspect = props.aspect_ratio;
  if (image) {
    // A start image sets the frame. Ask for it explicitly where the model offers that.
    const follow = aspect?.enum?.find((v) => v === 'auto' || v === 'adaptive');
    if (follow) input.aspect_ratio = follow;
    used.aspectRatio = 'from image';
  } else if (aspect) {
    const options = (aspect.enum ?? []).filter(
      (v): v is string => typeof v === 'string' && ratioOf(v) !== null,
    );
    const want = ratioOf(s.aspectRatio)!;
    if (!aspect.enum) input.aspect_ratio = s.aspectRatio;
    else if (options.length)
      input.aspect_ratio = options.includes(s.aspectRatio)
        ? s.aspectRatio
        : nearest(options, (o) => Math.abs(Math.log(ratioOf(o)! / want)));
    if (typeof input.aspect_ratio === 'string') used.aspectRatio = input.aspect_ratio;
  }

  const duration = props.duration;
  if (duration) {
    if (duration.enum?.length) {
      const options = duration.enum.filter((v) => numberIn(v) !== null);
      if (options.length) {
        const pick = nearest(options, (o) => Math.abs(numberIn(o)! - s.duration));
        input.duration = pick;
        used.duration = numberIn(pick);
      }
    } else if (duration.type === 'integer' || duration.type === 'number') {
      const lo = duration.minimum ?? 1;
      const hi = duration.maximum ?? 60;
      const v = Math.min(hi, Math.max(lo, s.duration));
      input.duration = duration.type === 'integer' ? Math.round(v) : v;
      used.duration = Number(input.duration);
    }
  } else if (
    props.num_frames &&
    (props.num_frames.type === 'integer' || props.num_frames.type === 'number')
  ) {
    const fpsProp = props.frames_per_second ?? props.fps;
    const fps = typeof fpsProp?.default === 'number' ? fpsProp.default : 24;
    const lo = props.num_frames.minimum ?? 1;
    const hi = props.num_frames.maximum ?? 1000;
    // Most frame-count models want 4n+1 frames (81 at 16 fps is five seconds).
    const frames = Math.min(hi, Math.max(lo, Math.round(s.duration * fps) + 1));
    input.num_frames = frames;
    used.duration = Math.round(((frames - 1) / fps) * 10) / 10;
  }

  const resolution = props.resolution;
  if (resolution?.enum?.length) {
    const options = resolution.enum.filter(
      (v): v is string => typeof v === 'string' && pixelsOf(v) !== null,
    );
    const exact = options.find((o) => o.toLowerCase() === s.resolution.toLowerCase());
    const want = pixelsOf(s.resolution)!;
    const pick =
      exact ??
      (options.length ? nearest(options, (o) => Math.abs(pixelsOf(o)! - want)) : undefined);
    if (pick) {
      input.resolution = pick;
      used.resolution = pick;
    }
  } else if (typeof resolution?.default === 'string') used.resolution = resolution.default;

  const audioKey = AUDIO_KEYS.find((k) => props[k]?.type === 'boolean');
  if (audioKey) {
    input[audioKey] = s.audio;
    used.audio = s.audio;
  } else if (props.sound?.enum?.includes('on') && props.sound.enum.includes('off')) {
    // Kling on Higgsfield takes sound as "on" or "off".
    input.sound = s.audio ? 'on' : 'off';
    used.audio = s.audio;
  }
  if (s.seed !== null && (props.seed?.type === 'integer' || props.seed?.type === 'number'))
    input.seed = s.seed;

  // Fill defaults the request did not set, so `used` reports what the model will really do.
  if (used.duration === null && duration)
    used.duration = numberIn((duration.default as string | number) ?? '') ?? null;
  if (used.aspectRatio === null && typeof aspect?.default === 'string')
    used.aspectRatio = aspect.default;
  return { input, used };
}

/** Cents for one render at fal's published unit price, or null when the unit cannot be predicted. */
export function centsForUnit(unit: string, unitPrice: number, seconds: number | null) {
  const u = unit.toLowerCase().trim();
  let dollars: number | null = null;
  if (/^(seconds?|second of video|video seconds?|s)$/.test(u)) dollars = unitPrice * (seconds ?? 5);
  else if (/^(videos?|requests?|generations?|clips?|calls?)$/.test(u)) dollars = unitPrice;
  else if (/^(\d+)\s*seconds?$/.test(u))
    dollars = unitPrice * Math.ceil((seconds ?? 5) / Number(/^(\d+)/.exec(u)![1]));
  return dollars === null ? null : Math.max(1, Math.ceil(dollars * 100 - 1e-9));
}

// Higgsfield publishes each endpoint's request parameters on its docs page as
// `<ParamField body="name" type="..." default="..." required>` blocks with "Allowed values",
// "Minimum" and "Maximum" lines. Nested fields (`a[].b`) are skipped. The result feeds the same
// snapping as fal's schemas.
export function parseHiggsfieldParams(markdown: string): InputSpec {
  const props: Record<string, SchemaProp> = {};
  const required: string[] = [];
  const re = /<ParamField\s+([^>]*)>([\s\S]*?)<\/ParamField>/g;
  for (let m = re.exec(markdown); m; m = re.exec(markdown)) {
    const attrs = m[1];
    const name = /body="([^"]+)"/.exec(attrs)?.[1];
    if (!name || /[[.]/.test(name) || props[name]) continue;
    const type = /type="([^"]+)"/.exec(attrs)?.[1];
    const rawDefault = /default="([^"]*)"/.exec(attrs)?.[1];
    const body = m[2].split('<Expandable')[0];
    const allowed = /Allowed values:\s*(.+)/.exec(body)?.[1];
    const enumValues = allowed
      ? [...allowed.matchAll(/`"?([^`"]+)"?`/g)].map((x) => x[1])
      : undefined;
    const min = /Minimum:\s*`(-?[\d.]+)`/.exec(body)?.[1];
    const max = /Maximum:\s*`(-?[\d.]+)`/.exec(body)?.[1];
    const numeric = type === 'integer' || type === 'number';
    props[name] = {
      type,
      enum: enumValues?.length ? (numeric ? enumValues.map(Number) : enumValues) : undefined,
      default:
        rawDefault === undefined
          ? undefined
          : numeric
            ? Number(rawDefault)
            : type === 'boolean'
              ? rawDefault === 'true'
              : rawDefault,
      minimum: min === undefined ? undefined : Number(min),
      maximum: max === undefined ? undefined : Number(max),
    };
    if (/\brequired\b/.test(attrs)) required.push(name);
  }
  let blocker: string | null = null;
  if (!props.prompt)
    blocker = Object.keys(props).length
      ? 'Takes no text prompt'
      : 'Higgsfield did not publish this model’s parameters';
  else {
    const missing = required.find(
      (r) =>
        r !== 'prompt' &&
        !(
          props[r] &&
          (props[r].default !== undefined || props[r].enum?.length || props[r].type === 'boolean')
        ),
    );
    if (missing) blocker = `Needs ${missing.replaceAll('_', ' ')}`;
  }
  return { props, required, blocker };
}

// Higgsfield's estimate answers some models (Wan 3.0, Seedance) with a pricing rule instead of a
// dollar figure. Two shapes are published: dollars per generated second by resolution, and
// dollars per 1,000 video tokens where tokens = ceil(seconds × width × height × 24 / 1024).
// Returns cents for this request, or null when the rule is not one of those.
const RES = '(?:\\d{3,4}p|4K)';
const RES_LIST = `(${RES}(?:\\s*(?:/|,|or|and)\\s*${RES})*)`;
const SHORT_SIDE: Record<string, number> = { '480p': 480, '720p': 720, '1080p': 1080, '4k': 2160 };
const rateFor = (text: string, resolution: string) => {
  const want = resolution.toLowerCase();
  const pairs: [string, number][] = [];
  for (const m of text.matchAll(new RegExp(`${RES_LIST}\\s*\\$(\\d+(?:\\.\\d+)?)`, 'gi')))
    pairs.push([m[1], Number(m[2])]);
  for (const m of text.matchAll(new RegExp(`\\$(\\d+(?:\\.\\d+)?)\\s*at\\s*${RES_LIST}`, 'gi')))
    pairs.push([m[2], Number(m[1])]);
  const hit = pairs.find(([list]) => list.toLowerCase().match(new RegExp(`\\b${want}\\b`)));
  return hit ? hit[1] : null;
};
export function centsFromRateDescription(
  description: string,
  d: { duration: number; resolution: string; aspectRatio: string },
) {
  const sentences = description.split(/(?<=\.)\s+/);
  const tokenSentence = sentences.find((s) => /1,?000 video tokens/i.test(s));
  if (tokenSentence) {
    const rate = rateFor(tokenSentence, d.resolution);
    const side = SHORT_SIDE[d.resolution.toLowerCase()];
    const [w, h] = d.aspectRatio.split(':').map(Number);
    if (rate === null || !side || !w || !h) return null;
    const long = Math.round((side * Math.max(w, h)) / Math.min(w, h));
    const tokens = Math.ceil((d.duration * side * long * 24) / 1024);
    return Math.max(1, Math.ceil((tokens / 1000) * rate * 100 - 1e-9));
  }
  const secondSentence = sentences.find((s) => /per (generated )?second/i.test(s));
  if (secondSentence) {
    const rate = rateFor(secondSentence, d.resolution);
    return rate === null ? null : Math.max(1, Math.ceil(rate * d.duration * 100 - 1e-9));
  }
  return null;
}
