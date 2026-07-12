// Shared mailer for Selah — sends English guest emails through Gmail using the
// existing Google service account (domain-wide delegation, gmail.send scope).
//
// Required environment variables (set in Netlify):
//   GOOGLE_SA_EMAIL        Service-account email (already set for the calendar).
//   GOOGLE_SA_PRIVATE_KEY  Service-account private key (already set; keep \n escapes).
//   SELAH_FROM_EMAIL       The JV mailbox to send AS, e.g. selah@josiahventure.com.
//                          A Workspace super-admin must authorise the service
//                          account for scope https://www.googleapis.com/auth/gmail.send
//                          (Admin console → Security → API controls → Domain-wide
//                          delegation) and this must be a real mailbox.
//   SELAH_FROM_NAME        Optional display name (default "Selah Retreat House").
//   SELAH_REPLY_TO         Optional reply-to address (default = SELAH_FROM_EMAIL).

const crypto = require('crypto');

const SA_EMAIL = process.env.GOOGLE_SA_EMAIL;
const SA_KEY = process.env.GOOGLE_SA_PRIVATE_KEY;
const FROM = process.env.SELAH_FROM_EMAIL;
const FROM_NAME = process.env.SELAH_FROM_NAME || 'Selah Retreat House';
const REPLY_TO = process.env.SELAH_REPLY_TO || FROM;
const PHONE = process.env.SELAH_PHONE || '+420 605 432 111';
const RESERVATIONS_NAME = process.env.SELAH_RESERVATIONS_NAME || 'Amy Ellenwood';
const ADDRESS = process.env.SELAH_ADDRESS || 'H8JF+2W Pstruží, Czechia';
const CHECKIN_TIME = process.env.SELAH_CHECKIN_TIME || '3:00 PM';
const CHECKOUT_TIME = process.env.SELAH_CHECKOUT_TIME || '11:00 AM';
const DOOR_CODE = process.env.SELAH_DOOR_CODE || '511111';
const ALARM_CODE = process.env.SELAH_ALARM_CODE || '1379';

function configured() { return !!(SA_EMAIL && SA_KEY && FROM); }

async function gmailToken() {
  if (!configured()) throw new Error('mailer_not_configured (need GOOGLE_SA_EMAIL, GOOGLE_SA_PRIVATE_KEY, SELAH_FROM_EMAIL)');
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: SA_EMAIL,
    sub: FROM, // impersonate the JV mailbox (domain-wide delegation)
    scope: 'https://www.googleapis.com/auth/gmail.send',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  });
  const key = String(SA_KEY).replace(/\\n/g, '\n');
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data && (data.error_description || data.error)) || 'gmail_token_failed');
  return data.access_token;
}

function encodeHeader(s) {
  // RFC 2047 for any non-ASCII in a header (subjects are English, but be safe)
  return /[^\x00-\x7F]/.test(s) ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=` : s;
}

let BANNER = '';
try { BANNER = require('./banner'); } catch (e) { BANNER = ''; }

function buildRaw(to, subject, html) {
  const base = [
    `From: ${encodeHeader(FROM_NAME)} <${FROM}>`,
    `Reply-To: ${REPLY_TO}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
  ];
  const htmlB64 = Buffer.from(html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  let msg;
  if (BANNER) {
    const boundary = 'selah_' + Date.now().toString(36);
    const htmlPart = ['Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', htmlB64].join('\r\n');
    const imgPart = ['Content-Type: image/jpeg', 'Content-Transfer-Encoding: base64', 'Content-ID: <selahbanner>', 'Content-Disposition: inline; filename="selah.jpg"', '', BANNER.replace(/(.{76})/g, '$1\r\n')].join('\r\n');
    msg = base.concat([`Content-Type: multipart/related; boundary="${boundary}"`]).join('\r\n')
      + '\r\n\r\n' + `--${boundary}\r\n` + htmlPart + `\r\n--${boundary}\r\n` + imgPart + `\r\n--${boundary}--`;
  } else {
    msg = base.concat(['Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64']).join('\r\n') + '\r\n\r\n' + htmlB64;
  }
  return Buffer.from(msg, 'utf8').toString('base64url');
}

async function sendEmail(to, subject, html) {
  if (!to || !/@/.test(String(to))) throw new Error('no_recipient');
  const token = await gmailToken();
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: buildRaw(to, subject, html) }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || 'gmail_send_failed');
  return data;
}

// ---------- content ----------
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || 'there'; }

