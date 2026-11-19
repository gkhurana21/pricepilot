# PricePilot: the agent suggests, the rules decide (a paper-collage film)

An explainer of 92 seconds, drawn frame by frame in an HTML canvas with plain JavaScript. There is no
stock art, no video, no image generation: every piece of paper, every torn edge, the grain, the
characters and the lettering are cut by code in `src/`, and the music and sound effects are
synthesised by `audio.mjs`. The only things not made here are the narration (a text-to-speech
voice), two open-licensed fonts, and six photographs of the real app.

**Most of it is an illustration of an idea, not footage of the product.** The coffee stall, the bird,
the gate, the rulebook and the stamps are a picture of how PricePilot works.

**Scene 6 (39 to 78 s) is the real app.** Six screenshots of the embedded app in the Shopify admin,
from the development-store run of 2026-11-18, are shown as photographs: printed large on white
paper, dealt onto the desk one on top of another, each labelled "the real app" by hand. They are
`assets/img/app/shot_1.jpg` to `shot_6.jpg` (1470 x 668), in the app's own order, and they are not
retouched: each is drawn whole, scaled to 1440 px wide, and nothing else is done to it. What is
added is pencil in the blank gaps and margins beside the app's words, never on them (a ring round
a badge, a line under a phrase, a brace or a tick in the margin), and two paper buttons under the
print, "apply" and "roll back", which a paper hand presses.

The pace of this scene is set by the pencil, not by a target length. Every mark is drawn slowly
enough to follow and then stays in full view for at least 1.8 s; every print is on screen for at
least 4.5 s; and the voice is laid out in phrases around that, so that it names a thing, the print
lands, and the pencil marks it. `npm run pace` checks those rules from the timeline.

| Seconds | On the desk | What the pencil marks, in order |
|---|---|---|
| 39.3 - 54.5 | 1. Preview: "Preview, not applied", the yellow "Synthetic order history" notice, the summary line, "Held back: proposed, and the policy refused" | a ring round the notice; a line under the "Held back" heading; a ring round "Change too small"; a brace beside the six reasons; a line under "4 adjusted by a guardrail" |
| 54.5 - 59.1 | 2. "Adjusted by a guardrail" (Ethiopia $19.00 to $16.99) | a line under the heading; a ring round "Largest decrease per run"; a line under "model proposed $14.99" |
| 59.1 - 63.5 | 3. "Accepted" ("Every guardrail passed...", Brazil) | a line under the heading; a brace beside the lines under it; a ring round "Rounded to .99" |
| 63.5 - 68.6 | 4. Apply report | a line under "5 of 5 verified by re-reading prices from Shopify"; a tick beside each "verified", one at a time |
| 68.6 - 72.9 | 5. "Roll back this run?" | a line under "This restores every price the run changed to its previous value."; a ring round "Yes, roll back" |
| 72.9 - 78 | 6. Rollback report | a line under "5 restored, 0 skipped, 0 failed"; a tick beside each of the five "Restored" badges, one at a time; a brace gathering the five |

## Watch or render it

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm install                 # playwright-core only; it drives the Chrome already on the machine

