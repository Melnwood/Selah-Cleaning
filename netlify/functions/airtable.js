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
//   ANTHROPIC_API_KEY  Enables English auto-translation of work orders.
//   Upcoming rentals (reads the "04 Selah Calendar", read-only, via a Google service account):
//   GOOGLE_SA_EMAIL        Service-account email (…@….iam.gserviceaccount.com).
//   GOOGLE_SA_PRIVATE_KEY  Service-account private key (PEM; keep the \n escapes).
//   SELAH_CALENDAR_ID      The "04 Selah Calendar" id (…@group.calendar.google.com).

const crypto = require('crypto');
const mailer = require('./lib/mailer');

const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appfsGzvzFQ6Fbvrs';
const TABLE_ID = process.env.AIRTABLE_TABLE_ID || 'tblzOQKrXXyzoecYC';
const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE_ID || 'tbl83YSq8GaWNkPf3';
const TOKEN = process.env.AIRTABLE_TOKEN;
const ACCESS_CODE = process.env.ACCESS_CODE || '';

const AT = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE_ID)}`;
function atUrl(t) { return `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(t)}`; }

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
      const t = (event.queryStringParameters || {}).t;
      if (t === 'bookings') return resp(200, { records: await listAll(BOOKINGS_TABLE) });
      return resp(200, { records: await listAll(TABLE_ID) });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (body.action === 'translate') return await translate(body);
      if (body.action === 'rentals') return await rentals(body);
      if (body.action === 'book') return await book(body);
      if (body.action === 'bookingStatus') return await bookingStatus(body);
      if (body.action === 'fx') return await fxRate(body);
      if (body.action === 'sendEmail') return await sendEmailAction(body);
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
      const url = body.table === 'bookings' ? atUrl(BOOKINGS_TABLE) : AT;
      const r = await fetch(`${url}/${body.id}?returnFieldsByFieldId=true`, {
        method: 'PATCH',
        headers: atHeaders(),
        body: JSON.stringify({ fields: body.fields, typecast: true }),
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
// ---- Booking requests → Bookings table (with overlap guard) ----
const B_CHECKIN = 'fldpmuL8HMEl49AaY', B_CHECKOUT = 'fld6qnW9lBTsRze3u', B_STATUS = 'fldpaz8B5NbPQ46pR', B_NAME = 'fldkrWGTZO9xH3tUg';
function overlapInc(a1, a2, b1, b2) { return a1 <= b2 && b1 <= a2; } // inclusive-day overlap on YYYY-MM-DD strings

async function bookingConflict(ci, co) {
  // 1) existing bookings that aren't declined
  let existing = [];
  try { existing = await listAll(BOOKINGS_TABLE); } catch (e) {}
  for (const r of existing) {
    const f = r.fields || {};
    let st = f[B_STATUS]; if (st && typeof st === 'object') st = st.name;
    if (String(st || '').startsWith('Zamít')) continue; // declined → doesn't block
    const eci = f[B_CHECKIN], eco = f[B_CHECKOUT];
    if (eci && eco && overlapInc(ci, co, eci, eco)) return { who: f[B_NAME] || 'another request', from: eci, to: eco, kind: 'request' };
  }
  // 2) the Selah Calendar (all-day events block their span + the checkout/cleaning day)
  const pad = 2 * 86400000;
  const tmin = new Date(new Date(ci).getTime() - pad).toISOString();
  const tmax = new Date(new Date(co).getTime() + pad).toISOString();
  const { ok, items } = await selahEvents(tmin, tmax);
  if (ok) {
    for (const ev of items) {
      const s = ev.start && ev.start.date, e = ev.end && ev.end.date; // all-day only
      if (!s || !e) continue;
      if (/^(massage|get ?meds|mel.s meds|mel’s meds)/i.test((ev.summary || '').trim())) continue;
      if (overlapInc(ci, co, s, e)) return { who: ev.summary || 'a calendar booking', from: s, to: e, kind: 'calendar' };
    }
  }
  return null;
}

async function book(body) {
  if (!body.fields || typeof body.fields !== 'object') return resp(400, { error: 'Missing "fields".' });
  const ci = body.fields[B_CHECKIN], co = body.fields[B_CHECKOUT];
  if (ci && co) {
    const c = await bookingConflict(ci, co);
    if (c) return resp(409, { error: 'conflict', conflict: c });
  }
  const r = await fetch(atUrl(BOOKINGS_TABLE), {
    method: 'POST',
    headers: atHeaders(),
    body: JSON.stringify({ fields: body.fields, typecast: true }),
  });
  const data = await r.json();
  return resp(r.ok ? 200 : r.status, data);
}

// Booking field IDs used for calendar sync
const B_PARTY = 'fldRuksM0SOYRaJOS', B_GUESTS = 'fldCv5Z6JFuNuNC3G', B_EMAIL = 'fldgNjaFIzrrXFtGp',
  B_PHONE = 'fld1jHbXT1sLuGYfm', B_TEAM = 'fldO7Wq8cW5Pnifbf', B_PURPOSE = 'fld01hHE2rz4WEnFU',
  B_REASON = 'fldRapIBVEQ7hYL7c', B_PAYMENT = 'fldHvsV5XaIiSm5hl', B_ACCT = 'fldGUaa6bMqkISP4e',
  B_EVENTID = 'fldns5wVSVhRiepZR';
const B_SPACE = 'fldUYaGvdvcV3EZOM', B_ACCEPT_SENT = 'fldyEfAAs7Ot72xBp',
  B_R7 = 'fldmGu5DEgUbICdHc', B_R2 = 'fldNMqw98yv5doBnL', B_CHECKOUT_SENT = 'fldAgU8UBLkXFjIsy';
function selName(v) { return v && typeof v === 'object' ? v.name : v; }

function calTitle(f) {
  const name = String(f[B_NAME] || '').trim();
  const last = name.split(/\s+/).pop() || name;
  const pay = selName(f[B_PAYMENT]) || '';
  const acct = /Cash|Hotov/i.test(pay) ? '#cash' : (f[B_ACCT] ? '#' + f[B_ACCT] : '');
  return `${last} (${f[B_PARTY] || '?'}) ${acct}`.trim();
}
function calDescription(f) {
  const pay = selName(f[B_PAYMENT]) || '';
  const acct = f[B_ACCT] ? ' #' + f[B_ACCT] : '';
  return [
    `Booked by: ${f[B_NAME] || ''}`,
    `Party: ${f[B_PARTY] || ''}`,
    `Guests:\n${f[B_GUESTS] || ''}`,
    `Purpose: ${selName(f[B_PURPOSE]) || ''}`,
    f[B_REASON] ? `Reason: ${f[B_REASON]}` : '',
    `Payment: ${pay}${acct}`,
    `Contact: ${f[B_EMAIL] || ''}${f[B_PHONE] ? ' · ' + f[B_PHONE] : ''}`,
    `JV team: ${f[B_TEAM] || ''}`,
    '(added automatically from the Selah booking page)',
  ].filter(Boolean).join('\n');
}

async function calWriteToken() {
  const email = process.env.GOOGLE_SA_EMAIL, pk = process.env.GOOGLE_SA_PRIVATE_KEY, cal = process.env.SELAH_CALENDAR_ID;
  if (!email || !pk || !cal) return null;
  const token = await googleToken(email, pk, 'https://www.googleapis.com/auth/calendar');
  return { token, cal };
}
async function createSelahEvent(f) {
  const w = await calWriteToken();
  if (!w) return { error: 'no_calendar' };
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(w.cal)}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${w.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: calTitle(f), description: calDescription(f), start: { date: f[B_CHECKIN] }, end: { date: f[B_CHECKOUT] } }),
  });
  const data = await r.json();
  if (!r.ok) return { error: (data && data.error && data.error.message) || 'insert_failed' };
  return { id: data.id };
}
async function deleteSelahEvent(eventId) {
  const w = await calWriteToken();
  if (!w) return;
  await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(w.cal)}/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${w.token}` },
  });
}

