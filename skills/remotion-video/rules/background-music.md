---
name: background-music
description: Generate royalty-free background music for a video from a mood/style, with no API key
metadata:
  tags: music, audio, background, procedural, generate, soundtrack, style
---

# Generating background music

Remotion plays audio files — it does not compose music. To give a video an
original background track **with no API key and no model download**, generate the
music procedurally with a self-contained synthesis script (pure JS → WAV, zero
dependencies), save it to `public/`, then play it with `<Audio>`.

This produces a tasteful synth/ambient/lo-fi **background bed** — ideal for promos
and intros. It is not a radio-produced song.

## Two ways to do this — your choice

1. **Use the preset script below** — pick a built-in `STYLE` (or tweak its `cfg`
   values). Fastest, gives reliably distinct moods. Good default.
2. **Write your own synthesis script** — the script is plain JS you own. If a
   style needs a sound the presets can't make (e.g. orchestral, a build/drop, an
   arpeggio melody, a specific genre), compose your own using the same primitives
   (see *Going further* below) or from scratch. Decide based on the brief.

## Step 1 — Pick a style

| Style | Feel |
|---|---|
| `tech-promo` | Energetic, modern, driving (124 BPM, saw pad, kick+hats) |
| `corporate-calm` | Mellow, professional, no drums (88 BPM, sine) |
| `cinematic` | Slow, dramatic, long pads (72 BPM) |
| `lofi` | Relaxed, swung, warm (78 BPM, kick+hats) |
| `playful` | Upbeat, bright, square-wave (128 BPM) |

To customize, edit the chosen entry's `cfg` (tempo, key `root`, `padWave`/`arpWave`
of `sine|triangle|sawtooth|square`, `cutoff` brightness, `delayWet` space, `swing`,
`kick`/`hats`, `arpSteps` density, gains, and the `prog` chord progression).

## Step 2 — Write `scripts/generate-music.mjs` and run it

Run `node scripts/generate-music.mjs <style>` (default `tech-promo`). No install
needed. It writes `public/music/bg.wav`.

