/* ============================================================
   NEON DJ — dual deck mixer + beat generator + synth keys
   Built with the Web Audio API (no external libraries).
   ============================================================ */
"use strict";

/* ---------------- audio core ---------------- */
const AC = window.AudioContext || window.webkitAudioContext;
const ctx = new AC();

const masterGain = ctx.createGain();
const analyser = ctx.createAnalyser();
analyser.fftSize = 512;
masterGain.connect(analyser);
analyser.connect(ctx.destination);

const masterVol = document.getElementById("masterVol");
masterGain.gain.value = (masterVol.value / 100) ** 2;
masterVol.addEventListener("input", () => {
  masterGain.gain.setTargetAtTime((masterVol.value / 100) ** 2, ctx.currentTime, 0.02);
});

function resumeCtx() {
  if (ctx.state === "suspended") {
    ctx.resume().then(wakeRender);
  } else {
    wakeRender();
  }
}
document.addEventListener("pointerdown", resumeCtx);
document.addEventListener("keydown", resumeCtx);

/* ---------------- helpers ---------------- */
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
}

/* ============================================================
   DECKS
   ============================================================ */
function deckTemplate(id) {
  return `
    <h2>DECK ${id}</h2>
    <button class="file-btn" data-el="load">📂 LOAD AUDIO FILE<small>click — or drop a file here</small></button>
    <div class="track-name" data-el="title">— no track loaded —</div>
    <div class="display">
      <div class="time-row">
        <span class="time" data-el="tcur">0:00</span>
        <span class="ttot" data-el="ttot">0:00</span>
      </div>
      <div class="bar" data-el="bar"><div class="bar-fill" data-el="barfill"></div></div>
    </div>
    <canvas class="wave" data-el="wave" width="500" height="88"></canvas>
    <div class="platter" data-el="platter"></div>
    <div class="transport">
      <button class="btn play" data-el="play">▶ PLAY</button>
      <button class="btn cue" data-el="cue">⏺ CUE</button>
    </div>
    <div class="transport">
      <button class="btn loop" data-el="loopBtn">🔁 LOOP OFF</button>
      <select class="loop-sel" data-el="loopLen" title="loop length">
        <option value="1">1 s</option>
        <option value="2">2 s</option>
        <option value="4" selected>4 s</option>
        <option value="8">8 s</option>
      </select>
    </div>
    <div class="sliders">
      <label>VOL&nbsp;&nbsp;&nbsp; <input data-el="vol" type="range" min="0" max="100" value="80"></label>
      <label>TEMPO <input data-el="tempo" type="range" min="50" max="200" value="100"><span class="val" data-el="rateTxt">100%</span></label>
    </div>
    <div class="eq">
      <label>LOW&nbsp;&nbsp; <input data-el="low" type="range" min="-12" max="12" value="0"></label>
      <label>MID&nbsp;&nbsp; <input data-el="mid" type="range" min="-12" max="12" value="0"></label>
      <label>HI&nbsp;&nbsp;&nbsp;&nbsp; <input data-el="high" type="range" min="-12" max="12" value="0"></label>
    </div>
    <input type="file" accept="audio/*" hidden data-el="file">
  `;
}

const decks = [];

function makeDeck(id) {
  const root = document.getElementById("deck" + id);
  root.classList.add("tag" + id);
  root.innerHTML = deckTemplate(id);
  const q = (k) => root.querySelector(`[data-el="${k}"]`);

  const d = {
    id,
    root,
    buffer: null,
    peaks: null,
    baseTitle: "— no track loaded —",
    source: null,
    playing: false,
    pos: 0,
    startedAt: 0,
    startOffset: 0,
    gen: 0,
    rate: 1,
    loopOn: false,
    loopStart: 0,
    loopEnd: 4,
    cue: 0,
    g: ctx.createGain(),
    low: ctx.createBiquadFilter(),
    mid: ctx.createBiquadFilter(),
    high: ctx.createBiquadFilter(),
    xg: ctx.createGain(),
  };

  d.low.type = "lowshelf";
  d.low.frequency.value = 200;
  d.mid.type = "peaking";
  d.mid.frequency.value = 1000;
  d.mid.Q.value = 0.8;
  d.high.type = "highshelf";
  d.high.frequency.value = 4000;

  /* source → gain → EQ(3) → crossfade gain → master */
  d.g.connect(d.low);
  d.low.connect(d.mid);
  d.mid.connect(d.high);
  d.high.connect(d.xg);
  d.xg.connect(masterGain);
  d.g.gain.value = 0.64;
  d.xg.gain.value = id === "A" ? 1 : 0;

  /* ---- elements ---- */
  const btnPlay = q("play");
  const btnCue = q("cue");
  const btnLoop = q("loopBtn");
  const loopLen = q("loopLen");
  const tempo = q("tempo");
  const rateTxt = q("rateTxt");
  const title = q("title");
  const tcur = q("tcur");
  const ttot = q("ttot");
  const bar = q("bar");
  const barfill = q("barfill");
  const platter = q("platter");
  const wave = q("wave");
  const fileIn = q("file");

  d.canvas = wave;
  d.canvasCtx = wave.getContext("2d");
  d.color = id === "A" ? "#18e8ff" : "#ff5aa0";

  q("load").addEventListener("click", () => fileIn.click());
  fileIn.addEventListener("change", () => {
    if (fileIn.files[0]) loadInto(d, fileIn.files[0]);
    fileIn.value = "";
  });

  btnPlay.addEventListener("click", () => togglePlay(d));
  btnCue.addEventListener("click", () => cueDeck(d));
  btnLoop.addEventListener("click", () => toggleLoop(d));
  loopLen.addEventListener("change", () => {
    if (d.loopOn) {
      const len = +loopLen.value;
      const p = currentPos(d);
      d.loopEnd = d.loopStart + len;
      d.loopStart = Math.max(0, Math.min(d.loopStart, Math.max(0, d.buffer.duration - len)));
      if (d.playing) playDeck(d, Math.max(d.loopStart, Math.min(p, d.loopEnd)));
    }
  });

  q("vol").addEventListener("input", (e) => {
    d.g.gain.setTargetAtTime((e.target.value / 100) ** 2, ctx.currentTime, 0.01);
  });

  tempo.addEventListener("input", () => {
    d.rate = tempo.value / 100;
    rateTxt.textContent = tempo.value + "%";
    if (d.playing) {
      d.pos = currentPos(d);
      d.startedAt = ctx.currentTime;
      d.startOffset = d.pos;
      if (d.source) d.source.playbackRate.setValueAtTime(d.rate, ctx.currentTime);
    }
  });

  [
    [q("low"), d.low],
    [q("mid"), d.mid],
    [q("high"), d.high],
  ].forEach(([inp, node]) => {
    inp.addEventListener("input", () => {
      node.gain.setTargetAtTime(+inp.value, ctx.currentTime, 0.02);
    });
  });

  bar.addEventListener("pointerdown", (e) => {
    if (!d.buffer) return;
    const r = bar.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * d.buffer.duration;
    if (d.playing) playDeck(d, p);
    else d.pos = p;
    wakeRender();
  });

  root.addEventListener("dragover", (e) => {
    e.preventDefault();
    root.classList.add("dragover");
  });
  root.addEventListener("dragleave", () => root.classList.remove("dragover"));
  root.addEventListener("drop", (e) => {
    e.preventDefault();
    root.classList.remove("dragover");
    const f = [...e.dataTransfer.files].find(
      (f) => f.type.startsWith("audio") || /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i.test(f.name)
    );
    if (f) loadInto(d, f);
  });

  d.el = { btnPlay, btnCue, btnLoop, title, tcur, ttot, barfill, platter, loopLen };

  decks[id === "A" ? 0 : 1] = d;
  return d;
}

