# Live-times relay

TUA's live API doesn't send CORS headers, so a web page on another site can't read it.
This Cloudflare Worker fetches it and adds them.

## Deploy (free Cloudflare account, about 10 minutes)

Easiest, in the browser:
1. Sign in at https://dash.cloudflare.com, open **Workers & Pages**, **Create**, **Create Worker**.
2. Name it `goviedo-relay` (any name works) and click **Deploy**.
3. Click **Edit code**, replace everything with `worker.js` from this folder, and click **Deploy**.
4. Open `https://goviedo-relay.<your-subdomain>.workers.dev/estimaciones/5019`.
   - JSON with `estimaciones`: it works. Put the base URL in `public/config.json` as
     `"liveRelay": "https://goviedo-relay.<your-subdomain>.workers.dev/estimaciones/"`.
   - An error mentioning bot protection: TUA blocks Cloudflare, so use a home relay instead.

Or from a terminal: `npx wrangler deploy` in this folder.