function shell(title, inner) {
  const banner = BANNER
    ? `<img src="cid:selahbanner" alt="Selah" width="560" style="display:block;width:100%;max-width:560px;height:auto;border-radius:14px;margin:0 auto 18px" />`
    : '';
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:8px 4px;color:#1b2a22;line-height:1.55;font-size:15px">
  ${banner}
  <div style="font-family:Georgia,'Times New Roman',serif;font-size:12px;letter-spacing:.26em;color:#a56c15;text-transform:uppercase;margin-bottom:4px">Selah</div>
  <h1 style="font-family:Georgia,serif;font-size:21px;margin:0 0 16px;font-weight:700">${title}</h1>
  ${inner}
  <p style="margin:24px 0 4px;color:#54655a">With love,<br>The Selah team &middot; Josiah Venture</p>
  <div style="margin-top:18px;padding-top:14px;border-top:1px solid #d6ddd2;color:#8a978d;font-size:12.5px">
    Selah &middot; ${ADDRESS}<br>Reservations: ${RESERVATIONS_NAME} &middot; ${PHONE}
  </div>
</div>`;
}
function spaceText(b) { return b.both ? 'the main house and the loft apartment' : 'the main house'; }
function stayBlock(b) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;margin:16px 0">
    <tr>
      <td style="width:50%;background:#f5f8f2;border:1px solid #d6ddd2;border-radius:12px;padding:12px 14px;vertical-align:top">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#54655a">Check-in</div>
        <div style="font-weight:700;font-size:15px;margin-top:2px">${fmtDate(b.checkin)}</div>
        <div style="font-size:12.5px;color:#54655a;margin-top:2px">from ${CHECKIN_TIME}</div>
      </td>
      <td style="width:12px"></td>
      <td style="width:50%;background:#f5f8f2;border:1px solid #d6ddd2;border-radius:12px;padding:12px 14px;vertical-align:top">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#54655a">Check-out</div>
        <div style="font-weight:700;font-size:15px;margin-top:2px">${fmtDate(b.checkout)}</div>
        <div style="font-size:12.5px;color:#54655a;margin-top:2px">by ${CHECKOUT_TIME}</div>
      </td>
    </tr>
  </table>`;
}
function bless(name, stage) {
  const n = esc(firstName(name));
  const lines = {
    accept: `${n}, as you look ahead to these days, our prayer is that Selah would be a true <i>pause</i> for you &mdash; and that in the quiet you would draw closer to God, your family, and your team.`,
    r7: `${n}, as the day draws near, we're praying you can begin to lay down whatever you're carrying, so that there's room to pause (<i>selah</i>) and reconnect with God, family, and team.`,
    r2: `${n}, the pause is almost here. Our prayer is that these days of <i>selah</i> would refresh you deeply, and renew your relationship with God, family, and team.`,
    out: `${n}, as you head home, our prayer is that the rest you found in this <i>selah</i> would go with you &mdash; into your life with God, your family, and your team.`,
  };
  return `<p style="margin-top:18px">${lines[stage] || lines.accept}</p>`;
}

