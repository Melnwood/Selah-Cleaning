# SELAH — Cabin & Apartment web interfaces

Single-page interfaces on top of the **Cabin & Apartment Cleaning Tracker** Airtable base, wired to Airtable through a secure Netlify function so the token never touches the browser. Every page has a **CZ / EN** toggle (Czech default; choice is remembered and shared across pages).

| Page | URL | Who | What it does |
|---|---|---|---|
| Cleaning report | `/cleaner` | Cleaners (phone) | Replaces Fillout. Collapsible areas, single-tap "Ano/Yes" checklist, live pay total, creates a completed record. |
| Payments | `/payments` | You / manager | Cleanings grouped by month with a **total at the end of each month**, a **Paid** toggle per cleaning, and an "owed vs paid" summary. Tap a cleaning to see what was cleaned. |
| Work orders | `/maintenance` | Maintenance person | Every flagged repair as a work order: status, priority, assignee, "what was repaired", and a running **updates log** (timestamped history). In English mode, the cleaner’s Czech text (reported problem, notes, updates) is auto-translated. |

`/` is a hub linking all three. `/dashboard` redirects to `/payments`.

## Deploy on Netlify
1. Push this folder to a Git repo and import it in Netlify (`netlify.toml` sets publish `public` + functions dir).
2. Environment variables:
   - `AIRTABLE_TOKEN` — personal access token with `data.records:read` + `data.records:write` on the base.
   - *(optional)* `ACCESS_CODE` — passphrase; if set, pages ask for it once. Leave unset to keep open.
   - *(optional)* `ANTHROPIC_API_KEY` — enables on-the-fly English translation of the cleaner’s Czech text on the Work orders page. Without it, the original Czech is shown. `ANTHROPIC_MODEL` optionally overrides the default model.
   - `AIRTABLE_BASE_ID` / `AIRTABLE_TABLE_ID` default to this base.
3. Deploy — no build step.

Local preview: `npm i -g netlify-cli` then `netlify dev` (set the same env vars).

## Data model notes
- **Pay** = checked room/window prices + a flat 200 Kč base (Airtable `Total Amount Owed`). The cleaner is paid this in full.
- **Fines** = 100–500 Kč per missed closing-checklist item (Airtable `Fines`). **These are charged to the guests, not the cleaner** — they never reduce her pay. Shown as guest fines in the cleaning detail only.
- Pages write by **field ID**, so renaming fields in Airtable won't break them.

## Fields added for this build (on `Cleanings`)
Cleaner: `Uklízeč/ka (Cleaner)`.
Maintenance: `Stav opravy (Maintenance Status)`, `Priorita (Priority)`, `Přiděleno (Assigned To)`, `Datum vyřešení (Resolved Date)`, `Pozn. k opravě (Resolution Notes)`, `Průběh oprav (Updates)`.
Payments: `Zaplaceno (Paid)`, `Datum platby (Paid Date)`.

## Open item
- `French doors` is priced at **8 Kč** vs 45–225 for comparable items — likely a typo for 80. Unchanged; fix in the Airtable `Total Amount Owed` formula + the room config in `cleaner.html`/`payments.html` if intended.
