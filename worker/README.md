# Deploy the free, read-only market-data Worker

The frontend is ready, but prices work only after this Worker is deployed.
The existing market-command-api currently serves Hello World. No API
credentials belong in this repository or in frontend settings.

## One-time setup on your Mac

Use the existing Cloudflare account and Workers **Free** plan. Do not upgrade.
Node.js/npm must be installed. From a local copy of this repository:

```sh
cd worker
npx wrangler login
npx wrangler deploy
npx wrangler secret put ALPACA_API_KEY_ID
npx wrangler secret put ALPACA_API_SECRET_KEY
```

Wrangler opens Cloudflare sign-in in your own browser. Verify the deployment
is to the existing account with the jjbeastlv.workers.dev subdomain. The config
uses the existing name market-command-api and adds a SQLite Durable Object,
which is supported on Workers Free.

Each secret command prompts securely for its value. Paste the existing
Alpaca **paper-account** key and secret into those prompts, never into chat,
a file, a command argument, GitHub, or the website. Alternatively, add these
two names as encrypted Secrets in the Worker's Cloudflare Settings.
Do not regenerate working keys unless you need to rotate them.

After both secrets are saved, verify:

```sh
curl https://market-command-api.jjbeastlv.workers.dev/health
curl 'https://market-command-api.jjbeastlv.workers.dev/quotes?symbols=AAPL,SPY'
```

Health must show configured:true and tradingEnabled:false. Quotes must return
feed:iex with prices and trade timestamps. Never include secret headers in
these curl requests: the Worker attaches them only on its private upstream call.
Then reload the website, add a supported stock if needed, and check Settings.

## Behavior and limits

- One batch of up to 100 distinct US stock/ETF symbols, holdings first.
- 10-second start-to-start polling target when visible; no overlapping requests.
- Backend cache lasts 10 seconds. Concurrent identical requests are combined.
- One globally shared object caps this service at 180 requests per rolling
  60 seconds and saves that budget across restarts. Alpaca Basic documents
  200/minute; other apps using the same key still share the remaining allowance.
- Provider 429s trigger a shared 60-second cooldown; the browser also backs off.
- Only IEX is requested; no paid SIP feed, paid data service, cron, or orders.
- With one continuously visible browser: at most about 8,640 quote polls/day,
  below the free 100,000/day Worker and Durable Object request limits.
  Shared account usage and unusual public traffic can still exhaust free quotas;
  stay on the Free plan to avoid overage billing.
- CORS allows the GitHub Pages origin. CORS is not authentication. Quotes are
  publicly reachable; the aggregate cap protects the Alpaca allowance, but
  malicious traffic could deny service or exhaust Cloudflare's free quota.
- Keep this a personal research dashboard; do not assume a data redistribution
  license for commercial use.

## Preserved records and price meaning

The original market-command-v2 localStorage key, backup format, shares,
purchase costs, saved manual prices, watch notes, and journal are unchanged.
Automatic quotes are an in-memory overlay and never rewrite saved holdings.
Exported backups retain manual prices. On a reload or connection failure before
the first quote, manual prices are used. After a successful quote, an outage
retains the last observed IEX quote with its timestamp and stale label.

IEX is one exchange, not the consolidated US market. Last trades older than
two minutes are labeled stale, including after hours. Polling every ten seconds
does not ensure that a new trade exists. Unsupported symbols retain manual
prices. Bid/ask values are returned, but valuations use the last trade.

The journal is manual recordkeeping, not execution. The Worker accepts GET
and OPTIONS only, proxies one fixed data endpoint, and has no trading route,
broker-balance endpoint, or order-placement code.

## Verification

```sh
node --test worker.test.mjs
```

These tests mock Alpaca and use no real secrets or trades.
