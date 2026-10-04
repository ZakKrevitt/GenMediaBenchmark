import { z } from 'zod';

// Shot direction shared by the tuned models: camera move, framing, duration, references.
// Everything here is pure so the prompt a shot was rendered from is reproducible and testable.

export const MOVES = ['in', 'out', 'left', 'right', 'static', 'free'] as const;
export const DOLLY_MOVES = ['in', 'out', 'left', 'right'] as const;
export const FRAMINGS = ['extreme-wide', 'wide', 'medium', 'close', 'extreme-close'] as const;
export const ASPECTS = ['9:16', '16:9', '21:9', '1:1', '3:4'] as const;
export const RESOLUTIONS = ['480p', '720p', '1080p'] as const;
export const REFERENCE_KINDS = ['character', 'location', 'prop', 'style'] as const;
export const PROVIDERS = ['fal', 'higgsfield'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const MAX_REFERENCES = 6;

export type Move = (typeof MOVES)[number];
export type Framing = (typeof FRAMINGS)[number];

export const moveInfo: Record<Move, { name: string; summary: string; reference: string }> = {
  in: {
    name: 'Dolly in',
    summary: 'The camera travels toward the subject. Tension builds as the world falls away.',
    reference: 'The slow push on a face at the moment of decision',
  },
  out: {
    name: 'Dolly out',
    summary: 'The camera pulls back from a close shot and reveals where the subject really is.',
    reference: 'The pull back that ends on a lone figure in a vast space',
  },
  left: {
    name: 'Dolly left',
    summary: 'The camera trucks sideways to the left, past a scene that keeps unfolding.',
    reference: 'The lateral tracking shot down a line of events',
  },
  right: {
    name: 'Dolly right',
    summary: 'The camera trucks sideways to the right while the background keeps changing.',
    reference: 'A subject held in frame while the world scrolls past',
  },
  static: {
    name: 'Locked off',
    summary: 'The camera stays on a tripod. Only the action moves, so the performance carries the shot.',
    reference: 'A held frame that lets the scene play out',
  },
  free: {
    name: 'Model decides',
    summary: 'No camera direction is added. The model, or your first and last frames, choose the motion.',
    reference: 'Leave the camera to the prompt',
  },
};

export const framingName: Record<Framing, string> = {
  'extreme-wide': 'Extreme wide',
  wide: 'Wide',
  medium: 'Medium',
  close: 'Close-up',
  'extreme-close': 'Extreme close-up',
};
const framingPhrase: Record<Framing, string> = {
  'extreme-wide': 'an extreme wide shot where the subject is small in a large environment',
  wide: 'a wide shot showing the subject head to toe within the location',
  medium: 'a medium shot framed from the waist up',
  close: 'a close-up framed on the face and shoulders',
  'extreme-close': 'an extreme close-up on the eyes',
};

export const SPEEDS = ['creep', 'steady', 'swift'] as const;
export const speedName = { creep: 'Creep', steady: 'Steady', swift: 'Swift' } as const;
const speedPhrase = {
  creep: 'a slow, deliberate creep that is barely perceptible yet never stops',
  steady: 'a smooth, constant speed like an experienced dolly grip on rails',
  swift: 'a fast, energetic glide at a constant velocity',
} as const;

export const LENSES = ['24mm', '35mm', '50mm', '85mm'] as const;
const lensPhrase = {
  '24mm': '24mm wide lens, deep focus, exaggerated parallax between foreground and background',
  '35mm': '35mm lens, natural perspective, moderate depth of field',
  '50mm': '50mm lens, true-to-eye perspective, gentle background separation',
  '85mm': '85mm lens, compressed background, shallow depth of field with soft bokeh',
} as const;

export const SUBJECT_MODES = ['tracks', 'anchored', 'none'] as const;
export const subjectModeInfo = {
  tracks: { name: 'Subject tracks', detail: 'Held in frame while the background passes' },
  anchored: { name: 'Subject stays', detail: 'The camera glides past a still subject' },
  none: { name: 'No hero', detail: 'The camera passes a sequence of moments' },
} as const;

const text = (max: number) => z.string().trim().max(max);
// The direction is provider-neutral. Which durations, frames and resolutions are allowed
// depends on the chosen model, so `checkForModel` in production-models.ts finishes the job.
export const directionSchema = z
  .object({
    move: z.enum(MOVES),
    scene: text(1200).default(''),
    subject: text(400).default(''),
    character: text(800).default(''),
    beats: z.array(text(200).min(1)).max(4).default([]),
    subjectMode: z.enum(SUBJECT_MODES).default('tracks'),
    startFraming: z.enum(FRAMINGS).default('wide'),
    endFraming: z.enum(FRAMINGS).default('close'),
    speed: z.enum(SPEEDS).default('steady'),
    lens: z.enum(LENSES).default('35mm'),
    look: text(600).default(''),
    sound: text(400).default(''),
    avoid: text(400).default(''),
    aspectRatio: z.enum(ASPECTS).default('9:16'),
    duration: z.number().int().min(2).max(20).default(8),
    resolution: z.enum(RESOLUTIONS).default('1080p'),
    provider: z.enum(PROVIDERS).default('fal'),
    model: z.string().regex(/^[a-z0-9.-]{2,60}$/).default('seedance-2.0'),
    audio: z.boolean().default(true),
    seed: z.number().int().min(0).max(2147483647).nullable().default(null),
    referenceIds: z.array(z.string().uuid()).max(MAX_REFERENCES).default([]),
    firstFrameId: z.string().uuid().nullable().default(null),
    lastFrameId: z.string().uuid().nullable().default(null),
    promptOverride: text(3500).default(''),
  })
  .superRefine((d, ctx) => {
    const order = (f: Framing) => FRAMINGS.indexOf(f);
    if (d.move === 'in' && order(d.startFraming) >= order(d.endFraming))
      ctx.addIssue({ code: 'custom', path: ['endFraming'], message: 'A dolly in ends closer than it starts' });
    if (d.move === 'out' && order(d.startFraming) <= order(d.endFraming))
      ctx.addIssue({ code: 'custom', path: ['endFraming'], message: 'A dolly out ends wider than it starts' });
    // Your own prompt replaces the directed one, so the scene is only needed without it.
    if (!d.promptOverride && d.scene.length < 3)
      ctx.addIssue({ code: 'custom', path: ['scene'], message: 'Describe the scene' });
    if (d.lastFrameId && !d.firstFrameId)
      ctx.addIssue({ code: 'custom', path: ['lastFrameId'], message: 'Add a first frame before a last frame' });
  });
export type Direction = z.infer<typeof directionSchema>;
export type StudioReference = { id: string; name: string; kind: (typeof REFERENCE_KINDS)[number] };

const referencePhrase = {
  character:
    'keep the face, hair, skin, wardrobe and build identical to the reference in every frame; take only their identity from it, never its plain backdrop, pose or framing',
  location: 'match its architecture, materials and light',
  prop: 'reproduce this object faithfully wherever it appears',
  style: 'match its colour palette, grade and texture without copying its content',
} as const;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Seedance addresses references as @Image1..n. Names the user types are tagged inline.
export function tagReferences(value: string, refs: StudioReference[]) {
  return refs.reduce(
    (out, ref, i) =>
      out.replace(
        new RegExp(`(^|[^\\p{L}\\p{N}@])(${escapeRegExp(ref.name)})(?![\\p{L}\\p{N}])(?! \\(@Image)`, 'giu'),
        `$1$2 (@Image${i + 1})`,
      ),
    value,
  );
}

const sentence = (value: string) => {
  const v = value.trim();
  return v && !/[.!?]$/.test(v) ? `${v}.` : v;
};

export type CompileOptions = { negativeParam?: boolean };
export function compilePrompt(d: Direction, refs: StudioReference[] = [], options: CompileOptions = {}) {
  const tag = (value: string) => tagReferences(value, refs);
  const subject = d.subject ? tag(d.subject) : '';
  const who = subject ? 'the subject' : 'the scene';
  const lines: string[] = [
    'One continuous shot: a single unbroken take with no cuts, no edits and no scene changes.',
  ];
  if (d.firstFrameId)
    lines.push(
      d.lastFrameId
        ? 'The shot opens exactly on the supplied first frame and lands exactly on the supplied last frame; move naturally between them.'
        : 'The shot opens exactly on the supplied first frame and continues from it.',
    );
  if (d.move === 'static') {
    lines.push('Camera: locked off on a tripod. No camera movement, no zoom; only the action moves.');
  } else if (d.move === 'free') {
    // No camera direction: the model or the frames decide.
  } else if (d.move === 'in' || d.move === 'out') {
    const verb =
      d.move === 'in'
        ? `a physical dolly push-in. The camera travels forward on a track toward ${who}`
        : `a physical dolly pull-out. The camera travels backward on a track away from ${who}`;
    lines.push(
      `Camera movement: ${verb}, starting on ${framingPhrase[d.startFraming]} and ending on ${framingPhrase[d.endFraming]}.`,
      'The camera body moves through space, it is not a zoom: perspective and parallax shift naturally as it travels.',
      d.move === 'out'
        ? 'As the camera retreats, more of the surrounding environment is revealed at the edges of the frame.'
        : 'As the camera advances, the surroundings slide out past the edges of the frame.',
    );
  } else {
    const travel = d.move === 'right' ? 'from left to right' : 'from right to left';
    const enters = d.move === 'right' ? 'right' : 'left';
    const exits = d.move === 'right' ? 'left' : 'right';
    lines.push(
      `Camera movement: a lateral dolly (trucking shot). The camera travels sideways ${travel} on a track parallel to the scene at a constant height.`,
      'The lens stays perpendicular to the direction of travel: no panning, no rotation, no zoom. Foreground layers slide past faster than the background.',
    );
    if (d.subjectMode === 'tracks')
      lines.push(
        `${subject ? 'The subject' : 'The main subject'} moves ${d.move === 'right' ? 'right' : 'left'} at exactly the camera's pace and holds the same position in frame for the whole shot while the world behind scrolls past.`,
      );
    else if (d.subjectMode === 'anchored')
      lines.push(
        `${subject ? 'The subject' : 'The main subject'} stays still in the foreground. The camera glides past, so they drift across the frame toward the ${exits} edge.`,
      );
    else lines.push('There is no single hero subject: the camera passes a sequence of moments laid out along its path.');
    if (d.beats.length)
      lines.push(
        `New moments enter from the ${enters} edge of the frame and leave past the ${exits} edge.`,
      );
  }
  if ((DOLLY_MOVES as readonly string[]).includes(d.move))
    lines.push(`The move has ${speedPhrase[d.speed]}, runs from the first frame to the last and never stops.`);
  if (subject) lines.push(`Subject: ${sentence(subject)}`);
  // Reference-driven models default to the reference's stiff catalogue pose. Ask for life.
  if (subject || d.character || refs.some((r) => r.kind === 'character'))
    lines.push(
      subject
        ? 'They stay in natural, continuous motion through the whole shot, never a frozen pose.'
        : 'The character is alive and in motion through the whole shot: they move through the space, shift their weight, turn and gesture naturally. Never a frozen or posed stance.',
    );
  if (d.character) lines.push(`Character: ${sentence(tag(d.character))} Keep this appearance identical in every frame.`);
  lines.push(`Scene: ${sentence(tag(d.scene))}`);
  if (d.beats.length) {
    const order = ['First', 'Then', 'Then', 'Finally'];
    const beats = d.beats.map((b, i) =>
      `${i === d.beats.length - 1 && i > 0 ? 'Finally' : order[i]}, ${sentence(tag(b)).replace(/^\p{Lu}/u, (c) => c.toLowerCase())}`,
    );
    lines.push(`In the background, in order as the camera moves: ${beats.join(' ')}`);
  }
  if (refs.length)
    lines.push(
      `References: ${refs
        .map((r, i) => `@Image${i + 1} is ${r.name} (${r.kind}); ${referencePhrase[r.kind]}.`)
        .join(' ')}`,
    );
  if (d.move !== 'free') lines.push(`Lens: ${lensPhrase[d.lens]}.`);
  lines.push(
    `Style: ${sentence(d.look ? tag(d.look) : 'Cinematic and photographic, motivated lighting, natural motion blur, level horizon')}${d.move === 'free' ? '' : ' Stabilized camera with no shake.'}`,
  );
  lines.push(
    d.audio
      ? d.sound
        ? `Sound: ${sentence(tag(d.sound))}`
        : 'Sound: natural ambience of the location only. No music and no narration.'
      : 'Silent.',
  );
  lines.push('No on-screen text, captions, logos or watermarks.');
  if (d.avoid && !options.negativeParam) lines.push(`Avoid: ${sentence(d.avoid)}`);
  return lines.join('\n');
}

// The brief for a composed first frame: the cast placed into the scene, mid-action, at the
// framing the shot opens on. It replaces the plain-backdrop reference as the opening image.
export function firstFrameBrief(d: Direction) {
  const framing =
    d.move === 'in' || d.move === 'out' ? framingPhrase[d.startFraming] : 'a medium-wide shot showing the subject within the location';
  const who = d.subject.trim() || 'The character, caught mid-movement';
  return [
    `Opening frame, ${framing}.`,
    sentence(who),
    d.character.trim() ? sentence(d.character) : '',
    `Setting: ${sentence(d.scene || 'the scene')}`,
    'A candid moment inside the scene, lit by its own light, not a posed portrait and not a studio backdrop.',
    d.move !== 'free' ? `${lensPhrase[d.lens]}.` : '',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 800);
}

export const dailyCapCents = () => {
  const cap = Number(process.env.STUDIO_DAILY_CENTS ?? 5000);
  return Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : 5000;
};

export function promptFor(d: Direction, refs: StudioReference[], options: CompileOptions = {}) {
  return d.promptOverride ? d.promptOverride : compilePrompt(d, refs, options);
}
