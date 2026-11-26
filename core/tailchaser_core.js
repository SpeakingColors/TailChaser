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
    echoMatch: 6,    // dB: an echo must sound like the hit it follows (spectrum shape within this)
    echoTime: 0,     // ms: delay time of the echoes; 0 = find it from the repeats (Auto)
    center: 100,     // %: how much of the cut hits the middle of the stereo picture (100 = same as the sides)
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
    var sfr = [];
    for (var b = 0; b < nb; b++) {
      var e = envelope(bl[b], br[b], sr); envs.push(e.env); hop = e.hop;
      // share of the band's power that is in the sides (L-R), per hop
      var n0 = bl[b].length, M = new Float32Array(n0), S = new Float32Array(n0);
      for (var i0 = 0; i0 < n0; i0++) { M[i0] = 0.5 * (bl[b][i0] + br[b][i0]); S[i0] = 0.5 * (bl[b][i0] - br[b][i0]); }
      var em = envelope(M, null, sr).env, es = envelope(S, null, sr).env, f0 = new Float32Array(em.length);
      for (var h0 = 0; h0 < em.length; h0++) { var pm = Math.pow(10, em[h0] / 10), ps = Math.pow(10, es[h0] / 10); f0[h0] = pm + ps > 1e-12 ? ps / (pm + ps) : 0; }
      sfr.push(f0);
    }
    // Sound fingerprint: level in 8 octave bands (63 Hz to 8 kHz), used to
    // tell an echo (a repeat of the same sound) from a new, different sound.
    var fp = [], fc = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
    var mono = new Float32Array(L.length); for (var i = 0; i < L.length; i++) mono[i] = 0.5 * (L[i] + R[i]);
    for (var f = 0; f < fc.length; f++) {
      var x = zp('lp', fc[f] * 1.41, sr, zp('hp', fc[f] / 1.41, sr, mono));
      fp.push(envelope(x, null, sr).env);
    }
    return { sr: sr, n: L.length, nb: nb, hop: hop, envs: envs, bandL: bl, bandR: br, xo: xo.slice(0, 3), fp: fp, sideFrac: sfr };
  }

  /* ---------- decide where the tails are ---------- */
  function deriveBand(env, p, amountPct, fp, octs, cmp) {
    var N = env.length, ms = function (v) { return Math.max(0, Math.round(v / HOP_MS)); };
    var gain = new Float32Array(N), tails = [], hits = [];
    // New sounds: a quick rise in the band level, OR a quick rise in one of the
    // octave bands inside this band (a hi-hat over a louder kick tail barely
    // moves the overall level, but jumps in the high octaves). An octave rise
    // only counts if that octave is audible (above -60 dBFS and within 40 dB
    // of the band level) and jumps 6 dB more than Hit sens; the low octaves
    // wobble too much in 10 ms and are left out (below 500 Hz).
    function rises(e, gate) {
      var out = [], k = gate ? 12 : 20, last = -1e9;
      for (var i = k; i < N; i++) {
        if (e[i] < -85 || i - last < 40) continue;
        if (gate && e[i] < Math.max(-60, env[i] - 40)) continue;
        var mn = 1e9;
        for (var j = i - k; j < i; j++) if (e[j] < mn) mn = e[j];
        if (e[i] - mn >= p.sens + (gate ? 6 : 0) && e[i] >= e[i - 1]) {
          var s = i; while (s > 1 && e[s - 1] < e[s] - 0.3 && i - s < k) s--;
          out.push(s); last = i;
        }
      }
      return out;
    }
    var all = rises(env, false);
    if (fp && octs) for (var o = 0; o < octs.length; o++) all = all.concat(rises(fp[octs[o]], true));
    all.sort(function (x, y) { return x - y; });
    var cands = [];
    for (var c0 = 0; c0 < all.length; c0++) if (!cands.length || all[c0] - cands[cands.length - 1] >= 40) cands.push(all[c0]);
    // peak of each candidate, then echo guard
    var peakWin = 120, lastPeak = -1e9, lastIdx = -1e9, echoWin = 2000, lastShape = null;
    // Shape of what a sound ADDED (power at its peak minus power just before
    // it started), per fingerprint band, normalised to its own loudest band.
    function shape(a, ip) {
      if (!fp) return null;
      var v = [], mx = -1e9, pre = Math.max(0, a - 3), use = cmp || [0, 1, 2, 3, 4, 5, 6, 7];
      for (var u0 = 0; u0 < use.length; u0++) { var f = use[u0];
        var d = Math.pow(10, fp[f][ip] / 10) - Math.pow(10, fp[f][pre] / 10);
        var db = 10 * Math.log10(Math.max(d, 1e-12)); v.push(db); if (db > mx) mx = db;
      }
      for (var g2 = 0; g2 < v.length; g2++) v[g2] = Math.max(v[g2] - mx, -40);
      return v;
    }
    function sameSound(x, y) {
      if (!x || !y) return true; // no fingerprint: old level-only rule
      // median difference, so one octave spoiled by another sound (a kick
      // landing under an echo) cannot break the match
      var ds = [];
      for (var f = 0; f < x.length; f++) if (x[f] > -30 || y[f] > -30) ds.push(Math.abs(x[f] - y[f]));
      if (!ds.length) return false;
      ds.sort(function (q, r) { return q - r; });
      var med = ds.length % 2 ? ds[ds.length >> 1] : 0.5 * (ds[(ds.length >> 1) - 1] + ds[ds.length >> 1]);
      return med <= (p.echoMatch === undefined ? 6 : p.echoMatch);
    }
    // Pass 1: every candidate with its peak and tone.
    var C = [];
    for (var c = 0; c < cands.length; c++) {
      var a = cands[c], pk = -1e9, ip = a;
      for (var q = a; q < Math.min(N, a + peakWin); q++) if (env[q] > pk) { pk = env[q]; ip = q; }
      C.push({ a: a, peak: pk, ip: ip, sh: shape(a, ip) });
    }
    // Pass 2: echo guard with timing. A quieter sound with the same tone is an
    // echo only if it sits on the echo grid: a multiple of the delay time after
    // the hit. The delay time is set (echoTime) or found from a repeat pattern
    // (a second repeat at twice the spacing). A single same-tone ghost note off
    // the grid stays a hit.
    var tol = 15, fixedD = p.echoTime > 0 ? p.echoTime / HOP_MS : 0, songD = fixedD, echoTimes = [];
    function onGrid(d, D) { if (!D) return false; var k = Math.round(d / D); return k >= 1 && k <= 16 && Math.abs(d - k * D) <= tol; }
    // An echo is matched to the most recent LOUDER sound with the SAME tone
    // (other sounds may play in between, like drums under a delayed stab).
    function sourceOf(x, list) {
      for (var r = list.length - 1; r >= 0; r--) {
        var h = list[r];
        if (x.a - h.a > echoWin) break;
        if (x.peak < h.peak - p.echo && sameSound(x.sh, h.sh)) return h;
      }
      return null;
    }
    // Song-wide pattern: the same spacing from a sound to a quieter copy of
    // it, at the same level drop, seen 4 or more times = the delay time, even
    // when the second repeat is hidden under the next note.
    if (!fixedD && p.echo > 0) {
      var pairs = [], seen = [];
      for (var c1 = 0; c1 < C.length; c1++) {
        var z = C[c1], h0 = sourceOf(z, seen);
        if (h0) pairs.push({ d: z.a - h0.a, drop: h0.peak - z.peak }); else seen.push(z);
      }
      var best = 0, bestN = 0;
      for (var i1 = 0; i1 < pairs.length; i1++) {
        var cnt = 0, sum = 0;
        for (var i2 = 0; i2 < pairs.length; i2++)
          if (Math.abs(pairs[i2].d - pairs[i1].d) <= tol && Math.abs(pairs[i2].drop - pairs[i1].drop) <= 3) { cnt++; sum += pairs[i2].d; }
        if (cnt > bestN) { bestN = cnt; best = sum / cnt; }
      }
      if (bestN >= 4) songD = best;
    }
    var real = [];
    for (var c2 = 0; c2 < C.length; c2++) {
      var x = C[c2], isEcho = false, src = p.echo > 0 ? sourceOf(x, real) : null;
      if (src) {
        var d = x.a - src.a;
        if (onGrid(d, src.D || songD)) isEcho = true;
        else if (!fixedD) {
          for (var m = c2 + 1; m < C.length && C[m].a - src.a <= 2 * d + tol; m++) {
            var y = C[m];
            if (Math.abs((y.a - src.a) - 2 * d) <= tol && y.peak <= x.peak + 1.5 && sameSound(y.sh, src.sh)) {
              isEcho = true; src.D = d; if (!songD) songD = d; break;
            }
          }
        }
      }
      if (isEcho) continue;
      hits.push({ a: x.a, peak: x.peak, ip: x.ip }); real.push({ a: x.a, peak: x.peak, sh: x.sh, D: 0 });
    }
    var depth = p.depth * (amountPct / 100), echoMs = songD ? songD * HOP_MS : 0;
    if (depth <= 0.001) return { gain: gain, tails: tails, hits: hits, echoMs: echoMs };
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
      if (!fromFloor && slopeMin > 0) {     // sustain guard: must KEEP decaying
        // A tail falls (steadily, or in echo steps) or into silence. A
        // level that drops and then holds (a kick decaying onto a held bass
        // note) is not a tail: slide forward and look again, so the cut only
        // starts once the held sound itself dies away.
        var ok0 = false;
        for (var tt = t0; tt < b - 20; tt += 10) {
          var wd = Math.min(250, b - tt), hf = wd >> 1;
          if (wd < 20) break;
          var e1 = avgDb(env, tt, tt + 10), e2 = avgDb(env, tt + hf - 5, tt + hf + 5), e3 = avgDb(env, tt + wd - 10, tt + wd);
          var need = slopeMin * wd / 1000, mn2 = 1e9, mx2 = -1e9, mnAll = 1e9;
          for (var w = tt; w < tt + wd; w++) { if (env[w] < mnAll) mnAll = env[w]; }
          for (var w2 = tt + hf; w2 + 20 <= tt + wd; w2 += 5) { var av = avgDb(env, w2, w2 + 20); if (av < mn2) mn2 = av; if (av > mx2) mx2 = av; }
          if (mx2 < -1e8) { mn2 = mx2 = e3; }
          var hold = e3 > -85 && mx2 - mn2 <= 5 && e2 - e3 < need * 0.25;  // level sits still: a held note
          if (!hold && e1 - mnAll >= need) { t0 = tt; ok0 = true; break; }
        }
        if (!ok0) continue;
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
    return { gain: smoothDb(gain, p.smooth), tails: tails, hits: hits, echoMs: echoMs };
  }

  function avgDb(e, a, b) { var s = 0, n = 0; for (var i = Math.max(0, a); i < Math.min(e.length, b); i++) { s += e[i]; n++; } return n ? s / n : -120; }

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
    for (var b = 0; b < an.nb; b++) {
      var lo = b === 0 ? 0 : an.xo[b - 1], hi = b === an.nb - 1 ? 1e9 : an.xo[b], octs = [], fc = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
      var cmp = [];
      for (var o = 0; o < fc.length; o++) {
        if (fc[o] >= 500 && fc[o] >= lo && fc[o] < hi) octs.push(o);
        if (fc[o] * 2 >= lo && fc[o] / 2 < hi) cmp.push(o);   // tone compare: the band plus one octave each side
      }
      res.push(deriveBand(an.envs[b], p, p.amount[b] === undefined ? 100 : p.amount[b], an.fp, octs, cmp));
    }
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

  /* Apply. With Center 100 the middle and the sides get the same cut (plain
     gain per band). Lower Center cuts the middle less: the dry centre stays
     natural while the wide reverb tail is still cleared. Unity gain or Mix 0
     leaves the input bit exact. */
  function render(an, der, L, R) {
    var n = an.n, p = der.params, mix = p.mix / 100, cen = Math.max(0, Math.min(100, p.center === undefined ? 100 : p.center)) / 100;
    var oL = new Float32Array(L), oR = new Float32Array(R);
    for (var b = 0; b < an.nb; b++) {
      var gh = der.bands[b].gain, any = false;
      for (var i = 0; i < gh.length; i++) if (gh[i] !== 0) { any = true; break; }
      if (!any) continue;
      var gS = perSample(gh, an.hop, n), bl = an.bandL[b], br = an.bandR[b];
      if (cen >= 1) {
        for (var s = 0; s < n; s++) { var d = (gS[s] - 1) * mix; oL[s] += d * bl[s]; oR[s] += d * br[s]; }
      } else {
        var gmh = new Float32Array(gh.length); for (var k = 0; k < gh.length; k++) gmh[k] = gh[k] * cen;
        var gM = perSample(gmh, an.hop, n);
        for (var s2 = 0; s2 < n; s2++) {
          var dm = (gM[s2] - 1) * mix * 0.5 * (bl[s2] + br[s2]), ds = (gS[s2] - 1) * mix * 0.5 * (bl[s2] - br[s2]);
          oL[s2] += dm + ds; oR[s2] += dm - ds;
        }
      }
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

  /* Auto: listen to the clip and suggest settings for it.
     - Floor: 6 dB above the noise floor (10th percentile of the level where
       there is sound), so steady hiss and bleed between hits go.
     - Tail start: for each hit, where the fast drop of the hit turns into
       the slow fall of the tail (the decay slope falls below a quarter of
       its steepest value); median over the hits.
     - Keep and Fade: from the typical spacing between hits (12 % and 30 %).
     - Echo time: the delay time found from the repeats, if there is one.
     Returns { params, why } so the page can show what changed and why. */
  function suggest(an, cur) {
    var p = withDefaults(cur || {}), nb = an.nb, n = an.envs[0].length, env = new Float32Array(n);
    for (var i = 0; i < n; i++) { var s = 0; for (var b = 0; b < nb; b++) s += Math.pow(10, an.envs[b][i] / 10); env[i] = 10 * Math.log10(s + 1e-12); }
    var why = [], out = {};
    // noise floor
    var lv = []; for (var i1 = 0; i1 < n; i1 += 2) if (env[i1] > -100) lv.push(env[i1]);
    lv.sort(function (x, y) { return x - y; });
    var p10 = lv.length ? lv[Math.floor(lv.length * 0.1)] : -120;
    // hits on the whole sound (1 band, plain level rule)
    // (echo guard on, so delay repeats are not counted as hits)
    var one = deriveBand(env, withDefaults({ echo: 8, depth: 60 }), 100, an.fp, [3, 4, 5, 6, 7], [0, 1, 2, 3, 4, 5, 6, 7]), hits = one.hits;
    var pkAll = hits.map(function (x) { return x.peak; }).sort(function (x, y) { return x - y; });
    var loud = pkAll.length ? pkAll[Math.floor(pkAll.length * 0.75)] : 0;
    // Floor only for real noise: the quiet part must sit 45 dB or more under
    // the hits (otherwise it is music: held bass, pads) and never above -55.
    if (p10 <= -88) { out.floor = -90; why.push('clean silence between sounds, Floor off'); }
    else if (loud - p10 >= 45) { out.floor = Math.max(-90, Math.min(-55, Math.round(p10 + 6))); why.push('noise floor ' + Math.round(p10) + ' dB'); }
    else why.push('quiet parts are music, not noise: Floor left as it was');
    if (hits.length < 2) { why.push('fewer than 2 hits found, timing left as it was'); return { params: out, why: why, hits: hits.length }; }
    var gaps = [], knees = [];
    for (var m0 = 0; m0 + 1 < hits.length; m0++) gaps.push(hits[m0 + 1].a - hits[m0].a);
    if (!gaps.length) gaps.push(n);
    for (var h = 0; h < hits.length; h++) {
      var a = hits[h].ip, end = h + 1 < hits.length ? hits[h + 1].a : n;
      if (end - a < 120) continue;
      var sl = [], mx = 0;
      for (var t = a; t + 10 < Math.min(end, a + 1500); t += 5) { var d = (env[t] - env[t + 10]) / 10; sl.push([t, d]); if (t < a + 60 && d > mx) mx = d; }
      if (mx <= 0.02) continue;
      // how fast the tail itself falls: median slope over the later part
      var late = sl.slice(Math.floor(sl.length * 0.4)).map(function (q) { return q[1]; }).sort(function (x, y) { return x - y; });
      var ls = late.length ? Math.max(0, late[Math.floor(late.length / 2)]) : 0, thr = Math.max(0.25 * mx, 1.6 * ls);
      if (thr >= 0.8 * mx) continue;   // no clear turn: the hit fades like its tail
      for (var k = 2; k < sl.length; k++) {
        if (sl[k][1] < thr && sl[k - 1][1] < thr) { var drop = hits[h].peak - env[sl[k][0]]; if (drop > 3) knees.push(drop); break; }
      }
    }
    function med(v) { v = v.slice().sort(function (x, y) { return x - y; }); return v[Math.floor(v.length / 2)]; }
    if (knees.length) { out.tailStart = Math.max(8, Math.min(36, Math.round(med(knees)))); why.push('hits turn into tails about ' + out.tailStart + ' dB under their peak'); }
    var g = med(gaps) * HOP_MS;
    out.keep = Math.max(10, Math.min(400, Math.round(g * 0.12)));
    out.fade = Math.max(20, Math.min(1200, Math.round(g * 0.3)));
    why.push('hits about ' + Math.round(g) + ' ms apart');
    // delay time with the suggested settings
    var tryP = withDefaults(Object.assign({}, cur, out, { echoTime: 0, echo: cur && cur.echo > 0 ? cur.echo : 8 }));
    var dv = derive(an, tryP), em = 0;
    dv.bands.forEach(function (bd) { if (bd.echoMs > em) em = bd.echoMs; });
    if (em) { out.echo = tryP.echo; out.echoTime = Math.round(em); why.push('delay repeats every ' + Math.round(em) + ' ms'); }
    else { out.echoTime = 0; why.push('no delay pattern found'); }
    return { params: out, why: why, hits: hits.length };
  }

  var API = { envelope: envelope, DEFAULTS: DEFAULTS, HOP_MS: HOP_MS, WIN_MS: WIN_MS, withDefaults: withDefaults,
    analyze: analyze, derive: derive, render: render, stats: stats, perSample: perSample, suggest: suggest };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.TC = API;
})(typeof self !== 'undefined' ? self : this);