/* ---- deck transport ---- */
function currentPos(d) {
  if (!d.buffer || !d.playing) return d.pos;
  const dur = d.buffer.duration;
  if (d.loopOn) {
    const len = d.loopEnd - d.loopStart;
    if (len <= 0) return d.startOffset;
    const off = Math.max(0, d.startOffset - d.loopStart) + (ctx.currentTime - d.startedAt) * d.rate;
    return d.loopStart + (off % len);
  }
  return Math.min(d.startOffset + (ctx.currentTime - d.startedAt) * d.rate, dur);
}

function stopSource(d) {
  if (d.source) {
    const s = d.source;
    d.source = null;
    s.onended = null;
    try { s.stop(); } catch (e) {}
    try { s.disconnect(); } catch (e) {}
  }
}

function playDeck(d, offset) {
  if (!d.buffer) return;
  stopSource(d);
  const dur = d.buffer.duration;
  offset = Math.max(0, Math.min(offset, dur - 0.001));

  const s = ctx.createBufferSource();
  s.buffer = d.buffer;
  s.playbackRate.value = d.rate;
  if (d.loopOn && d.loopEnd > d.loopStart) {
    s.loop = true;
    s.loopStart = d.loopStart;
    s.loopEnd = d.loopEnd;
    offset = Math.max(d.loopStart, Math.min(offset, d.loopEnd));
  }
  s.connect(d.g);

  const gen = ++d.gen;
  s.onended = () => {
    if (gen !== d.gen) return;
    d.playing = false;
    d.pos = 0;
    d._lastDrawn = null; /* force repaint at 0:00 */
    updateDeckUI(d);
    wakeRender();
  };
  s.start(0, offset);

  d.source = s;
  d.playing = true;
  d.startedAt = ctx.currentTime;
  d.startOffset = offset;
  updateDeckUI(d);
  wakeRender();
}

function pauseDeck(d) {
  if (!d.playing) return;
  d.pos = currentPos(d);
  stopSource(d);
  d.playing = false;
  d._lastDrawn = null; /* force exact final repaint */
  updateDeckUI(d);
  wakeRender();
}

function togglePlay(d) {
  if (!d.buffer) return flash(d, "load an audio track first ⚠");
  if (d.playing) pauseDeck(d);
  else playDeck(d, d.pos > 0 ? d.pos : d.cue);
}

function cueDeck(d) {
  if (!d.buffer) return flash(d, "load an audio track first ⚠");
  if (d.playing) {
    playDeck(d, d.cue); /* jump back to cue, keep playing */
  } else {
    d.cue = d.pos;
    flash(d, "cue set @ " + fmtTime(d.cue), 1200);
  }
  updateDeckUI(d);
}

function toggleLoop(d) {
  if (!d.buffer) return flash(d, "load an audio track first ⚠");
  const len = +d.el.loopLen.value;
  const p = currentPos(d);
  if (!d.loopOn) {
    d.loopStart = Math.max(0, Math.min(p, Math.max(0, d.buffer.duration - len)));
    d.loopEnd = d.loopStart + len;
    d.loopOn = true;
    if (d.playing) playDeck(d, Math.max(d.loopStart, Math.min(p, d.loopEnd)));
    flash(d, "loop " + fmtTime(d.loopStart) + " → " + fmtTime(d.loopEnd));
  } else {
    d.loopOn = false;
    if (d.playing) playDeck(d, p);
    flash(d, "loop off");
  }
  wakeRender();
  updateDeckUI(d);
}

function updateDeckUI(d) {
  d.el.btnPlay.textContent = d.playing ? "⏸ PAUSE" : "▶ PLAY";
  d.el.btnPlay.classList.toggle("on", d.playing);
  d.el.btnCue.classList.toggle("on", d.cue > 0);
  d.el.btnLoop.textContent = d.loopOn ? "🔁 LOOP ON" : "🔁 LOOP OFF";
  d.el.btnLoop.classList.toggle("on", d.loopOn);
  d.el.platter.classList.toggle("spin", d.playing);
}

function flash(d, msg, ms = 1600) {
  if (!d.el) return;
  d.el.title.textContent = msg;
  d.el.title.classList.add("alert");
  clearTimeout(d._ft);
  d._ft = setTimeout(() => {
    d.el.title.classList.remove("alert");
    d.el.title.textContent = d.baseTitle;
  }, ms);
}

