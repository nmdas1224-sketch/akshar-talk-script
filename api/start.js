// POST /api/start: start transcribing a talk in the background and return a job id straight away.
// The work continues on Vercel (waitUntil) after the phone disconnects; the result is saved to Blob storage.
import { waitUntil } from '@vercel/functions';
import { put } from '@vercel/blob';
import { runJob, validPayload } from './_core.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function save(id, data) {
  const body = JSON.stringify(data);
  const opts = { contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 };
  try { await put(`jobs/${id}.json`, body, { ...opts, access: 'private' }); }
  catch (e) { await put(`jobs/${id}.json`, body, { ...opts, access: 'public' }); }
}

export async function POST(request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) return json({ error: 'NO_STORAGE' }, 501);
  let p;
  try { p = await request.json(); } catch (e) { return json({ error: 'BAD_REQUEST' }, 400); }
  if (!validPayload(p)) return json({ error: 'BAD_REQUEST' }, 400);
  const id = crypto.randomUUID();
  const started = Date.now();
  const deadline = started + 280 * 1000; // Vercel Hobby functions can run for 300 seconds
  waitUntil((async () => {
    let out;
    try { out = await runJob(p, { deadline }); }
    catch (e) { out = { error: String(e.message || e), sections: [] }; }
    out.id = id; out.startedAt = started;
    try { await save(id, out); } catch (e) { console.error('Could not save job result', e); }
  })());
  return json({ id });
}

export function GET() { return json({ ok: true, storage: !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID) }); }
