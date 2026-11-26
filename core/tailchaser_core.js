/* Tail Chaser core: finds reverb and delay tails (and quiet leftovers) and
   turns them down. Plain JS so the mockup and the tests run the same code;
   the C++ port in the plugin must match it (parity test planned).
   Design: split into bands, follow each band's level (10 ms window, 1 ms hop),
   find hits, find where each hit's decay becomes a tail, fade it out, and open
   again just before the next hit (the whole file is known in Scan mode, so
   the gain can open early). All gains are written as one dB value per hop and
   linearly interpolated per sample, so there are no jumps.
   Bypass is exact: output = input + sum((gain_band - 1) * band), so unity
   gain leaves the input untouched bit for bit. */
(function (root) {
  'use strict';
  var HOP_MS = 1, WIN_MS = 10;

  var DEFAULTS = {
    bands: 3, xo: [250, 3000, 8000],
    tailStart: 18,   // dB below a hit's peak where the body ends and the tail starts
    keep: 60,        // ms of tail kept before the fade starts
    fade: 150,       // ms fade length
    depth: 60,       // dB maximum cut
    curve: 0,        // -100..100 fade shape (+ = fast first)
    guard: 50,       // % sustain guard (a level dip must be a real decay)
    echo: 8,         // dB: a hit this far under the last hit is an echo (0 = off)
    floor: -70,      // dB: quieter than this counts as silence (-90 = off)
    protect: 12,     // ms after a hit where no tail may start
    open: 4,         // ms to open before the next hit (3 ms minimum, 1 ms could click on bass)
    smooth: 3,       // ms: rounds the corners of every cut (0 = off, max 6)
    sens: 6,         // dB rise that counts as a hit
    mix: 100,        // % wet
    amount: [100, 100, 100, 100] // % of depth per band
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function withDefaults(p) {
    var o = clone(DEFAULTS);
    if (p) for (var k in p) if (p[k] !== undefined) o[k] = p[k];
    return o;
  }

  /* ---------- filters (Butterworth 2nd order, two in series = LR4) ---------- */
  function biquad(type, f, sr) {
    var w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2);
    var b0, b1, b2, a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
    if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
    else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }
  function run(c, x) {
    var y = new Float32Array(x.length), x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < x.length; i++) {
      var xi = x[i], yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      if (!(yi === yi) || Math.abs(yi) > 1e6) { yi = 0; x1 = x2 = y1 = y2 = 0; } // NaN guard
      y[i] = yi; x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    }
    return y;
  }
  function lr4(type, f, sr, x) { var c = biquad(type, f, sr); return run(c, run(c, x)); }

  /* Zero-phase 4th order low pass (same size as LR4: -6 dB at the corner):
     a 2nd order Butterworth run forward, then backward. The offline core can
     do this because the whole clip is known; the plugin needs a linear phase
     FIR with reported latency to match it. */
  function zp(type, f, sr, x) {
    var c = biquad(type, f, sr), y = run(c, x), n = y.length, r = new Float32Array(n);
    for (var i = 0; i < n; i++) r[i] = y[n - 1 - i];
    var z = run(c, r), o = new Float32Array(n);
    for (var j = 0; j < n; j++) o[j] = z[n - 1 - j];
    return o;
  }

  /* Split one channel into n bands. Each band is a zero-phase low pass of what
     is left; the top band is the remainder. Every band response is real and
     between 0 and 1, and the bands add back to the input exactly, so any mix
     of band gains lands between the smallest and the largest gain: no bump or
     dip at the crossovers. */
  function split(x, sr, n, xo) {
    var out = [], rest = x;
    for (var b = 0; b < n - 1; b++) {
      var lo = zp('lp', xo[b], sr, rest), hi = new Float32Array(rest.length);
      for (var i = 0; i < rest.length; i++) hi[i] = rest[i] - lo[i];
      out.push(lo); rest = hi;
    }
    out.push(rest);
    return out;
  }

  /* ---------- level follower ---------- */
  function envelope(L, R, sr) {
    var hop = Math.max(1, Math.round(sr * HOP_MS / 1000)), win = Math.round(sr * WIN_MS / 1000);
    var n = L.length, S = new Float64Array(n + 1);
    for (var i = 0; i < n; i++) {
      var a = L[i] * L[i], b = R ? R[i] * R[i] : a;
      S[i + 1] = S[i] + (a > b ? a : b);
    }
    var nh = Math.floor(n / hop) + 1, env = new Float32Array(nh);
    for (var h = 0; h < nh; h++) {
      var c = h * hop, lo = Math.max(0, c - (win >> 1)), hi = Math.min(n, c + (win >> 1));
      var m = hi > lo ? (S[hi] - S[lo]) / (hi - lo) : 0;
      env[h] = 10 * Math.log10(m + 1e-12);
    }
    return { env: env, hop: hop };
  }

  /* Analyse: bands and their levels. Slow part; only redo if the audio or
     the crossovers change. */
  function analyze(L, R, sr, bands, xo) {
    var nb = Math.max(1, Math.min(4, bands | 0)), bl, br;
    if (nb === 1) { bl = [L]; br = [R]; }
    else { bl = split(L, sr, nb, xo); br = split(R, sr, nb, xo); }
    var envs = [], hop = 0;
    for (var b = 0; b < nb; b++) { var e = envelope(bl[b], br[b], sr); envs.push(e.env); hop = e.hop; }
    return { sr: sr, n: L.length, nb: nb, hop: hop, envs: envs, bandL: bl, bandR: br, xo: xo.slice(0, 3) };
  }

  /* ---------- decide where the tails are ---------- */
  function deriveBand(env, p, amountPct) {
    var N = env.length, ms = function (v) { return Math.max(0, Math.round(v / HOP_MS)); };
    var gain = new Float32Array(N), tails = [], hits = [];
    var k = 12, cands = [], last = -1e9;
    for (var i = k; i < N; i++) {
      if (env[i] < -85 || i - last < 40) continue;
      var mn = 1e9;
      for (var j = i - k; j < i; j++) if (env[j] < mn) mn = env[j];
      if (env[i] - mn >= p.sens && env[i] >= env[i - 1]) {
        // walk back to where the rise began
        var s = i; while (s > 1 && env[s - 1] < env[s] - 0.3 && i - s < 12) s--;
        cands.push(s); last = i;
      }
    }
    // peak of each candidate, then echo guard
    var peakWin = 120, lastPeak = -1e9, lastIdx = -1e9, echoWin = 2000;
    for (var c = 0; c < cands.length; c++) {
      var a = cands[c], pk = -1e9, ip = a;
      for (var q = a; q < Math.min(N, a + peakWin); q++) if (env[q] > pk) { pk = env[q]; ip = q; }
      if (p.echo > 0 && a - lastIdx <= echoWin && pk < lastPeak - p.echo) continue; // echo: part of the last tail
      hits.push({ a: a, peak: pk, ip: ip }); lastPeak = pk; lastIdx = a;
    }
    var depth = p.depth * (amountPct / 100);
    if (depth <= 0.001) return { gain: gain, tails: tails, hits: hits };
    var keepH = ms(p.keep), fadeH = Math.max(1, ms(p.fade)), openH = Math.max(3, ms(p.open)), leadH = 8;
    var slopeMin = 30 * (p.guard / 100); // dB per second
    var kk = Math.pow(2, (p.curve / 100) * 2);
    for (var h = 0; h < hits.length; h++) {
      var hit = hits[h], b = h + 1 < hits.length ? hits[h + 1].a : N;
      var P = hit.peak, t0 = -1, fromFloor = false;
      var from = Math.max(hit.ip, hit.a + ms(p.protect));
      for (var t = from; t < b; t++) { if (env[t] <= P - p.tailStart) { t0 = t; break; } }
      if (p.floor > -89) {
        for (var u = from; u < b; u++) { if (env[u] <= p.floor) { if (t0 < 0 || u < t0) { t0 = u; fromFloor = true; } break; } }
      }
      if (t0 < 0) continue;
      if (!fromFloor) {                     // sustain guard: must really be decaying
        var wd = Math.min(250, b - t0);
        if (wd < 20) continue;
        var mnv = 1e9; for (var w = t0; w < t0 + wd; w++) if (env[w] < mnv) mnv = env[w];
        if (env[t0] - mnv < slopeMin * wd / 1000) continue;
      }
      var iF = t0 + keepH, iE = iF + fadeH;
      var rs = (b >= N) ? N + 1e6 : b - leadH - openH;       // ramp start
      if (rs <= iF) continue;                                 // next hit too soon: nothing to cut
      var endFade = Math.min(iE, rs), gAt = 0;
      for (var m = iF; m <= Math.min(N - 1, rs) && m < N; m++) {
        var u2 = Math.min(1, (m - iF) / fadeH);
        var shape = 1 - Math.pow(1 - u2, kk);
        var g = -depth * shape;
        if (m > endFade) g = gAt; else gAt = g;
        gain[m] = g;
      }
      if (b < N) {
        var a0 = Math.pow(10, gAt / 20);
        for (var r = 1; r <= openH && rs + r < N; r++) {
          var uu = r / openH, aa = a0 + (1 - a0) * (0.5 - 0.5 * Math.cos(Math.PI * uu));
          gain[rs + r] = 20 * Math.log10(aa);
        }
      }
      tails.push({ t0: t0, from: iF, to: b >= N ? N - 1 : rs, peak: P });
    }
    return { gain: smoothDb(gain, p.smooth), tails: tails, hits: hits };
  }

  /* Round the corners of a dB gain curve with a triangular kernel. Zero stays
     exactly zero wherever all neighbours are zero, so bypass stays bit exact.
     Max 6 hops each side: the open ramp ends 8 ms before a hit, so a hit is
     never touched. */
  function smoothDb(g, s) {
    var h = Math.max(0, Math.min(6, Math.round(s || 0)));
    if (!h) return g;
    var N = g.length, o = new Float32Array(N), tot = (h + 1) * (h + 1);
    for (var i = 0; i < N; i++) {
      if (g[i] === 0) { var z = true; for (var k = -h; k <= h; k++) { var j = i + k; if (j >= 0 && j < N && g[j] !== 0) { z = false; break; } } if (z) continue; }
      var a = 0;
      for (var k2 = -h; k2 <= h; k2++) { var j2 = i + k2; if (j2 < 0) j2 = 0; if (j2 >= N) j2 = N - 1; a += g[j2] * (h + 1 - Math.abs(k2)); }
      o[i] = a / tot;
    }
    return o;
  }

  /* Derive the gain curves for all bands from the analysis. Fast: call it on
     every knob change. */
  function derive(an, params) {
    var p = withDefaults(params), res = [];
    for (var b = 0; b < an.nb; b++) res.push(deriveBand(an.envs[b], p, p.amount[b] === undefined ? 100 : p.amount[b]));
    return { bands: res, params: p };
  }

  /* ---------- apply ---------- */
  function perSample(gainHop, hop, n) {
    var g = new Float32Array(n), N = gainHop.length;
    for (var i = 0; i < n; i++) {
      var x = i / hop, i0 = Math.floor(x), f = x - i0, i1 = i0 + 1 < N ? i0 + 1 : i0;
      var db = gainHop[i0] + (gainHop[i1] - gainHop[i0]) * f;
      g[i] = db === 0 ? 1 : Math.pow(10, db / 20);
    }
    return g;
  }

  function render(an, der, L, R) {
    var n = an.n, p = der.params, mix = p.mix / 100;
    var oL = new Float32Array(L), oR = new Float32Array(R), gm = [];
    for (var b = 0; b < an.nb; b++) {
      var gh = der.bands[b].gain, any = false;
      for (var i = 0; i < gh.length; i++) if (gh[i] !== 0) { any = true; break; }
      if (!any) { gm.push(null); continue; }
      var g = perSample(gh, an.hop, n); gm.push(g);
      var bl = an.bandL[b], br = an.bandR[b];
      for (var s = 0; s < n; s++) { var d = (g[s] - 1) * mix; oL[s] += d * bl[s]; oR[s] += d * br[s]; }
    }
    return { L: oL, R: oR };
  }

  /* Numbers for the read-outs. */
  function stats(an, der, L, R, O) {
    var tails = 0, eIn = 0, eOut = 0, maxCut = 0;
    der.bands.forEach(function (b) { tails += b.tails.length; for (var i = 0; i < b.gain.length; i++) if (b.gain[i] < maxCut) maxCut = b.gain[i]; });
    for (var i = 0; i < L.length; i++) { eIn += L[i] * L[i] + R[i] * R[i]; eOut += O.L[i] * O.L[i] + O.R[i] * O.R[i]; }
    return { tails: tails, removedDb: 10 * Math.log10((eOut + 1e-20) / (eIn + 1e-20)), maxCut: maxCut };
  }

  var API = { envelope: envelope, DEFAULTS: DEFAULTS, HOP_MS: HOP_MS, WIN_MS: WIN_MS, withDefaults: withDefaults,
    analyze: analyze, derive: derive, render: render, stats: stats, perSample: perSample };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.TC = API;
})(typeof self !== 'undefined' ? self : this);