async function loadInto(d, file) {
  flash(d, "decoding " + file.name + " …", 10000);
  try {
    const ab = await file.arrayBuffer();
    const buf = await ctx.decodeAudioData(ab);
    stopSource(d);
    d.playing = false;
    d.buffer = buf;
    d.pos = 0;
    d.cue = 0;
    d.rate = 1;

    /* build waveform peaks (max abs amplitude per bucket) */
    const N = 500;
    const chunk = Math.max(1, Math.floor(buf.length / N));
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    const peaks = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let m = 0;
      const s0 = i * chunk;
      const e0 = Math.min(buf.length, s0 + chunk);
      for (let j = s0; j < e0; j += 7) {
        const v = Math.abs(ch0[j]) + (ch1 ? Math.abs(ch1[j]) : 0);
        if (v > m) m = v;
      }
      peaks[i] = Math.min(1, m / 2);
    }
    d.peaks = peaks;
    buildWaveCache(d);
    d.baseTitle = file.name;
    d.el.title.textContent = file.name;
    d.el.title.classList.remove("alert");
    d.el.ttot.textContent = fmtTime(buf.duration);
    updateDeckUI(d);
    wakeRender();
  } catch (err) {
    console.error(err);
    flash(d, "couldn't decode " + file.name + " ⚠", 3000);
  }
}

makeDeck("A");
makeDeck("B");

/* ---- crossfader (equal-power) ---- */
const crossfader = document.getElementById("crossfader");
function applyCrossfader() {
  const x = crossfader.value / 100;
  const t = ctx.currentTime;
  decks[0].xg.gain.setTargetAtTime(Math.cos((x * Math.PI) / 2), t, 0.01);
  decks[1].xg.gain.setTargetAtTime(Math.sin((x * Math.PI) / 2), t, 0.01);
}
crossfader.addEventListener("input", applyCrossfader);
applyCrossfader();

/* ============================================================
   MIXDOWN RECORDER
   Taps the MASTER bus (decks + beat generator + synth keys all
   included) and records it to a downloadable file.
   ============================================================ */
const recDest = ctx.createMediaStreamDestination();
masterGain.connect(recDest);

const recBtn = document.getElementById("recBtn");
const recTime = document.getElementById("recTime");
let recorder = null;
const recChunks = [];
let recTimer = null;

recBtn.addEventListener("click", () => {
  resumeCtx();
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    return;
  }
  if (!window.MediaRecorder) {
    flash(decks[0], "MediaRecorder not supported in this browser ⚠", 3000);
    return;
  }
  recChunks.length = 0;
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
    .find((t) => MediaRecorder.isTypeSupported(t));
  recorder = new MediaRecorder(recDest.stream, mime ? { mimeType: mime } : undefined);

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) recChunks.push(e.data);
  };
  recorder.onstop = () => {
    clearInterval(recTimer);
    recTime.textContent = "";
    recBtn.classList.remove("on");
    recBtn.textContent = "● REC";
    const type = (recorder.mimeType || "audio/webm").split(";")[0];
    const blob = new Blob(recChunks, { type });
    recChunks.length = 0;
    if (blob.size) {
      const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "neondj-mix." + ext;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    recorder = null;
  };

  recorder.start();
  recBtn.classList.add("on");
  recBtn.textContent = "⏹ STOP";
  const t0 = Date.now();
  recTime.textContent = "0:00";
  recTimer = setInterval(() => {
    recTime.textContent = fmtTime((Date.now() - t0) / 1000);
  }, 500);
});

/* ============================================================
   BEAT GENERATOR (16-step sequencer, synthesised drums)
   ============================================================ */
const noiseBuf = (() => {
  const b = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
  const data = b.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return b;
})();

const genGain = ctx.createGain();
genGain.connect(masterGain);
const drumGain = ctx.createGain();
drumGain.connect(genGain);
const bassGain = ctx.createGain();
bassGain.connect(genGain);
const synthGain = ctx.createGain();
synthGain.connect(masterGain);
const bassNoteSel = document.getElementById("bassNote");

const drumVolSlider = document.getElementById("drumVol");
genGain.gain.value = (drumVolSlider.value / 100) ** 2 * 1.3;
drumVolSlider.addEventListener("input", () => {
  genGain.gain.setTargetAtTime((drumVolSlider.value / 100) ** 2 * 1.3, ctx.currentTime, 0.02);
});

