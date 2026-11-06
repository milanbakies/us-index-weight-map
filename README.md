# US Index Weight Map

A tiny local dashboard that turns the biggest U.S. index holdings into a live treemap.

Tile size = index weight. Color = how much each stock moved. Switch between **S&P 500**, **Nasdaq-100**, and **Dow Jones**, and flip the change window from **past day** through **past year**. When the regular session is closed, it also shows **pre-market / after-hours** moves vs the last regular close, plus whether the U.S. market is open, in extended hours, or closed.

No accounts. No API keys. One Node process.

## Run it

Requires [Node.js](https://nodejs.org/) 18+.

```bash
cd index-dashboard
npm start
```

Then open [http://127.0.0.1:8787](http://127.0.0.1:8787).

**macOS:** you can also double-click `Launch Index Dashboard.command` (first time: right-click → Open).

## What you get

- Top ~20 names per index, with full company names (Tesla, not TSLA)
- Live % change for day / week / month / quarter / 6 months / year
- Market status: open · pre-market · after hours · closed
- Extended-hours % after the regular close
- Auto-refresh while the page is open

## Notes

- Prices come from Yahoo Finance’s unofficial chart API.
- Index weights are a static SPY / QQQ / DIA snapshot — useful for shape, not a live reconstitution feed.
- Not investment advice. For friends, demos, and curiosity.

Built as a vibe-coded side tool: small, local, and meant to be shared.