// Set a booking's status and keep the Selah Calendar in sync (approve → add event, un-approve → remove)
async function bookingStatus(body) {
  const { id, status } = body;
  if (!id || !status) return resp(400, { error: 'Missing "id" or "status".' });
  const getR = await fetch(`${atUrl(BOOKINGS_TABLE)}/${id}?returnFieldsByFieldId=true`, { headers: atHeaders() });
  const rec = await getR.json();
  if (!getR.ok) return resp(getR.status, rec);
  const f = rec.fields || {};
  const approved = String(status).startsWith('Schvál');
  const existingEv = f[B_EVENTID];
  const patch = { [B_STATUS]: status };
  let calendar = 'skipped';
  try {
    if (approved && !existingEv) {
      const ev = await createSelahEvent(f);
      if (ev.id) { patch[B_EVENTID] = ev.id; calendar = 'created'; }
      else calendar = ev.error === 'no_calendar' ? 'no_calendar' : ('error:' + (ev.error || 'unknown'));
    } else if (!approved && existingEv) {
      await deleteSelahEvent(existingEv);
      patch[B_EVENTID] = '';
      calendar = 'removed';
    }
  } catch (e) { calendar = 'error:' + ((e && e.message) || e); }
  const pr = await fetch(`${atUrl(BOOKINGS_TABLE)}/${id}?returnFieldsByFieldId=true`, {
    method: 'PATCH', headers: atHeaders(), body: JSON.stringify({ fields: patch, typecast: true }),
  });
  const pdata = await pr.json();
  // Acceptance email — sent once, when a booking is approved and has an email on file.
  let emailed = false;
  if (pr.ok && approved && f[B_EMAIL] && !f[B_ACCEPT_SENT] && mailer.configured()) {
    try {
      const both = /apartm|Apartment/i.test((selName(f[B_SPACE]) || ''));
      const payLabel = /Cash|Hotov/i.test((selName(f[B_PAYMENT]) || '')) ? 'Cash' : 'JV account';
      const msg = mailer.acceptanceEmail({ name: f[B_NAME], checkin: f[B_CHECKIN], checkout: f[B_CHECKOUT], both, party: f[B_PARTY], payLabel, acct: f[B_ACCT] });
      await mailer.sendEmail(f[B_EMAIL], msg.subject, msg.html);
      await fetch(`${atUrl(BOOKINGS_TABLE)}/${id}`, { method: 'PATCH', headers: atHeaders(), body: JSON.stringify({ fields: { [B_ACCEPT_SENT]: true } }) });
      emailed = true;
    } catch (e) { emailed = 'error:' + ((e && e.message) || e); }
  }
  return resp(pr.ok ? 200 : pr.status, Object.assign({ calendar, emailed }, pdata));
}