/* ---- instruments (all synthesised, scheduled at exact times) ---- */
function trigKick(t) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(160, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  g.gain.setValueAtTime(1, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
  o.connect(g).connect(drumGain);
  o.start(t);
  o.stop(t + 0.35);
}

function trigSnare(t) {
  const n = ctx.createBufferSource();
  n.buffer = noiseBuf;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 1700;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.7, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  n.connect(hp).connect(g).connect(drumGain);
  n.start(t);
  n.stop(t + 0.2);
  const o = ctx.createOscillator();
  const og = ctx.createGain();
  o.type = "triangle";
  o.frequency.setValueAtTime(190, t);
  og.gain.setValueAtTime(0.4, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  o.connect(og).connect(drumGain);
  o.start(t);
  o.stop(t + 0.12);
}

function trigHat(t) {
  const n = ctx.createBufferSource();
  n.buffer = noiseBuf;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 7500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.35, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  n.connect(hp).connect(g).connect(drumGain);
  n.start(t);
  n.stop(t + 0.07);
}

function trigClap(t) {
  const n = ctx.createBufferSource();
  n.buffer = noiseBuf;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1400;
  bp.Q.value = 1.6;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  for (let k = 0; k < 3; k++) {
    const s = t + k * 0.012;
    g.gain.setValueAtTime(0.6, s);
    g.gain.exponentialRampToValueAtTime(0.15, s + 0.01);
  }
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  n.connect(bp).connect(g).connect(drumGain);
  n.start(t);
  n.stop(t + 0.25);
}

function trigBass(t, freq) {
  const o = ctx.createOscillator();
  const lp = ctx.createBiquadFilter();
  const g = ctx.createGain();
  o.type = "sawtooth";
  o.frequency.value = freq;
  lp.type = "lowpass";
  lp.frequency.value = 650;
  lp.Q.value = 1;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  o.connect(lp).connect(g).connect(bassGain);
  o.start(t);
  o.stop(t + 0.33);
}

const TRIG = {
  kick: (t) => trigKick(t),
  snare: (t) => trigSnare(t),
  hihat: (t) => trigHat(t),
  clap: (t) => trigClap(t),
  bass: (t, i) => trigBass(t, bassFreqAt(i)),
  lead: (t, i) => trigLead(t, leadFreqAt(i)),
};

/* ---- sequencer grid ---- */
const SEQ_ROWS = [
  { inst: "kick" },
  { inst: "snare" },
  { inst: "hihat" },
  { inst: "clap" },
  { inst: "bass" },
  { inst: "lead" },
];

const pattern = {};
SEQ_ROWS.forEach((r) => (pattern[r.inst] = new Array(16).fill(false)));
const muted = {};
SEQ_ROWS.forEach((r) => (muted[r.inst] = false));

const seqRowsEl = document.getElementById("seqRows");
const cellEls = {};
const colCells = Array.from({ length: 16 }, () => []);

SEQ_ROWS.forEach((row) => {
  const div = document.createElement("div");
  div.className = "seq-row";
  const name = document.createElement("div");
  name.className = "seq-name";
  name.dataset.inst = row.inst;
  name.textContent = row.inst === "hihat" ? "HAT" : row.inst.toUpperCase();
  const muteBtn = document.createElement("button");
  muteBtn.className = "seq-mute";
  muteBtn.textContent = "M";
  muteBtn.addEventListener("click", () => {
    muted[row.inst] = !muted[row.inst];
    muteBtn.classList.toggle("on", muted[row.inst]);
  });
  const steps = document.createElement("div");
  steps.className = "steps";
  cellEls[row.inst] = [];
  for (let i = 0; i < 16; i++) {
    const c = document.createElement("button");
    c.className = "step";
    c.dataset.inst = row.inst;
    c.dataset.i = i;
    c.addEventListener("click", () => {
      pattern[row.inst][i] = !pattern[row.inst][i];
      c.classList.toggle("on", pattern[row.inst][i]);
      if (row.inst === "lead") {
        if (pattern[row.inst][i] && aiState.leadNotes[i] == null) {
          aiState.leadNotes[i] = chordToneSemiForCell(i);
        }
        if (pattern[row.inst][i]) paintPitchCell(c, aiState.leadNotes[i], "lead");
      } else if (row.inst === "bass" && pattern[row.inst][i]) {
        paintPitchCell(c, chordRootSemiForCell(i), "bass");
      }
      notifyAiEdit(row.inst, i, pattern[row.inst][i]);
      resumeCtx();
    });
    steps.appendChild(c);
    cellEls[row.inst].push(c);
    colCells[i].push(c);
  }
  div.appendChild(name);
  div.appendChild(muteBtn);
  div.appendChild(steps);
  seqRowsEl.appendChild(div);
});

/* ---- presets ---- */
const PRESETS = {
  house: { kick: [0, 4, 8, 12], hihat: [2, 6, 10, 14], clap: [4, 12], snare: [], bass: [0, 3, 6, 10] },
  hiphop: { kick: [0, 7, 10], snare: [4, 12], hihat: [0, 2, 4, 6, 8, 10, 12, 14], clap: [], bass: [3, 7, 11] },
  techno: { kick: [0, 4, 8, 12], hihat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], clap: [8], snare: [], bass: [2, 5, 9, 13] },
};

function paintCells() {
  SEQ_ROWS.forEach((row) => {
    cellEls[row.inst].forEach((c, i) => c.classList.toggle("on", pattern[row.inst][i]));
  });
}

document.querySelectorAll(".btn.preset").forEach((b) => {
  b.addEventListener("click", () => {
    const name = b.dataset.preset;
    SEQ_ROWS.forEach((r) => pattern[r.inst].fill(false));
    if (name !== "clear" && PRESETS[name]) {
      Object.entries(PRESETS[name]).forEach(([inst, steps]) => {
        steps.forEach((i) => (pattern[inst][i] = true));
      });
    }
    paintCells();
    resumeCtx();
  });
});

/* ---- scheduler (lookahead pattern) ---- */
const seq = { playing: false, bpm: 120, cur: 0, nextTime: 0, timer: null, queue: [] };
const bpmSlider = document.getElementById("bpm");
const bpmVal = document.getElementById("bpmVal");

bpmSlider.addEventListener("input", () => {
  seq.bpm = +bpmSlider.value;
  bpmVal.textContent = bpmSlider.value;
});

const seqPlayBtn = document.getElementById("seqPlay");
seqPlayBtn.addEventListener("click", () => {
  resumeCtx();
  if (seq.playing) {
    clearInterval(seq.timer);
    seq.timer = null;
    seq.playing = false;
    seq.queue.length = 0;
    seqPlayBtn.textContent = "▶ START";
    seqPlayBtn.classList.remove("on");
    clearStepHighlight();
    wakeRender(); /* ring out, then park on silence */
  } else {
    seq.playing = true;
    seq.cur = 0;
    seq.nextTime = ctx.currentTime + 0.06;
    seq.timer = setInterval(scheduler, 25);
    seqPlayBtn.textContent = "⏹ STOP";
    seqPlayBtn.classList.add("on");
    wakeRender();
  }
});

function scheduler() {
  const stepSec = 60 / seq.bpm / 4;
  while (seq.nextTime < ctx.currentTime + 0.12) {
    const stepAt = seq.cur;
    SEQ_ROWS.forEach((row) => {
      if (shouldTriggerLive(row.inst, stepAt)) TRIG[row.inst](seq.nextTime, stepAt);
    });
    seq.queue.push({ step: stepAt, time: seq.nextTime });
    seq.nextTime += stepSec;
    seq.cur = (seq.cur + 1) % 16;
    globalStep++;
    if (globalStep % 16 === 0) onAIBarBoundary();
  }
}

let seqShownStep = -1;

function drainSeq() {
  let shown = null;
  while (seq.queue.length && seq.queue[0].time <= ctx.currentTime) {
    shown = seq.queue.shift().step;
  }
  if (shown === null || !seq.playing || shown === seqShownStep) return;
  /* move the highlight between the two affected columns only */
  if (seqShownStep >= 0) {
    const prev = colCells[seqShownStep];
    for (let i = 0; i < prev.length; i++) prev[i].classList.remove("playing");
  }
  const cur = colCells[shown];
  for (let i = 0; i < cur.length; i++) cur[i].classList.add("playing");
  seqShownStep = shown;
}

function clearStepHighlight() {
  if (seqShownStep < 0) return;
  const prev = colCells[seqShownStep];
  for (let i = 0; i < prev.length; i++) prev[i].classList.remove("playing");
  seqShownStep = -1;
}

/* ============================================================
   AI COMPOSER — offline statistical composition engine
   ------------------------------------------------------------
   "Learning": per-style per-instrument probability grids are
   blended toward every pattern you edit (EMA), persisted in
   localStorage. Generation samples those grids (intensity
   scales the density), picks a weighted chord progression,
   and composes a scale-aware lead melody. EVOLVE mode adds
   live performance variations (fills, breaths, drops) while
   your grid pattern stays untouched.
   ============================================================ */
let globalStep = 0;

const AI_STYLES = {
  house: { bpm: 124, scale: "minor",
    progs: [{ w: 3, deg: [0, 3, 4, 4] }, { w: 2, deg: [0, 5, 4, 4] }, { w: 2, deg: [3, 4, 0, 4] }],
    drums: {
      kick:   [1, 0, .18, 0, 1, 0, 0, .1, 1, 0, .16, 0, 1, 0, 0, .08],
      snare:  [0, 0, 0, 0, 0, 0, 0, .05, 0, 0, 0, 0, 0, 0, 0, .05],
      hihat:  [.3, 0, .95, .1, .35, 0, .95, .12, .3, 0, .95, .1, .35, 0, .95, .15],
      clap:   [0, 0, 0, .05, 1, 0, 0, 0, 0, 0, 0, .05, 1, 0, 0, .15],
      bass:   [.85, 0, .3, .35, .55, .35, .25, .35, .85, 0, .3, .35, .55, .35, .25, .4],
    } },
  hiphop: { bpm: 90, scale: "minor",
    progs: [{ w: 3, deg: [0, 0, 5, 5] }, { w: 2, deg: [0, 0, 3, 3] }, { w: 1, deg: [5, 3, 0, 5] }],
    drums: {
      kick:   [.9, .1, 0, .25, 0, .1, .65, 0, .15, .6, 0, .3, 0, .15, .4, .1],
      snare:  [0, 0, 0, 0, 1, 0, 0, .1, 0, 0, 0, .06, 1, 0, 0, .12],
      hihat:  [.9, .45, .85, .5, .9, .4, .85, .55, .9, .45, .85, .5, .9, .4, .85, .6],
      clap:   [0, 0, 0, 0, .25, 0, 0, 0, 0, 0, 0, 0, .25, 0, 0, 0],
      bass:   [.8, 0, 0, .12, .15, .1, .35, .1, 0, .2, 0, .12, .25, .1, .15, .05],
    } },
  techno: { bpm: 132, scale: "phrygian",
    progs: [{ w: 3, deg: [0, 0, 0, 0] }, { w: 2, deg: [0, 0, 3, 3] }, { w: 1, deg: [0, 6, 5, 0] }],
    drums: {
      kick:   [.95, 0, .12, 0, .95, 0, .1, 0, .95, 0, .14, 0, .95, 0, .12, 0],
      snare:  [.05, 0, .08, 0, .06, 0, .1, 0, .05, 0, .08, 0, .06, 0, .1, 0],
      hihat:  [.75, .5, .6, .5, .75, .5, .6, .5, .75, .5, .6, .5, .75, .5, .6, .5],
      clap:   [0, 0, 0, 0, .6, 0, 0, .08, 0, 0, 0, 0, .6, 0, 0, .08],
      bass:   [.75, .15, .3, .15, .6, .15, .3, .2, .75, .15, .3, .15, .6, .2, .3, .25],
    } },
  dnb: { bpm: 174, scale: "minor",
    progs: [{ w: 3, deg: [0, 0, 5, 3] }, { w: 2, deg: [0, 4, 0, 3] }],
    drums: {
      kick:   [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, .9, 0, 0, 0, 0, 0],
      snare:  [0, 0, 0, 0, .95, 0, 0, .12, 0, 0, 0, .08, .95, 0, 0, .18],
      hihat:  [.55, .25, .75, .3, .55, .25, .75, .3, .55, .25, .75, .3, .55, .25, .75, .3],
      clap:   [0, 0, 0, 0, .3, 0, 0, 0, 0, 0, 0, 0, .3, 0, 0, .08],
      bass:   [.9, .08, .1, .18, .1, .08, .12, .1, .08, .5, .08, .12, .1, .08, .12, .1],
    } },
  synthwave: { bpm: 110, scale: "dorian",
    progs: [{ w: 3, deg: [0, 5, 3, 4] }, { w: 2, deg: [0, 4, 5, 3] }],
    drums: {
      kick:   [1, 0, 0, 0, 0, 0, 0, 0, .9, 0, 0, 0, 0, 0, 0, 0],
      snare:  [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, .15],
      hihat:  [.15, 0, .8, 0, .15, 0, .8, 0, .15, 0, .8, 0, .15, 0, .8, .1],
      clap:   [0, 0, 0, 0, .55, 0, 0, 0, 0, 0, 0, 0, .55, 0, 0, .1],
      bass:   [.9, 0, .4, 0, .9, 0, .4, 0, .6, 0, .4, 0, .9, 0, .4, 0],
    } },
  trap: { bpm: 140, scale: "minor",
    progs: [{ w: 3, deg: [0, 0, 0, 5] }, { w: 2, deg: [0, 3, 0, 4] }],
    drums: {
      kick:   [.95, .05, 0, .12, .1, .3, .65, 0, .1, .55, .85, 0, 0, .3, 0, .15],
      snare:  [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, .18, 0, 0, 0, .05],
      hihat:  [.95, .75, .9, .7, .95, .7, .9, .65, .95, .75, .9, .7, .95, .8, .95, .85],
      clap:   [0, 0, 0, 0, .4, 0, 0, 0, 0, 0, 0, 0, .4, 0, 0, 0],
      bass:   [.9, .05, .1, .15, .1, .05, .35, .1, .08, .3, .15, .1, .08, .15, .1, .08],
    } },
};

const AI_SCALES = {
  minor:    [0, 2, 3, 5, 7, 8, 10],
  dorian:   [0, 2, 3, 5, 7, 9, 10],
  major:    [0, 2, 4, 5, 7, 9, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};

const DRUM_INSTS = ["kick", "snare", "hihat", "clap", "bass"];
const AI_MEM_KEY = "neondj-ai-memory-v1";

function seedStyle(def) {
  const m = {};
  DRUM_INSTS.forEach((k) => (m[k] = Array.from(def.drums[k])));
  m.progB = def.progs.map((p) => p.w);
  return m;
}

let aiMemory = (() => {
  try {
    const raw = localStorage.getItem(AI_MEM_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.styles) return parsed;
    }
  } catch (e) {}
  const styles = {};
  Object.keys(AI_STYLES).forEach((k) => (styles[k] = seedStyle(AI_STYLES[k])));
  return { ver: 1, styles, edits: 0 };
})();

let aiSaveTimer = null;
function persistAI() {
  clearTimeout(aiSaveTimer);
  aiSaveTimer = setTimeout(() => {
    try { localStorage.setItem(AI_MEM_KEY, JSON.stringify(aiMemory)); } catch (e) {}
  }, 700);
}

const aiState = { styleKey: "house", progDeg: [0, 3, 4, 4], leadNotes: new Array(16).fill(null) };

/* ---- music-theory helpers ---- */
function aiSemisOf(deg) {
  const sc = AI_SCALES[AI_STYLES[aiState.styleKey].scale];
  const oct = Math.floor(deg / 7);
  return sc[deg - oct * 7] + 12 * oct;
}
function chordDegAt(i) {
  return aiState.progDeg[Math.floor(i / 4) % 4];
}
function chordRootSemiForCell(i) {
  return aiSemisOf(chordDegAt(i));
}
function chordToneSemiForCell(i) {
  const d = chordDegAt(i) + [0, 2, 4][(i >> 1) % 3];
  return aiSemisOf(Math.min(9, Math.max(0, d)));
}
function midiOfBassRoot() {
  const opt = bassNoteSel.selectedOptions && bassNoteSel.selectedOptions[0];
  const m = opt ? /^([A-G])(#?)(\d)$/.exec(opt.text.trim()) : null;
  if (!m) return 36;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] === "#" ? 1 : 0);
  return 12 * (parseInt(m[3], 10) + 1) + base;
}

