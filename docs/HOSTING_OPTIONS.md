# Hosting options and costs

Nothing is hosted, and no paid service has been chosen. This page is for deciding. Paid
infrastructure and public deployment need the owner's decision.

**Prices** were collected on 2026-09-25 from provider docs and recent third-party pricing summaries
(sources at the end). They change often, so check them on the provider's own pricing page before
committing. EUR prices are for Hetzner's EU regions; US regions cost more.

## What we need to host

- **Catalog database:** about 70 GB for the full Discogs catalog, estimated from the real
  2025-12-01 import. Allow 100–150 GB, for indexes, growth and a monthly-update working copy.
- **App server:** Node.js with Express. Small, but it needs ~4–8 GB RAM so the database's hot pages
  stay in memory.
- **Uploads:** photos of users' copies. Small at first.
- **Backups:** the catalog can always be rebuilt from the dumps (about 2–3 h). User data (library,
  crates, listings, orders) is small but must never be lost.

## Options

| # | Setup | Monthly cost (approx.) | Good for | Main drawbacks |
|---|---|---|---|---|
| 1 | **One Hetzner server running SQLite** (as the app works today). CX33: 4 vCPU, 8 GB RAM, 80 GB disk, €6.49; plus a 150 GB volume at €0.0572/GB ≈ €8.60; plus snapshots/backups ≈ €2–4 | **≈ €17–20** | Launch and early users; a mostly-read catalog | One writer at a time; you run the server yourself. Volumes are network storage (slower than local disk), so the database may need a server with more local disk instead |
| 2 | **One Hetzner server running PostgreSQL yourself** (same hardware as 1) | **≈ €17–25** | Many simultaneous writers, cheaply | Needs the PostgreSQL port (see POSTGRES_READINESS.md). You handle updates, backups and recovery |
| 3 | **DigitalOcean managed PostgreSQL + a small app server.** Growth plan: 2 vCPU, 4 GB RAM, 60 GB, $60.90; ~90 GB extra storage at $0.115–0.21/GiB ≈ $10–19; app droplet ≈ $12–24 | **≈ $85–105** (a high-availability standby roughly doubles the database cost) | Busy site; database backups and point-in-time recovery handled for you | ~5× option 1. Needs the PostgreSQL port |
| 4 | **Neon serverless PostgreSQL + a small app server.** Storage 100 GB × $0.35 ≈ $35; compute $0.106 per CU-hour, ≈ $77 for 1 CU always on, less when idle; app server ≈ $6–24 | **≈ $50–135**, depending on traffic | Spiky or low traffic (scales to zero when idle) | Cost depends on usage, so it's harder to predict. Needs the PostgreSQL port |
| 5 | **Catalog subset** on the cheapest server (e.g. only chosen genres, or only releases users own or want). Hetzner CX23 from €5.49 | **≈ €6–10** | Cheapest possible start | Search covers only part of Discogs; needs a "fetch from the full catalog when needed" step |

## Recommendation

1. **To start: option 1**, about €20 a month.
   - The catalog is read-heavy, and SQLite serves reads well.
   - The app already runs this way, and the real-dump import is proven on it (with `--bulk`).
2. **Move to option 2 or 3** when writes get busy, meaning many simultaneous checkouts or edits.
   Option 3 if you'd rather pay to have backups and recovery handled for you.
3. **Option 5** if even €20 a month is too much at first, accepting a partial catalog.

## Not included

- **Payments:** a provider such as Stripe charges a fee per transaction. That's separate from
  hosting, and live payments need their own decision.
- **Domain and email:** roughly €1–3/month.
- **Images and bandwidth at scale:** these depend on traffic. The Discogs dumps contain no images,
  so none are hosted from them.
- **Discogs data:** free. The dumps are CC0, and there's no licence fee.

## Sources

- Hetzner pricing after the 2026 changes: [bitdoze.com](https://www.bitdoze.com/hetzner-cloud-cost-optimized-plans/), [Northflank](https://northflank.com/blog/hetzner-cloud-server-price-increases), [Hetzner price adjustment notice](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), [costgoat.com calculator](https://costgoat.com/pricing/hetzner), [wz-it.com on volumes](https://wz-it.com/en/blog/explained-and-set-up-hetzner-cloud-volumes/)
- DigitalOcean: [PostgreSQL pricing docs](https://docs.digitalocean.com/products/databases/postgresql/details/pricing/), [managed databases pricing](https://www.digitalocean.com/pricing/managed-databases), [infratally.com review](https://infratally.com/articles/digitalocean-managed-postgres-deep-dive/)
- Neon: [pricing page](https://neon.com/pricing), [selfhost.dev breakdown](https://selfhost.dev/blog/neon-pricing-cost-of-serverless-postgres/)