function resp(statusCode, obj) {
  return { statusCode, headers: CORS, body: JSON.stringify(obj) };
}

// ---- Selah Calendar reader (shared) ----
async function selahEvents(timeMin, timeMax) {
  const email = process.env.GOOGLE_SA_EMAIL, pk = process.env.GOOGLE_SA_PRIVATE_KEY, cal = process.env.SELAH_CALENDAR_ID;
  if (!email || !pk || !cal) return { ok: false, items: [], error: 'no_calendar' };
  try {
    const token = await googleToken(email, pk, 'https://www.googleapis.com/auth/calendar.readonly');
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events`
      + `?singleEvents=true&orderBy=startTime&maxResults=250`
      + `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json();
    if (!r.ok) return { ok: false, items: [], error: (data && data.error && data.error.message) || 'calendar_failed' };
    return { ok: true, items: data.items || [] };
  } catch (e) {
    return { ok: false, items: [], error: String((e && e.message) || e) };
  }
}

// ---- Upcoming rentals from the "04 Selah Calendar" ----
async function rentals(body) {
  const days = Math.min(120, Math.max(1, parseInt(body.days, 10) || 30));
  const back = Math.min(60, Math.max(0, parseInt(body.back, 10) || 0));
  const now = new Date();
  const timeMin = new Date(now.getTime() - back * 86400000);
  const timeMax = new Date(now.getTime() + days * 86400000);
  const { ok, items, error } = await selahEvents(timeMin.toISOString(), timeMax.toISOString());
  if (!ok) return resp(200, { error: error || 'no_calendar', rentals: [] });
  return resp(200, { rentals: items.map(ev => ({ summary: ev.summary || '', start: ev.start, end: ev.end })) });
}