/* ---- frequency resolution for the trig layer ---- */
function bassFreqAt(i) {
  const root = +bassNoteSel.value;
  const f = root * Math.pow(2, chordRootSemiForCell(i) / 12);
  const bar = Math.floor(globalStep / 16);
  if (aiEvolveEl.checked && bar % 4 === 3 && i >= 12) return f * 2; /* oct lift in fills */
  return f;
}
function leadFreqAt(i) {
  const root = +bassNoteSel.value;
  const n = aiState.leadNotes[i] == null ? 0 : aiState.leadNotes[i];
  return Math.min(2600, Math.max(140, root * 4 * Math.pow(2, n / 12)));
}

function trigLead(t, freq) {
  const o = ctx.createOscillator();
  const f = ctx.createBiquadFilter();
  const g = ctx.createGain();
  o.type = synthWave.value;
  o.frequency.value = freq;
  f.type = "lowpass";
  f.frequency.value = 2400;
  f.Q.value = 1;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.26, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  o.connect(f).connect(g).connect(synthGain);
  o.start(t);
  o.stop(t + 0.23);
}

/* ---- live performance layer (EVOLVE) ---- */
function shouldTriggerLive(inst, i) {
  if (muted[inst]) return false;
  let on = pattern[inst][i];
  if (!aiEvolveEl.checked) return on;

  const bar = Math.floor(globalStep / 16);
  const b4 = bar % 4;
  const sec = Math.floor(bar / 4);

  /* breath: drop extra voices right after each 4-bar section */
  if (sec > 0 && b4 === 0 && i < 2 && inst !== "kick" && inst !== "bass") return false;

  /* hat drop on section breaks every other section */
  if (sec % 2 === 1 && b4 === 0 && inst === "hihat") return false;

  /* fill bar: sprinkle snare rolls & extra hats on steps 10-15 */
  if (b4 === 3 && i >= 10) {
    if (inst === "snare" && !on && Math.random() < 0.3) on = true;
    if (inst === "hihat" && !on && Math.random() < 0.5) on = true;
  }
  /* final accent */
  if (b4 === 3 && i === 15 && inst === "clap" && !on) on = true;

  return on;
}

