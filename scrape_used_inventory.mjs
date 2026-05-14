// WMPE — Boyer Hyundai — used inventory scraper → Google Merchant Center vehicle feed.
//
// Crawls https://www.boyerhyundai.com/inventory/used/?page=N until empty, extracts
// each car's JSON-LD Car schema + its VDP URL (paired by stocknumber), and emits
// a TSV file matching the Google Merchant Center Vehicle Ads feed spec.
//
// JSON-LD itemCondition is unreliable (eDealer's Yoast schema marks every car as
// NewCondition); we ignore that field and force condition='used' since the source
// path is /inventory/used/.
//
// Usage: node scrape_used_inventory.mjs [out_path]
//        Default out path: ./boyer_used_feed.tsv
//
// No external deps. Pure Node fetch + regex.

import { writeFileSync } from 'node:fs';

const BASE = 'https://www.boyerhyundai.com';
const LISTING_PATH = '/inventory/used/';

const STORE_CODE = 'boyer-hyundai-pickering';
const DEALERSHIP_NAME = 'Boyer Hyundai';
const DEALERSHIP_ADDRESS = '775 Kingston Road, Pickering, ON L1V 1A2, CA';
// Cloudflare on boyerhyundai.com blocks bot-shaped UAs coming from datacenter
// IPs (e.g. GitHub Actions runners). Pose as real Chrome + standard browser
// headers + retry briefly on transient 403/429/503.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-CA,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

const MAX_PAGES = 20;
const OUT_PATH = process.argv[2] || './boyer_used_feed.tsv';

async function fetchHtml(url, attempt = 1) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) {
    if ([403, 429, 503].includes(r.status) && attempt < 3) {
      await new Promise(res => setTimeout(res, 2000 * attempt));
      return fetchHtml(url, attempt + 1);
    }
    const e = new Error(`${r.status} ${url}`);
    e.status = r.status;
    throw e;
  }
  return await r.text();
}

function collectCars(obj, out = []) {
  if (obj && typeof obj === 'object') {
    if (obj['@type'] === 'Car') out.push(obj);
    for (const v of Object.values(obj)) collectCars(v, out);
  }
  return out;
}

function extractCars(html) {
  const cars = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      collectCars(JSON.parse(m[1].trim()), cars);
    } catch (_) { /* malformed JSON-LD block */ }
  }
  return cars;
}

// Find each card's VDP URL by scanning for data-stocknumber="<SKU>" then the
// nearest preceding/following <a href="/inventory/...vdp">.
function extractVdpBySku(html) {
  const map = new Map();
  const stockRe = /data-stocknumber="([^"]+)"/g;
  let m;
  while ((m = stockRe.exec(html)) !== null) {
    const sku = m[1];
    const start = Math.max(0, m.index - 3000);
    const end = Math.min(html.length, m.index + 3000);
    const window = html.slice(start, end);
    const vdpMatch = window.match(/href="(\/inventory\/[^"]+vdp[^"]*)"/);
    if (vdpMatch) map.set(sku, BASE + vdpMatch[1]);
  }
  return map;
}

function priceCell(car) {
  const p = car.offers?.price;
  if (typeof p !== 'number') return '';
  const cur = (car.offers?.priceCurrency || 'CAD').toUpperCase();
  return `${p.toFixed(2)} ${cur}`;
}

function mileageCell(car) {
  const v = car.mileageFromOdometer?.value;
  if (typeof v !== 'number') return '';
  const u = car.mileageFromOdometer?.unitCode === 'SMI' ? 'mi' : 'km';
  return `${Math.round(v)} ${u}`;
}

function deriveTrim(car) {
  // vehicleConfiguration ex: "Ultimate AWD SUV" — first token is trim.
  // Some entries have "Preferred" or trim like "N Line"; treat the first 1-2 tokens
  // as trim (until we hit a body word). For v1, take everything before known body words.
  const cfg = (car.vehicleConfiguration || '').trim();
  if (!cfg) return '';
  const stopWords = new Set(['AWD', 'FWD', 'RWD', '4WD', '4X4', 'SUV', 'Sedan', 'Hatchback', 'Coupe', 'Truck', 'Van', 'Wagon']);
  const tokens = cfg.split(/\s+/);
  const out = [];
  for (const t of tokens) {
    if (stopWords.has(t)) break;
    out.push(t);
  }
  return out.join(' ');
}

