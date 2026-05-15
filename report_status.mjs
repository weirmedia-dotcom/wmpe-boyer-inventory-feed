// WMPE — Boyer Hyundai inventory feed — daily status reporter.
//
// Runs after the scraper. Reads the new TSV, fetches yesterday's TSV from the
// public gh-pages URL, computes stats + diff (added/removed VINs, price
// changes), writes a status.html + status.json into the gh-pages working copy,
// and emails Mark via Resend (free tier).
//
// Inputs (env):
//   NEW_FEED_PATH        path to today's TSV (default: out/boyer_used_feed.tsv)
//   PUBLIC_FEED_URL      where yesterday's TSV lives (default: gh-pages URL)
//   PAGES_DIR            local checkout of gh-pages (default: pages)
//   STATUS_OK            "true" if scraper succeeded, "false" if it failed (default: true)
//   SCRAPE_LOG_TAIL      last lines of scraper log (passed in on failure)
//   GMAIL_USER           Gmail SMTP user (e.g. hello@weirmedia.ca)
//   GMAIL_APP_PASSWORD   Gmail app password (16-char, no spaces)
//   STATUS_TO            recipient address (default: mark@weirmedia.ca)
//   STATUS_FROM          From: header (default: derived from GMAIL_USER)
//
// Exit code is always 0 — reporting failure should not fail the workflow.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';

const NEW_FEED_PATH = process.env.NEW_FEED_PATH || 'out/boyer_used_feed.tsv';
const PUBLIC_FEED_URL = process.env.PUBLIC_FEED_URL || 'https://weirmedia-dotcom.github.io/wmpe-boyer-inventory-feed/boyer/used_feed.tsv';
const PAGES_DIR = process.env.PAGES_DIR || 'pages';
const STATUS_OK = (process.env.STATUS_OK || 'true') === 'true';
const SCRAPE_LOG_TAIL = process.env.SCRAPE_LOG_TAIL || '';
const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';
const STATUS_TO = process.env.STATUS_TO || 'mark@weirmedia.ca';
const STATUS_FROM = process.env.STATUS_FROM || (GMAIL_USER ? `Boyer Feed Bot <${GMAIL_USER}>` : '');

const now = new Date();
const stamp = now.toISOString();
const localDate = now.toLocaleString('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' });

function parseTsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split('\t');
  const rows = lines.slice(1).map(l => {
    const cells = l.split('\t');
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] || ''; });
    return row;
  });
  return { headers, rows };
}