function onAIBarBoundary() {
  if (!aiEvolveEl.checked) return;
  const bar = Math.floor(globalStep / 16);
  if (bar > 0 && bar % 8 === 0 && Math.random() < 0.3) {
    aiState.progDeg = aiSampleProgs(aiState.styleKey); /* harmony morph */
  }
  if (bar > 0 && bar % 16 === 0 && Math.random() < 0.35) aiMutateMelody();
}

function aiMutateMelody() {
  for (let i = 0; i < 16; i++) {
    if (aiState.leadNotes[i] != null && Math.random() < 0.25) {
      aiState.leadNotes[i] = Math.max(0, Math.min(15, aiState.leadNotes[i] + (Math.random() < 0.5 ? -1 : 1) * (Math.random() < 0.7 ? 1 : 2)));
    }
  }
  paintAllPitch();
}

/* ---- generation ---- */
function aiSampleProgs(key) {
  const st = AI_STYLES[key];
  const w = aiMemory.styles[key].progB.map((x) => Math.max(0.0001, x));
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < w.length; i++) {
    r -= w[i];
    if (r <= 0) return st.progs[i].deg.slice();
  }
  return st.progs[0].deg.slice();
}

function aiConstrainDrums(key) {
  pattern.kick[0] = true;
  if (pattern.hihat.every((x) => !x)) {
    pattern.hihat[2] = pattern.hihat[10] = true;
  }
  if (!pattern.snare.some(Boolean) && ["hiphop", "trap", "dnb", "synthwave"].includes(key)) {
    pattern.snare[4] = pattern.snare[12] = true;
  }
  let claps = 0;
  pattern.clap.forEach((x, i) => { if (x && claps++ >= 4) pattern.clap[i] = false; });
}

function aiMakeMelody(st, inten) {
  const empty = new Array(16).fill(null);
  const budget = 3 + Math.round(inten * 8); /* 3..11 lead notes */
  let placed = 0;
  let deg = aiState.progDeg[0] + [0, 2, 4][Math.floor(Math.random() * 3)];
  for (let i = 0; i < 16; i++) {
    const strong = i % 4 === 0;
    if (placed < budget && (strong || Math.random() < 0.28 + inten * 0.3)) {
      if (strong) {
        deg = aiState.progDeg[Math.floor(i / 4)] + [0, 2, 4][Math.floor(Math.random() * 3)];
      } else {
        const dir = Math.random() < 0.5 ? -1 : 1;
        const mag = [1, 1, 2, 2, 3, 3, 4, 5][Math.floor(Math.random() * 8)];
        deg += dir * mag;
      }
      deg = Math.max(0, Math.min(9, deg));
      empty[i] = aiSemisOf(deg);
      placed++;
    }
  }
  return empty;
}

