# Product

The app is called **Stacks**. Visual branding (logo, colours) hasn't been decided.

## Who it is for

Record collectors, DJs and small sellers who keep music in several places (a Discogs
collection, a Rekordbox library, shelves of records with no export at all) and want one private
place to see, organise and eventually sell it.

## What exists in the prototype

| Area | Status |
|---|---|
| Catalog of artists, labels, companies, masters and releases | Working locally; filled by seed data or the Discogs dump importer |
| Search (title, artist, label, catalog number, barcode, accent-insensitive) | Working (SQLite FTS5) |
| Discogs collection / wantlist CSV import with preview, review, undo | Working against synthetic fixtures; **not yet verified against real exports** |
| Rekordbox XML import (tracks + playlists) | Working against synthetic fixtures; **not yet verified against real exports** |
| Manual entry of physical copies and digital files | Working |
| Unified library (physical + digital), tags, crates, Top 5 drafts | Working |
| Wantlist | Working |
| Moderated contributions (new releases, corrections, images, YouTube links) | Working |
| YouTube previews | Moderated links only. Shown as a click-to-load `youtube-nocookie` embed. No fake player controls |
| Marketplace | **Simulated**: listings, reservations, checkout and orders with no real payments |

## Rules the code enforces

- Copies are **private** and **not for sale** unless the owner lists them.
- A copy can have at most **one active listing**.
- Money is stored as **integer cents**.
- Checkout reserves copies **atomically**. Reservations **expire** (default 30 minutes), and
  checkout is **idempotent**, so a retry never creates a second order.
- Orders follow a fixed state machine, and each order stores a **snapshot** of what was bought.
- Archive changes by contributors are **proposals** that a moderator accepts or rejects.
- Imports never delete holdings because they are missing from a newer export, and never overwrite a user's edits.
- The demo account switcher only exists in development.

## What is deliberately not here

- No scraping of Discogs pages and no Discogs API use.
- No pricing or sales history. We don't hold rights to Discogs marketplace data.
- No Discogs images, since their rights aren't granted by the dumps.
- No live payments, paid accounts, or public deployment. Each of these needs an explicit decision first.

## Vocabulary

- **Master**: the shared identity of a work (e.g. an album), across all its pressings.
- **Release**: one specific pressing or edition (label, catalog number, country, format, year).
  A release may have no master.
- **Copy**: one physical item a user owns, linked to a release when known.
- **Digital holding**: one file a user owns (e.g. from Rekordbox).
- **Listing**: an offer to sell one copy (simulated).
