// Run: node tests/test_core.js   (no dependencies)
const TC = require('../core/tailchaser_core.js');
const SR = 44100;
let fails = 0;
function ok(name, cond, info) { console.log((cond ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!cond) fails++; }
let seed = 12345; function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; }
const db = x => 20 * Math.log10(x + 1e-12);
function rmsDb(a, i0, i1) { i0 = Math.round(i0); i1 = Math.round(i1); let s = 0; for (let i = i0; i < i1; i++) s += a[i] * a[i]; return 10 * Math.log10(s / (i1 - i0) + 1e-20); }

// synthetic parts ------------------------------------------------------------
function hit(buf, t, freq, level, bodyMs) { // drum-like: sine + noise, fast decay
  const i0 = Math.round(t * SR), n = Math.round(0.4 * SR);
  for (let i = 0; i < n && i0 + i < buf.length; i++) { const e = Math.exp(-i / (bodyMs / 1000 * SR)); buf[i0 + i] += level * e * (Math.sin(2 * Math.PI * freq * i / SR) * 0.8 + rnd() * 0.2); }
}
function tail(buf, t, level, rt60, fromMs) { // reverb-like noise tail, starts under the hit
  const i0 = Math.round(t * SR), n = Math.round(Math.min(rt60 * 1.3, 2.5) * SR), k = 6.9078 / (rt60 * SR);
  for (let i = 0; i < n && i0 + i < buf.length; i++) buf[i0 + i] += level * Math.exp(-i * k) * rnd();
}
function mk(len) { return { L: new Float32Array(len * SR), R: new Float32Array(len * SR) }; }
function both(sig, fn) { fn(sig.L); fn(sig.R); }
function run(sig, params) { const p = TC.withDefaults(params); const an = TC.analyze(sig.L, sig.R, SR, p.bands, p.xo); const d = TC.derive(an, p); const o = TC.render(an, d, sig.L, sig.R); return { an, d, o, st: TC.stats(an, d, sig.L, sig.R, o) }; }

