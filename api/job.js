// GET /api/job?id=...    -> { pending: true } until the background job has saved its result, then the result.
// DELETE /api/job?id=... -> removes the saved result once the phone has stored it.
import { get, del } from '@vercel/blob';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function read(path) {
  for (const access of ['private', 'public']) {
    try {
      const r = await get(path, { access, useCache: false });
      if (r && r.statusCode === 200 && r.stream) return await new Response(r.stream).text();
    } catch (e) { /* try the other access type */ }
  }
  return null;
}

export async function GET(request) {
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!ID.test(id)) return json({ error: 'BAD_ID' }, 400);
  const text = await read(`jobs/${id}.json`);
  if (!text) return json({ pending: true });
  return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!ID.test(id)) return json({ error: 'BAD_ID' }, 400);
  try { await del(`jobs/${id}.json`); } catch (e) { /* already gone */ }
  return json({ ok: true });
}
