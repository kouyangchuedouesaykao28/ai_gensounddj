# 🎛 Neon DJ

A browser-based DJ app built with **HTML + CSS + JavaScript and the Web Audio API** — no frameworks, no build step, no dependencies.

## Run it

Just open `index.html` in any modern browser (Chrome, Edge, Firefox).
Or serve it locally: `npx serve .` / `python -m http.server`
> Tip: browsers require one click/keypress before audio can start (autoplay policy) — click any button first.

## Features

### Dual decks (A & B)
- Load local audio files (click **LOAD FILE** or drag & drop onto a deck) — MP3/WAV/OGG/M4A/FLAC
- Play / Pause, **CUE** point (press CUE while stopped to set it, while playing to jump back)
- **Loop** button with selectable loop length (1/2/4/8 s)
- clickable **waveform** display with playhead + progress bar (click to seek)
- spinning platter indicator, per-deck **TEMPO** 50–200 % (pitch-speed), **VOLUME**
- 3-band **EQ** (LOW / MID / HI) per deck
- equal-power **crossfader** between deck A and deck B
- master volume + live **spectrum visualizer**

### Beat generator (16-step sequencer)
- 5 instrument rows (Kick / Snare / Hat / Clap / Bass note)
- click cells to program, per-row **M** mute
- BPM slider 40–220
- one-click patterns: **HOUSE / HIP-HOP / TECHNO** (+ CLEAR)
- all sounds are synthesized live (no samples needed)

### Synth keys
- One octave (C4–B4) playable with the mouse or the computer keyboard **Z S X C D V G B H N J M**
- waveform selector (saw / square / tri / sine) + resonant-ish filter + volume

### Keyboard shortcuts
| Key | Action |
|-----|--------|
| Q | play/pause deck A |
| A | cue deck A |
| P | play/pause deck B |
| L | cue deck B |
| Z–M | synth keyboard |

### 🤖 AI Composer (offline, built-in)
- 6 learned styles: **House / Hip-Hop / Techno / Drum&Bass / Synthwave / Trap**
- **GENERATE ALL** composes drums, a chord progression, a bassline, and a scale-aware **lead melody** (new LEAD row — the white dash height = pitch)
- **Learning**: every cell you edit adjusts that style's probability model via EMA and persists in `localStorage` ("RESET LEARNING" clears it)
- **INTENSITY** scales pattern and melody density; **EVOLVE** performs live variations while playing: section breaths, hat drops, end-of-bar snare fills, octave bass lifts, rare harmony/melody morphs — your grid stays untouched
- **REGEN MELODY** keeps your drum groove and re-mixes harmony + lead only

### Recording your mix
- **REC** button (top-right) records the full MASTER mixdown (decks + beat generator + synth) to a file
- auto-download on stop as `neondj-mix.webm` / `.ogg` / `.m4a`, depending on browser support
- keyboard shortcut: **R**

## Files
- `index.html` — layout & UI structure
- `style.css` — dark neon theme
- `app.js` — all audio engine & logic (Web Audio API)

## Performance notes
- The renderer **parks itself when idle** (all decks paused, sequencer stopped, audio tails decayed) — zero render work until you press play again
- Waveforms are pre-rendered to offscreen canvases; each update is two GPU blits + a playhead line
- The spectrum visualizer skips painting entirely during silence



echo "# ai_gensounddj" >> README.md
git init
git add README.md
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/kouyangchuedouesaykao28/ai_gensounddj.git
git push -u origin main