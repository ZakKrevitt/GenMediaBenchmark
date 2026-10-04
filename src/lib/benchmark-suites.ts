// Ready-made prompt batteries. Each one stresses a different weakness of video models, so a
// suite run says more than any single prompt. Prompts are concrete and visual, with no brands,
// real people or copyrighted characters.

export type StandardSuite = { id: string; name: string; tests: string; prompts: string[] };

export const STANDARD_SUITES: StandardSuite[] = [
  {
    id: 'motion',
    name: 'Motion and physics',
    tests: 'Liquids, cloth, gravity, collisions and crowds moving believably',
    prompts: [
      'Red wine poured slowly into a clear glass on a wooden table, the liquid swirling and settling, macro shot, soft window light',
      'A white linen sheet on a clothesline snapping and rippling in strong wind on a sunny hillside',
      'A basketball bounces three times on an outdoor court and rolls to a stop against the fence, late afternoon light',
      'Dozens of runners start a city marathon at dawn, the crowd surging forward between barriers, overhead angle',
      'Thick white smoke curls up from a snuffed candle and drifts across a dark room, lit from the side',
    ],
  },
  {
    id: 'people',
    name: 'People and faces',
    tests: 'Faces that stay the same person, hands, bodies and natural expression',
    prompts: [
      'Close-up of a woman in her sixties laughing at something off camera, warm kitchen light, shallow depth of field',
      'Hands of a pianist playing a fast passage on a grand piano, fingers clearly separate, overhead close-up',
      'Two dancers spin and dip together in an empty ballroom, their bodies and limbs staying intact through the turn',
      'A young man walks toward the camera down a rainy street at night, his face lit by shop windows, the shot holding on him',
      'A child blows out birthday candles and grins, family blurred in the background, handheld camera',
    ],
  },
  {
    id: 'camera',
    name: 'Camera moves',
    tests: 'Whether the model follows a named camera move without cutting or warping',
    prompts: [
      'Slow dolly in on a lone chess player at a park table, the background falling away, one continuous shot',
      'The camera orbits a full 180 degrees around a vintage motorcycle parked in a desert, constant height',
      'Drone shot pulling back and rising from a lighthouse to reveal the whole rocky coastline at golden hour',
      'Handheld tracking shot following a cyclist through a busy market from behind, matching their speed',
      'Crane shot rising from street level over a rooftop garden to a wide view of the city skyline at dusk',
    ],
  },
  {
    id: 'detail',
    name: 'Text and fine detail',
    tests: 'Legible lettering, small repeated detail, reflections and textures',
    prompts: [
      'A red neon sign reading OPEN LATE flickers on above a diner door at night, rain on the window, the letters clearly legible',
      'Macro shot of a mechanical watch movement, gears and jewels turning, sharp detail on every tooth',
      'A street chalkboard menu outside a cafe with handwritten prices, the camera slowly panning across it',
      'Rows of tiny origami cranes in every colour hanging from a ceiling, swaying gently, shallow focus',
      'A city at night reflected in the glass of a moving tram window, reflections and passengers layered together',
    ],
  },
  {
    id: 'nightlife',
    name: 'DJ and nightlife',
    tests: 'Low light and fast light: decks, crowds, strobes and lasers',
    prompts: [
      'Close-up of a DJ’s hands on two CDJs and a mixer, riding a fader and nudging a jog wheel, booth lights glowing',
      'A packed warehouse crowd raises their hands as green lasers sweep through haze above them, wide shot from the booth',
      'A vinyl record spins on a turntable while the needle tracks the groove, extreme close-up, red booth light',
      'Strobe lights freeze a dancing crowd in flashes, faces and arms caught mid-motion, low angle from the floor',
      'Sunrise over a rooftop after-party, a DJ finishing a set as the last dancers sway, city waking up behind them',
    ],
  },
];
