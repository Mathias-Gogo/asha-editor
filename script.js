const $ = id => document.getElementById(id), clamp = (v, a, b) => v < a ? a : v > b ? b : v, sleep = ms => new Promise(r => setTimeout(r, ms));
        const viewer = $('viewer'), stage = $('stage'), cO = $('cO'), cG = $('cG'), divEl = $('div'), autoBtn = $('auto');
        const ctxO = cO.getContext('2d', { willReadFrequently: true }), ctxG = cG.getContext('2d');
        const KEYS = ['exposure', 'contrast', 'highlights', 'shadows', 'vibrance', 'saturation', 'warmth', 'tint'];
        const DEFS = {
            gs: [['exposure', 'Exposure'], ['contrast', 'Contrast'], ['highlights', 'Highlights'], ['shadows', 'Shadows'], ['vibrance', 'Vibrance'], ['saturation', 'Saturation'], ['warmth', 'Warmth'], ['tint', 'Tint']],
            ts: [['structure', 'Structure'], ['clarity', 'Clarity'], ['sharpen', 'Sharpen', 0], ['grain', 'Grain', 0], ['vignette', 'Vignette'], ['fade', 'Fade', 0]]
        };
        const HINT = { c: 'Tint shadows, midtones and highlights with the wheels, or shift single colors below.', v: 'Drag points to shape brightness. Tap the line to add a point, double-tap a point to remove it.', g: 'Adjust the sliders yourself, or run Auto color grade and fine tune from there.', t: 'Structure and clarity add texture, sharpen adds crispness.' };
        const reduce = matchMedia('(prefers-reduced-motion:reduce)').matches;
        const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
        const P = {};[...KEYS, 'structure', 'clarity', 'sharpen', 'grain', 'vignette', 'fade'].forEach(k => P[k] = 0);
        const inputs = {}, outs = {};
        let W = 0, H = 0, src = null, auto = null, noise = null, graded = false, busy = false, pending = false, pos = 100, tab = 'g', showing = false, TEMP = 0, cx = 0, cy = 0;
        /* ---------- sound: tiny synthesized clicks ---------- */
        let AC = null, muted = false, lt = 0;
        function beep(f1, f2, d, v, ty) { if (muted) return; try { AC = AC || new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === 'suspended') AC.resume(); const t = AC.currentTime, o = AC.createOscillator(), g = AC.createGain(); o.type = ty || 'sine'; o.frequency.setValueAtTime(f1, t); o.frequency.exponentialRampToValueAtTime(f2, t + d); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(.0001, t + d); o.connect(g); g.connect(AC.destination); o.start(t); o.stop(t + d + .02) } catch (e) { } }
        const SND = { click: () => { beep(2000, 650, .05, .06, 'square'); setTimeout(() => beep(900, 500, .04, .04), 45) }, tick: () => { const n = performance.now(); if (n - lt > 65) { lt = n; beep(2700, 2300, .02, .025) } }, pop: () => beep(520, 900, .1, .07), send: () => beep(700, 1150, .07, .06), done: () => { beep(660, 660, .16, .06); setTimeout(() => beep(990, 990, .26, .06), 120) } };
        /* ---------- caption + chat ---------- */
        let capT; function cap(t, hold) { const c = $('cap'); c.textContent = t; c.classList.add('on'); clearTimeout(capT); if (hold) capT = setTimeout(() => c.classList.remove('on'), hold) }
        const addMsg = () => { }, asha = async () => { }, openChat = () => { };
        /* ---------- sliders ---------- */
        function fill(i) { const mn = +i.min, mx = +i.max, p = (+i.value - mn) / (mx - mn) * 100, z = mn < 0 ? -mn / (mx - mn) * 100 : 0; i.style.setProperty('--a', Math.min(p, z)); i.style.setProperty('--b', Math.max(p, z)) }
        Object.keys(DEFS).forEach(h => DEFS[h].forEach(([k, l, mn = -100, mx = 100]) => {
            const row = document.createElement('div'); row.className = 'row';
            row.innerHTML = '<span>' + l + '</span><input type="range" min="' + mn + '" max="' + mx + '" value="0" aria-label="' + l + '"><output>0</output>';
            inputs[k] = row.querySelector('input'); outs[k] = row.querySelector('output'); fill(inputs[k]);
            inputs[k].addEventListener('input', () => { P[k] = +inputs[k].value; outs[k].textContent = P[k]; fill(inputs[k]); scheduleRender() });
            $(h).appendChild(row)
        }));
        function sync() { Object.keys(inputs).forEach(k => { inputs[k].value = P[k]; outs[k].textContent = Math.round(P[k]); fill(inputs[k]) }); syncX() }
        /* ---------- image maths ---------- */
        function blur(a, w, h, r) {
            const t = new Float32Array(a.length), o = new Float32Array(a.length), n = 2 * r + 1;
            for (let y = 0; y < h; y++) { const row = y * w; let s = 0; for (let x = -r; x <= r; x++)s += a[row + clamp(x, 0, w - 1)]; for (let x = 0; x < w; x++) { t[row + x] = s / n; s += a[row + clamp(x + r + 1, 0, w - 1)] - a[row + clamp(x - r, 0, w - 1)] } }
            for (let x = 0; x < w; x++) { let s = 0; for (let y = -r; y <= r; y++)s += t[clamp(y, 0, h - 1) * w + x]; for (let y = 0; y < h; y++) { o[y * w + x] = s / n; s += t[clamp(y + r + 1, 0, h - 1) * w + x] - t[clamp(y - r, 0, h - 1) * w + x] } } return o
        }
        function sf(v, a) { return v <= .88 ? v : v + (.88 + .12 * Math.tanh((v - .88) / .12) - v) * a }
        function analyze(d) {
            const n = d.length / 4, hist = new Uint32Array(256); let sd = 0, sh = 0, ch = 0, nn = 0, nr = 0, ng = 0, nb = 0;
            for (let i = 0; i < d.length; i += 4) { const r = d[i], g = d[i + 1], b = d[i + 2], L = Math.round(.2126 * r + .7152 * g + .0722 * b), c = (Math.max(r, g, b) - Math.min(r, g, b)) / 255; hist[L]++; ch += c; if (L > 235) sh++; if (L < 30) sd++; if (L > 150 && c < .12) { nn++; nr += r; ng += g; nb += b } }
            let acc = 0, p1 = 0, p99 = 255, med = 128, gm = false, g1 = false;
            for (let v = 0; v < 256; v++) { acc += hist[v]; if (!g1 && acc >= n * .01) { p1 = v; g1 = true } if (!gm && acc >= n * .5) { med = v; gm = true } if (acc >= n * .99) { p99 = v; break } }
            let warm = 0, tint = 0; if (nn > n * .01) { nr /= nn; ng /= nn; nb /= nn; warm = clamp((nb - nr) / 255 * 70, -12, 12); tint = clamp((ng - (nr + nb) / 2) / 255 * 70, -6, 6) }
            const m = med / 255, target = m < .38 ? .38 : m > .62 ? .62 : m, spread = (p99 - p1) / 255, sat = ch / n;
            return { exposure: clamp(Math.log2(target / Math.max(m, .05)), -.4, .5) * 50, contrast: clamp((.98 - spread) * 60 + 8, 8, 30), highlights: -clamp(sh / n * 120, 0, 40), shadows: clamp(sd / n * 100, 0, 30), vibrance: 18 + (sat < .2 ? 12 : 0), saturation: 4, warmth: warm, tint: tint }
        }
        function measure(p) {
            const s = src.data, k = Math.pow(2, p.exposure / 50), w = p.warmth / 100, t = p.tint / 100, rM = k * (1 + .25 * w), gM = k * (1 - .2 * t), bM = k * (1 - .25 * w), sh = p.shadows / 100 * .3, hl = p.highlights / 100 * .45, c = 1 + p.contrast / 100 * .8; let n = 0, sum = 0, clip = 0;
            for (let i = 0; i < s.length; i += 24) { let r = s[i] / 255 * rM, g = s[i + 1] / 255 * gM, b = s[i + 2] / 255 * bM, L = .2126 * r + .7152 * g + .0722 * b; L = L < 0 ? 0 : L > 1 ? 1 : L; const a = sh * (1 - L) * (1 - L) + hl * L * L; r += a; g += a; b += a; r = .5 + (r - .5) * c; g = .5 + (g - .5) * c; b = .5 + (b - .5) * c; sum += clamp(.2126 * r + .7152 * g + .0722 * b, 0, 1); n++; if (Math.max(r, g, b) > .97) clip++ }
            return { mean: sum / n, clip: clip / n }
        }
        function fitTo(o, lo, hi) {
            const z = {}; KEYS.forEach(k => z[k] = 0); const lim = Math.max(.015, measure(z).clip + .005);
            for (let i = 0; i < 18; i++) { const m = measure(o); if (m.clip > lim) { o.exposure -= 5; o.highlights = Math.max(-90, o.highlights - 4) } else if (m.mean > hi) o.exposure -= 4; else if (m.mean < lo && o.exposure < 40) o.exposure += 3; else break }
            for (let i = 0; i < 8 && measure(o).clip > lim; i++)o.exposure -= 4
        }
        function hsv(h) { const q = (((h % 360) + 360) % 360) / 60, x = 1 - Math.abs(q % 2 - 1); return [[1, x, 0], [x, 1, 0], [0, 1, x], [0, x, 1], [x, 0, 1], [1, 0, x]][Math.floor(q) % 6] }
        const WH = [0, 1, 2].map(() => ({ h: 0, s: 0, l: 0 })), H8 = Array.from({ length: 8 }, () => [0, 0, 0]), CVS = [], LU = [];
        let hi = 0, ci = 0, cd = -1, cvOn = false; const ID = () => [[0, 0], [.25, .25], [.5, .5], [.75, .75], [1, 1]];
        function lutOf(pts) {
            const n = pts.length, x = pts.map(p => p[0]), y = pts.map(p => p[1]), d = [], m = [], o = new Float32Array(256);
            for (let i = 0; i < n - 1; i++)d[i] = (y[i + 1] - y[i]) / (x[i + 1] - x[i]); m[0] = d[0]; m[n - 1] = d[n - 2]; for (let i = 1; i < n - 1; i++)m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
            for (let i = 0; i < n - 1; i++) { if (d[i] === 0) { m[i] = m[i + 1] = 0 } else { const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b; if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i] } } }
            let sg = 0; for (let k = 0; k < 256; k++) { const v = k / 255; while (sg < n - 2 && v > x[sg + 1]) sg++; const h = x[sg + 1] - x[sg], t = (v - x[sg]) / h, t2 = t * t, t3 = t2 * t; o[k] = clamp((2 * t3 - 3 * t2 + 1) * y[sg] + (t3 - 2 * t2 + t) * h * m[sg] + (-2 * t3 + 3 * t2) * y[sg + 1] + (t3 - t2) * h * m[sg + 1], 0, 1) } return o
        }
        function rebuild() { CVS.forEach((p, i) => { LU[i] = lutOf(p) }); cvOn = CVS.some(p => p.some(q => Math.abs(q[0] - q[1]) > .002)) }
        function resetExtras() { WH.forEach(q => { q.h = 0; q.s = 0; q.l = 0 }); H8.forEach(q => { q[0] = q[1] = q[2] = 0 }); for (let i = 0; i < 4; i++)CVS[i] = ID(); rebuild() } resetExtras();
        function prep() {
            const V = []; let w = false; WH.forEach(q => { const c = hsv(q.h), m = (c[0] + c[1] + c[2]) / 3, k = q.s * .35, l = q.l / 100 * .2; V.push((c[0] - m) * k + l, (c[1] - m) * k + l, (c[2] - m) * k + l); if (q.s > 0 || q.l) w = true });
            return { fd: P.fade / 100 * .18, w, V, h: H8.some(q => q[0] || q[1] || q[2]), H: H8, C: [0, 30, 60, 120, 180, 240, 285, 330], c: cvOn ? LU : null }
        }
        function render() {
            pending = false; if (!src) return;
            const s = src.data, out = ctxG.createImageData(W, H), d = out.data, sa = Math.min(1, KEYS.reduce((a, q) => a + Math.abs(P[q]), 0) / 40), k = Math.pow(2, P.exposure / 50), w = P.warmth / 100, t = P.tint / 100, rM = k * (1 + .25 * w), gM = k * (1 - .2 * t), bM = k * (1 - .25 * w);
            const sh = P.shadows / 100 * .3, hl = P.highlights / 100 * .45, c = 1 + P.contrast / 100 * .8, sat = 1 + P.saturation / 100, vib = P.vibrance / 100, X = prep(), vg = P.vignette / 100;
            for (let y = 0; y < H; y++)for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4; let r = s[i] / 255 * rM, g = s[i + 1] / 255 * gM, b = s[i + 2] / 255 * bM, L = .2126 * r + .7152 * g + .0722 * b; L = L < 0 ? 0 : L > 1 ? 1 : L;
                const a = sh * (1 - L) * (1 - L) + hl * L * L; r += a; g += a; b += a; r = .5 + (r - .5) * c; g = .5 + (g - .5) * c; b = .5 + (b - .5) * c;
                const L2 = .2126 * r + .7152 * g + .0722 * b, mx = Math.max(r, g, b), mn = Math.min(r, g, b), am = Math.max(0, sat + vib * (1 - (mx > 0 ? (mx - mn) / mx : 0)));
                r = L2 + (r - L2) * am; g = L2 + (g - L2) * am; b = L2 + (b - L2) * am; r = sf(r, sa); g = sf(g, sa); b = sf(b, sa);
                if (X.fd) { r = X.fd + r * (1 - X.fd); g = X.fd + g * (1 - X.fd); b = X.fd + b * (1 - X.fd) }
                if (X.w) { const Y = clamp(.2126 * r + .7152 * g + .0722 * b, 0, 1), a1 = (1 - Y) * (1 - Y), a3 = Y * Y, a2 = 1 - a1 - a3, V = X.V; r += a1 * V[0] + a2 * V[3] + a3 * V[6]; g += a1 * V[1] + a2 * V[4] + a3 * V[7]; b += a1 * V[2] + a2 * V[5] + a3 * V[8] }
                if (X.h) {
                    const mx3 = Math.max(r, g, b), dl = mx3 - Math.min(r, g, b); if (dl > .03) {
                        const hh = (mx3 === r ? ((g - b) / dl + 6) % 6 : mx3 === g ? (b - r) / dl + 2 : (r - g) / dl + 4) * 60, C = X.C; let j = 0; while (j < 7 && hh >= C[j + 1]) j++;
                        const f = (hh - C[j]) / ((j < 7 ? C[j + 1] : 360) - C[j]), A = X.H[j], B = X.H[(j + 1) % 8], wt = Math.min(1, dl * 5), ag = (A[0] + (B[0] - A[0]) * f) / 100 * .5 * wt, cc = Math.cos(ag), sg = Math.sin(ag);
                        const nr = r * (.213 + cc * .787 - sg * .213) + g * (.715 - cc * .715 - sg * .715) + b * (.072 - cc * .072 + sg * .928), ng = r * (.213 - cc * .213 + sg * .143) + g * (.715 + cc * .285 + sg * .14) + b * (.072 - cc * .072 - sg * .283), nb = r * (.213 - cc * .213 - sg * .787) + g * (.715 - cc * .715 + sg * .715) + b * (.072 + cc * .928 + sg * .072);
                        const Lq = .2126 * nr + .7152 * ng + .0722 * nb, s2 = 1 + (A[1] + (B[1] - A[1]) * f) / 100 * wt, lm = 1 + (A[2] + (B[2] - A[2]) * f) / 100 * .5 * wt; r = (Lq + (nr - Lq) * s2) * lm; g = (Lq + (ng - Lq) * s2) * lm; b = (Lq + (nb - Lq) * s2) * lm
                    }
                }
                if (X.c) { const q = X.c[0]; r = X.c[1][(q[(clamp(r, 0, 1) * 255 + .5) | 0] * 255 + .5) | 0]; g = X.c[2][(q[(clamp(g, 0, 1) * 255 + .5) | 0] * 255 + .5) | 0]; b = X.c[3][(q[(clamp(b, 0, 1) * 255 + .5) | 0] * 255 + .5) | 0] }
                if (vg) { const dx = (x / W - .5) * 2, dy = (y / H - .5) * 2, f = 1 - vg * .45 * (dx * dx + dy * dy) / 2; r *= f; g *= f; b *= f }
                d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255; d[i + 3] = 255
            }
            if (P.structure || P.clarity || P.sharpen || P.grain) {
                const n = W * H, Ly = new Float32Array(n); for (let p = 0; p < n; p++)Ly[p] = .2126 * d[p * 4] + .7152 * d[p * 4 + 1] + .0722 * d[p * 4 + 2];
                const bs = P.structure ? blur(Ly, W, H, 3) : null, bc = P.clarity ? blur(Ly, W, H, 12) : null, bh = P.sharpen ? blur(Ly, W, H, 1) : null, ks = P.structure / 100 * 1.1, kc = P.clarity / 100 * .9, kh = P.sharpen / 100 * 1.6, kg = P.grain / 100 * 70;
                for (let p = 0; p < n; p++) { let dl = kg * noise[p]; if (bs) dl += ks * (Ly[p] - bs[p]); if (bc) dl += kc * (Ly[p] - bc[p]); if (bh) dl += kh * (Ly[p] - bh[p]); const i = p * 4; d[i] += dl; d[i + 1] += dl; d[i + 2] += dl }
            }
            ctxG.putImageData(out, 0, 0); drawHist(d)
        }
        function scheduleRender() { if (!pending) { pending = true; requestAnimationFrame(render) } }
        function drawHist(d) { }
        function readPhoto() {
            const d = src.data, hist = new Uint32Array(256); let n = 0, sum = 0, sr = 0, sb = 0, cl = 0, cr = 0, ch = 0, sk = 0;
            for (let i = 0; i < d.length; i += 8) { const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), L = Math.round(.2126 * r + .7152 * g + .0722 * b); hist[L]++; sum += L; sr += r; sb += b; n++; if (mx >= 250) cl++; if (L < 8) cr++; ch += (mx - mn) / 255; if (r > 95 && g > 40 && b > 20 && mx - mn > 15 && Math.abs(r - g) > 15 && r > g && r > b) sk++ }
            let acc = 0, p1 = 0, p99 = 255, g1 = false; for (let v = 0; v < 256; v++) { acc += hist[v]; if (!g1 && acc >= n * .01) { p1 = v; g1 = true } if (acc >= n * .99) { p99 = v; break } }
            const mean = sum / n / 255, spread = (p99 - p1) / 255, temp = (sr - sb) / n / 255, sat = ch / n;
            const T = [['Brightness', (mean < .3 ? 'Dark' : mean < .42 ? 'Low-key' : mean < .6 ? 'Balanced' : 'Bright') + ' \u00b7 ' + Math.round(mean * 100) + '%'], ['Contrast', spread < .55 ? 'Flat' : spread < .85 ? 'Natural' : 'Punchy'], ['Light range', cl / n > .02 ? Math.round(cl / n * 100) + '% near clipping' : cr / n > .1 ? 'Deep shadows' : 'Healthy'], ['Color', (temp > .1 ? 'Warm' : temp < -.05 ? 'Cool' : 'Neutral') + ', ' + (sat < .15 ? 'muted' : sat < .35 ? 'natural' : 'vivid')]];
            
            TEMP = temp
        }
        /* ---------- color wheels, single colors, curves ---------- */
        function wheelCanvas() {
            const S = 140, c = document.createElement('canvas'); c.width = c.height = S; const x = c.getContext('2d'), im = x.createImageData(S, S), d = im.data;
            for (let j = 0; j < S; j++)for (let i = 0; i < S; i++) { const dx = (i + .5) / S * 2 - 1, dy = (j + .5) / S * 2 - 1, rr = Math.hypot(dx, dy), q = (j * S + i) * 4; if (rr > 1) continue; const col = hsv(Math.atan2(dy, dx) * 180 / Math.PI); for (let k = 0; k < 3; k++)d[q + k] = 70 + (col[k] * 215 - 70) * Math.min(1, rr * 1.1); d[q + 3] = 255 } x.putImageData(im, 0, 0); return c
        }
        const pk = [], lum = [];
        ['Shadows', 'Midtones', 'Highlights'].forEach((nm, z) => {
            const w = document.createElement('div'); w.className = 'wh';
            w.innerHTML = '<span>' + nm + '</span><div class="wc"><div class="pk"></div></div><input type="range" min="-100" max="100" value="0" aria-label="' + nm + ' brightness">';
            const wc = w.querySelector('.wc'); wc.insertBefore(wheelCanvas(), wc.firstChild); pk[z] = w.querySelector('.pk'); lum[z] = w.querySelector('input'); fill(lum[z]);
            const set = e => { const r = wc.getBoundingClientRect(), dx = (e.clientX - r.left) / r.width * 2 - 1, dy = (e.clientY - r.top) / r.height * 2 - 1; WH[z].h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360; WH[z].s = Math.min(1, Math.hypot(dx, dy)); syncX(); scheduleRender() };
            let dn = false; wc.addEventListener('pointerdown', e => { dn = true; wc.setPointerCapture(e.pointerId); set(e) }); wc.addEventListener('pointermove', e => { if (dn) set(e) });
            ['pointerup', 'pointercancel'].forEach(v => wc.addEventListener(v, () => { dn = false })); wc.addEventListener('dblclick', () => { WH[z].s = 0; syncX(); scheduleRender() });
            lum[z].addEventListener('input', () => { WH[z].l = +lum[z].value; fill(lum[z]); scheduleRender() }); $('wheels').appendChild(w)
        });
        const BAND = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'], BC = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#26c6da', '#1e88e5', '#8e24aa', '#ec407a'];
        const hd = document.createElement('div'); hd.className = 'chips';
        BAND.forEach((n, j) => { const b = document.createElement('button'); b.className = 'dot'; b.style.background = BC[j]; b.title = n; b.setAttribute('aria-label', n); b.onclick = () => { hi = j; syncHS() }; hd.appendChild(b) }); $('hs').appendChild(hd);
        const hsIn = ['Hue', 'Saturation', 'Luminance'].map((l, q) => {
            const r = document.createElement('div'); r.className = 'row'; r.innerHTML = '<span>' + l + '</span><input type="range" min="-100" max="100" value="0" aria-label="' + l + '"><output>0</output>';
            const inp = r.querySelector('input'), o = r.querySelector('output'); fill(inp); inp.addEventListener('input', () => { H8[hi][q] = +inp.value; o.textContent = inp.value; fill(inp); scheduleRender() }); $('hs').appendChild(r); return [inp, o]
        });
        function syncHS() { hd.querySelectorAll('.dot').forEach((b, j) => b.classList.toggle('on', j === hi)); hsIn.forEach(([i, o], q) => { i.value = H8[hi][q]; o.textContent = H8[hi][q]; fill(i) }) }
        const cv = $('cv'), cvx = cv.getContext('2d'), CCOL = ['#9aa3b5', '#ff6b6b', '#3dc27f', '#5a9bff'];
        function drawCV() {
            const S = 240, x = cvx; x.clearRect(0, 0, S, S); x.strokeStyle = css('--border'); x.lineWidth = 1;
            for (let i = 1; i < 4; i++) { x.beginPath(); x.moveTo(i * S / 4, 0); x.lineTo(i * S / 4, S); x.moveTo(0, i * S / 4); x.lineTo(S, i * S / 4); x.stroke() }
            x.strokeStyle = ci ? CCOL[ci] : css('--ink'); x.lineWidth = 2; x.beginPath(); for (let k = 0; k < 256; k++) { const px = k / 255 * S, py = S - LU[ci][k] * S; k ? x.lineTo(px, py) : x.moveTo(px, py) } x.stroke();
            x.fillStyle = css('--ink'); CVS[ci].forEach(p => { x.beginPath(); x.arc(p[0] * S, S - p[1] * S, 5, 0, 6.283); x.fill() })
        }
        function syncX() { WH.forEach((q, z) => { const a = q.h * Math.PI / 180; pk[z].style.left = (50 + 50 * q.s * Math.cos(a)) + '%'; pk[z].style.top = (50 + 50 * q.s * Math.sin(a)) + '%'; lum[z].value = q.l; fill(lum[z]) }); syncHS(); drawCV() }
        matchMedia('(prefers-color-scheme:dark)').addEventListener('change', () => drawCV());
        function cpt(e) { const r = cv.getBoundingClientRect(); return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp(1 - (e.clientY - r.top) / r.height, 0, 1)] }
        cv.addEventListener('pointerdown', e => {
            const [px, py] = cpt(e), pts = CVS[ci]; cd = pts.findIndex(p => Math.hypot(p[0] - px, p[1] - py) < .06);
            if (cd < 0 && pts.length < 9 && Math.abs(LU[ci][Math.round(px * 255)] - py) < .08) { pts.push([px, py]); pts.sort((a, b) => a[0] - b[0]); cd = pts.findIndex(p => p[0] === px) } if (cd >= 0) cv.setPointerCapture(e.pointerId)
        });
        cv.addEventListener('pointermove', e => { if (cd < 0) return; const pts = CVS[ci], [px, py] = cpt(e), p = pts[cd]; if (cd > 0 && cd < pts.length - 1) p[0] = clamp(px, pts[cd - 1][0] + .03, pts[cd + 1][0] - .03); p[1] = py; rebuild(); drawCV(); scheduleRender() });
        ['pointerup', 'pointercancel'].forEach(v => cv.addEventListener(v, () => { cd = -1 }));
        cv.addEventListener('dblclick', e => { const [px, py] = cpt(e), pts = CVS[ci], j = pts.findIndex(p => Math.hypot(p[0] - px, p[1] - py) < .06); if (j > 0 && j < pts.length - 1) { pts.splice(j, 1); rebuild(); drawCV(); scheduleRender() } });
        ['RGB', 'R', 'G', 'B'].forEach((n, i) => { const b = document.createElement('button'); b.className = 'chip' + (i ? '' : ' on'); b.textContent = n; b.onclick = () => { ci = i;[...$('ch').children].forEach((c, j) => c.classList.toggle('on', j === i)); drawCV() }; $('ch').appendChild(b) });
        $('cr').onclick = () => { CVS[ci] = ID(); rebuild(); drawCV(); scheduleRender() };
        /* ---------- looks ---------- */
        /* ---------- Asha demo cursor ---------- */
        const ash = $('ash'), dots = $('dots'), dc = dots.getContext('2d');
        function drawDots(t) {
            const S = Math.round(W / 34), xs = W * (1 - t), R = S * .46, ph = performance.now() / 260; dc.clearRect(0, 0, W, H); dc.fillStyle = 'rgba(0,0,0,.6)'; dc.fillRect(0, 0, W, H); dc.fillStyle = '#4d8bff';
            for (let y = S / 2; y < H; y += S)for (let x = S / 2; x < W; x += S) { const dx = (x - xs) / (W * .3), g = Math.exp(-dx * dx), yw = .3 + .7 * (y / H), w = .5 + .5 * Math.sin((x + y) / S * .7 - ph), k = g * yw * (.55 + .45 * w) + .05; dc.beginPath(); dc.arc(x, y, R * Math.min(1, k), 0, 6.283); dc.fill() }
            dots.style.opacity = Math.min(1, t * 8) * (1 - Math.max(0, (t - .88) / .12))
        }
        const ease = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        function tween(ms, fn) { return new Promise(res => { const t0 = performance.now(); ms = reduce ? 10 : ms; (function f(n) { const p = Math.min(1, (n - t0) / ms); fn(ease(p)); p < 1 ? requestAnimationFrame(f) : res() })(t0) }) }
        function place(x, y) { cx = x; cy = y; ash.style.transform = 'translate(' + x + 'px,' + y + 'px)' }
        async function moveTo(x, y, ms) { const x0 = cx, y0 = cy, dx = x - x0, dy = y - y0, d = Math.hypot(dx, dy) || 1, nx = -dy / d, ny = dx / d, bow = Math.min(40, d * .12); await tween(ms, t => { const k = Math.sin(Math.PI * t) * bow; place(x0 + dx * t + nx * k, y0 + dy * t + ny * k) }) }
        function clickFx() { ash.classList.remove('ck'); void ash.offsetWidth; ash.classList.add('ck'); SND.click() }
        async function seeEl(el) { let r = el.getBoundingClientRect(); if (r.top < 70 || r.bottom > innerHeight - 24 || r.left < 0 || r.right > innerWidth) { el.scrollIntoView({ block: 'center', inline: 'center', behavior: reduce ? 'auto' : 'smooth' }); await sleep(520); r = el.getBoundingClientRect() } return r }
        async function tapTab(t) { const b = document.querySelector('.tab[data-t="' + t + '"]'), r = await seeEl(b); await moveTo(r.left + r.width / 2, r.top + r.height / 2, 500); clickFx(); await sleep(160); setTab(t); await sleep(200) }
        async function dragSlider(k, to, ms) {
            const inp = inputs[k], r = await seeEl(inp), mn = +inp.min, mx = +inp.max, ty = r.top + r.height / 2, tx = v => r.left + 8 + (v - mn) / (mx - mn) * (r.width - 16);
            await moveTo(tx(P[k]), ty, 380); ash.classList.add('dn'); SND.click(); const v0 = P[k];
            await tween(ms, t => { const v = v0 + (to - v0) * t; P[k] = v; inp.value = v; outs[k].textContent = Math.round(v); fill(inp); place(tx(v), ty); SND.tick(); render() }); ash.classList.remove('dn')
        }
        async function dragPoint(i, tx, ty, ms) {
            const r = await seeEl(cv), p = CVS[ci][i], px = x => r.left + x * r.width, py = y => r.top + (1 - y) * r.height;
            await moveTo(px(p[0]), py(p[1]), 450); ash.classList.add('dn'); SND.click(); const x0 = p[0], y0 = p[1];
            await tween(ms, t => { p[0] = x0 + (tx - x0) * t; p[1] = y0 + (ty - y0) * t; rebuild(); drawCV(); render(); place(px(p[0]), py(p[1])); SND.tick() }); ash.classList.remove('dn')
        }
        async function dragWheel(z, h, s, ms) {
            const wc = document.querySelectorAll('.wc')[z], r = await seeEl(wc), q = WH[z], c = (a, b) => [r.left + r.width * (.5 + .5 * a), r.top + r.height * (.5 + .5 * b)];
            const a0 = q.h * Math.PI / 180, X0 = q.s * Math.cos(a0), Y0 = q.s * Math.sin(a0), a1 = h * Math.PI / 180, X1 = s * Math.cos(a1), Y1 = s * Math.sin(a1), p0 = c(X0, Y0);
            await moveTo(p0[0], p0[1], 450); ash.classList.add('dn'); SND.click();
            await tween(ms, t => { const X = X0 + (X1 - X0) * t, Y = Y0 + (Y1 - Y0) * t; q.h = (Math.atan2(Y, X) * 180 / Math.PI + 360) % 360; q.s = Math.min(1, Math.hypot(X, Y)); syncX(); render(); const p = c(X, Y); place(p[0], p[1]); SND.tick() }); ash.classList.remove('dn')
        }
        function setPos(p) { pos = p; cG.style.clipPath = 'inset(0 0 0 ' + p + '%)'; divEl.style.left = p + '%'; divEl.setAttribute('aria-valuenow', Math.round(p)) }
        function showCompare(on) { divEl.classList.toggle('show', on); $('labB').classList.toggle('on', on); $('labA').classList.toggle('on', on); viewer.classList.toggle('live', on) }
        async function show(T, W3, cu, msg) {
            busy = true; showing = true; autoBtn.disabled = true; openChat(false); document.body.classList.add('showing'); graded = false; $('exp').classList.remove('open'); showCompare(false);
            Object.keys(P).forEach(k => P[k] = 0); resetExtras(); sync(); render(); $('gwrap').classList.add('open'); setTab('g'); setPos(100); window.scrollTo({ top: 0 });
            place(innerWidth - 80, innerHeight - 90); ash.classList.add('on'); cap('Reading the photo...');
            const hr = await seeEl($('viewer')); await Promise.all([moveTo(hr.left + hr.width * .7, hr.top + hr.height * .5, 1100), tween(1300, t => drawDots(t))]);
            if (window.__plan) {
                let dn = false; window.__plan.then(() => { dn = true }, () => { dn = true }); const M = ['Studying the skin tones...', 'Reading the light...', 'Checking the colors...', 'Balancing the shadows...', 'Almost there...']; let mi = 0;
                while (!dn) { cap(M[mi++ % M.length]); await tween(1500, t => drawDots(t)) } window.__plan = null
            }
            dots.style.opacity = 0; setPos(0); cap('Adjusting the light...'); await tapTab('g');
            const keys = ['exposure', 'highlights', 'shadows', 'contrast', 'vibrance', 'saturation', 'warmth'].filter(k => Math.abs(T[k]) >= 2).slice(0, 5), done = new Set(keys);
            for (const k of keys) await dragSlider(k, T[k], 520);
            cap('Balancing color...'); const P1 = { ...P };
            await Promise.all([tapTab('v'), tween(700, t => { Object.keys(T).forEach(k => { if (!done.has(k)) P[k] = P1[k] + (T[k] - P1[k]) * t }); sync(); render() })]);
            cap('Shaping the curve...'); ci = 0;[...$('ch').children].forEach((c, j) => c.classList.toggle('on', j === 0)); drawCV();
            if (cu) { await dragPoint(1, .25, .25 - cu, 700); await dragPoint(3, .75, .75 + cu, 700) }
            if (W3 && W3.some(w => w[1] > 0)) { cap('Tinting shadows and highlights...'); await tapTab('c'); for (const z of [0, 2, 1]) if (W3[z][1] > 0) { WH[z].l = W3[z][2]; await dragWheel(z, W3[z][0], W3[z][1], 700) } }
            await tapTab('g'); graded = true; showCompare(true); setPos(0);
            window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); await sleep(450);
            const vr = viewer.getBoundingClientRect(), y = vr.top + vr.height / 2; await moveTo(vr.left + 3, y, 550); ash.classList.add('dn'); SND.click();
            await tween(750, t => { setPos(50 * t); place(vr.left + 3 + vr.width * .5 * t, y) }); ash.classList.remove('dn'); await sleep(300); ash.classList.remove('on');
            $('exp').classList.add('open'); cap('Done. Drag the line to compare.', 2600); SND.done();
            document.body.classList.remove('showing'); showing = false; busy = false; autoBtn.disabled = false; autoBtn.textContent = 'Run auto again'; asha(msg, 350)
        }
        async function autoShow() {
            if (!src || busy) return;
            const wv = TEMP > .1 ? [[195, .18, 0], [0, 0, 0], [35, .12, 0]] : TEMP < -.05 ? [[220, .1, 0], [0, 0, 0], [35, .15, 0]] : [[0, 0, 0], [0, 0, 0], [40, .08, 0]];
            const T = {}; Object.keys(P).forEach(k => T[k] = KEYS.includes(k) ? auto[k] : 0);
            await show(T, wv, .035, 'Done. I adjusted the light, the curve and the color balance. Drag the line over the photo to compare, then fine tune any tool on the right.')
        }
        autoBtn.onclick = autoShow;
        $('reset').onclick = () => { KEYS.forEach(k => P[k] = graded ? auto[k] : 0); sync(); render() };
        /* ---------- tabs, compare, layout ---------- */
        function setTab(t) {
            tab = t; document.querySelectorAll('.tab').forEach(b => { const on = b.dataset.t === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on) });
            ['g', 'c', 'v', 't'].forEach(x => $('p-' + x).classList.toggle('on', x === t));
            if (!showing) { if (graded) { setPos(50); showCompare(true) } else setPos(0) }
            $('hint').textContent = HINT[t]
        }
        document.querySelectorAll('.tab').forEach(b => b.onclick = () => setTab(b.dataset.t));
        function fit() { if (!W) return; const k = Math.min(stage.clientWidth / W, stage.clientHeight / H); viewer.style.width = Math.floor(W * k) + 'px'; viewer.style.height = Math.floor(H * k) + 'px' }
        new ResizeObserver(fit).observe(stage);
        let drag = false;
        function movePos(e) { const r = viewer.getBoundingClientRect(); setPos(clamp((e.clientX - r.left) / r.width * 100, 0, 100)) }
        viewer.addEventListener('pointerdown', e => { if (graded) { drag = true; viewer.setPointerCapture(e.pointerId); movePos(e) } });
        viewer.addEventListener('pointermove', e => { if (drag) movePos(e) });
        ['pointerup', 'pointercancel'].forEach(v => viewer.addEventListener(v, () => { drag = false }));
        divEl.addEventListener('keydown', e => { if (!graded) return; if (e.key === 'ArrowLeft') setPos(clamp(pos - 4, 0, 100)); if (e.key === 'ArrowRight') setPos(clamp(pos + 4, 0, 100)) });
        function loadImage(img) {
            const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height, sc = Math.min(1, 1280 / Math.max(iw, ih)); W = Math.round(iw * sc); H = Math.round(ih * sc);
            viewer.hidden = false; $('drop').hidden = true; cO.width = cG.width = dots.width = W; cO.height = cG.height = dots.height = H; fit();
            ctxO.imageSmoothingQuality = 'high'; ctxO.drawImage(img, 0, 0, W, H); src = ctxO.getImageData(0, 0, W, H);
            noise = new Float32Array(W * H); for (let i = 0; i < noise.length; i++)noise[i] = Math.random() - .5;
            auto = analyze(src.data); const z = {}; KEYS.forEach(k => z[k] = 0); const lim = Math.max(.02, measure(z).clip * 1.15 + .005);
            for (let i = 0; i < 18; i++) { const m = measure(auto); if (m.clip > lim) { auto.exposure -= 4; auto.highlights = Math.max(-60, auto.highlights - 4) } else if (m.mean < .3 && auto.exposure < 30) auto.exposure += 3; else break }
            readPhoto(); resetExtras(); Object.keys(P).forEach(k => P[k] = 0); sync(); render();
            graded = false; busy = false; divEl.classList.remove('scan'); showCompare(false); setTab('g'); setPos(0); autoBtn.textContent = 'Auto color grade'; autoBtn.disabled = false
        }
        /* ---------- open photo: JPG/PNG/WebP natively, HEIC and RAW previews ---------- */
        const RAWX = 'dng cr2 cr3 crw nef nrw arw srf sr2 orf rw2 raf pef srw raw 3fr erf kdc mrw x3f rwl iiq'.split(' '), fext = n => (n.split('.').pop() || '').toLowerCase();
        const bmpOf = b => createImageBitmap(b, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(b));
        function loadScript(u) { return new Promise((res, rej) => { if (document.querySelector('script[src="' + u + '"]')) return res(); const s = document.createElement('script'); s.src = u; s.onload = res; s.onerror = () => rej(new Error('script')); document.head.appendChild(s) }) }
        function jpegEnd(b, s) { let i = s + 2; while (i < b.length - 1) { if (b[i] !== 255) { i++; continue } const m = b[i + 1]; if (m === 255) { i++; continue } if (m === 0 || m === 1 || m === 216 || (m >= 208 && m <= 215)) { i += 2; continue } if (m === 217) return i + 2; i += 2 + ((b[i + 2] << 8) | b[i + 3]); if (m === 218) { while (i < b.length - 1 && !(b[i] === 255 && b[i + 1] !== 0 && b[i + 1] !== 255 && !(b[i + 1] >= 208 && b[i + 1] <= 215))) i++ } } return -1 }
        function tiffOrient(b) {
            const le = b[0] === 73 && b[1] === 73; if (!le && !(b[0] === 77 && b[1] === 77)) return 1; const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
            try { if (u16(2) !== 42) return 1; const o = u32(4), n = u16(o); for (let i = 0; i < n; i++) { const e = o + 2 + i * 12; if (u16(e) === 274) return u16(e + 8) } } catch (err) { } return 1
        }
        async function rawPreview(f) {
            const buf = new Uint8Array(await f.arrayBuffer()); let best = null;
            for (let i = 0; i < buf.length - 3; i++) { if (buf[i] === 255 && buf[i + 1] === 216 && buf[i + 2] === 255) { const e = jpegEnd(buf, i); if (e > i) { if (!best || e - i > best[1] - best[0]) best = [i, e]; i = e - 1 } } }
            if (!best || best[1] - best[0] < 30000) throw new Error('nopreview');
            let img = await bmpOf(new Blob([buf.subarray(best[0], best[1])], { type: 'image/jpeg' })); const o = tiffOrient(buf);
            if ((o === 6 || o === 8) && img.width > img.height) { const c = document.createElement('canvas'); c.width = img.height; c.height = img.width; const x = c.getContext('2d'); if (o === 6) { x.translate(c.width, 0); x.rotate(Math.PI / 2) } else { x.translate(0, c.height); x.rotate(-Math.PI / 2) } x.drawImage(img, 0, 0); img = c }
            return { img, note: 'I opened the camera\u2019s built-in preview from that RAW file, so edits apply to the preview rather than the raw sensor data.' }
        }
        async function heicDecode(f) { await loadScript('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js'); const out = await heic2any({ blob: f, toType: 'image/jpeg', quality: .95 }); return { img: await bmpOf(Array.isArray(out) ? out[0] : out), note: '' } }
        async function isHeic(f) { const b = new Uint8Array(await f.slice(0, 16).arrayBuffer()); return /ftyp(hei|hev|mif1|msf1)/.test(String.fromCharCode(...b.slice(4, 12))) }
        async function decodeFile(f) {
            const x = fext(f.name); if (RAWX.includes(x)) return await rawPreview(f);
            try { return { img: await bmpOf(f), note: '' } } catch (e) { } if (/hei[cf]/.test(x) || /hei[cf]/.test(f.type) || await isHeic(f)) return await heicDecode(f); return await rawPreview(f)
        }
        async function openFile(f) {
            if (busy) return; cap('Opening ' + f.name + '...');
            try { const r = await decodeFile(f); loadImage(r.img); cap('Photo opened.', 1800); if (r.note) asha(r.note, 300) }
            catch (err) { cap('Could not open that file.', 2500); asha('I couldn\u2019t open that file. Try JPG, PNG, WebP, HEIC, or a RAW file that has a built-in preview.', 300) }
        }
        addEventListener('dragover', e => e.preventDefault()); addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) openFile(f) });
        $('file').addEventListener('change', e => { if (e.target.files && e.target.files[0]) { openFile(e.target.files[0]); e.target.value = '' } });
        /* ---------- download ---------- */
        async function save(long, label) {
            const sc = long / Math.max(W, H), c = document.createElement('canvas'); c.width = Math.round(W * sc); c.height = Math.round(H * sc);
            const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(cG, 0, 0, c.width, c.height); const name = 'asha-graded-' + label + '.jpg';
            try { const dl = window.claude && claude.use ? await claude.use('downloads') : null; if (dl) { const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', .92)); await dl.save({ filename: name, data: blob }); cap('Saved the ' + label + ' photo.', 2200); return } }
            catch (err) { if (err && err.code === 'declined') { cap('Download cancelled.', 2000); return } }
            const url = c.toDataURL('image/jpeg', .92); $('svi').src = url; $('sva').href = url; $('sva').download = name; $('sv').hidden = false
        }
        $('svx').onclick = () => { $('sv').hidden = true }; $('d1080').onclick = () => save(1920, '1080p'); $('d720').onclick = () => save(1280, '720p');
        /* ---------- starter photo (drawn, so the page needs no image file) ---------- */
        function makeSeed() {
            const c = document.createElement('canvas'); c.width = 1200; c.height = 800; const x = c.getContext('2d');
            let g = x.createLinearGradient(0, 0, 0, 560); g.addColorStop(0, '#6f8fb0'); g.addColorStop(.6, '#d6c8aa'); g.addColorStop(1, '#e6b88c'); x.fillStyle = g; x.fillRect(0, 0, 1200, 800);
            x.fillStyle = '#f4e6c3'; x.beginPath(); x.arc(840, 330, 48, 0, 7); x.fill();
            [['#9a9498', 300, 90], ['#74717b', 390, 70], ['#4d5154', 480, 50], ['#2f3b35', 570, 36]].forEach(([col, y, amp], i) => { x.fillStyle = col; x.beginPath(); x.moveTo(0, 800); for (let px = 0; px <= 1200; px += 20)x.lineTo(px, y + Math.sin(px / 130 + i * 1.7) * amp * .6 + Math.sin(px / 47 + i) * amp * .25); x.lineTo(1200, 800); x.fill() });
            g = x.createLinearGradient(0, 640, 0, 800); g.addColorStop(0, '#3d5560'); g.addColorStop(1, '#1f2d33'); x.fillStyle = g; x.fillRect(0, 650, 1200, 150); return c
        }
        autoBtn.disabled = true; setTab('g');
        const dz = $('drop'); dz.onclick = () => $('file').click(); dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click() } });
        let dcn = 0; addEventListener('dragenter', e => { e.preventDefault(); dcn++; dz.classList.add('over') }); addEventListener('dragleave', () => { if (--dcn <= 0) { dcn = 0; dz.classList.remove('over') } }); addEventListener('drop', () => { dcn = 0; dz.classList.remove('over') });

        /* Asha batch layer. Add it AFTER your main <script>, inside its own <script> tag (or save as a file and load it after the main script). */
        (() => {
            const MAX = 40, PREV = 1024, COL = ['#4d8bff', '#34d399', '#f59e0b', '#f472b6', '#a78bfa', '#22d3ee', '#fb7185', '#a3e635', '#facc15', '#38bdf8'];
            const PICK = '<svg width="26" height="26" viewBox="0 0 32 32"><path d="M5 5L26 12L12 26Z" fill="#fff" stroke="#fff" stroke-width="6" stroke-linejoin="round"/><path d="M5 5L26 12L12 26Z" fill="currentColor" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>';

            /* ---------- styles + markup ---------- */
            const sty = document.createElement('style');
            sty.textContent = `
                .batch{display:flex;align-items:center;gap:10px}
                .batch[hidden]{display:none}
                .bs{position:relative;flex:1;min-width:0;display:flex;gap:8px;overflow-x:auto;padding:4px 2px;scrollbar-width:none}
                .bs::-webkit-scrollbar{display:none}
                .bt{position:relative;flex:none;width:62px;height:62px;display:grid;place-items:center;padding:0;overflow:hidden;border:2px solid var(--border);border-radius:11px;background:var(--paper);color:var(--muted);opacity:.55;transition:opacity .2s,border-color .2s}
                .bt canvas{object-fit:cover}
                .bt.on,.bt.work,.bt.done,.bt.add{opacity:1}
                .bt.on,.bt.work{border-color:var(--accent)}
                .bt.work,.bt.ld{animation:bw .9s ease-in-out infinite alternate}
                @keyframes bw{to{box-shadow:0 0 0 3px var(--accent-d)}}
                .bt.add{border-style:dashed;font:600 26px/1 "Nunito",system-ui,sans-serif}
                .bt .pg{position:absolute;left:0;bottom:0;height:3px;width:0;background:var(--accent)}
                .bt.done::after{content:"✓";position:absolute;right:3px;top:3px;width:17px;height:17px;border-radius:50%;background:var(--accent);color:#fff;font:800 11px/17px "Nunito",system-ui,sans-serif;text-align:center}
                .bc{flex:none;font-size:12px;font-weight:700;color:var(--muted);font-variant-numeric:tabular-nums}
                .ag{position:fixed;left:0;top:0;z-index:91;pointer-events:none;opacity:1;transition:opacity .25s;will-change:transform;color:var(--c)}
                .ag svg{display:block;margin:-4px 0 0 -4px;filter:drop-shadow(0 3px 5px rgba(0,0,0,.4))}
                .nv{position:absolute;top:50%;z-index:6;width:42px;height:42px;margin-top:-21px;border:0;border-radius:50%;background:rgba(12,14,18,.72);color:#fff;display:none;place-items:center}
                .nv svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
                .nv.l{left:8px}.nv.r{right:8px}.nv.show{display:grid}
                .bl .nv,.bl .bs{pointer-events:none}
                .bl .nv{opacity:.4}
                .bx{position:absolute;left:3px;top:3px;z-index:2;width:18px;height:18px;border-radius:50%;background:rgba(12,14,18,.82);color:#fff;font:700 13px/18px "Nunito",system-ui,sans-serif;text-align:center;opacity:0;transition:opacity .15s}
                .bt:hover .bx,.bt:focus-within .bx{opacity:1}
                @media(hover:none){.bx{opacity:1}}
                .bl .bx{display:none}
                .dlm{position:fixed;inset:0;z-index:96;background:rgba(5,8,16,.8);display:flex;align-items:center;justify-content:center;padding:16px}
                .dlm[hidden]{display:none}
                .dlb{width:min(520px,100%);max-height:100%;overflow:auto;display:flex;flex-direction:column;gap:14px;padding:16px;background:var(--panel);border:1px solid var(--border);border-radius:16px}
                .dh,.ds{display:flex;align-items:center;justify-content:space-between;gap:10px}
                .dh b{font-size:17px;font-weight:800}
                .dnum{font-size:13px;font-weight:700;color:var(--muted)}
                .dg{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:8px;max-height:260px;overflow:auto;padding:2px}
                .dt{position:relative;aspect-ratio:1;padding:0;overflow:hidden;border:2px solid var(--border);border-radius:11px;background:var(--paper)}
                .dt canvas{object-fit:cover}
                .dt.on{border-color:var(--accent)}
                .dt::after{content:"";position:absolute;left:5px;top:5px;width:18px;height:18px;border-radius:50%;border:2px solid #fff;background:rgba(0,0,0,.35)}
                .dt.on::after{content:"✓";background:var(--accent);border-color:var(--accent);color:#fff;font:800 11px/14px "Nunito",system-ui,sans-serif;text-align:center}
                .dt small{position:absolute;left:5px;bottom:5px;padding:1px 7px;border-radius:99px;background:rgba(12,14,18,.8);color:#fff;font-size:10.5px;font-weight:700}
                .dgo{width:100%;height:48px;font-size:15px}`;
            document.head.appendChild(sty);

            const bar = document.createElement('div'); bar.className = 'batch'; bar.hidden = true;
            bar.innerHTML = '<div class="bs"></div><span class="bc"></span>';
            document.querySelector('.center').insertBefore(bar, document.querySelector('.below'));
            const bs = bar.firstChild, bc = bar.lastChild;
            const add = document.createElement('label'); add.className = 'bt add'; add.htmlFor = 'file'; add.textContent = '+'; add.setAttribute('aria-label', 'Add photos'); bs.appendChild(add);
            const arrow = (c, d, l) => { const b = document.createElement('button'); b.className = 'nv ' + c; b.setAttribute('aria-label', l); b.innerHTML = '<svg viewBox="0 0 24 24"><path d="' + d + '"/></svg>'; return b };
            const nl = arrow('l', 'M15 5l-7 7 7 7', 'Previous photo'), nr = arrow('r', 'M9 5l7 7-7 7', 'Next photo');
            $('stage').append(nl, nr);

            /* ---------- state ---------- */
            let items = [], cur = -1, running = false, adding = false, loading = false, ags = [], queue = [], finish = null, grab = null, exporting = false, dlSel = new Set(), dq = 1920;
            const snap = () => ({ gr: graded, P: { ...P }, WH: WH.map(q => ({ ...q })), H8: H8.map(q => [...q]), C: CVS.map(p => p.map(q => [...q])) });
            const apply = s => {
                Object.assign(P, s.P); WH.forEach((q, i) => Object.assign(q, s.WH[i])); H8.forEach((q, i) => { q[0] = s.H8[i][0]; q[1] = s.H8[i][1]; q[2] = s.H8[i][2] });
                for (let i = 0; i < 4; i++) CVS[i] = s.C[i].map(p => [...p]); rebuild()
            }, restore = s => { apply(s); sync(); render() };
            const stFrom = g => {
                const p = {}; Object.keys(P).forEach(k => p[k] = KEYS.includes(k) ? g.T[k] : 0);
                const C = [0, 1, 2, 3].map(() => ID()); C[0][1][1] -= g.cu; C[0][3][1] += g.cu;
                return { gr: true, P: p, WH: g.wv.map(a => ({ h: a[0], s: a[1], l: a[2] })), H8: g.h8 || Array.from({ length: 8 }, () => [0, 0, 0]), C }
            };
            const gUI = () => { graded = true; $('gwrap').classList.add('open'); $('exp').classList.add('open'); showCompare(true); setPos(50); autoBtn.textContent = 'Run auto again' };

            function upd() {
                const n = items.length, d = items.filter(x => x.status === 'done').length;
                bar.hidden = n < 1; $('exp').classList.toggle('open', !running && n > 0); bc.textContent = d + ' of ' + n + ' graded';
                [nl, nr].forEach(b => b.classList.toggle('show', n > 1));
                items.forEach((x, i) => x.el.classList.toggle('on', i === cur))
            }
            function ensure(it) { const l = it.el.offsetLeft, w = it.el.offsetWidth; if (l < bs.scrollLeft || l + w > bs.scrollLeft + bs.clientWidth) bs.scrollTo({ left: l - bs.clientWidth / 2 + w / 2, behavior: reduce ? 'auto' : 'smooth' }) }

            function mk(f) {
                const el = document.createElement('button'); el.className = 'bt ld'; el.title = f.name; el.setAttribute('aria-label', f.name);
                const cv2 = document.createElement('canvas'), pg = document.createElement('i'); pg.className = 'pg'; const bx = document.createElement('span'); bx.className = 'bx'; bx.textContent = '×'; bx.setAttribute('role', 'button'); bx.setAttribute('aria-label', 'Remove ' + f.name); el.append(cv2, pg, bx);
                const it = { geo: G0(), base: null, file: f, name: f.name, el, cv: cv2, cx: cv2.getContext('2d'), pg, status: 'queued' };
                el.onclick = () => select(items.indexOf(it)); bx.onclick = e => { e.stopPropagation(); remove(items.indexOf(it)) }; bs.insertBefore(el, add); items.push(it); return it
            }

            /* ---------- per-photo auto grade (same maths as the main editor, run on the small copy) ---------- */
            function gradeOf(it) {
                const keep = src; src = it.sm; let a;
                try {
                    a = analyze(it.sm.data); const z = {}; KEYS.forEach(k => z[k] = 0); const lim = Math.max(.02, measure(z).clip * 1.15 + .005);
                    for (let i = 0; i < 18; i++) { const m = measure(a); if (m.clip > lim) { a.exposure -= 4; a.highlights = Math.max(-60, a.highlights - 4) } else if (m.mean < .3 && a.exposure < 30) a.exposure += 3; else break }
                } finally { src = keep }
                const d = it.sm.data; let sr = 0, sb = 0, n = 0; for (let i = 0; i < d.length; i += 8) { sr += d[i]; sb += d[i + 2]; n++ } const tp = (sr - sb) / n / 255;
                return { T: tame(a), cu: .035, wv: wheelsFor(tp) }
            }
            /* draws the thumbnail with the grade applied at strength t (0 = original, 1 = full) */
            function paint(it, t) {
                const g = it.g, T = g.T, s = it.sm.data, o = it.out.data, n = s.length;
                const k = Math.pow(2, T.exposure * t / 50), w = T.warmth * t / 100, ti = T.tint * t / 100, rM = k * (1 + .25 * w), gM = k * (1 - .2 * ti), bM = k * (1 - .25 * w);
                const sh = T.shadows * t / 100 * .3, hl = T.highlights * t / 100 * .45, ct = 1 + T.contrast * t / 100 * .8, sat = 1 + T.saturation * t / 100, vib = T.vibrance * t / 100;
                const sa = Math.min(1, KEYS.reduce((a, q) => a + Math.abs(T[q]), 0) * t / 40), V = [];
                g.wv.forEach(q => { const c1 = hsv(q[0]), m = (c1[0] + c1[1] + c1[2]) / 3, kk = q[1] * t * .35; V.push((c1[0] - m) * kk, (c1[1] - m) * kk, (c1[2] - m) * kk) });
                const LM = lutOf([[0, 0], [.25, .25 - g.cu * t], [.5, .5], [.75, .75 + g.cu * t], [1, 1]]);
                for (let i = 0; i < n; i += 4) {
                    let r = s[i] / 255 * rM, gg = s[i + 1] / 255 * gM, b = s[i + 2] / 255 * bM, L = .2126 * r + .7152 * gg + .0722 * b; L = L < 0 ? 0 : L > 1 ? 1 : L;
                    const a = sh * (1 - L) * (1 - L) + hl * L * L; r += a; gg += a; b += a; r = .5 + (r - .5) * ct; gg = .5 + (gg - .5) * ct; b = .5 + (b - .5) * ct;
                    const L2 = .2126 * r + .7152 * gg + .0722 * b, mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), am = Math.max(0, sat + vib * (1 - (mx > 0 ? (mx - mn) / mx : 0)));
                    r = sf(L2 + (r - L2) * am, sa); gg = sf(L2 + (gg - L2) * am, sa); b = sf(L2 + (b - L2) * am, sa);
                    const Y = clamp(.2126 * r + .7152 * gg + .0722 * b, 0, 1), a1 = (1 - Y) * (1 - Y), a3 = Y * Y, a2 = 1 - a1 - a3;
                    r += a1 * V[0] + a2 * V[3] + a3 * V[6]; gg += a1 * V[1] + a2 * V[4] + a3 * V[7]; b += a1 * V[2] + a2 * V[5] + a3 * V[8];
                    o[i] = LM[(clamp(r, 0, 1) * 255 + .5) | 0] * 255; o[i + 1] = LM[(clamp(gg, 0, 1) * 255 + .5) | 0] * 255; o[i + 2] = LM[(clamp(b, 0, 1) * 255 + .5) | 0] * 255; o[i + 3] = 255
                }
                it.cx.putImageData(it.out, 0, 0)
            }

            /* big-picture edits are mirrored onto the active photo's thumbnail */
            const _dh = drawHist;
            window.drawHist = function (d) { if (grab) { grab(d); return } _dh(d); const it = items[cur]; if (it && it.sm) it.cx.drawImage(cG, 0, 0, it.cv.width, it.cv.height) };

            /* ---------- agents ---------- */
            function assign(a, it, x, y, t0, fd) { it.g = it.g || gradeOf(it); it.status = 'work'; it.el.classList.add('work'); a.it = it; a.mode = 'fly'; a.fx = x; a.fy = y; a.t0 = t0; a.fd = fd; a.lp = 0; ensure(it) }
            function next(a, x, y, now) {
                const it = a.it; it.status = 'done'; it.pg.style.width = '0'; it.el.classList.remove('work'); it.el.classList.add('done'); SND.tick(); upd();
                const n = queue.shift(); if (n) assign(a, n, x, y, now, 320); else { a.it = null; a.el.style.opacity = 0 }
            }
            function tick(now) {
                const sr = bs.getBoundingClientRect();
                for (const a of ags) {
                    const it = a.it; if (!it) continue;
                    const r = it.el.getBoundingClientRect(), tx = r.left + r.width / 2, ty = r.top + r.height / 2; let x = a.x, y = a.y;
                    if (now < a.t0) { x = a.fx; y = a.fy }
                    else if (a.mode === 'fly') { const p = Math.min(1, (now - a.t0) / a.fd), e = ease(p); x = a.fx + (tx - a.fx) * e; y = a.fy + (ty - a.fy) * e; if (p >= 1) { a.mode = 'work'; a.t0 = now } }
                    else {
                        const p = Math.min(1, (now - a.t0) / a.D); x = tx + Math.sin(now / 170 + a.ph) * r.width * .3; y = ty + Math.cos(now / 210 + a.ph) * r.height * .28;
                        it.pg.style.width = p * 100 + '%'; if (now - a.lp > 110 || p >= 1) { a.lp = now; paint(it, ease(p)) } if (p >= 1) next(a, x, y, now)
                    }
                    a.x = x; a.y = y; a.el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
                    if (a.it) a.el.style.opacity = now < a.t0 || (r.right > sr.left && r.left < sr.right) ? 1 : 0
                }
                if (ags.some(a => a.it) || queue.length) requestAnimationFrame(tick); else finish()
            }

            async function startBatch() {
                if (running || busy || loading || adding || !src) return;
                const lead = items[cur], q = items.filter(x => x !== lead && x.status !== 'done'), n = q.length + 1;
                const tr = n <= 5 ? [n, 14000] : n <= 15 ? [8, 8000] : [10, 4000];
                let ex = Math.min(tr[0] - 1, q.length); if (innerWidth < 700) ex = Math.min(ex, 4); const D = reduce ? 500 : tr[1];
                running = true; document.body.classList.add('bl'); queue = q; ags = [];
                lead.status = 'work'; lead.el.classList.remove('done'); lead.el.classList.add('work'); q.forEach(x => x.el.classList.remove('done')); upd();
                const lp = autoShow().then(() => { lead.status = 'done'; lead.el.classList.remove('work'); lead.el.classList.add('done'); upd(); const w = window.__want; window.__want = null; if (w && w !== lead && items.includes(w)) { if (w.status === 'done') select(items.indexOf(w)); else cap('Tap that one again once it is graded.', 2400) } });
                const sx = innerWidth - 80, sy = innerHeight - 90, now = performance.now();
                for (let i = 0; i < ex; i++) {
                    const el = document.createElement('div'); el.className = 'ag'; el.style.setProperty('--c', COL[i % COL.length]); el.innerHTML = PICK; el.style.transform = 'translate(' + sx + 'px,' + sy + 'px)'; document.body.appendChild(el);
                    const a = { el, D, ph: i * 1.9, x: sx, y: sy, it: null }; ags.push(a); assign(a, queue.shift(), sx, sy, now + 120 + i * 110, 650)
                }
                const ad = new Promise(res => { finish = res }); if (ex) requestAnimationFrame(tick); else finish();
                try { await Promise.all([lp, ad]) } finally { running = false; document.body.classList.remove('bl'); ags.forEach(a => a.el.remove()); ags = []; upd() }
                if (items.length > 1) asha('All ' + items.length + ' photos are graded. Tap one below, or use the arrows, to check each one.', 350)
            }

            /* ---------- adding + switching photos ---------- */
            async function addFiles(list) {
                if (running || busy) { cap('Wait for Asha to finish first.', 2000); return }
                if (adding || loading) return;
                const fs = [...list]; adding = true; autoBtn.disabled = true; let ok = 0; const bad = [];
                for (const f of fs) {
                    if (items.length >= MAX) { cap('Up to ' + MAX + ' photos per batch.', 2500); break }
                    const it = mk(f); upd(); cap('Reading ' + f.name + '...');
                    try {
                        const r = await decodeFile(f), im = r.img, iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height, k = Math.min(1, 200 / Math.max(iw, ih)), w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k)), c = document.createElement('canvas');
                        c.width = w; c.height = h; const x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; x.drawImage(im, 0, 0, w, h);
                        it.sm = x.getImageData(0, 0, w, h); it.out = new ImageData(w, h); it.cv.width = w; it.cv.height = h; it.cx.putImageData(it.sm, 0, 0); it.el.classList.remove('ld'); ok++;
                        if (cur < 0) { cur = items.indexOf(it); it.base = prev(im); loadImage(it.base); syncGeo() }
                        if (im.close) im.close(); if (r.note) asha(r.note, 300)
                    } catch (e) { it.el.remove(); items.splice(items.indexOf(it), 1); bad.push(f.name); cap('Could not open ' + f.name + '.', 2500) }
                    upd()
                }
                adding = false; autoBtn.disabled = !items.length; upd(); if (ok) cap(ok + (ok > 1 ? ' photos' : ' photo') + ' ready.', 1800); if (bad.length) asha('I could not open ' + bad.length + (bad.length > 1 ? ' files: ' : ' file: ') + bad.slice(0, 5).join(', ') + (bad.length > 5 ? '...' : '') + '. For RAW files this means no usable built-in preview was found.', 300)
            }
            async function select(i) {
                if (adding || loading || i < 0 || i === cur || !items[i]) return;
                if (busy || window.__pre) { window.__want = items[i]; cap('Asha is finishing the main photo. I will open that one next.', 2400); return }
                if (running && items[i].status !== 'done') { cap(items[i].status === 'work' ? 'Asha is still grading that one. Open it once it finishes.' : 'That one is waiting in line. Open it once it is graded.', 2200); return }
                const old = items[cur], it = items[i]; if (old && src) { old.st = snap(); old.base = null }
                loading = true; cur = i; upd(); cap('Opening ' + it.name + '...');
                try {
                    const r = await decodeFile(it.file); it.base = prev(r.img); loadImage(it.base); if (!isG0(it.geo)) applyGeo(); syncGeo(); if (r.img.close) r.img.close();
                    const s = it.st || (it.g && it.status === 'done' ? stFrom(it.g) : null); if (s) { restore(s); if (s.gr) gUI() }
                    cap(it.name, 1200)
                } catch (e) { cap('Could not open that photo.', 2500) }
                loading = false; upd()
            }
            nl.onclick = () => select((cur - 1 + items.length) % items.length); nr.onclick = () => select((cur + 1) % items.length);

            /* ---------- remove photos ---------- */
            function prev(im) { const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height, k = Math.min(1, PREV / Math.max(iw, ih)); const c = document.createElement('canvas'); c.width = Math.round(iw * k); c.height = Math.round(ih * k); const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(im, 0, 0, c.width, c.height); return c }
            function clearMain() {
                src = null; W = H = 0; graded = false; viewer.hidden = true; $('drop').hidden = false; showCompare(false); Object.keys(P).forEach(k => P[k] = 0); resetExtras(); sync(); autoBtn.disabled = true; autoBtn.textContent = 'Auto color grade'
            }
            async function remove(i) {
                if (running || adding || loading || busy || !items[i]) return;
                const was = i === cur; items[i].el.remove(); items.splice(i, 1);
                if (!items.length) { cur = -1; clearMain(); syncGeo(); upd(); return }
                if (was) { cur = -1; await select(Math.min(i, items.length - 1)) } else { if (i < cur) cur--; upd() }
            }

            /* ---------- one Download button: choose photos + quality, full-quality re-render, zip for many ---------- */
            const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })();
            const crc = b => { let c = ~0; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8); return ~c >>> 0 };
            function zip(files) {
                const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
                for (const f of files) {
                    const nm = enc.encode(f.name), c = crc(f.data), n = f.data.length, lh = new DataView(new ArrayBuffer(30));
                    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, c, true); lh.setUint32(18, n, true); lh.setUint32(22, n, true); lh.setUint16(26, nm.length, true);
                    parts.push(new Uint8Array(lh.buffer), nm, f.data);
                    const ch = new DataView(new ArrayBuffer(46));
                    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, c, true); ch.setUint32(20, n, true); ch.setUint32(24, n, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
                    cen.push(new Uint8Array(ch.buffer), nm); off += 30 + nm.length + n
                }
                const cs = cen.reduce((a, p) => a + p.length, 0), e = new DataView(new ArrayBuffer(22));
                e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cs, true); e.setUint32(16, off, true);
                return new Blob([...parts, ...cen, new Uint8Array(e.buffer)], { type: 'application/zip' })
            }
            /* re-renders a photo from the ORIGINAL file at the chosen size, using the editor's own render() with that photo's edits */
            async function renderTo(it, long, st) {
                const r = await decodeFile(it.file), im = r.img, iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height, b = geoBox(iw, ih, it.geo), k = Math.min(1, long / Math.max(b.cw * b.sw, b.ch * b.sh));
                const c = geoDraw(im, iw, ih, it.geo, k), w = c.width, h = c.height, x = c.getContext('2d'); if (im.close) im.close();
                if (st) {
                    src = x.getImageData(0, 0, w, h); W = w; H = h; noise = new Float32Array(w * h); for (let i = 0; i < noise.length; i++) noise[i] = Math.random() - .5;
                    apply(st); let d = null; grab = o => { d = o }; try { render() } finally { grab = null } x.putImageData(new ImageData(d, w, h), 0, 0)
                }
                return new Promise(res => c.toBlob(res, 'image/jpeg', .92))
            }
            async function deliver(blob, name) {
                try { const dl = window.claude && claude.use ? await claude.use('downloads') : null; if (dl) { await dl.save({ filename: name, data: blob }); return 'saved' } }
                catch (e) { if (e && e.code === 'declined') return 'declined' }
                const url = URL.createObjectURL(blob);
                if (blob.type === 'image/jpeg') { $('svi').src = url; $('sva').href = url; $('sva').download = name; $('sv').hidden = false; return 'saved' }
                const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); return 'saved'
            }
            const modal = document.createElement('div'); modal.className = 'dlm'; modal.hidden = true;
            modal.innerHTML = '<div class="dlb" role="dialog" aria-label="Download"><div class="dh"><b>Download</b><button class="ib dx" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div><div class="ds"><span class="dnum"></span><button class="chip dall"></button></div><div class="dg"></div><div class="ct">Quality</div><div class="chips dq"></div><button class="btn dgo"></button><p class="hint dp" hidden></p></div>';
            document.body.appendChild(modal);
            const mq = s => modal.querySelector(s), grid = mq('.dg'), goBtn = mq('.dgo'), dp = mq('.dp'), allBtn = mq('.dall'), num = mq('.dnum'), qc = mq('.dq');
            [['1080p', 1920], ['720p', 1280]].forEach(([l, v]) => { const b = document.createElement('button'); b.className = 'chip' + (v === dq ? ' on' : ''); b.textContent = l; b.onclick = () => { dq = v;[...qc.children].forEach(c => c.classList.toggle('on', c === b)) }; qc.appendChild(b) });
            function refresh() {
                const n = dlSel.size; num.textContent = n + ' of ' + items.length + ' selected'; allBtn.textContent = n === items.length ? 'Clear' : 'Select all';
                goBtn.textContent = n ? 'Download ' + n + (n > 1 ? ' photos' : ' photo') : 'Select photos'; goBtn.disabled = !n || exporting;[...grid.children].forEach((t, i) => t.classList.toggle('on', dlSel.has(items[i])))
            }
            function openDl() {
                if (running || busy || adding || loading || !items.length) return;
                dlSel = new Set(items); grid.innerHTML = '';
                items.forEach(it => {
                    const t = document.createElement('button'), c = document.createElement('canvas'); t.className = 'dt'; t.setAttribute('aria-label', it.name); c.width = it.cv.width; c.height = it.cv.height; c.getContext('2d').drawImage(it.cv, 0, 0); t.appendChild(c);
                    t.onclick = () => { dlSel.has(it) ? dlSel.delete(it) : dlSel.add(it); refresh() }; grid.appendChild(t)
                });
                dp.hidden = true; refresh(); modal.hidden = false
            }
            async function runExport() {
                const sel = items.filter(x => dlSel.has(x)); if (!sel.length || exporting) return;
                const long = dq, tag = long > 1500 ? '1080p' : '720p', keep = { src, W, H, noise, s: snap() }, outs = [];
                exporting = adding = busy = true; viewer.style.visibility = 'hidden'; goBtn.disabled = true; dp.hidden = false;
                try {
                    for (let n = 0; n < sel.length; n++) {
                        const it = sel[n]; dp.textContent = 'Preparing ' + (n + 1) + ' of ' + sel.length + '...'; await new Promise(r => setTimeout(r, 30));
                        const st = it === items[cur] ? keep.s : it.st || (it.g && it.status === 'done' ? stFrom(it.g) : null), b = await renderTo(it, long, st), base = it.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_');
                        outs.push({ name: (sel.length > 1 ? String(n + 1).padStart(2, '0') + '-' : '') + 'asha-' + base + '-' + tag + '.jpg', blob: b })
                    }
                    let blob = outs[0].blob, name = outs[0].name;
                    if (outs.length > 1) { const fl = []; for (const o of outs) fl.push({ name: o.name, data: new Uint8Array(await o.blob.arrayBuffer()) }); blob = zip(fl); name = 'asha-photos-' + tag + '.zip' }
                    dp.textContent = 'Almost there...'; const res = await deliver(blob, name);
                    if (res !== 'declined') { modal.hidden = true; cap(outs.length > 1 ? 'Saved ' + outs.length + ' photos as a zip.' : 'Saved your photo.', 2400) }
                } catch (e) { dp.textContent = 'That did not work. Try fewer photos or 720p.' }
                finally { src = keep.src; W = keep.W; H = keep.H; noise = keep.noise; apply(keep.s); sync(); render(); viewer.style.visibility = ''; exporting = adding = busy = false; goBtn.disabled = false; upd(); refresh() }
            }
            mq('.dx').onclick = () => { if (!exporting) modal.hidden = true }; modal.onclick = e => { if (e.target === modal && !exporting) modal.hidden = true };
            allBtn.onclick = () => { dlSel = dlSel.size === items.length ? new Set() : new Set(items); refresh() }; goBtn.onclick = runExport;
            $('d720').remove(); $('d1080').textContent = 'Download'; $('d1080').onclick = openDl;

            /* ---------- colour: about 5% less contrast, no orange-highlight tint, smaller white-balance push ---------- */
            const tame = a => { a.contrast = Math.max(0, a.contrast - 6); a.warmth = clamp(a.warmth, -6, 4); a.tint = clamp(a.tint, -3, 3); return a };
            const wheelsFor = t => t > .1 ? [[200, .12, 0], [0, 0, 0], [0, 0, 0]] : t < -.05 ? [[0, 0, 0], [0, 0, 0], [35, .08, 0]] : [[200, .05, 0], [0, 0, 0], [0, 0, 0]];
            const _li = loadImage; window.loadImage = function (img) { _li(img); tame(auto) };
            window.autoShow = async function () {
                if (!src || busy) return; const T = {}; Object.keys(P).forEach(k => T[k] = KEYS.includes(k) ? auto[k] : 0);
                await show(T, wheelsFor(TEMP), .035, 'Done. I adjusted the light, the curve and the color balance. Drag the line over the photo to compare, then fine tune any tool on the right.')
            };

            /* ---------- RAW: try every embedded JPEG (skipping lossless sensor data) until one opens ---------- */
            RAWX.push(...'mef mos dcr fff gpr ari bay cap dcs drf k25 mdc ptx pxn rwz'.split(' '));
            const sofOk = (b, i) => { let j = i + 2; while (j < b.length - 4 && j < i + 65536) { if (b[j] !== 255) return false; const m = b[j + 1]; if (m === 255) { j++; continue } if (m >= 192 && m <= 207 && m !== 196 && m !== 200 && m !== 204) return m <= 194; j += 2 + ((b[j + 2] << 8) | b[j + 3]) } return false };
            window.rawPreview = async function (f) {
                const buf = new Uint8Array(await f.arrayBuffer()), c = [];
                for (let i = 0; i < buf.length - 3; i++) if (buf[i] === 255 && buf[i + 1] === 216 && buf[i + 2] === 255) { const e = jpegEnd(buf, i); if (e > i) { if (sofOk(buf, i)) c.push([i, e]); i = e - 1 } }
                c.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
                for (const [s0, e] of c.slice(0, 6)) {
                    if (e - s0 < 6000) continue;
                    try {
                        let img = await bmpOf(new Blob([buf.subarray(s0, e)], { type: 'image/jpeg' })); const o = tiffOrient(buf);
                        if ((o === 6 || o === 8) && img.width > img.height) { const c3 = document.createElement('canvas'); c3.width = img.height; c3.height = img.width; const x = c3.getContext('2d'); if (o === 6) { x.translate(c3.width, 0); x.rotate(Math.PI / 2) } else { x.translate(0, c3.height); x.rotate(-Math.PI / 2) } x.drawImage(img, 0, 0); img = c3 }
                        return { img, note: Math.max(img.width, img.height) < 900 ? 'That RAW file only has a small built-in preview, so it will look soft.' : 'I opened the camera\u2019s built-in preview from that RAW file, so edits apply to the preview rather than the raw sensor data.' }
                    } catch (_) { }
                }
                throw new Error('nopreview')
            };

            /* ---------- Crop tab: rotate, flip, straighten, crop (aspect + zoom + position) ---------- */
            const G0 = () => ({ rot: 0, fh: false, fv: false, ang: 0, asp: 0, cr: null }), isG0 = g => !g.rot && !g.fh && !g.fv && !g.ang && !g.cr;
            function geoBox(iw, ih, g) {
                const sw = g.rot % 180 ? ih : iw, sh = g.rot % 180 ? iw : ih, c = g.cr || { x: 0, y: 0, w: 1, h: 1 }; return { sw, sh, cw: c.w, ch: c.h, cx: c.x, cy: c.y }
            }
            function geoDraw(img, iw, ih, g, k) {
                const b = geoBox(iw, ih, g), c = document.createElement('canvas'); c.width = Math.max(1, Math.round(b.cw * b.sw * k)); c.height = Math.max(1, Math.round(b.ch * b.sh * k));
                const x = c.getContext('2d', { willReadFrequently: true }), t = g.ang * Math.PI / 180, s = Math.cos(Math.abs(t)) + Math.sin(Math.abs(t)) * Math.max(b.sw / b.sh, b.sh / b.sw);
                x.imageSmoothingQuality = 'high'; x.scale(k, k); x.translate(-b.cx * b.sw, -b.cy * b.sh); x.translate(b.sw / 2, b.sh / 2); x.rotate(t); x.scale(s, s); x.rotate(g.rot * Math.PI / 180); x.scale(g.fh ? -1 : 1, g.fv ? -1 : 1); x.translate(-iw / 2, -ih / 2); x.drawImage(img, 0, 0); return c
            }
            function applyGeo() {
                const it = items[cur]; if (!it || !it.base) return;
                const c = geoDraw(it.base, it.base.width, it.base.height, it.geo.cropping ? { ...it.geo, cr: null } : it.geo, 1); W = c.width; H = c.height; cO.width = cG.width = dots.width = W; cO.height = cG.height = dots.height = H;
                ctxO.drawImage(c, 0, 0); src = ctxO.getImageData(0, 0, W, H); noise = new Float32Array(W * H); for (let i = 0; i < noise.length; i++) noise[i] = Math.random() - .5; fit();
                const k = Math.min(1, 200 / Math.max(W, H)), w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k)), t = document.createElement('canvas'); t.width = w; t.height = h;
                const x = t.getContext('2d', { willReadFrequently: true }); x.drawImage(c, 0, 0, w, h); it.sm = x.getImageData(0, 0, w, h); it.out = new ImageData(w, h); it.cv.width = w; it.cv.height = h; it.cx.putImageData(it.sm, 0, 0); render()
            }
            let gp = false; const schedGeo = () => { if (!gp) { gp = true; requestAnimationFrame(() => { gp = false; applyGeo() }) } };
                        /* ================= shared helpers ================= */
            const ok2 = () => { const it = items[cur]; return it && !busy && !running ? it : null };
            const FULL = () => ({ x: 0, y: 0, w: 1, h: 1 }), itc = () => items[cur];
            let down = false, restoring = false, seen = '';
            addEventListener('pointerdown', () => { down = true }, true);
            ['pointerup', 'pointercancel'].forEach(v => addEventListener(v, () => { down = false }, true));
            const fdims = it => { const b = geoBox(it.sm.width, it.sm.height, it.geo); return { sw: b.sw, sh: b.sh } };
            function modeFix() { if (tab === 'x' || tab === 'k') { showCompare(false); setPos(0) }  }
            function setGradedUI(on) { if (on) gUI(); else { graded = false; showCompare(false); setPos(0); autoBtn.textContent = 'Auto color grade'; upd() } modeFix() }

            /* ================= zoom ================= */
            let Z = 1, TX = 0, TY = 0, pan = null; const stg = $('stage');
            const zt = document.createElement('div'); zt.className = 'zt';
            zt.innerHTML = '<button class="ib" id="zo" title="Zoom out" aria-label="Zoom out"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button><button class="zl" id="zl" title="Fit to screen" aria-label="Fit to screen">100%</button><button class="ib" id="zi" title="Zoom in" aria-label="Zoom in"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>';
            document.querySelector('.below').appendChild(zt);
            function zapply() { viewer.style.setProperty('--z', Z); viewer.style.setProperty('--tx', TX + 'px'); viewer.style.setProperty('--ty', TY + 'px'); $('zl').textContent = Math.round(Z * 100) + '%'; viewer.classList.toggle('zm', Z > 1) }
            function clampPan() { const sr = stg.getBoundingClientRect(), mx = Math.max(0, (viewer.offsetWidth * Z - sr.width) / 2 + 60), my = Math.max(0, (viewer.offsetHeight * Z - sr.height) / 2 + 60); TX = clamp(TX, -mx, mx); TY = clamp(TY, -my, my) }
            function zoomTo(z, px, py) {
                if (viewer.hidden) return; z = clamp(z, 1, 8); const r = viewer.getBoundingClientRect(), bx = r.left + r.width / 2 - TX, by = r.top + r.height / 2 - TY; if (px == null) { px = bx + TX; py = by + TY }
                TX = (px - bx) - (px - bx - TX) * z / Z; TY = (py - by) - (py - by - TY) * z / Z; Z = z; if (Z === 1) TX = TY = 0; clampPan(); zapply()
            }
            $('zi').onclick = () => zoomTo(Z * 1.4); $('zo').onclick = () => zoomTo(Z / 1.4); $('zl').onclick = () => zoomTo(1);
            stg.addEventListener('wheel', e => { if (viewer.hidden) return; e.preventDefault(); zoomTo(Z * Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .0018)), e.clientX, e.clientY) }, { passive: false });
            const _li2 = window.loadImage; window.loadImage = function (i) { _li2(i); Z = 1; TX = TY = 0; zapply() };

            /* ================= crop + rotate (interactive) ================= */
            const ASP = [['Free', 0], ['Original', -1], ['1:1', 1], ['4:5', .8], ['3:2', 1.5], ['2:3', 2 / 3], ['16:9', 16 / 9], ['9:16', 9 / 16]];
            const tb = document.createElement('button'); tb.className = 'tab'; tb.setAttribute('role', 'tab'); tb.setAttribute('aria-selected', 'false'); tb.dataset.t = 'x';
            tb.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 3v14h14M3 7h14v14"/></svg>Crop'; tb.onclick = () => setTab('x'); document.querySelector('.tabs').appendChild(tb);
            const pane = document.createElement('div'); pane.className = 'pane'; pane.id = 'p-x';
            pane.innerHTML = '<div class="ct">Rotate and flip</div><div class="icons" id="xr"></div><div class="ct">Straighten</div><div class="col" id="xs"></div><div class="ct">Crop shape</div><div class="chips" id="xa"></div><div class="two"><button class="btn" id="xok">Apply crop</button><button class="btn ghost" id="xrst">Reset</button></div>';
            document.querySelector('.panel').appendChild(pane); HINT.x = 'Drag the corners or edges to crop, drag inside the box to move it. Pick a shape to lock the ratio.';
            const ov = document.createElement('div'); ov.className = 'crop'; ov.hidden = true;
            ov.innerHTML = '<i class="gl v1"></i><i class="gl v2"></i><i class="gl h1"></i><i class="gl h2"></i>' + ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(h => '<b class="hd ' + h + '" data-h="' + h + '"></b>').join(''); viewer.appendChild(ov);
            function drawCrop() { const it = itc(); if (!it) return; const c = it.geo.cr || FULL(); ov.style.left = c.x * 100 + '%'; ov.style.top = c.y * 100 + '%'; ov.style.width = c.w * 100 + '%'; ov.style.height = c.h * 100 + '%' }
            const lockK = it => { const g = it.geo; if (!g.asp) return 0; const d = fdims(it); return (g.asp < 0 ? d.sw / d.sh : g.asp) * d.sh / d.sw };
            function resize(s, h, px, py, k, mn) {
                let l = s.x, t = s.y, r = s.x + s.w, b = s.y + s.h;
                if (!k) { if (h.includes('w')) l = clamp(px, 0, r - mn); if (h.includes('e')) r = clamp(px, l + mn, 1); if (h.includes('n')) t = clamp(py, 0, b - mn); if (h.includes('s')) b = clamp(py, t + mn, 1); return { x: l, y: t, w: r - l, h: b - t } }
                const hx = h.includes('w') ? -1 : h.includes('e') ? 1 : 0, hy = h.includes('n') ? -1 : h.includes('s') ? 1 : 0, ax = hx < 0 ? r : l, ay = hy < 0 ? b : t;
                let w = hx && hy ? Math.max(Math.abs(px - ax), Math.abs(py - ay) * k) : hx ? Math.abs(px - ax) : Math.abs(py - ay) * k;
                const mw = hx < 0 ? ax : hx > 0 ? 1 - ax : 1, mh = hy < 0 ? ay : hy > 0 ? 1 - ay : 1; w = Math.max(mn, Math.min(w, mw, mh * k, k)); const hh = w / k;
                return { x: hx < 0 ? ax - w : hx > 0 ? ax : clamp(s.x + s.w / 2 - w / 2, 0, 1 - w), y: hy < 0 ? ay - hh : hy > 0 ? ay : clamp(s.y + s.h / 2 - hh / 2, 0, 1 - hh), w, h: hh }
            }
            let ds = null;
            ov.addEventListener('pointerdown', e => { e.stopPropagation(); const it = itc(); if (!it) return; const r = viewer.getBoundingClientRect(); ds = { h: e.target.dataset.h || 'm', c: { ...(it.geo.cr || FULL()) }, x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; ov.setPointerCapture(e.pointerId); e.preventDefault() });
            ov.addEventListener('pointermove', e => {
                if (!ds) return; const it = itc(), r = viewer.getBoundingClientRect(), px = clamp((e.clientX - r.left) / r.width, 0, 1), py = clamp((e.clientY - r.top) / r.height, 0, 1), s = ds.c;
                it.geo.cr = ds.h === 'm' ? { x: clamp(s.x + px - ds.x, 0, 1 - s.w), y: clamp(s.y + py - ds.y, 0, 1 - s.h), w: s.w, h: s.h } : resize(s, ds.h, px, py, lockK(it), .05); drawCrop()
            });
            ['pointerup', 'pointercancel'].forEach(v => ov.addEventListener(v, () => { ds = null }));
            function enterCrop() { const it = itc(); if (!it || !it.base) return; zoomTo(1); it.geo.cropping = true; document.body.classList.add('cropping'); applyGeo(); ov.hidden = false; drawCrop() }
            function exitCrop() { const it = itc(); ov.hidden = true; document.body.classList.remove('cropping'); zoomTo(1); if (it && it.geo.cropping) { it.geo.cropping = false; const c = it.geo.cr; if (c && c.w > .999 && c.h > .999) it.geo.cr = null; if (it.base) applyGeo() } }
            const XF = { R: p => [1 - p[1], p[0]], L: p => [p[1], 1 - p[0]], H: p => [1 - p[0], p[1]], V: p => [p[0], 1 - p[1]] };
            function remap(it, op, fac) {
                const f = XF[op], q = op === 'R' || op === 'L', c = it.geo.cr;
                if (c) { const a = f([c.x, c.y]), b = f([c.x + c.w, c.y + c.h]); it.geo.cr = { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) } }
                if (q && it.geo.asp > 0) it.geo.asp = 1 / it.geo.asp;
            }
            const IBS = [['Rotate left', 'M4 4v5h5M4.6 9A8 8 0 1 1 4 12', 'L', g => { g.rot = (g.rot + 270) % 360 }], ['Rotate right', 'M20 4v5h-5M19.4 9A8 8 0 1 0 20 12', 'R', g => { g.rot = (g.rot + 90) % 360 }],
            ['Flip horizontal', 'M12 3v18M9 7L3 17h6zM15 7l6 10h-6z', 'H', g => { g.fh = !g.fh; g.rot = (360 - g.rot) % 360; g.ang = -g.ang }], ['Flip vertical', 'M3 12h18M7 9l5-6 5 6zM7 15l5 6 5-6z', 'V', g => { g.fv = !g.fv; g.rot = (360 - g.rot) % 360; g.ang = -g.ang }]];
            IBS.forEach(([l, d, op, fn]) => {
                const b = document.createElement('button'); b.className = 'ib big'; b.title = l; b.setAttribute('aria-label', l); b.innerHTML = '<svg viewBox="0 0 24 24"><path d="' + d + '"/></svg>';
                b.onclick = () => { const it = ok2(); if (!it) return; const d0 = fdims(it); fn(it.geo); remap(it, op, d0.sw / d0.sh); syncGeo(); applyGeo(); drawCrop() }; $('xr').appendChild(b)
            });
            const ang = (() => {
                const r = document.createElement('div'); r.className = 'row'; r.innerHTML = '<span>Angle</span><input type="range" min="-45" max="45" step=".5" value="0" aria-label="Straighten"><output>0</output>';
                const i = r.querySelector('input'), o = r.querySelector('output'); fill(i); i.addEventListener('input', () => { const it = ok2(); if (!it) return; it.geo.ang = +i.value; o.textContent = i.value; fill(i); schedGeo() }); $('xs').appendChild(r); return [i, o]
            })();
            function syncGeo() { const it = items[cur], g = it ? it.geo : G0(); ang[0].value = g.ang; ang[1].textContent = g.ang; fill(ang[0]); [...$('xa').children].forEach((b, i) => b.classList.toggle('on', ASP[i][1] === g.asp)) }
            ASP.forEach(([l, v]) => {
                const b = document.createElement('button'); b.className = 'chip'; b.textContent = l;
                b.onclick = () => { const it = ok2(); if (!it) return; it.geo.asp = v; const k = lockK(it); if (k) { const c = it.geo.cr || FULL(), w = k >= 1 ? 1 : k, h = k >= 1 ? 1 / k : 1; it.geo.cr = { x: clamp(c.x + c.w / 2 - w / 2, 0, 1 - w), y: clamp(c.y + c.h / 2 - h / 2, 0, 1 - h), w, h } } syncGeo(); drawCrop() }; $('xa').appendChild(b)
            });
            $('xok').onclick = () => setTab('g');
            $('xrst').onclick = () => { const it = ok2(); if (!it) return; const c = it.geo.cropping; Object.assign(it.geo, G0()); it.geo.cropping = c; syncGeo(); applyGeo(); drawCrop() };

            /* ================= history: undo / redo ================= */
            const HMAX = 60, cl = o => JSON.parse(JSON.stringify(o, (k, v) => k === 'mc' || k === 'mk' || k === 'cropping' ? undefined : v));
            const full = it => ({ s: snap(), g: cl(it.geo) });
            function labelOf(a, b) {
                const j = (x, y) => JSON.stringify(x) !== JSON.stringify(y), ch = Object.keys(b.s.P).filter(k => a.s.P[k] !== b.s.P[k]);
                if (j(a.g, b.g)) return 'Crop / rotate'; if (ch.length > 3) return 'Look / auto grade';
                if (ch.length) return ch.slice(0, 2).map(k => k[0].toUpperCase() + k.slice(1)).join(' + '); if (j(a.s.WH, b.s.WH)) return 'Color wheels'; if (j(a.s.H8, b.s.H8)) return 'Single colors'; if (j(a.s.C, b.s.C)) return 'Curves'; return 'Edit'
            }
            function bu() { const it = items[cur], h = it && it.hist; $('undo').disabled = !h || h.i <= 0; $('redo').disabled = !h || h.i >= h.a.length - 1 }
            function hl() { bu() }
            setInterval(() => {
                const it = items[cur]; if (!it || !src || busy || running || loading || adding || exporting || showing || down || restoring) { bu(); return }
                const f = full(it), sg = JSON.stringify(f), h = it.hist || (it.hist = { a: [], i: -1 });
                if (h.i < 0) { h.a = [{ f, sg, t: graded ? 'Graded' : 'Original' }]; h.i = 0; seen = sg; hl(); return }
                if (sg === h.a[h.i].sg) { seen = sg; return } if (sg !== seen) { seen = sg; return }
                h.a.length = h.i + 1; h.a.push({ f, sg, t: labelOf(h.a[h.i].f, f) }); if (h.a.length > HMAX) h.a.shift(); h.i = h.a.length - 1; hl()
            }, 250);
            function jump(n) {
                const it = items[cur], h = it && it.hist; if (!h || n < 0 || n >= h.a.length || n === h.i || busy || running || loading || adding || exporting) return;
                restoring = true; h.i = n; const e = h.a[n].f, gd = JSON.stringify(e.g) !== JSON.stringify(cl(it.geo)), c = it.geo.cropping;
                Object.assign(it.geo, G0(), e.g); it.geo.cropping = c; apply(e.s); sync(); if (e.s.gr !== graded) setGradedUI(e.s.gr);
                if (gd) applyGeo(); else render(); syncGeo(); drawCrop(); seen = JSON.stringify(full(it)); restoring = false; hl()
            }
            const undo = () => { const h = items[cur] && items[cur].hist; if (h) jump(h.i - 1) }, redo = () => { const h = items[cur] && items[cur].hist; if (h) jump(h.i + 1) };
            $('undo').onclick = undo; $('redo').onclick = redo;
            addEventListener('keydown', e => {
                const t = e.target; if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type !== 'range'))) return; const m = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
                if (m && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo() } else if (m && k === 'y') { e.preventDefault(); redo() }
                else if (!m) { if (e.key === '+' || e.key === '=') zoomTo(Z * 1.25); else if (e.key === '-') zoomTo(Z / 1.25); else if (e.key === '0') zoomTo(1) }
            });
            
            /* ================= pan when zoomed ================= */
            viewer.addEventListener('pointerdown', e => {
                if (e.target.closest('.crop') || viewer.hidden) return;
                if (Z > 1 && !e.target.closest('#div')) { pan = { x: e.clientX, y: e.clientY, tx: TX, ty: TY }; viewer.setPointerCapture(e.pointerId); e.stopImmediatePropagation(); e.preventDefault(); return }
                if (tab === 'x') e.stopImmediatePropagation()
            }, true);
            viewer.addEventListener('pointermove', e => { if (pan) { TX = pan.tx + e.clientX - pan.x; TY = pan.ty + e.clientY - pan.y; clampPan(); zapply() } }, true);
            ['pointerup', 'pointercancel'].forEach(v => viewer.addEventListener(v, () => { pan = null }, true));
            const _sel = select; select = async function (i) { const o = items[cur]; if (o) o.geo.cropping = false; await _sel(i); if (tab === 'x') enterCrop(); hl() };

