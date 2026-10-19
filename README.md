# Grid Scanner

Type in a local business name and address. The scanner:

1. **Finds the business on Google Maps** and lets you confirm the right listing.
2. **Runs a 9 × 11 grid (99 points)** around the business and records where it ranks on Google Maps for each keyword. Choose 0.5, 1 or 2 miles between points.
3. **Checks whether it is spending on ads:**
   - sponsored Google Maps pins at every grid point;
   - Google Search ads and Local Services Ads at a 3 × 3 sample of points;
   - ad history from Google's Ads Transparency Center;
   - estimated monthly ad spend and the keywords it bids on (DataForSEO Labs).
4. **Scores likely wasted spend:**
   - no conversion or call tracking;
   - ads landing on the homepage;
   - paying for "jobs" and "DIY" searches;
   - slow mobile pages;
   - weak reviews and other drags on conversion.
5. **Audits the website:**
   - mobile speed (Google PageSpeed);
   - tap-to-call, forms and calls to action;
   - reviews and trust signals;
   - schema markup and tracking tags.

Every scan is saved under **Past scans**.

## What it costs to run

The tool uses DataForSEO's pay-as-you-go API. Typical cost per scan:

| Scan | Approx. cost |
|---|---|
| 1 keyword, 99 points + ad checks + spend lookup | ~$0.24 |
| 5 keywords (default) | ~$1.12 |

The app shows an estimate before each scan and the actual cost after.

## Try it locally with sample data

```bash
npm install
npm run demo        # opens on http://localhost:3000, password: demo
```

Demo mode uses obviously fake sample data and makes no API calls.

## Run it for real

1. Create a DataForSEO account at dataforseo.com and add funds ($50 minimum). Copy your **API login and API password** from Dashboard → API Access. These are not your website login.
2. Copy `.env.example` to `.env` and fill in `APP_PASSWORD`, `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD`.
3. Start the app:
   ```bash
   npm install
   npm start
   ```

### Hosting so you can reach it from anywhere (Render)

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, then pick the repo. It reads `render.yaml`.
3. Enter `APP_PASSWORD`, `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` when asked.
4. Open the `.onrender.com` URL and sign in with your password.

`render.yaml` uses the $7/mo Starter plan with a 1 GB disk so scan history survives restarts. On the free plan, remove the `disk` block and `DATA_DIR`. It still works, but the app sleeps when idle and past scans are wiped on each deploy.

The same app runs anywhere Node 18+ runs (Railway, Fly.io, a VPS) with the same environment variables.

## How to read the results

- **Rank pins:**
  - green = top 3;
  - yellow = 4–10;
  - orange = 11–20;
  - red = not in the top 20.
  - A blue **$** badge means their sponsored Maps listing showed at that point.
- **Avg Maps rank** counts "not in top 20" as 21, the usual convention for grid rank tools.
- **Spending on ads:**
  - **Yes** means ads were seen live during the scan, or Ads Transparency shows ads in the last 30 days.
  - **Likely** means there is evidence of ad spend, but no ads were seen during this scan.
- **Estimated monthly spend** comes from DataForSEO's keyword data. Treat it as a ballpark. Nobody outside the account can see real budgets or Quality Scores.
- **Likely waste** is a 0–100 sales signal built from what is visible from outside. It is not an audit of their Google Ads account.

## Notes

- The tool only reads search results through the API. It never clicks anyone's ads.
- Search ads are personalized and vary through the day. Scan at different times to see when budgets run out.
- If a grid point lands in the bay, it is still searched. Google answers as if the searcher stood there.

## Project layout

```
server.js           Express app, login, scan jobs, history
lib/grid.js         9x11 grid math
lib/dataforseo.js   DataForSEO API client
lib/scan.js         Scan orchestration
lib/analysis.js     Rank stats, spend verdict, waste score
lib/audit.js        Website + PageSpeed audit
lib/demo.js         Sample-data client for demo mode
public/             Web UI (Leaflet map)
test/               node --test suite
```