npm run preview             # http://localhost:4173/  real-time preview with sound (space = play)
npm run render              # node audio.mjs && node render.mjs  ->  out/pricepilot-collage.mp4
```

`render.mjs` opens `index.html` in headless Chrome (six tabs, software canvas, so that every tab
draws exactly the same pixels; `node tools/same.mjs` checks it), calls `renderAt(frame / 60)` for every frame,
and hands the frames and `out/audio/mix.wav` to ffmpeg (H.264 High, yuv420p, crf 15, 60 fps,
AAC 192 kb/s, faststart). `renderAt(t)` is deterministic: all randomness is seeded and nothing
depends on the frame drawn before, so the same `t` always gives the same pixels
(`npm run smooth` checks this, and measures per-frame motion).

| File | What it does |
|---|---|
| `src/script.js` | The narration, line by line, and the pauses between lines |
| `src/timeline.js` | The film's clock, built from the measured length of each narration clip |
| `src/lib/paper.js` | Paper: seeded grain, torn / cut / deckled edges, drop shadows, lettering, pencil lines |
| `src/lib/util.js` | Easing, springs, pendulum swings, seeded noise |
| `src/cast.js` | Price tags, the helper (a bird with a pencil), the rulebook, the stamps, the shopkeeper |
| `src/scenes/*.js` | One file per scene: what is on the sheet, how it moves, and which sounds it cues |
| `audio.mjs` | Felt-piano bed, paper / pencil / stamp sounds, ducking, limiter, loudness to -16 LUFS |
| `tts.mjs` | Narration through OpenRouter's speech endpoint, one clip per line, measured with ffprobe |
| `render.mjs`, `serve.mjs` | Frame rendering and a small static server |
| `tools/` | `still.mjs` (single frames), `smooth.mjs` (motion and determinism), `sync.mjs` (words against actions), `pace.mjs` (how long each mark and print is in view in scene 6), `activity.mjs` (second by second: voice, motion, pencil, and the longest stretch with none of them), `phrases.mjs` (cuts a clip into phrases at its own pauses), `voice-check.mjs` (pauses, pitch and peaks of a clip), `or-key.mjs` (key usage, numbers only) |

Picture and sound read the same clock. Change the voice, regenerate the clips, and every scene, cut
and sound effect moves with the words.

## The voice

Narration: **ElevenLabs Eleven v4, voice "george"**, through OpenRouter
(`POST https://openrouter.ai/api/v1/audio/speech`, model `elevenlabs/eleven-v4`), generated
2026-11-19, one clip per line (eleven lines; lines 6 to 9 are the real-app scene). Lines 7 and 9
were then cut into phrases ("Refusals come first, with the reasons listed." / "Then the four prices
a rule pulled back," / "and the one that passed every rule." and "Change your mind," / "and
everything goes back.") by `tools/phrases.mjs`: inside the pauses the voice itself left, at a zero
crossing, with a few milliseconds of fade; no word is altered and nothing was re-synthesised. The
whole clips are kept in `assets/audio/whole/`. The clips are in `assets/audio/` with `VOICE.txt`, the measured
lengths in `clips.json`.

```bash
node --env-file=/path/to/.env tts.mjs --list                                   # speech models
node --env-file=/path/to/.env tts.mjs --audition --model M --voices a,b,c      # lines 1-2 only
node --env-file=/path/to/.env tts.mjs --model elevenlabs/eleven-v4 --voice george
node tools/voice-check.mjs assets/audio/line-*.wav                             # measure the result
```

The key is read from `OPENROUTER_API_KEY` in the process environment and is never printed or written.
`node tts.mjs --backend say --voice Daniel` makes a rough local stand-in with the macOS voice, for
working on the picture without spending anything.

The voice was shortlisted by measurement: four models and nine voices read lines 1-2, and
`tools/voice-check.mjs` measured pace, where the pauses fell, peak level and pitch. George on
Eleven v4 was the slowest that still paused only at the punctuation (about 150 words a minute while
speaking).

## Music and sound

All synthesised in `audio.mjs`; nothing is downloaded. The bed is a soft piano (a few decaying
partials per note, a small reverb) playing F maj7, D min7, B flat maj7, C6, with as many bars (a
multiple of four) as keep one bar near three and a half seconds, timed so its last chord lands as
the name appears. Effects (paper sliding, pencil, stamp, a book set down, the
bird) are filtered noise and short tones placed on cues listed beside each scene's drawing code. The
music drops by 8.5 dB under speech and comes back slowly between phrases; the mix is levelled to -16 LUFS by measurement with ffmpeg's
`ebur128`, behind a look-ahead limiter.

## Where every number comes from

Each one was checked at its source before it went on screen.

| On screen or spoken | Source |
|---|---|
| "1%" and "11%"; "one percent ... eleven" | Marn and Rosiello, "Managing Price, Gaining Profit", Harvard Business Review, Sept-Oct 1992, Exhibit 1: a 1% improvement in price improves operating profit by 11.1% (rounded to eleven); the article states the reverse too, hence "in either direction" |
| "Harvard Business Review, 1992 · average of 2,463 companies · volume held constant" | The same exhibit and its footnote. It is a statement about pricing at large public companies in 1992, not about Shopify merchants and not a claim about PricePilot |
| $20.00, the helper's $17.62, the rulebook's $18.99 "margin floor" (Kenya) | Development-store run of 2026-11-18 |
| $19.00 to $17.99, accepted (Brazil) | The same run. The app lists it under "Accepted" (every rule passed; the price was rounded to a .99 ending) |
| $28.00 stays, "excluded by policy" (Subscription) | The same run: refused, rule "excluded" |
| "62,464,769 tries", "0 violations"; "sixty-two million times" | Fuzz executions and violations reported in `enforcer/README.md` |
| "the four prices a rule pulled back", "the one that passed every rule" (spoken) | The same run: the app's summary line reads "13 products · 9 proposals · 1 accepted · 4 adjusted by a guardrail · 4 held back · 4 no proposal" (print 1), and its "Adjusted by a guardrail" and "Accepted" sections are prints 2 and 3 |
| "each price is read back from Shopify" (spoken) | The same run: the apply report reads "5 written, 0 skipped, 0 failed · 5 of 5 verified by re-reading prices from Shopify" (print 4) |
| "everything goes back" (spoken) | The same run: the rollback report reads "5 restored, 0 skipped, 0 failed · 5 of 5 verified by re-reading prices from Shopify" (print 5) |
| "The order history here is synthetic" (spoken) | The app's own notice on prints 1 and 4: "These estimates come from 90 synthetic orders..." |
| Every figure inside the photographs | The real app's own screen on 2026-11-18, photographed, not drawn |

The arm in scene 1 is drawn to scale: the "1%" tag sits one notch from the hinge and the "11%" eleven
notches out, so the far end really does travel eleven times as far.

## Fonts

Hand lettering uses two fonts under the SIL Open Font License 1.1, with their licence files beside
them in `assets/fonts/`:

- Caveat (variable), The Caveat Project Authors, https://github.com/googlefonts/caveat
- Patrick Hand, Patrick Wagesreiter, distributed by Google Fonts (https://fonts.google.com/specimen/Patrick+Hand)