```js
import { mkdirSync, writeFileSync } from "node:fs";

const SR = 44100;

// chord shapes (semitone intervals from the chord root)
const MINOR = [0, 3, 7, 10];   // minor 7
const MAJOR = [0, 4, 7, 11];   // major 7
const MINTRI = [0, 3, 7];
const MAJTRI = [0, 4, 7];

// ===== STYLE PRESETS — pick by name (arg), or edit a cfg, or write your own =====
const STYLES = {
  "tech-promo":     { bpm: 124, root: 45, bars: 16, padWave: "sawtooth", arpWave: "triangle", cutoff: 2600, delayWet: 0.18, swing: 0,    kick: true,  hats: true,  arpSteps: 8, padGain: 0.06, arpGain: 0.11, bassGain: 0.26, prog: [[0, MINOR], [-2, MAJTRI], [3, MAJTRI], [-4, MAJOR]] },
  "corporate-calm": { bpm: 88,  root: 48, bars: 16, padWave: "sine",     arpWave: "sine",     cutoff: 1800, delayWet: 0.25, swing: 0,    kick: false, hats: false, arpSteps: 4, padGain: 0.10, arpGain: 0.07, bassGain: 0.20, prog: [[0, MAJOR], [5, MAJTRI], [-3, MINOR], [2, MAJTRI]] },
  "cinematic":      { bpm: 72,  root: 41, bars: 16, padWave: "sawtooth", arpWave: "sine",     cutoff: 1400, delayWet: 0.30, swing: 0,    kick: false, hats: false, arpSteps: 2, padGain: 0.12, arpGain: 0.05, bassGain: 0.22, prog: [[0, MINTRI], [3, MAJTRI], [-4, MAJTRI], [0, MINOR]] },
  "lofi":           { bpm: 78,  root: 45, bars: 16, padWave: "triangle", arpWave: "triangle", cutoff: 1200, delayWet: 0.22, swing: 0.12, kick: true,  hats: true,  arpSteps: 6, padGain: 0.08, arpGain: 0.09, bassGain: 0.24, prog: [[0, MINOR], [5, MAJOR], [-2, MAJOR], [3, MINOR]] },
  "playful":        { bpm: 128, root: 48, bars: 16, padWave: "square",   arpWave: "square",   cutoff: 3000, delayWet: 0.12, swing: 0,    kick: true,  hats: true,  arpSteps: 8, padGain: 0.05, arpGain: 0.10, bassGain: 0.24, prog: [[0, MAJTRI], [5, MAJTRI], [-4, MINTRI], [2, MAJTRI]] },
};

const STYLE = process.argv[2] || "tech-promo";
const cfg = STYLES[STYLE] || STYLES["tech-promo"];
const MASTER = 0.9;
// ================================================================================

const spb = 60 / cfg.bpm;
const barSec = spb * 4;
const totalSec = cfg.bars * barSec;
const N = Math.floor(totalSec * SR);

const tone = new Float32Array(N); // pad + arp + bass (gets lowpass)
const perc = new Float32Array(N); // kick + hats (stays punchy)

const midiToFreq = (m) => 440 * 2 ** ((m - 69) / 12);
const osc = (type, ph) => {
  switch (type) {
    case "sine": return Math.sin(2 * Math.PI * ph);
    case "square": return ph < 0.5 ? 1 : -1;
    case "sawtooth": return 2 * ph - 1;
    default: { const s = 2 * ph - 1; return 2 * Math.abs(s) - 1; } // triangle
  }
};

function addNote(target, startSec, durSec, freq, gain, type, attack, release) {
  const s0 = Math.floor(startSec * SR);
  const s1 = Math.min(N, Math.floor((startSec + durSec) * SR));
  const aS = Math.max(1, attack * SR), rS = Math.max(1, release * SR);
  for (let i = s0; i < s1; i++) {
    const t = i - s0;
    let e = t < aS ? t / aS : 1;
    const tr = s1 - i;
    if (tr < rS) e = Math.min(e, tr / rS);
    target[i] += gain * e * osc(type, (freq * (i / SR)) % 1);
  }
}

function addKick(startSec) {
  const dur = 0.18, s0 = Math.floor(startSec * SR), s1 = Math.min(N, s0 + Math.floor(dur * SR));
  for (let i = s0; i < s1; i++) {
    const t = (i - s0) / SR;
    const f = 45 + (110 - 45) * Math.exp(-t * 30);
    perc[i] += 0.7 * Math.exp(-t * 18) * Math.sin(2 * Math.PI * f * t);
  }
}

function addHat(startSec, gain) {
  const dur = 0.05, s0 = Math.floor(startSec * SR), s1 = Math.min(N, s0 + Math.floor(dur * SR));
  for (let i = s0; i < s1; i++) {
    const t = (i - s0) / SR;
    perc[i] += gain * Math.exp(-t * 70) * (Math.random() * 2 - 1);
  }
}

for (let bar = 0; bar < cfg.bars; bar++) {
  const [deg, quality] = cfg.prog[bar % cfg.prog.length];
  const chordRoot = cfg.root + deg;
  const t0 = bar * barSec;
  addNote(tone, t0, barSec, midiToFreq(chordRoot - 12), cfg.bassGain, "sine", 0.02, 0.12);
  for (const iv of quality) addNote(tone, t0, barSec, midiToFreq(chordRoot + 12 + iv), cfg.padGain, cfg.padWave, barSec * 0.25, barSec * 0.4);
  const arp = quality.map((iv) => chordRoot + 24 + iv);
  const steps = cfg.arpSteps, stepLen = barSec / steps;
  for (let s = 0; s < steps; s++) {
    const sw = s % 2 === 1 ? cfg.swing * stepLen : 0;
    addNote(tone, t0 + s * stepLen + sw, stepLen * 0.9, midiToFreq(arp[s % arp.length]), cfg.arpGain, cfg.arpWave, 0.005, 0.12);
  }
  if (cfg.kick) for (let b = 0; b < 4; b++) addKick(t0 + b * spb);
  if (cfg.hats) for (let b = 0; b < 4; b++) addHat(t0 + b * spb + spb * 0.5 + cfg.swing * spb * 0.5, 0.08);
}

// one-pole lowpass on the tonal bus (brightness control)
{
  const dt = 1 / SR, rc = 1 / (2 * Math.PI * cfg.cutoff), a = dt / (rc + dt);
  let y = 0;
  for (let i = 0; i < N; i++) { y += a * (tone[i] - y); tone[i] = y; }
}

// mix + feedback delay (space)
const mix = new Float32Array(N);
for (let i = 0; i < N; i++) mix[i] = tone[i] + perc[i];
{
  const d = Math.floor(spb * 0.75 * SR), wet = cfg.delayWet;
  for (let i = d; i < N; i++) mix[i] += wet * mix[i - d];
}

// normalize + fade in/out
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(mix[i]));
const g = peak > 0 ? MASTER / peak : 1;
const fadeIn = Math.floor(0.5 * SR), fadeOut = Math.floor(1.5 * SR);

const out = Buffer.alloc(44 + N * 2);
out.write("RIFF", 0); out.writeUInt32LE(36 + N * 2, 4); out.write("WAVE", 8);
out.write("fmt ", 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
out.write("data", 36); out.writeUInt32LE(N * 2, 40);

for (let i = 0; i < N; i++) {
  let v = mix[i] * g;
  if (i < fadeIn) v *= i / fadeIn;
  if (i > N - fadeOut) v *= (N - i) / fadeOut;
  v = Math.max(-1, Math.min(1, v));
  out.writeInt16LE((v * 32767) | 0, 44 + i * 2);
}

mkdirSync("public/music", { recursive: true });
writeFileSync("public/music/bg.wav", out);
console.log(`Wrote public/music/bg.wav  style=${STYLE} duration=${totalSec.toFixed(1)}s`);
```