function paintPitchCell(c, semi, inst) {
  const midi = midiOfBassRoot() + (inst === "bass" ? 0 : 24) + semi;
  c.style.setProperty("--p", Math.round(92 - (semi / 15) * 74) + "%");
  c.title = NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

function paintAllPitch() {
  SEQ_ROWS.forEach((row) => {
    if (row.inst !== "bass" && row.inst !== "lead") return;
    cellEls[row.inst].forEach((c, i) => {
      if (!pattern[row.inst][i]) { c.style.removeProperty("--p"); c.title = ""; return; }
      paintPitchCell(c, row.inst === "bass" ? chordRootSemiForCell(i) : (aiState.leadNotes[i] == null ? 0 : aiState.leadNotes[i]), row.inst);
    });
  });
}

const aiStyleEl = document.getElementById("aiStyle");
const aiDensityEl = document.getElementById("aiDensity");
const aiEvolveEl = document.getElementById("aiEvolve");
const aiHint = document.getElementById("aiHint");

function aiGenerate() {
  const key = aiStyleEl.value;
  const st = AI_STYLES[key];
  aiState.styleKey = key;
  const inten = aiDensityEl.value / 100;

  /* tempo follows the style */
  bpmSlider.value = st.bpm;
  bpmVal.textContent = st.bpm;
  seq.bpm = st.bpm;

  /* rhythm rows sampled from the learned tables */
  const mult = 0.35 + inten * 1.3;
  DRUM_INSTS.forEach((inst) => {
    const src = aiMemory.styles[key][inst];
    for (let i = 0; i < 16; i++) pattern[inst][i] = Math.random() < Math.min(0.98, src[i] * mult);
  });
  aiConstrainDrums(key);

  /* harmony + melody + lead rhythm */
  aiState.progDeg = aiSampleProgs(key);
  aiState.leadNotes = aiMakeMelody(st, inten);
  pattern.lead = aiState.leadNotes.map((n) => n !== null);

  paintCells();
  paintAllPitch();
  aiHint.textContent = `AI: ${key.toUpperCase()} · ${st.bpm} BPM · prog ${aiState.progDeg.join("-")} · ${
    pattern.lead.filter(Boolean).length
  } lead notes — learned from ${aiMemory.edits} of your edits`;
  resumeCtx();
}

function aiRegenMelody() {
  aiState.progDeg = aiSampleProgs(aiState.styleKey);
  aiState.leadNotes = aiMakeMelody(AI_STYLES[aiState.styleKey], aiDensityEl.value / 100);
  pattern.lead = aiState.leadNotes.map((n) => n !== null);
  paintCells();
  paintAllPitch();
  aiHint.textContent = `AI: melody regenerated over prog ${aiState.progDeg.join("-")}`;
}

function notifyAiEdit(inst, i, on) {
  const mem = aiMemory.styles[aiStyleEl.value];
  if (!mem || !mem[inst]) return;
  const target = on ? 0.95 : 0.05;
  mem[inst][i] += (target - mem[inst][i]) * 0.35;
  aiMemory.edits++;
  persistAI();
}

document.getElementById("aiGenerate").addEventListener("click", aiGenerate);
document.getElementById("aiMelody").addEventListener("click", aiRegenMelody);
document.getElementById("aiReset").addEventListener("click", () => {
  try { localStorage.removeItem(AI_MEM_KEY); } catch (e) {}
  Object.keys(AI_STYLES).forEach((k) => (aiMemory.styles[k] = seedStyle(AI_STYLES[k])));
  aiMemory.edits = 0;
  persistAI();
  aiHint.textContent = "AI memory reset — starting from style priors.";
});

/* ============================================================
   SYNTH KEYS (one octave, keyboard + mouse playable)
   ============================================================ */
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = [1, 3, 6, 8, 10];
const K2S = { z: 0, s: 1, x: 2, c: 3, d: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11 };

const synthWave = document.getElementById("synthWave");
const synthCut = document.getElementById("synthCut");
const synthVol = document.getElementById("synthVol");
synthGain.gain.value = (synthVol.value / 100) ** 2;
synthVol.addEventListener("input", () => {
  synthGain.gain.setTargetAtTime((synthVol.value / 100) ** 2, ctx.currentTime, 0.02);
});

const synthKeysEl = document.getElementById("synthKeys");
const keyEls = [];

function makeVoice(semi) {
  const t = ctx.currentTime;
  const freq = 261.625565 * Math.pow(2, semi / 12);
  const o = ctx.createOscillator();
  o.type = synthWave.value;
  o.frequency.value = freq;
  const f = ctx.createBiquadFilter();
  f.type = "lowpass";
  f.Q.value = 0.7;
  f.frequency.value = 200 * Math.pow(40, synthCut.value / 100);
  const g = ctx.createGain();
  o.connect(f).connect(g).connect(synthGain);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.4, t + 0.012);
  o.start(t);
  const el = keyEls[semi];
  if (el) el.classList.add("on");
  wakeRender(); /* spectrum animates while the voice sounds */
  return {
    release() {
      const rt = ctx.currentTime;
      g.gain.cancelScheduledValues(rt);
      g.gain.setValueAtTime(g.gain.value, rt);
      g.gain.linearRampToValueAtTime(0.0001, rt + 0.18);
      o.stop(rt + 0.25);
      if (el) el.classList.remove("on");
    },
  };
}

for (let s = 0; s < 12; s++) {
  const kb = document.createElement("button");
  kb.className = "key" + (BLACK.includes(s) ? " black" : "");
  kb.innerHTML = NOTE_NAMES[s] + "<span>" + Object.keys(K2S).find((k) => K2S[k] === s) + "</span>";
  kb.addEventListener("pointerdown", (e) => e.preventDefault() /* keep focus for keyboard */);
  keyEls[s] = kb;
  synthKeysEl.appendChild(kb);
}

const held = new Map(); /* keyboard */
const mouseHeld = new Map(); /* pointer per key el */

document.addEventListener("pointerup", () => {
  for (const [el, v] of mouseHeld) {
    v.release();
    el._v = null;
  }
  mouseHeld.clear();
});

/* avoid stuck notes if the browser window loses focus */
window.addEventListener("blur", () => {
  for (const [, v] of held) v.release();
  held.clear();
  for (const [, v] of mouseHeld) v.release();
  mouseHeld.clear();
});