/* ================= tabs ================= */
            const _st = setTab; window.setTab = t => { const was = tab; pane.classList.toggle('on', t === 'x'); _st(t); if (was === 'x' && t !== 'x') exitCrop(); if (t === 'x' && was !== 'x') enterCrop(); modeFix() };
            syncGeo();


                        /* ================= AI colour plan: vision model first, on-device fallback ================= */
            const AI_URL = '/api/analyze', WK = { exposure: .3, contrast: .6, highlights: .6, shadows: .6, vibrance: .6, saturation: .6, warmth: .6, tint: .6 };
            const inum = (v, lim) => clamp(Math.round(+v || 0), -lim, lim), LIGHT = ['very_light', 'light', 'medium'];
            async function thumbOf(it) {
                let s0 = it.base, tmp = null; if (!s0) { const r = await decodeFile(it.file); s0 = tmp = r.img }
                const w0 = s0.naturalWidth || s0.width, h0 = s0.naturalHeight || s0.height, k = Math.min(1, 512 / Math.max(w0, h0)), c = document.createElement('canvas');
                c.width = Math.round(w0 * k); c.height = Math.round(h0 * k); c.getContext('2d').drawImage(s0, 0, 0, c.width, c.height); if (tmp && tmp.close) tmp.close(); return c.toDataURL('image/jpeg', .8)
            }
            /* skin pixels by colour (YCbCr range); boxes (optional) limits the search to detected faces */
            function skinStats(d, w, h, boxes) {
                let n = 0, sr = 0, sg = 0, sy = 0;
                for (let y = 0; y < h; y++)for (let x = 0; x < w; x++) {
                    if (boxes && !boxes.some(b => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height)) continue;
                    const i = (y * w + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2], Y = .299 * r + .587 * g + .114 * b, cb = 128 - .168736 * r - .331264 * g + .5 * b, cr = 128 + .5 * r - .418688 * g - .081312 * b;
                    if (Y > 45 && Y < 240 && cb > 77 && cb < 127 && cr > 133 && cr < 173 && r > g && r > b) { n++; sr += r; sg += g; sy += Y }
                }
                return { n, share: n / Math.max(1, w * h), rg: n ? sr / Math.max(1, sg) : 1, lum: n ? sy / n : 0 }
            }
            /* on-device plan: face detector when the browser has one, otherwise skin colour alone. Needs no network. */
            async function localPlan(it) {
                const sm = it.sm; let boxes = null;
                try { if ('FaceDetector' in window) { const c = document.createElement('canvas'); c.width = sm.width; c.height = sm.height; c.getContext('2d').putImageData(sm, 0, 0); const f = await new FaceDetector({ fastMode: true }).detect(c); if (f.length) boxes = f.map(q => q.boundingBox) } } catch (e) { }
                const s = skinStats(sm.data, sm.width, sm.height, boxes), people = !!boxes || s.share > .012, k = people && s.lum > 110 ? clamp((s.rg - 1.42) / .25, 0, 1) : 0, cov = clamp(s.share * 6, 0, 1);
                return { src: 'device', people, share: s.share, tone: null, cast: k > .3 ? 'too_red' : 'ok', adj: { exposure: 0, contrast: -Math.round(10 * cov), highlights: 0, shadows: 0, vibrance: 0, saturation: -Math.round(6 * k), warmth: 0, tint: 0 }, red: [Math.round(18 * k), -Math.round(28 * k), 0], orange: [Math.round(12 * k), -Math.round(16 * k), 0], note: '' }
            }
            function fromAI(a) {
                const A = a.adjust || {}, adj = {}; Object.keys(WK).forEach(k => adj[k] = inum(A[k], 40)); const b = o => o ? [inum(o.hue, 40), inum(o.sat, 40), inum(o.lum, 40)] : [0, 0, 0];
                return { src: 'ai', people: !!a.people, share: clamp(+a.skin_share || 0, 0, 1), tone: String(a.skin || ''), cast: String(a.skin_cast || 'ok'), adj, red: b(a.red_band), orange: b(a.orange_band), note: String(a.note || '').slice(0, 140) }
            }
            async function aiPlan(it) {
                const image = await thumbOf(it), ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 16000);
                try {
                    const r = await fetch(AI_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }), signal: ctl.signal });
                    if (!r.ok) throw new Error('ai ' + r.status); const j = await r.json(); if (!j || !j.analysis) throw new Error('ai empty'); return fromAI(j.analysis)
                } finally { clearTimeout(to) }
            }
            const mb = (a, b) => [Math.max(a[0], b[0]), Math.min(a[1], b[1]), a[2] || b[2]];
            function planFor(it) {
                if (it.planP) return it.planP;
                return it.planP = (async () => {
                    let pl = null; try { pl = await aiPlan(it) } catch (e) { pl = null }
                    const loc = await localPlan(it).catch(() => null);
                    if (!pl) pl = loc; else if (loc && loc.people && pl.people && LIGHT.includes(pl.tone)) { pl.red = mb(pl.red, loc.red); pl.orange = mb(pl.orange, loc.orange); pl.adj.contrast = Math.min(pl.adj.contrast, loc.adj.contrast) } // the on-device check can only add skin protection
                    it.plan = pl; return pl
                })()
            }
            function fillT(T, pl) {
                Object.keys(WK).forEach(k => { if (k in T) T[k] = clamp(T[k] + (pl.adj[k] || 0) * WK[k], -100, 100) });
                if (pl.people) T.contrast = clamp(T.contrast - 6 * clamp(pl.share * 6, 0, 1), -100, 100)
            }
            const bandsOf = pl => { const H = Array.from({ length: 8 }, () => [0, 0, 0]); if (pl.people) { H[0] = pl.red.slice(); H[1] = pl.orange.slice() } return H };
            function measureOut() {
                const k = Math.min(1, 200 / Math.max(W, H)), c = document.createElement('canvas'); c.width = Math.max(1, Math.round(W * k)); c.height = Math.max(1, Math.round(H * k));
                const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(cG, 0, 0, c.width, c.height); return skinStats(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height, null)
            }
            async function finishSkin(it) {
                const pl = it.plan; if (!pl) return; const lightSkin = !pl.tone || LIGHT.includes(pl.tone);
                if (pl.people && (pl.red.some(Boolean) || pl.orange.some(Boolean) || lightSkin)) {
                    const H = bandsOf(pl), from = H8.map(q => [...q]); cap('Softening the skin tones...');
                    await tween(700, t => { for (let j = 0; j < 2; j++)for (let q = 0; q < 3; q++)H8[j][q] = from[j][q] + (H[j][q] - from[j][q]) * t; syncHS(); render() });
                    for (let i = 0; i < 2 && lightSkin; i++) { const s = measureOut(); if (s.n < 30 || s.rg <= 1.5) break; for (const j of [0, 1]) { H8[j][1] = clamp(H8[j][1] - 8, -60, 60); H8[j][0] = clamp(H8[j][0] + 5, -60, 60) } syncHS(); render() } // check the result, and nudge if skin is still too red
                }
                cap(pl.src === 'ai' ? 'Done. Drag the line to compare.' : 'Done (quick mode). Drag the line to compare.', 2600)
            }
            window.autoShow = async function () {
                if (!src || busy) return; const it = items[cur], T = {}; Object.keys(P).forEach(k => T[k] = KEYS.includes(k) ? auto[k] : 0);
                window.__plan = it ? planFor(it).then(pl => { fillT(T, pl); return pl }) : null;
                await show(T, wheelsFor(TEMP), .035, ''); if (it) await finishSkin(it)
            };
            const _go = gradeOf; gradeOf = function (it) { const g = _go(it); if (it.plan) { fillT(g.T, it.plan); g.h8 = bandsOf(it.plan) } return g };
            const _sb = startBatch; startBatch = async function () {
                if (running || busy || loading || adding || !src) return;
                const rest = items.filter(x => x !== items[cur] && x.status !== 'done');
                if (rest.length) { autoBtn.disabled = true; window.__pre = true; cap('Asha is studying your photos...'); try { await Promise.race([Promise.all(rest.map(planFor)), sleep(9000)]) } finally { autoBtn.disabled = false; window.__pre = false } }
                return _sb()
            };

            /* ---------- wiring: multi-select input, multi-drop, new Auto button ---------- */
            window.openFile = () => { };
            const fi = $('file').cloneNode(true); fi.multiple = true; fi.accept += ',.mef,.mos,.dcr,.fff,.gpr,.ari,.bay,.cap,.dcs,.drf,.k25,.mdc,.ptx,.pxn,.rwz'; $('file').replaceWith(fi);
            fi.addEventListener('change', () => { if (fi.files.length) addFiles(fi.files); fi.value = '' });
            addEventListener('drop', e => { const fs = e.dataTransfer && e.dataTransfer.files; if (fs && fs.length) addFiles(fs) });
            autoBtn.onclick = startBatch; upd();
        })();