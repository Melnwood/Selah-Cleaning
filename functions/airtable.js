// Secure Airtable proxy for the Cabin & Apartment Cleaning Tracker.
// The Airtable token lives only in Netlify environment variables — never in the browser.
//
// Required env vars (Netlify → Site settings → Environment variables):
//   AIRTABLE_TOKEN     A personal access token with data.records:read + data.records:write on the base.
// Optional env vars:
//   AIRTABLE_BASE_ID   Defaults to the Cabin base below.
//   AIRTABLE_TABLE_ID  Defaults to the Cleanings table below.
//   ACCESS_CODE        If set, every request must send a matching "x-access-code" header.
//                      Leave unset to keep the endpoint open (fine for an obscure URL).

const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appfsGzvzFQ6Fbvrs';
const TABLE_ID = process.env.AIRTABLE_TABLE_ID || 'tblzOQKrXXyzoecYC';
const TOKEN = process.env.AIRTABLE_TOKEN;
const ACCESS_CODE = process.env.ACCESS_CODE || '';

const AT = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE_ID)}`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-access-code',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!TOKEN) return resp(500, { error: 'Server not configured: AIRTABLE_TOKEN is missing.' });

  if (ACCESS_CODE) {
    const h = event.headers || {};
    const provided = h['x-access-code'] || h['X-Access-Code'] || '';
    if (provided !== ACCESS_CODE) return resp(401, { error: 'Wrong or missing access code.' });
  }

  try {
    if (event.httpMethod === 'GET') {
      return resp(200, { records: await listAll() });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (body.action === 'translate') return await translate(body);
      if (!body.fields || typeof body.fields !== 'object') return resp(400, { error: 'Missing "fields".' });
      const r = await fetch(AT, {
        method: 'POST',
        headers: atHeaders(),
        body: JSON.stringify({ fields: body.fields, returnFieldsByFieldId: true }),
      });
      const data = await r.json();
      return resp(r.ok ? 200 : r.status, data);
    }

    if (event.httpMethod === 'PATCH') {
      const body = JSON.parse(event.body || '{}');
      if (!body.id || !body.fields) return resp(400, { error: 'Missing "id" or "fields".' });
      const r = await fetch(`${AT}/${body.id}?returnFieldsByFieldId=true`, {
        method: 'PATCH',
        headers: atHeaders(),
        body: JSON.stringify({ fields: body.fields }),
      });
      const data = await r.json();
      return resp(r.ok ? 200 : r.status, data);
    }

    return resp(405, { error: 'Method not allowed.' });
  } catch (e) {
    return resp(500, { error: String((e && e.message) || e) });
  }
};

function atHeaders() {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
}

async function translate(body) {
  const texts = Array.isArray(body.texts) ? body.texts : [];
  if (!texts.length) return resp(200, { translations: [] });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return resp(200, { error: 'no_key', translations: texts });
  const target = body.target === 'cs' ? 'Czech' : 'English';
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        system: `You are a translation engine for a cabin cleaning & maintenance app. Translate each string in the user's JSON array into natural, concise ${target}. Preserve dates, numbers, names, and any [bracketed] tags. Return ONLY a JSON array of strings, same length and order as the input — no explanations, no markdown.`,
        messages: [{ role: 'user', content: JSON.stringify(texts) }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return resp(200, { error: (data.error && data.error.message) || 'translate_failed', translations: texts });
    let out = texts;
    try {
      const txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
      const parsed = JSON.parse(txt);
      if (Array.isArray(parsed) && parsed.length === texts.length) out = parsed;
    } catch (e) {}
    return resp(200, { translations: out });
  } catch (e) {
    return resp(200, { error: String((e && e.message) || e), translations: texts });
  }
}
function resp(statusCode, obj) {
  return { statusCode, headers: CORS, body: JSON.stringify(obj) };
}

async function listAll() {
  let records = [];
  let offset;
  do {
    const url = new URL(AT);
    url.searchParams.set('returnFieldsByFieldId', 'true');
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const r = await fetch(url, { headers: atHeaders() });
    const data = await r.json();
    if (!r.ok) throw new Error((data && data.error && data.error.message) || 'Airtable list failed.');
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}