function tsvEsc(v) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[\t\r\n]/g, ' ').trim();
}

const FEED_HEADERS = [
  // required (Google Merchant Center vehicle feed spec)
  'id', 'vin', 'store_code', 'dealership_name', 'dealership_address',
  'price', 'condition', 'make', 'model', 'trim', 'year', 'mileage',
  // strongly recommended
  'image_link', 'link',
  // optional / improves match quality
  'body_style', 'fuel', 'engine', 'transmission', 'color', 'interior_color',
  'seating_capacity', 'doors', 'drive_wheel_configuration',
  // descriptive
  'title', 'description',
];

function carToRow(car, vdpUrl) {
  return {
    id: car.sku || car.vehicleIdentificationNumber || '',
    vin: car.vehicleIdentificationNumber || '',
    store_code: STORE_CODE,
    dealership_name: DEALERSHIP_NAME,
    dealership_address: DEALERSHIP_ADDRESS,
    price: priceCell(car),
    condition: 'used',
    make: car.brand?.name || '',
    model: car.model || '',
    trim: deriveTrim(car),
    year: car.vehicleModelDate || '',
    mileage: mileageCell(car),
    image_link: Array.isArray(car.image) ? car.image[0] : (car.image || ''),
    link: vdpUrl || `${BASE}${LISTING_PATH}`,
    body_style: car.bodyType || '',
    fuel: car.vehicleEngine?.fuelType || '',
    engine: car.vehicleEngine?.name || '',
    transmission: car.vehicleTransmission || '',
    color: car.color || '',
    interior_color: car.vehicleInteriorColor || '',
    seating_capacity: car.vehicleSeatingCapacity || '',
    doors: car.numberOfDoors || '',
    drive_wheel_configuration: (car.driveWheelConfiguration || '').split('/').pop().replace(/^schema.org/, '') || '',
    title: car.name || '',
    description: (car.description || '').replace(/\s+/g, ' ').trim().slice(0, 5000),
  };
}

async function main() {
  console.error(`[scrape] starting at ${new Date().toISOString()}`);
  const seenSkus = new Set();
  const rows = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${BASE}${LISTING_PATH}?page=${page}`;
    let html;
    try {
      html = await fetchHtml(url);
    } catch (e) {
      if (e.status === 400 || e.status === 404) {
        console.error(`[scrape] page ${page}: ${e.status} — stop`);
        break;
      }
      throw e;
    }
    const cars = extractCars(html);
    if (cars.length === 0) {
      console.error(`[scrape] page ${page}: 0 cars — stop`);
      break;
    }
    const vdpMap = extractVdpBySku(html);
    let newOnPage = 0;
    for (const car of cars) {
      const sku = car.sku || car.vehicleIdentificationNumber;
      if (!sku || seenSkus.has(sku)) continue;
      seenSkus.add(sku);
      rows.push(carToRow(car, vdpMap.get(sku) || ''));
      newOnPage++;
    }
    console.error(`[scrape] page ${page}: ${cars.length} cars (${newOnPage} new) — ${vdpMap.size} VDP urls matched`);
  }

  console.error(`[scrape] total unique vehicles: ${rows.length}`);

  // QA — flag rows missing required fields
  const missingByField = {};
  const required = ['vin', 'price', 'make', 'model', 'year', 'mileage', 'link', 'image_link'];
  for (const r of rows) {
    for (const k of required) {
      if (!r[k]) missingByField[k] = (missingByField[k] || 0) + 1;
    }
  }
  if (Object.keys(missingByField).length) {
    console.error(`[scrape] WARNING — rows missing required fields: ${JSON.stringify(missingByField)}`);
  } else {
    console.error('[scrape] all rows have required fields ✓');
  }

  // Emit TSV
  const lines = [FEED_HEADERS.join('\t')];
  for (const r of rows) lines.push(FEED_HEADERS.map(h => tsvEsc(r[h])).join('\t'));
  const out = lines.join('\n') + '\n';
  writeFileSync(OUT_PATH, out);
  console.error(`[scrape] wrote ${OUT_PATH} (${rows.length} rows, ${out.length} bytes)`);
}

main().catch(err => {
  console.error('[scrape] FATAL:', err);
  process.exit(1);
});
