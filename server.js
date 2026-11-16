'use strict';
/* Asha server: serves /public and proxies photo analysis to Groq so the API key never reaches the browser. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

// Local .env (Pxxl and other hosts set real environment variables instead; those always win)
try {
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { /* no .env file */ }

const KEY = process.env.GROQ_API_KEY || '', MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
const BASE = (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const PORT = +process.env.PORT || 3000, MAX_CONC = +process.env.AI_CONCURRENCY || 3, MAX_QUEUE = +process.env.AI_QUEUE || 60;
const DAILY = +process.env.AI_DAILY_LIMIT || 300, TIMEOUT = +process.env.AI_TIMEOUT_MS || 15000, PUB = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname, FLAT = PUB === __dirname, OPEN = new Set(['index.html', 'script.js', 'styles.css']); // flat layout: only these three files are ever served
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const SYSTEM = `You are a photo colorist helping an automatic grading tool. Look at the photo and answer with ONE JSON object only: no markdown, no explanation.
Fields:
"people": true/false
"skin": "none"|"very_light"|"light"|"medium"|"tan"|"brown"|"dark"
"skin_cast": "ok"|"too_red"|"too_orange"|"too_yellow"|"too_pale"|"too_dark"
"skin_share": 0 to 1, the fraction of the frame covered by visible skin
"light": "harsh"|"soft"|"low"|"mixed"|"flat"
"adjust": {"exposure","contrast","highlights","shadows","vibrance","saturation","warmth","tint"} integers from -40 to 40 (small, tasteful corrections)
"red_band": {"hue","sat","lum"} and "orange_band": {"hue","sat","lum"} integers from -40 to 40. For hue, positive moves toward yellow and negative toward magenta.
"note": one short sentence.
Rules: leave skin_cast "ok" and the bands at 0 unless skin truly looks too red, orange, yellow, pale or dark. If skin is too red, use a negative sat and a small positive hue on both bands and lower contrast a little. Never push dark or brown skin toward pale. If there are no people, set the bands to 0.`;

// ---- state: cache, queue, rate limit, circuit breaker
const cache = new Map(), perIp = new Map(); let active = 0, openUntil = 0, fails = 0; const waiters = [];
const acquire = () => new Promise((res, rej) => { if (active < MAX_CONC) { active++; res() } else if (waiters.length >= MAX_QUEUE) rej(new Error('queue')); else waiters.push(res) });
const release = () => { const n = waiters.shift(); if (n) n(); else active-- };
const trip = (s, why) => { openUntil = Date.now() + s * 1000; console.warn('[ai] paused for ' + s + 's: ' + why) };
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function allow(ip) { const day = new Date().toISOString().slice(0, 10), r = perIp.get(ip); if (!r || r.day !== day) { perIp.set(ip, { day, n: 1 }); return true } return ++r.n <= DAILY }

async function callGroq(image) {
  let last;
  for (const extra of [{ reasoning_effort: 'none' }, {}]) { // fast non-thinking mode first; retry plain if the API rejects the option
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const r = await fetch(BASE + '/chat/completions', {
        method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
        body: JSON.stringify({ model: MODEL, temperature: .2, max_completion_tokens: 600, response_format: { type: 'json_object' }, ...extra,
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: [{ type: 'text', text: 'Analyze this photo.' }, { type: 'image_url', image_url: { url: image } }] }] })
      });
      if (r.status === 400 && extra.reasoning_effort) { last = new Error('groq 400'); continue }
      if (!r.ok) { const e = new Error('groq ' + r.status); e.status = r.status; e.retry = +r.headers.get('retry-after') || 0; throw e }
      const j = await r.json(); let txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      txt = txt.replace(/<think>[\s\S]*?<\/think>/g, '').trim(); const m = txt.match(/\{[\s\S]*\}/); if (!m) throw new Error('no json in reply');
      return JSON.parse(m[0]);
    } finally { clearTimeout(t) }
  }
  throw last || new Error('failed');
}

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)) };
function readBody(req, max) { return new Promise((res, rej) => { let n = 0; const a = []; req.on('data', c => { n += c.length; if (n > max) { rej(new Error('big')); req.destroy() } else a.push(c) }); req.on('end', () => res(Buffer.concat(a).toString())); req.on('error', rej) }) }

async function analyze(req, res) {
  let image; try { image = JSON.parse(await readBody(req, 1.6e6)).image } catch (e) { return send(res, 400, { fallback: true, reason: 'bad request' }) }
  if (typeof image !== 'string' || !image.startsWith('data:image/jpeg;base64,') || image.length > 1.5e6) return send(res, 400, { fallback: true, reason: 'bad image' });
  const h = crypto.createHash('sha256').update(image).digest('hex'); if (cache.has(h)) return send(res, 200, { source: 'ai', cached: true, analysis: cache.get(h) });
  if (!KEY) return send(res, 503, { fallback: true, reason: 'no key' });
  if (Date.now() < openUntil) return send(res, 503, { fallback: true, reason: 'paused', retryIn: Math.ceil((openUntil - Date.now()) / 1000) });
  if (!allow(ipOf(req))) return send(res, 429, { fallback: true, reason: 'daily limit' });
  try { await acquire() } catch (e) { return send(res, 503, { fallback: true, reason: 'busy' }) }
  try {
    const analysis = await callGroq(image); fails = 0; cache.set(h, analysis); if (cache.size > 500) cache.delete(cache.keys().next().value);
    send(res, 200, { source: 'ai', analysis });
  } catch (e) {
    if (e.status === 429) trip(Math.min(900, Math.max(30, e.retry || 60)), 'rate limit or quota reached');
    else if (e.status === 401 || e.status === 403) trip(600, 'key rejected, check GROQ_API_KEY');
    else if (++fails >= 3) { fails = 0; trip(30, 'repeated failures: ' + e.message) }
    console.warn('[ai] ' + e.message); send(res, 503, { fallback: true, reason: 'ai error' });
  } finally { release() }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/api/analyze') return analyze(req, res).catch(e => { console.error(e); send(res, 500, { fallback: true }) });
  if (url.pathname === '/api/health') return send(res, 200, { ai: !!KEY, model: MODEL, paused: Date.now() < openUntil });
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end() }
  let p = decodeURIComponent(url.pathname); if (p.endsWith('/')) p += 'index.html'; const f = path.join(PUB, path.normalize(p));
  if (!f.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end() }
  if (FLAT && (path.dirname(f) !== PUB || !OPEN.has(path.basename(f)))) { res.writeHead(404); return res.end('Not found') }
  fs.readFile(f, (err, data) => { if (err) { res.writeHead(404); return res.end('Not found') } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(data) });
}).listen(PORT, () => console.log('Asha running on http://localhost:' + PORT + (KEY ? ' (AI on: ' + MODEL + ')' : ' (no GROQ_API_KEY: on-device grading only)')));