// b = { name, checkin, checkout, both, party, payLabel, acct }
function acceptanceEmail(b) {
  return {
    subject: 'Your Selah reservation is confirmed',
    html: shell('Reservation confirmed', `
      <p>Hello ${esc(firstName(b.name))},</p>
      <p>We are so glad that you are planning to spend time at <b>Selah</b>. We are praying that your time here is full of exactly what you need.</p>
      ${stayBlock(b)}
      <p>You've reserved ${spaceText(b)}${b.party ? ` for ${esc(b.party)} guests` : ''}. About a week before you arrive we'll send a note to help you prepare, and again a couple of days before with the final details.</p>
      <p style="background:#f5ead2;border-radius:12px;padding:12px 14px;margin:16px 0">
        <b>Good to know</b><br>
        Check-in is no earlier than ${CHECKIN_TIME}, and check-out no later than ${CHECKOUT_TIME}.<br>
        For any changes or special requests, please contact Amy at ${PHONE} or simply reply to this email &mdash; we'll do our best to help.
      </p>
      ${bless(b.name, 'accept')}`),
  };
}
function reminder7Email(b) {
  return {
    subject: 'One week until your Selah stay',
    html: shell('One week to go', `
      <p>Hello ${esc(firstName(b.name))},</p>
      <p>Your stay at <b>Selah</b> is just a week away, and we're looking forward to welcoming you.</p>
      ${stayBlock(b)}
      <p>A few things to help you get ready:</p>
      <ul style="padding-left:20px">
        <li>Bring your own food for the stay &mdash; the kitchen is fully equipped for cooking.</li>
        <li>Bed linens and towels are provided.</li>
        <li>Check-in is no earlier than ${CHECKIN_TIME}; check-out no later than ${CHECKOUT_TIME}.</li>
      </ul>
      <p>If anything about your reservation changes, or you have questions before you come, contact Amy at ${PHONE} or just reply here.</p>
      ${bless(b.name, 'r7')}`),
  };
}
function reminder2Email(b) {
  const pay = b.payLabel === 'Cash'
    ? 'Payment for your stay is in cash.'
    : (b.acct ? `Your stay will be charged to JV account #${esc(b.acct)}.` : '');
  return {
    subject: 'See you in two days at Selah',
    html: shell('Almost time', `
      <p>Hello ${esc(firstName(b.name))},</p>
      <p>Just two days until your stay at <b>Selah</b> begins &mdash; here's everything you need for arrival.</p>
      ${stayBlock(b)}
      <div style="background:#eef3ec;border:1px solid #d6ddd2;border-radius:12px;padding:14px 16px;margin:16px 0">
        <div style="font-weight:700;margin-bottom:6px">Getting in</div>
        <div style="margin-bottom:6px">To unlock the door, enter <b>${DOOR_CODE}</b>, then press the <b>Yale</b> button.</div>
        <div>To turn the alarm <b>off</b>, enter <b>${ALARM_CODE}</b> then <b>Enter</b>. When you leave, turn it back <b>on</b> the same way &mdash; <b>${ALARM_CODE}</b> then <b>Enter</b>.</div>
      </div>
      <ul style="padding-left:20px">
        <li>Check-in is no earlier than ${CHECKIN_TIME}, and check-out no later than ${CHECKOUT_TIME}.</li>
        <li>Before you head out, please take care of the checkout tasks &mdash; dishes done, trash out, windows closed, lights off, doors locked &mdash; so we can keep the cleaning fee low for everyone.</li>
        ${pay ? `<li>${pay}</li>` : ''}
      </ul>
      <p>Questions on the day? Call Amy at ${PHONE}. Safe travels &mdash; we can't wait to welcome you.</p>
      ${bless(b.name, 'r2')}`),
  };
}
// Checkout tasks and the fine (in USD) added to the bill if left undone.
// These match the house rules guests agree to on the booking page.
const CHECKOUT_TASKS = [
  ['Restack firewood inside', 20],
  ['Clean the coffee maker', 10],
  ['Close all windows', 10],
  ['Wash and put away dishes', 10],
  ['Take out the trash', 10],
  ['Turn off all lights', 10],
  ['Lock all doors', 25],
  ['Bring in the rocking chairs', 10],
];
function checkoutEmail(b) {
  const rows = CHECKOUT_TASKS.map(([task, fine]) =>
    `<tr><td style="padding:7px 0;border-bottom:1px solid #e4e9e0">${task}</td><td style="padding:7px 0;border-bottom:1px solid #e4e9e0;text-align:right;white-space:nowrap;color:#a2372a;font-weight:600">$${fine}</td></tr>`
  ).join('');
  return {
    subject: `Checkout today — please leave Selah by ${CHECKOUT_TIME}`,
    html: shell('Checkout today', `
      <p>Hello ${esc(firstName(b.name))},</p>
      <p>Today is your checkout day. Please be packed and <b>out by ${CHECKOUT_TIME}</b> so our cleaner can prepare Selah for the next guests.</p>
      <p>Before you leave, please take care of the checkout list below. Anything left undone will be added to your bill at the amount shown:</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:14px 0;font-size:14.5px">
        <tr><th style="text-align:left;padding:6px 0;border-bottom:2px solid #d6ddd2;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#54655a">Checkout task</th><th style="text-align:right;padding:6px 0;border-bottom:2px solid #d6ddd2;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#54655a">Fine if not done</th></tr>
        ${rows}
      </table>
      <p>Thank you for helping us keep Selah beautiful and the costs low for everyone. If anything comes up as you leave, call Amy at ${PHONE}.</p>
      ${bless(b.name, 'out')}`),
  };
}

module.exports = { configured, sendEmail, acceptanceEmail, reminder7Email, reminder2Email, checkoutEmail, fmtDate };