/* ---- global keyboard ---- */
window.addEventListener("keydown", (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();

  if (k === "q") togglePlay(decks[0]);
  else if (k === "a") cueDeck(decks[0]);
  else if (k === "p") togglePlay(decks[1]);
  else if (k === "l") cueDeck(decks[1]);
  else if (k === "r") recBtn.click();
  else if (k in K2S && !(e.target instanceof HTMLSelectElement)) {
    resumeCtx();
    if (!held.has(k)) {
      const v = makeVoice(K2S[k]);
      if (v) {
        held.set(k, v);
        const el = keyEls[K2S[k]];
        mouseHeld.set(el, v);
      }
    }
  }
});

window.addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  if (held.has(k)) {
    held.get(k).release();
    const el = keyEls[K2S[k]];
    el._v = null;
    mouseHeld.delete(el);
    held.delete(k);
  }
});

document.addEventListener("pointerdown", (e) => {
  const el = e.target.closest(".key");
  if (el) {
    const s = keyEls.indexOf(el);
    if (s > -1) mouseHeld.set(el, makeVoice(s));
  }
});

/* ============================================================
   RENDER LOOP (waveforms, spectrum, step highlight)
   ============================================================ */
const specCanvas = document.getElementById("spectrum");
const specCtx2d = specCanvas.getContext("2d");
const fdata = new Uint8Array(analyser.frequencyBinCount);

/* gradients are built once, not every frame */
const SPEC_BARS = 36;
let specGrads = null;
function buildSpecGrads() {
  specGrads = [];
  for (let i = 0; i < SPEC_BARS; i++) {
    const grad = specCtx2d.createLinearGradient(0, specCanvas.height, 0, 0);
    grad.addColorStop(0, "#18e8c8");
    grad.addColorStop(1, "#a05aff");
    specGrads.push(grad);
  }
}
let specSilent = false; /* true = painted empty, can skip */

function drawSpectrum() {
  analyser.getByteFrequencyData(fdata);
  let energy = 0;
  for (let i = 0; i < fdata.length; i += 4) {
    if (fdata[i] > 0) { energy = 1; break; }
  }
  if (!energy) {
    if (specSilent) return; /* silence — already cleared, skip */
    specSilent = true; /* paint one empty frame, then idle */
  } else {
    specSilent = false;
  }

  const w = specCanvas.width, h = specCanvas.height;
  specCtx2d.clearRect(0, 0, w, h);
  const bw = w / SPEC_BARS;
  for (let i = 0; i < SPEC_BARS; i++) {
    const idx = Math.floor(Math.pow(i / SPEC_BARS, 1.6) * fdata.length * 0.72);
    const v = fdata[idx] / 255;
    const bh = Math.max(2, v * (h - 4));
    specCtx2d.fillStyle = specGrads[i];
    specCtx2d.fillRect(i * bw + 1, h - bh, bw - 2, bh);
  }
}

/* ---- pre-render waveforms once per loaded track ---- */
function paintWaveTo(g2d, d, w, h, color) {
  const N = d.peaks.length;
  g2d.fillStyle = color;
  g2d.fillRect(0, h / 2 - 1, w, 2);
  for (let x = 0; x < w; x++) {
    const p = d.peaks[Math.floor((x / w) * N)] || 0;
    const a = Math.max(2, p * (h * 0.44));
    g2d.fillRect(x, h / 2 - a * 0.9, 1, a * 1.8);
  }
}

function buildWaveCache(d) {
  const w = d.canvas.width, h = d.canvas.height;
  d.waveDim = document.createElement("canvas");
  d.waveDim.width = w;
  d.waveDim.height = h;
  paintWaveTo(d.waveDim.getContext("2d"), d, w, h, "rgba(110,130,160,0.4)");
  d.waveBright = document.createElement("canvas");
  d.waveBright.width = w;
  d.waveBright.height = h;
  paintWaveTo(d.waveBright.getContext("2d"), d, w, h, d.color);
  d._lastDrawn = null; /* force one repaint */
}

function drawDeck(d) {
  const cv = d.canvas;
  if (!cv) return;
  const w = cv.width, h = cv.height;
  const g2d = d.canvasCtx;
  const pos = currentPos(d);

  /* repaint only when the playhead actually moved */
  if (pos === d._lastDrawn) return;
  d._lastDrawn = pos;

  g2d.clearRect(0, 0, w, h);
  if (!d.buffer || !d.waveDim) {
    g2d.fillStyle = "#4a5568";
    g2d.font = "12px system-ui";
    g2d.textAlign = "center";
    g2d.fillText("load a track to see the waveform", w / 2, h / 2);
    g2d.textAlign = "left";
    return;
  }
  g2d.drawImage(d.waveDim, 0, 0);
  const frac = pos / d.buffer.duration;
  const x = frac * w;
  if (x > 0) {
    g2d.save();
    g2d.beginPath();
    g2d.rect(0, 0, x, h);
    g2d.clip();
    g2d.drawImage(d.waveBright, 0, 0);
    g2d.restore();
  }
  g2d.fillStyle = d.color;
  g2d.fillRect(x - 1, 0, 2, h);
  d.el.tcur.textContent = fmtTime(pos);
  d.el.barfill.style.width = frac * 100 + "%";
}

/* ============================================================
   SLEEP/WAKE RENDER LOOP
   The renderer parks itself whenever nothing animates:
   no decks playing, sequencer stopped, and the analyser fully
   silent (all audio tails decayed). It wakes via wakeRender()
   from transport / interaction events. While parked the app
   performs zero render work.
   ============================================================ */
let rendering = false;

function allQuiet() {
  if (seq.playing || seq.queue.length) return false; /* sequencer animating */
  if (
    (decks[0].playing || decks[1].playing) &&
    ctx.state === "running"
  ) {
    return false; /* playheads advancing */
  }
  if (!specSilent) return false; /* audio still ringing */
  return true;
}

function renderTick() {
  decks.forEach(drawDeck);
  drawSpectrum();
  drainSeq();
  if (allQuiet()) {
    rendering = false; /* park — fully idle until the next wakeRender() */
    return;
  }
  requestAnimationFrame(renderTick);
}

function wakeRender() {
  if (rendering) return;
  rendering = true;
  requestAnimationFrame(renderTick);
}

buildSpecGrads();
wakeRender(); /* paint placeholders once at startup, then park */