function priceNum(s) {
  const m = String(s || '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

function mileageNum(s) {
  const m = String(s || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function fmt(n, suffix = '') {
  return Number.isFinite(n) ? n.toLocaleString('en-CA') + suffix : '–';
}

function fmtMoney(n) {
  return '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

let newRows = [], newErr = null;
try {
  const text = readFileSync(NEW_FEED_PATH, 'utf8');
  newRows = parseTsv(text).rows;
} catch (e) {
  newErr = e.message;
}

let oldRows = [];
try {
  const r = await fetch(PUBLIC_FEED_URL, { cache: 'no-store' });
  if (r.ok) oldRows = parseTsv(await r.text()).rows;
} catch (_) { /* first run — no prior */ }

// --- Stats on new feed ---
const total = newRows.length;
const prices = newRows.map(r => priceNum(r.price)).filter(p => p > 0);
const mileages = newRows.map(r => mileageNum(r.mileage)).filter(m => m > 0);
const totalValue = prices.reduce((a, b) => a + b, 0);
const avgPrice = prices.length ? totalValue / prices.length : 0;
const avgMileage = mileages.length ? mileages.reduce((a, b) => a + b, 0) / mileages.length : 0;

const byModel = {};
for (const r of newRows) {
  const k = r.model || '(unknown)';
  byModel[k] = (byModel[k] || 0) + 1;
}
const modelTopList = Object.entries(byModel).sort((a, b) => b[1] - a[1]);

// --- Diff vs yesterday ---
const oldByVin = new Map(oldRows.map(r => [r.vin, r]));
const newByVin = new Map(newRows.map(r => [r.vin, r]));
const added = newRows.filter(r => r.vin && !oldByVin.has(r.vin));
const removed = oldRows.filter(r => r.vin && !newByVin.has(r.vin));
const priceChanges = [];
for (const [vin, n] of newByVin) {
  const o = oldByVin.get(vin);
  if (!o) continue;
  const np = priceNum(n.price), op = priceNum(o.price);
  if (np && op && np !== op) priceChanges.push({ vin, title: n.title, model: n.model, year: n.year, was: op, now: np });
}

// --- Build email content ---
const ok = STATUS_OK && !newErr && total > 0;
const subject = ok
  ? `✅ Boyer feed ${localDate} — ${total} used vehicles`
  : `❌ Boyer feed ${localDate} — FAILED`;

let text = '';
text += `Boyer Hyundai used inventory feed — ${stamp}\n`;
text += `Status: ${ok ? 'SUCCESS' : 'FAILED'}\n`;
text += `Feed URL: ${PUBLIC_FEED_URL}\n\n`;

if (!ok) {
  text += `--- ERROR ---\n`;
  if (newErr) text += `read error: ${newErr}\n`;
  if (SCRAPE_LOG_TAIL) text += `scraper log tail:\n${SCRAPE_LOG_TAIL}\n`;
  text += `\n`;
} else {
  text += `--- TODAY'S INVENTORY ---\n`;
  text += `Total vehicles: ${total}\n`;
  text += `Total inventory value: ${fmtMoney(totalValue)}\n`;
  text += `Average price: ${fmtMoney(avgPrice)}\n`;
  text += `Average mileage: ${fmt(Math.round(avgMileage))} km\n\n`;
  text += `By model:\n`;
  for (const [model, n] of modelTopList) text += `  ${String(n).padStart(3)} × ${model}\n`;
  text += `\n`;

  text += `--- DIFF vs YESTERDAY ---\n`;
  text += `Added: ${added.length}\n`;
  for (const r of added.slice(0, 10)) text += `  + ${r.year} ${r.title || (r.make + ' ' + r.model)}  ${r.price}  vin=${r.vin}\n`;
  if (added.length > 10) text += `  …and ${added.length - 10} more\n`;
  text += `Removed (sold or pulled): ${removed.length}\n`;
  for (const r of removed.slice(0, 10)) text += `  − ${r.year} ${r.title || (r.make + ' ' + r.model)}  ${r.price}  vin=${r.vin}\n`;
  if (removed.length > 10) text += `  …and ${removed.length - 10} more\n`;
  text += `Price changes: ${priceChanges.length}\n`;
  for (const p of priceChanges.slice(0, 10)) {
    const dir = p.now < p.was ? '↓' : '↑';
    text += `  ${dir} ${p.year} ${p.model} ${fmtMoney(p.was)} → ${fmtMoney(p.now)} (${p.now > p.was ? '+' : '-'}${fmtMoney(Math.abs(p.now - p.was))})  vin=${p.vin}\n`;
  }
  if (priceChanges.length > 10) text += `  …and ${priceChanges.length - 10} more\n`;
  text += `\n`;

  text += `--- HEALTH ---\n`;
  const missingFields = { vin: 0, price: 0, mileage: 0, link: 0, image_link: 0 };
  for (const r of newRows) for (const k of Object.keys(missingFields)) if (!r[k]) missingFields[k]++;
  const missingSummary = Object.entries(missingFields).filter(([_, n]) => n > 0).map(([k, n]) => `${n}× ${k}`).join(', ') || 'all required fields present ✓';
  text += `Required-field gaps: ${missingSummary}\n`;
}

text += `\n— WMPE Feed Bot (Mac Mini self-hosted runner)\n`;

// HTML version (basic)
const htmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:680px;margin:24px auto;padding:0 16px;">
<h2 style="margin:0 0 4px">${ok ? '✅' : '❌'} Boyer used inventory feed — ${localDate}</h2>
<p style="color:#666;margin:0 0 16px">${htmlEsc(stamp)} · <a href="${htmlEsc(PUBLIC_FEED_URL)}">feed.tsv</a></p>
<pre style="background:#f6f8fa;padding:12px;border-radius:6px;font-size:12px;white-space:pre-wrap">${htmlEsc(text)}</pre>
</body></html>`;

// --- Write status files into gh-pages ---
try {
  mkdirSync(join(PAGES_DIR, 'boyer'), { recursive: true });
  writeFileSync(join(PAGES_DIR, 'boyer', 'status.html'), html);
  writeFileSync(join(PAGES_DIR, 'boyer', 'status.json'), JSON.stringify({
    ok, stamp, localDate, total, totalValue, avgPrice, avgMileage,
    added: added.length, removed: removed.length, priceChanges: priceChanges.length,
    byModel,
  }, null, 2));
  console.log(`[report] wrote status.html + status.json to ${PAGES_DIR}/boyer/`);
} catch (e) {
  console.log(`[report] WARN: could not write status files: ${e.message}`);
}

// --- Send email via Gmail SMTP ---
if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.log('[report] GMAIL_USER / GMAIL_APP_PASSWORD not set — skipping email send. Subject would have been:');
  console.log('  ' + subject);
  process.exit(0);
}

try {
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,            // STARTTLS
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  const info = await transporter.sendMail({
    from: STATUS_FROM,
    to: STATUS_TO.split(',').map(s => s.trim()).filter(Boolean),
    subject,
    text,
    html,
  });
  console.log(`[report] email sent: messageId=${info.messageId} accepted=${(info.accepted||[]).join(',')} rejected=${(info.rejected||[]).join(',')}`);
} catch (e) {
  console.log(`[report] email FAILED: ${e.message}`);
}

console.log('[report] done.');
