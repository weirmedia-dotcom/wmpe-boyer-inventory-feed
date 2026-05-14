# WMPE — Boyer Hyundai inventory feed

Daily Node scraper that pulls Boyer Hyundai's **used** inventory from
`https://www.boyerhyundai.com/inventory/used/`, parses the JSON-LD `Car`
schemas embedded in the listing pages, pairs each car to its VDP URL via
`data-stocknumber`, and emits a Google Merchant Center **vehicle ads** feed
in TSV format.

Built 2026-05-14 after audit. ~39 used vehicles in stock at time of build.

## Files

| Path | What |
|---|---|
| `scrape_used_inventory.mjs` | The scraper. Pure Node fetch + regex, zero deps. |
| `package.json` | Node ≥20, ESM, single `scrape` script. |
| `.github/workflows/boyer-used-feed.yml` | Daily cron + publish to `gh-pages` branch. |
| `README.md` | This file. |

## Run locally

```bash
cd "WMPE-Google Ads Engine/boyer/inventory-feed"
node scrape_used_inventory.mjs ./boyer_used_feed.tsv
```

Stderr prints per-page diagnostics; stdout/file gets the TSV. Expected:

```
[scrape] page 1: 24 cars (24 new) — 24 VDP urls matched
[scrape] page 2: 15 cars (15 new) — 15 VDP urls matched
[scrape] page 3: 400 — stop
[scrape] total unique vehicles: 39
[scrape] all rows have required fields ✓
[scrape] wrote ./boyer_used_feed.tsv (39 rows, ...bytes)
```

## TSV columns

```
id  vin  store_code  dealership_name  dealership_address
price  condition  make  model  trim  year  mileage
image_link  link
body_style  fuel  engine  transmission  color  interior_color
seating_capacity  doors  drive_wheel_configuration
title  description
```

All [Google Merchant Center vehicle feed required attributes](https://support.google.com/merchants/answer/11189169)
are present.

## Deploy to GitHub Actions

The scraper is meant to run daily. Local cron on a Mac won't work reliably
because the machine has to be on. Use GitHub Actions:

1. **Push this directory to a GitHub repo.** Easiest: create a new
   private repo `weirmedia/wmpe` (or wherever you keep WMPE code) and push
   the `WMPE-Google Ads Engine/` tree.

2. **Create a `gh-pages` branch** (empty is fine):
   ```bash
   git checkout --orphan gh-pages
   git rm -rf .
   echo "boyer inventory feed" > README.md
   git add README.md && git commit -m "init gh-pages"
   git push -u origin gh-pages
   git checkout main
   ```

3. **Enable GitHub Pages** for the repo, source = `gh-pages` branch, `/` root.

4. **Confirm the workflow** in `.github/workflows/boyer-used-feed.yml` is at
   the repo root (move it if your repo layout differs). It runs daily at
   11:00 UTC (6/7 am Toronto) and on manual `workflow_dispatch`.

5. After first successful run, the feed is publicly served at:
   ```
   https://<owner>.github.io/<repo>/boyer/used_feed.tsv
   ```

## Set up in Google Merchant Center (one-time)

1. **Create / claim a Merchant Center account** for Boyer Hyundai. Use the
   same Google identity that owns Google Business Profile for the dealership.
2. **Verify website ownership** for `https://www.boyerhyundai.com` (DNS TXT
   or HTML file — GTM is already on the site so it should be straightforward).
3. **Activate vehicle ads** in MC (Marketing → Vehicle ads). Accept the
   vehicle-listings policy and link the Google Business Profile that
   represents Boyer Hyundai Pickering.
4. **Create a primary feed**:
   - Country: Canada
   - Language: English
   - Destination: Vehicle ads
   - Input method: **Scheduled fetch**
   - Fetch URL: `https://<owner>.github.io/<repo>/boyer/used_feed.tsv`
   - Frequency: daily, time = ~10 minutes after the GitHub Actions cron
5. **Link Merchant Center to Google Ads** (customer ID `9576221315`,
   Manager `2098090633`).
6. **Enable Vehicle Ads** in `Boyer Hyundai — PMax` (campaign 23760707970)
   and/or create a dedicated Used Vehicle Search campaign.

Allow 1-3 days for Google to approve the feed + start serving ads.

## Caveats

- **`itemCondition` in JSON-LD always reports `NewCondition`** — eDealer's
  Yoast schema bug. Scraper ignores that field and forces `condition = used`
  because the source path is `/inventory/used/`.
- **JSON-LD only includes 1 image per car.** Google accepts that, but the
  VDP usually has many. If you want richer creative, extend the scraper
  to fetch each VDP page and collect additional images into a
  `additional_image_link` column (pipe-separated).
- **Volume is small (~39 used vehicles).** Google's vehicle ads work best
  with ≥50 vehicles for inventory variety. Consider adding new inventory
  (`/inventory/new/`) to the feed once used is live — same scraper, swap
  the listing path + condition.
- **Landing-page-compliance** — Google's vehicle ads policy requires the
  VDP to show dealership name, address, vehicle price, VIN, and mileage
  clearly above the fold. eDealer VDPs typically comply; verify on one
  before launching ads.
- **`/inventory/used/?page=N` pagination capped at 2 pages currently.**
  Site returns HTTP 400 for `page=3+` (no inventory). Scraper auto-stops.
- **Free organic "Vehicle Listings on Google" feature is being deprecated.**
  Doesn't affect the paid Vehicle Ads / VLAs setup above.

## Maintenance notes

- If eDealer changes their HTML, the `data-stocknumber="..."` selector
  may break. Add `[scrape] WARNING — rows missing required fields` to your
  alerting if that fails.
- If Boyer's primary phone, address, or store code changes, edit the
  three constants at the top of `scrape_used_inventory.mjs`.
- To add new inventory: duplicate the script, swap `LISTING_PATH` to
  `/inventory/new/` and emit `condition = new`. Or refactor into a single
  scraper that walks both paths and emits one combined feed.