async function googleToken(email, privateKey, scope) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' +
    b64({ iss: email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const key = String(privateKey).replace(/\\n/g, '\n');
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64url');
  const jwt = `${unsigned}.${sig}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data && (data.error_description || data.error)) || 'google_token_failed');
  return data.access_token;
}

async function sendEmailAction(body) {
  const { id, type } = body || {};
  if (!id || !type) return resp(400, { error: 'Missing "id" or "type".' });
  if (!mailer.configured()) return resp(400, { error: 'mailer_not_configured' });
  const map = {
    acceptance: ['acceptanceEmail', B_ACCEPT_SENT],
    r7: ['reminder7Email', B_R7],
    r2: ['reminder2Email', B_R2],
    checkout: ['checkoutEmail', B_CHECKOUT_SENT],
  };
  const entry = map[type];
  if (!entry) return resp(400, { error: 'Unknown email type.' });
  const getR = await fetch(`${atUrl(BOOKINGS_TABLE)}/${id}?returnFieldsByFieldId=true`, { headers: atHeaders() });
  const rec = await getR.json();
  if (!getR.ok) return resp(getR.status, rec);
  const f = rec.fields || {};
  const email = f[B_EMAIL];
  if (!email) return resp(400, { error: 'no_email' });
  const both = /apartm|Apartment/i.test(selName(f[B_SPACE]) || '');
  const payLabel = /Cash|Hotov/i.test(selName(f[B_PAYMENT]) || '') ? 'Cash' : 'JV account';
  const b = { name: f[B_NAME], checkin: f[B_CHECKIN], checkout: f[B_CHECKOUT], both, party: f[B_PARTY], payLabel, acct: f[B_ACCT] };
  try {
    const msg = mailer[entry[0]](b);
    await mailer.sendEmail(email, msg.subject, msg.html);
    await fetch(`${atUrl(BOOKINGS_TABLE)}/${id}`, { method: 'PATCH', headers: atHeaders(), body: JSON.stringify({ fields: { [entry[1]]: true } }) });
    return resp(200, { sent: true, to: email, type });
  } catch (e) { return resp(500, { error: String((e && e.message) || e) }); }
}

async function fxRate(body) {
  const date = body && body.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return resp(400, { error: 'fx: bad or missing date (YYYY-MM-DD).' });
  const base = 'https://www.cnb.cz/en/financial-markets/foreign-exchange-market/central-bank-exchange-rate-fixing/central-bank-exchange-rate-fixing/daily.txt';
  // ČNB only publishes on business days — walk back up to 6 days for weekends/holidays.
  for (let i = 0; i < 6; i++) {
    const dt = new Date(date + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() - i);
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const yy = dt.getUTCFullYear();
    try {
      const r = await fetch(`${base}?date=${dd}.${mm}.${yy}`);
      if (!r.ok) continue;
      const txt = await r.text();
      const line = (txt || '').split('\n').find((l) => l.split('|')[3] === 'USD');
      if (line) {
        const p = line.split('|');
        const amt = parseFloat(String(p[2]).replace(',', '.'));
        const val = parseFloat(String(p[4]).replace(',', '.'));
        if (amt && val) return resp(200, { rate: val / amt, rateDate: `${yy}-${mm}-${dd}`, requested: date });
      }
    } catch (e) { /* try previous day */ }
  }
  return resp(200, { rate: null, requested: date });
}

async function listAll(tableId) {
  const base = atUrl(tableId || TABLE_ID);
  let records = [];
  let offset;
  do {
    const url = new URL(base);
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
