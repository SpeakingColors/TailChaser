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
console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed'); process.exit(fails ? 1 : 0);
