// Shared job runner for the background transcription (files starting with "_" are not public endpoints).
// It runs Gemini requests for every section of a talk at the same time, then (if time allows) the summary.

const BASE = 'https://generativelanguage.googleapis.com';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function readError(r) {
  let msg = '', retry = 0;
  try {
    const j = await r.json();
    msg = (j.error && j.error.message) || '';
    for (const d of (j.error && j.error.details) || []) if (d.retryDelay) retry = parseFloat(d.retryDelay) || 0;
  } catch (e) { /* ignore */ }
  return { status: r.status, msg, retry, zero: /limit: 0\b/.test(msg) };
}

// One generateContent call with the same fallbacks the app uses: next model if one is unavailable,
// no "thinking" setting if a model rejects it, and waiting out short rate limits while time allows.
export async function generate({ key, models, contents, cfg, deadline, fetchFn = fetch, state }) {
  state.noThink = state.noThink || new Set();
  const order = state.good ? [state.good, ...models.filter((m) => m !== state.good)] : models;
  let last = null;
  for (const model of order) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const left = deadline - Date.now();
      if (left < 20000) throw Object.assign(new Error('Out of time on the server'), { timeout: true });
      const gc = Object.assign({ temperature: 0 }, cfg || {});
      if (!state.noThink.has(model)) gc.thinkingConfig = { thinkingLevel: 'low' };
      let r;
      try {
        r = await fetchFn(`${BASE}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents, generationConfig: gc }),
          signal: AbortSignal.timeout(Math.max(5000, left - 15000)),
        });
      } catch (e) {
        last = { status: 0, msg: String(e.message || e) };
        if (e.name === 'TimeoutError' || e.name === 'AbortError') throw Object.assign(new Error('Out of time on the server'), { timeout: true });
        await sleep(2000); continue;
      }
      if (r.ok) {
        const j = await r.json();
        state.good = model;
        const c = (j.candidates || [])[0] || {};
        const text = ((c.content && c.content.parts) || []).map((p) => p.text || '').join('');
        return { text, finish: c.finishReason || '' };
      }
      const e = await readError(r); last = e;
      if (r.status === 400 && /API key not valid|API_KEY_INVALID/i.test(e.msg)) throw new Error('Your Gemini key was not accepted. Check it in Settings.');
      if (r.status === 400 && /thinking/i.test(e.msg) && !state.noThink.has(model)) { state.noThink.add(model); attempt--; continue; }
      if (r.status === 429 && !e.zero && attempt < 3) {
        const wait = Math.min(60, Math.ceil(e.retry || 15)) * 1000;
        if (Date.now() + wait > deadline - 30000) throw Object.assign(new Error('Gemini free limit reached'), { timeout: true });
        await sleep(wait); continue;
      }
      if (r.status >= 500 && attempt < 2) { await sleep(3000 * (attempt + 1)); continue; }
      break; // model not available for this key: try the next one
    }
  }
  throw new Error('Gemini error' + (last ? ' ' + last.status + (last.msg ? ': ' + last.msg.slice(0, 200) : '') : ''));
}

function stampOf(p) {
  const m = p.match(/^\s*\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/);
  if (!m) return null;
  return m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
}
// Join section texts in order, keeping each paragraph only in the section its timestamp belongs to.
export function joinSections(list) {
  const sorted = [...list].sort((a, b) => a.from - b.from);
  const lastIdx = sorted.length - 1;
  return sorted.map((s, k) => (s.text || '').split(/\n\s*\n/).filter((p) => {
    const t = stampOf(p); if (t == null) return true;
    return t >= s.from - 5 && (k === lastIdx ? t <= s.to + 30 : t < s.to);
  }).join('\n\n')).filter(Boolean).join('\n\n');
}

// payload: { key, models, file:{uri,mimeType}, sections:[{i,from,to,prompt}], known:[{i,from,to,text}], summaryPrompt, summaryCfg }
export async function runJob(payload, { deadline, fetchFn = fetch } = {}) {
  const { key, models, file, sections } = payload;
  const state = {};
  const results = await Promise.all(sections.map(async (s, idx) => {
    await sleep(idx * 400); // small stagger so requests don't all land in the same instant
    try {
      const r = await generate({
        key, models, fetchFn, state, deadline,
        contents: [{ role: 'user', parts: [{ file_data: { mime_type: file.mimeType, file_uri: file.uri } }, { text: s.prompt }] }],
        cfg: { maxOutputTokens: 24000 },
      });
      return { i: s.i, text: (r.text || '').replace(/```[a-z]*/g, '').trim() };
    } catch (e) {
      return { i: s.i, error: String(e.message || e) };
    }
  }));
  const out = { sections: results, finishedAt: Date.now() };
  const allDone = results.every((r) => typeof r.text === 'string');
  if (allDone && payload.summaryPrompt && deadline - Date.now() > 45000) {
    const byI = new Map(results.map((r) => [r.i, r.text]));
    const full = joinSections([
      ...(payload.known || []),
      ...sections.map((s) => ({ from: s.from, to: s.to, text: byI.get(s.i) })),
    ]);
    if (full.trim()) {
      try {
        const r = await generate({
          key, models, fetchFn, state, deadline,
          contents: [{ role: 'user', parts: [{ text: payload.summaryPrompt.replace('{{TRANSCRIPT}}', full.slice(0, 400000)) }] }],
          cfg: Object.assign({ responseMimeType: 'application/json', maxOutputTokens: 4000 }, payload.summaryCfg || {}),
        });
        out.summaryText = r.text;
      } catch (e) { out.summaryError = String(e.message || e); }
    }
  }
  out.finishedAt = Date.now();
  return out;
}

export function validPayload(p) {
  return p && typeof p.key === 'string' && p.key.length > 10 && Array.isArray(p.models) && p.models.length &&
    p.file && typeof p.file.uri === 'string' && /^https:\/\/generativelanguage\.googleapis\.com\//.test(p.file.uri) &&
    Array.isArray(p.sections) && p.sections.length > 0 && p.sections.length <= 30 &&
    p.sections.every((s) => typeof s.prompt === 'string' && Number.isFinite(s.from) && Number.isFinite(s.to));
}