## Step 3 — Play it in the composition

The track loops seamlessly, so any video length works. Keep it quiet under the
content and fade it out at the end. Mount this once at the top of the root
composition so it spans every scene:

```tsx
import { Audio } from "@remotion/media";
import { staticFile, useVideoConfig, interpolate } from "remotion";

export const BackgroundMusic = () => {
  const { durationInFrames, fps } = useVideoConfig();
  return (
    <Audio
      src={staticFile("music/bg.wav")}
      loop
      volume={(f) =>
        interpolate(
          f,
          [0, fps, durationInFrames - fps, durationInFrames],
          [0, 0.16, 0.16, 0], // fade in 1s, hold at 16%, fade out 1s
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        )
      }
    />
  );
};
```

## Going further — write your own / extend the engine

The script is yours to modify. You are not limited to the presets. Available
primitives you can reuse or rewrite:

- **Oscillators** — `osc(type, phase)` for `sine | triangle | sawtooth | square`.
- **`addNote(buffer, start, dur, freq, gain, type, attack, release)`** — a
  pitched voice with a linear ADSR-style envelope. Write into `tone` (filtered)
  or a buffer of your own.
- **`addKick` / `addHat`** — drum voices into the `perc` bus.
- **One-pole lowpass** — brightness via `cutoff`.
- **Feedback delay** — space/echo via `delayWet`.
- **`midiToFreq(m)`** — MIDI note → Hz. Build melodies, counter-lines, basslines.

To extend: add new instruments (e.g. a pluck melody, a pad swell, noise risers),
add song **sections** (intro → build → main → outro by varying gains/density per
bar range), use richer chords (9ths, sus), add a second delay/reverb tap, or
replace the arrangement entirely. If the brief needs a sound the presets can't
reach, prefer writing a custom script over forcing a preset.

## Notes

- **No dependencies, no key, no model download** — uses only Node built-ins, so it
  runs on any machine that already has Node.
- To shrink the file, convert: `npx remotion ffmpeg -i public/music/bg.wav public/music/bg.mp3` and point `<Audio>` at the `.mp3` (no separate ffmpeg install needed).
- Keep music volume low (0.12–0.2) so it sits under titles and any SFX (see [sfx.md](sfx.md)).
- Regenerate with a different style/params to A/B moods quickly.