// T1 one hit with a long reverb tail ----------------------------------------
{
  seed = 1; const s = mk(3);
  both(s, b => { hit(b, 0.5, 150, 0.8, 60); tail(b, 0.5, 0.08, 1.2); });
  const r = run(s, { bands: 1 });
  const t0 = Math.round(0.5 * SR);
  const before = rmsDb(s.L, t0 + 0.9 * SR, t0 + 1.3 * SR), after = rmsDb(r.o.L, t0 + 0.9 * SR, t0 + 1.3 * SR);
  ok('T1 tail found', r.st.tails >= 1, 'tails=' + r.st.tails);
  ok('T1 tail late in the decay is cut by 30 dB or more', before - after >= 30, 'cut ' + (before - after).toFixed(1) + ' dB');
  let maxd = 0; for (let i = t0 - 200; i < t0 + 0.04 * SR; i++) maxd = Math.max(maxd, Math.abs(r.o.L[i] - s.L[i]));
  ok('T1 attack and first 40 ms untouched (bit exact)', maxd === 0, 'max diff ' + maxd);
}
// T2 sustained steady pad: nothing to cut ----------------------------------
{
  seed = 2; const s = mk(3);
  both(s, b => { for (let i = 0.2 * SR; i < 2.8 * SR; i++) b[i] = 0.3 * (1 + 0.25 * Math.sin(2 * Math.PI * 0.5 * i / SR)) * Math.sin(2 * Math.PI * 220 * i / SR); });
  const r = run(s, { bands: 1 });
  let maxd = 0; for (let i = 0.2 * SR; i < 2.7 * SR; i++) maxd = Math.max(maxd, Math.abs(r.o.L[i] - s.L[i]));
  ok('T2 steady modulated pad is left alone', maxd === 0, 'max diff ' + maxd + ' tails=' + r.st.tails);
}
// T3 two hits, long tails, second attack protected -------------------------
{
  seed = 3; const s = mk(3);
  both(s, b => { hit(b, 0.4, 150, 0.8, 60); tail(b, 0.4, 0.08, 1.5); hit(b, 1.2, 150, 0.8, 60); tail(b, 1.2, 0.08, 1.5); });
  const r = run(s, { bands: 1 });
  const t1 = Math.round(1.2 * SR); let maxd = 0;
  for (let i = t1 - Math.round(0.002 * SR); i < t1 + 0.05 * SR; i++) maxd = Math.max(maxd, Math.abs(r.o.L[i] - s.L[i]));
  ok('T3 second attack untouched from 2 ms before the hit', maxd < 1e-6, 'max diff ' + maxd.toExponential(2));
  const mid = rmsDb(r.o.L, 0.9 * SR, 1.1 * SR) - rmsDb(s.L, 0.9 * SR, 1.1 * SR);
  ok('T3 gap between the hits is cleaned', mid < -20, 'gap level change ' + mid.toFixed(1) + ' dB');
}
// T4 exact bypass ----------------------------------------------------------
{
  seed = 4; const s = mk(2); both(s, b => { hit(b, 0.3, 150, 0.8, 60); tail(b, 0.3, 0.08, 1.2); });
  const a = run(s, { mix: 0 }), c = run(s, { depth: 0 });
  let d1 = 0, d2 = 0; for (let i = 0; i < s.L.length; i++) { d1 = Math.max(d1, Math.abs(a.o.L[i] - s.L[i])); d2 = Math.max(d2, Math.abs(c.o.L[i] - s.L[i])); }
  ok('T4 Mix 0 is bit exact', d1 === 0, 'diff ' + d1);
  ok('T4 Depth 0 is bit exact', d2 === 0, 'diff ' + d2);
}
// T5 delay echoes (one band) -----------------------------------------------
{
  seed = 5; const s = mk(4);
  both(s, b => { for (let k = 0; k < 5; k++) hit(b, 0.5 + k * 0.375, 400, 0.8 * Math.pow(0.35, k), 80); });
  const on = run(s, { bands: 1, echo: 8 }), off = run(s, { bands: 1, echo: 0 });
  const w0 = 0.5 + 0.375, w1 = w0 + 0.3; // second to fifth echoes
  const ein = rmsDb(s.L, w0 * SR, 2.2 * SR), eon = rmsDb(on.o.L, w0 * SR, 2.2 * SR), eoff = rmsDb(off.o.L, w0 * SR, 2.2 * SR);
  ok('T5 echo guard removes the repeats', ein - eon >= 20, 'cut ' + (ein - eon).toFixed(1) + ' dB');
  ok('T5 without guard repeats stay (they count as hits)', ein - eoff < 10, 'cut ' + (ein - eoff).toFixed(1) + ' dB');
  let maxd = 0; const i0 = Math.round(0.5 * SR); for (let i = i0 - 100; i < i0 + 0.05 * SR; i++) maxd = Math.max(maxd, Math.abs(on.o.L[i] - s.L[i]));
  ok('T5 first hit untouched', maxd === 0, 'diff ' + maxd);
}
// T6 bands: low note keeps sustaining while the high reverb is cut ---------
{
  seed = 6; const s = mk(3);
  both(s, b => { for (let i = 0.2 * SR; i < 2.8 * SR; i++) b[i] += 0.4 * Math.sin(2 * Math.PI * 60 * i / SR); hit(b, 0.6, 3500, 0.5, 30); tail(b, 0.6, 0.06, 1.0); });
  const r = run(s, { bands: 3 });
  const lowKept = rmsDb(r.o.L, 1.5 * SR, 2.5 * SR) - rmsDb(s.L, 1.5 * SR, 2.5 * SR);
  ok('T6 sustained bass is untouched while high tail is cut', Math.abs(lowKept) < 3 && r.st.tails >= 1, 'low change ' + lowKept.toFixed(2) + ' dB tails=' + r.st.tails);
}
// T7 Silence in: quiet hiss between hits goes away --------------------------
{
  seed = 7; const s = mk(3);
  both(s, b => { for (let i = 0; i < b.length; i++) b[i] = 0.0008 * rnd(); hit(b, 0.5, 150, 0.8, 60); hit(b, 1.8, 150, 0.8, 60); });
  const r = run(s, { bands: 1, floor: -50, tailStart: 30 });
  const ch = rmsDb(r.o.L, 1.1 * SR, 1.6 * SR) - rmsDb(s.L, 1.1 * SR, 1.6 * SR);
  ok('T7 floor mutes the hiss between hits', ch < -20, 'change ' + ch.toFixed(1) + ' dB');
}
// T8 stability --------------------------------------------------------------
{
  seed = 8; const s = mk(2); both(s, b => { for (let i = 0; i < b.length; i++) b[i] = rnd() * 0.9; });
  const r = run(s, { bands: 4 });
  let bad = 0; for (let i = 0; i < r.o.L.length; i++) if (!isFinite(r.o.L[i])) bad++;
  ok('T8 loud noise stays finite', bad === 0);
  const z = mk(1); const rz = run(z, {}); let bz = 0; for (let i = 0; i < rz.o.L.length; i++) if (rz.o.L[i] !== 0) bz++;
  ok('T8 silence in, silence out', bz === 0);
}
// T9 bands add back to the input; broadband tails are cut in multiband mode ---
{
  seed = 9; const s = mk(3);
  both(s, b => { for (let i = 0; i < b.length; i++) b[i] = 0.3 * rnd(); });
  const an = TC.analyze(s.L, s.R, SR, 4, [250, 3000, 8000]);
  let md = 0; for (let i = 0; i < s.L.length; i++) { let t = 0; for (let b = 0; b < 4; b++) t += an.bandL[b][i]; md = Math.max(md, Math.abs(t - s.L[i])); }
  ok('T9 bands add up to the input', md < 1e-5, 'max diff ' + md.toExponential(1));
  const m = mk(3); seed = 10;
  both(m, b => { hit(b, 0.5, 150, 0.8, 60); tail(b, 0.5, 0.05, 1.5, 100); });
  const r = run(m, { bands: 3 });
  const ch = rmsDb(r.o.L, 1.6 * SR, 2.0 * SR) - rmsDb(m.L, 1.6 * SR, 2.0 * SR);
  ok('T9 broadband tail is cut hard in 3 bands', ch < -30, 'change ' + ch.toFixed(1) + ' dB');
}
// T10 no bump at the crossovers when one band is cut; T11 smooth reduces clicks --
{
  const xo = [250, 3000, 8000]; let worst = -99;
  for (const [nb, gains] of [[3, [-20, 0, 0]], [3, [0, -20, 0]], [4, [0, 0, -20, 0]]]) {
    for (let f = 30; f < 18000; f *= 1.12) {
      const n = SR / 4, x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f * i / SR);
      const an = TC.analyze(x, x, SR, nb, xo), o = new Float32Array(n);
      for (let b = 0; b < nb; b++) { const g = Math.pow(10, gains[b] / 20); for (let i = 0; i < n; i++) o[i] += g * an.bandL[b][i]; }
      worst = Math.max(worst, rmsDb(o, n / 2, n) - rmsDb(x, n / 2, n));
    }
  }
  ok('T10 cutting one band never boosts any frequency', worst < 0.1, 'max ' + worst.toFixed(2) + ' dB');
  function hpf(x, f) { const w = 2 * Math.PI * f / SR, c = Math.cos(w), a = Math.sin(w) / 1.4142, b0 = (1 + c) / 2, b1 = -(1 + c), a0 = 1 + a, a1 = -2 * c, a2 = 1 - a; let x1 = 0, x2 = 0, y1 = 0, y2 = 0; const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; }
  function click(smooth) {
    const m = mk(3);
    both(m, b => { for (let i = 0; i < b.length; i++) { const t = i / SR; let v = 0; if (t >= 0.5 && t < 2) v += 0.05 * Math.exp(-(t - 0.5) * 2.5) * (Math.sin(2 * Math.PI * 150 * t) + 0.5 * Math.sin(2 * Math.PI * 330 * t)); for (const h of [0.5, 2]) if (t >= h) v += 0.8 * Math.exp(-(t - h) * 30) * Math.sin(2 * Math.PI * 110 * (t - h)); b[i] = v; } });
    const r = run(m, { bands: 1, fade: 20, keep: 20, smooth, depth: 60, tailStart: 12, floor: -90 });
    const a = hpf(hpf(r.o.L, 3000), 3000); let pk = 0; for (let i = Math.round(0.53 * SR); i < Math.round(1.95 * SR); i++) pk = Math.max(pk, Math.abs(a[i])); return 20 * Math.log10(pk + 1e-12);
  }
  const c0 = click(0), c3 = click(3);
  ok('T11 Smooth 3 ms lowers click energy by 10 dB or more', c0 - c3 >= 10, c0.toFixed(1) + ' to ' + c3.toFixed(1) + ' dBFS above 3 kHz');
}
// T12 echo guard keeps a different, quieter sound (hi-hat after a snare) ---
{
  seed = 12; const s = mk(3);
  both(s, b => { hit(b, 0.5, 200, 0.8, 120); tail(b, 0.5, 0.04, 1.2, 100); });
  const hh = new Float32Array(s.L.length); seed = 120; let h1 = 0;
  for (let i = 0; i < 0.04 * SR; i++) { const x = rnd(); hh[Math.round(1.0 * SR) + i] = 0.12 * Math.exp(-i / (0.01 * SR)) * (x - h1); h1 = x; }
  for (let i = 0; i < s.L.length; i++) { s.L[i] += hh[i]; s.R[i] += hh[i]; }
  const r = run(s, { bands: 1, echo: 8, tailStart: 12, keep: 20, fade: 60 });
  const i0 = Math.round(1.0 * SR), i1 = i0 + Math.round(0.02 * SR);
  const ch = rmsDb(r.o.L, i0, i1) - rmsDb(s.L, i0, i1);
  ok('T12 hi-hat after a snare is not taken for an echo', ch > -1, 'change ' + ch.toFixed(1) + ' dB');
}
// T13 echo timing: a single ghost note of the same drum (no repeat pattern) stays --
{
  seed = 13; const s = mk(3);
  both(s, b => { hit(b, 0.5, 300, 0.8, 60); hit(b, 0.5 + 0.2, 300, 0.8 * 0.18, 60); hit(b, 1.6, 300, 0.8, 60); });
  const on = run(s, { bands: 1, echo: 8, tailStart: 12, keep: 10, fade: 40 });
  const i0 = Math.round(0.7 * SR), i1 = i0 + Math.round(0.03 * SR);
  const ch = rmsDb(on.o.L, i0, i1) - rmsDb(s.L, i0, i1);
  ok('T13 single ghost note of the same drum is kept', ch > -1, 'change ' + ch.toFixed(1) + ' dB');
  const fx = run(s, { bands: 1, echo: 8, echoTime: 200, tailStart: 12, keep: 10, fade: 40 });
  const ch2 = rmsDb(fx.o.L, i0, i1) - rmsDb(s.L, i0, i1);
  ok('T13 same note is cut when Echo time is set to its delay (200 ms)', ch2 < -20, 'change ' + ch2.toFixed(1) + ' dB');
}
// T14 a single echo later in the song is cut once the delay time is known ----
{
  seed = 14; const s = mk(4);
  both(s, b => { for (let k = 0; k < 4; k++) hit(b, 0.3 + k * 0.375, 400, 0.8 * Math.pow(0.35, k), 80);
                 hit(b, 2.2, 400, 0.8, 80); hit(b, 2.2 + 0.375, 400, 0.8 * 0.3, 80); });
  const r = run(s, { bands: 1, echo: 8 });
  const i0 = Math.round(2.575 * SR), i1 = i0 + Math.round(0.05 * SR);
  const ch = rmsDb(r.o.L, i0, i1) - rmsDb(s.L, i0, i1);
  ok('T14 lone echo on the learned 375 ms grid is cut', ch < -20, 'change ' + ch.toFixed(1) + ' dB, found ' + r.d.bands[0].echoMs + ' ms');
}
// T15 Center: mono content untouched at Center 0, wide tail still cut, bypass exact --
{
  seed = 15; const s = mk(3);
  hit(s.L, 0.5, 200, 0.8, 60); s.R.set(s.L);
  const t1 = new Float32Array(s.L.length), t2 = new Float32Array(s.L.length); tail(t1, 0.5, 0.05, 1.5, 100); seed = 151; tail(t2, 0.5, 0.05, 1.5, 100);
  const mono = mk(3); for (let i = 0; i < s.L.length; i++) { const m = 0.6 * t1[i]; mono.L[i] = s.L[i] + m; mono.R[i] = s.R[i] + m; s.L[i] += t1[i]; s.R[i] += t2[i]; }
  const rm = run(mono, { bands: 1, center: 0 }); let md = 0; for (let i = 0; i < mono.L.length; i++) md = Math.max(md, Math.abs(rm.o.L[i] - mono.L[i]));
  ok('T15 Center 0 leaves a mono tail untouched', md < 1e-6, 'max diff ' + md.toExponential(1));
  const rw = run(s, { bands: 1, center: 0 }); const side = x => { const o = new Float32Array(x.L.length); for (let i = 0; i < o.length; i++) o[i] = 0.5 * (x.L[i] - x.R[i]); return o; };
  const ch = rmsDb(side(rw.o), 1.6 * SR, 2.0 * SR) - rmsDb(side(s), 1.6 * SR, 2.0 * SR);
  ok('T15 Center 0 still cuts the wide part of the tail', ch < -30, 'side change ' + ch.toFixed(1) + ' dB');
  const rb = run(s, { bands: 3, center: 40, mix: 0 }); let bd = 0; for (let i = 0; i < s.L.length; i++) bd = Math.max(bd, Math.abs(rb.o.L[i] - s.L[i]), Math.abs(rb.o.R[i] - s.R[i]));
  ok('T15 Mix 0 with Center 40 is bit exact', bd === 0, 'diff ' + bd);
}
// T16 delay whose 2nd repeat is hidden under the next note: learned from the song --
{
  seed = 16; const s = mk(6);
  both(s, b => { for (let k = 0; k < 7; k++) { const t = 0.3 + k * 0.7; hit(b, t, 500, 0.6, 70); hit(b, t + 0.35, 500, 0.6 * 0.3, 70); } });
  const r = run(s, { bands: 1, echo: 8 });
  let worst = -999; for (let k = 0; k < 7; k++) { const i0 = Math.round((0.3 + k * 0.7 + 0.35) * SR), i1 = i0 + Math.round(0.04 * SR); worst = Math.max(worst, rmsDb(r.o.L, i0, i1) - rmsDb(s.L, i0, i1)); }
  ok('T16 every repeat cut when the pattern is only visible across the song', worst < -20, 'weakest cut ' + (-worst).toFixed(1) + ' dB, found ' + r.d.bands[0].echoMs + ' ms');
  let hd = 0; for (let k = 0; k < 7; k++) { const i0 = Math.round((0.3 + k * 0.7) * SR); for (let i = i0; i < i0 + 0.03 * SR; i++) hd = Math.max(hd, Math.abs(r.o.L[i] - s.L[i])); }
  ok('T16 the notes themselves untouched', hd < 1e-6, 'max diff ' + hd.toExponential(1));
}
// T17 Auto: finds the hit-to-tail turn, the noise floor and the delay time ----
{
  seed = 17; const s = mk(6);
  both(s, b => { for (let k = 0; k < 8; k++) { const t = 0.3 + k * 0.7; hit(b, t, 300, 0.7, 40); tail(b, t, 0.04, 1.0, 100); hit(b, t + 0.35, 300, 0.7 * 0.25, 40); } for (let i = 0; i < b.length; i++) b[i] += 0.0006 * rnd(); });
  const an = TC.analyze(s.L, s.R, SR, 3, [250, 3000, 8000]), sg = TC.suggest(an, {});
  ok('T17 Auto sets Floor just above the noise', sg.params.floor > -75 && sg.params.floor < -50, 'Floor ' + sg.params.floor + ' (' + sg.why[0] + ')');
  ok('T17 Auto finds where hits turn into tails', sg.params.tailStart >= 8 && sg.params.tailStart <= 36, 'Tail start ' + sg.params.tailStart);
  ok('T17 Auto finds the 350 ms delay', Math.abs(sg.params.echoTime - 350) <= 15, 'Echo time ' + sg.params.echoTime);
  ok('T17 Auto Keep and Fade follow the 700 ms spacing', sg.params.keep >= 60 && sg.params.keep <= 110 && sg.params.fade >= 150 && sg.params.fade <= 260, 'Keep ' + sg.params.keep + ', Fade ' + sg.params.fade);
}
console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed'); process.exit(fails ? 1 : 0);
