// Scheduled daily — sends the 7-day and 2-day "your stay is coming up" emails.
// Schedule is set in netlify.toml. Runs server-side with no user request.
//
// For each APPROVED booking with an email on file:
//   • 3–7 days before check-in  → 7-day reminder (once), sets Reminder7Sent
//   • 0–2 days before check-in  → 2-day reminder (once), sets Reminder2Sent
// The windows (not exact days) make it robust if a daily run is ever missed.

const mailer = require('./lib/mailer');

const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appfsGzvzFQ6Fbvrs';
const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE_ID || 'tbl83YSq8GaWNkPf3';
const TOKEN = process.env.AIRTABLE_TOKEN;

const B_NAME = 'fldkrWGTZO9xH3tUg', B_CHECKIN = 'fldpmuL8HMEl49AaY', B_CHECKOUT = 'fld6qnW9lBTsRze3u',
  B_STATUS = 'fldpaz8B5NbPQ46pR', B_PARTY = 'fldRuksM0SOYRaJOS', B_SPACE = 'fldUYaGvdvcV3EZOM',
  B_EMAIL = 'fldgNjaFIzrrXFtGp', B_PAYMENT = 'fldHvsV5XaIiSm5hl', B_ACCT = 'fldGUaa6bMqkISP4e',
  B_R7 = 'fldmGu5DEgUbICdHc', B_R2 = 'fldNMqw98yv5doBnL', B_CHECKOUT_SENT = 'fldAgU8UBLkXFjIsy';

function atUrl() { return `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(BOOKINGS_TABLE)}`; }
function atHeaders() { return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }; }
function selName(v) { return v && typeof v === 'object' ? v.name : v; }

async function listApproved() {
  let records = [], offset;
  do {
    const url = new URL(atUrl());
    url.searchParams.set('returnFieldsByFieldId', 'true');
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const r = await fetch(url, { headers: atHeaders() });
    const data = await r.json();
    if (!r.ok) throw new Error((data && data.error && data.error.message) || 'airtable_list_failed');
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records.filter((x) => /Schvál|Approved/i.test(selName((x.fields || {})[B_STATUS]) || ''));
}

async function mark(id, field) {
  await fetch(`${atUrl()}/${id}`, { method: 'PATCH', headers: atHeaders(), body: JSON.stringify({ fields: { [field]: true } }) });
}

function daysUntil(checkin) {
  if (!checkin) return null;
  const todayPrague = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date()); // YYYY-MM-DD
  return Math.round((Date.parse(String(checkin).slice(0, 10) + 'T00:00:00Z') - Date.parse(todayPrague + 'T00:00:00Z')) / 86400000);
}

function toB(f) {
  return {
    name: f[B_NAME], checkin: f[B_CHECKIN], checkout: f[B_CHECKOUT],
    both: /apartm|Apartment/i.test(selName(f[B_SPACE]) || ''),
    party: f[B_PARTY],
    payLabel: /Cash|Hotov/i.test(selName(f[B_PAYMENT]) || '') ? 'Cash' : 'JV account',
    acct: f[B_ACCT],
  };
}

exports.handler = async () => {
  if (!TOKEN) return { statusCode: 500, body: 'AIRTABLE_TOKEN missing' };
  if (!mailer.configured()) return { statusCode: 200, body: JSON.stringify({ skipped: 'mailer_not_configured' }) };
  const out = { sent7: 0, sent2: 0, checkout: 0, errors: [] };
  let bookings;
  try { bookings = await listApproved(); } catch (e) { return { statusCode: 500, body: String((e && e.message) || e) }; }

  for (const x of bookings) {
    const f = x.fields || {};
    const email = f[B_EMAIL];
    if (!email) continue;
    const d = daysUntil(f[B_CHECKIN]);
    const dOut = daysUntil(f[B_CHECKOUT]);
    try {
      if (dOut === 0 && !f[B_CHECKOUT_SENT]) {
        const m = mailer.checkoutEmail(toB(f));
        await mailer.sendEmail(email, m.subject, m.html);
        await mark(x.id, B_CHECKOUT_SENT); out.checkout++;
      }
      if (d == null) continue;
      if (d <= 7 && d > 2 && !f[B_R7]) {
        const m = mailer.reminder7Email(toB(f));
        await mailer.sendEmail(email, m.subject, m.html);
        await mark(x.id, B_R7); out.sent7++;
      } else if (d <= 2 && d >= 0 && !f[B_R2]) {
        const m = mailer.reminder2Email(toB(f));
        await mailer.sendEmail(email, m.subject, m.html);
        await mark(x.id, B_R2); out.sent2++;
      }
    } catch (e) {
      out.errors.push({ id: x.id, error: String((e && e.message) || e) });
    }
  }
  return { statusCode: 200, body: JSON.stringify(out) };
};
