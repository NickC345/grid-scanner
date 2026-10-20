# Grid Scanner

Type in a local business name and address. The scanner:

1. **Finds the business on Google Maps** and lets you confirm the right listing.
2. **Runs a 9 × 11 grid (99 points)** around the business and records where it ranks on Google Maps. It defaults to one keyword to keep the cost low. Choose 1, 2, 3 or 5 miles between points (2 is the default).
3. **Checks whether it is spending on ads:**
   - sponsored Google Maps pins at every grid point;
   - optionally, live Google Search ads and Local Services Ads at a 3 × 3 sample of points;
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

Every scan is saved under **Past scans**. Companies you want to pursue go into the **Pipeline**, and the ones you win move to **Clients**.

## Pipeline and clients

- **Save to pipeline:** press the button on any scan result. The company becomes a card with its mini heatmap, rank, ad and website scores.
- **Board:** New lead, Contacted, Responded, Follow up, Call scheduled, Client and Not interested. Drag cards between columns. On a phone, use the "Move to" menu on each card.
- **Call scheduled:** dropping a card here asks for the call date and time. The column is sorted by the soonest call, and past calls turn red.
- **Card details:** contact name, email, phone, notes and an activity log. Every stage change is logged.
- **Rescans:** a new scan of a saved company joins its history automatically.
- **Clients:** a card moved to Client gets a workspace with its baseline scan, starter checklists (onboarding, website redesign, Google Ads, local SEO), monthly fee, and a before and after comparison after each rescan. Starter tasks live in `lib/templates.js`; each client's list can be edited in the app.
- **Backup:** "Download backup" on the Pipeline page saves everything (companies, notes, checklists and scans) to one file. "Restore backup" merges it back.

### Where saved data lives

Saved companies are stored in `DATA_DIR` (default `./data`). On a host with a persistent disk, point `DATA_DIR` at the disk (for example `/var/data` on Render). Without a persistent disk the data is erased whenever the app restarts or updates, and the Pipeline page shows a warning.

## What it costs to run

The tool uses DataForSEO's pay-as-you-go API. The scan screen shows an estimate before each scan, and the real cost after.

| Scan | Estimated cost |
|---|---|
| 1 keyword, Economy speed, with the ad-spend lookup (default) | about $0.08 |
| 1 keyword, Fast speed | about $0.22 |
| Each extra keyword, Economy | about $0.06 |
| Live Search-ad check (optional) | about $0.02 per keyword |

- **Economy** sends the map searches in DataForSEO's queue at normal priority. Results are the same, and a scan takes a few minutes. **Fast** uses live searches, which finish in under a minute.
- The estimate uses list prices from memory. The cost shown after each scan comes from DataForSEO's own responses and is the number to trust.

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

`render.yaml` uses Render's **free plan**. The app sleeps when idle, so the first visit takes about 30 seconds, and past scans are wiped on each deploy. To keep scan history, switch to the $7/mo Starter plan: in `render.yaml`, set `plan: starter` and uncomment the `disk` block and `DATA_DIR`.

To try the hosted app before you have a DataForSEO account, set `DEMO_MODE` to `true` in Render. The DataForSEO fields can then be left blank.

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
lib/store.js        Saved companies, pipeline stages, client workspaces
lib/templates.js    Starter client checklists
lib/audit.js        Website + PageSpeed audit
lib/demo.js         Sample-data client for demo mode
public/             Web UI (scanner, pipeline board, clients; Leaflet map)
test/               node --test suite
```
