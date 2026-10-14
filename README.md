# Morrow Studio

A sourcing studio for a leather-jacket brand. An **n8n** workflow hunts eBay, Etsy, Google Shopping and any shop website you add; the dashboard scores what it finds, removes duplicates, and lets the team approve, compare, board and push the best pieces to Shopify.

Built and running in production for the Morrow brand: Node.js, PostgreSQL, Docker, Traefik, n8n and an on-server CLIP vision model.

## What it does

**Hunting (n8n)**
- One run reads eBay, Etsy and up to dozens of shop websites in parallel (sitemaps → product pages, 4 pages at a time per site), so a 10-site hunt takes minutes instead of 12+.
- **Reviews-first scoring:** jackets with the most real customer reviews rank highest, then sales signals, price fit and photo quality.
- **Fair share:** every source gets a quota, so one big shop can't fill a whole hunt (default 20 jackets per run).
- A leather filter rejects faux leather, PU and "leather-look" listings by title and description.
- Live progress, a **Stop** button that works mid-run, and a watchdog that marks stuck runs.

**Never the same jacket twice**
- Products are matched by source id, a content hash (title + image id) and a 256-bit **perceptual photo fingerprint** (dHash), so the same jacket listed on two sites, or re-uploaded with a new URL, is caught.
- Guards against false matches: placeholder "no image" pictures, low-detail images and shared stock photos are ignored. Duplicates are never auto-deleted once someone has reviewed the jacket.

**Photo AI (CLIP, runs on the server)**
- Checks that each photo really shows a leather jacket and detects style and colour.
- Photo search ("find jackets like this picture") and taste learning from what the team approves.

**Team workspace**
- Review queue with keyboard and swipe, compare view, boards with read-only client share links (no costs or margins exposed), comments and notes.
- **Per-person permissions** with a checkbox grid (view, review, edit, run hunts, settings, team, backups, Shopify ...) and presets.
- Live updates over Server-Sent Events, notifications, an activity log, and an installable PWA that works offline.

**Business tools**
- Profit calculator, weekly report, interactive insight charts (sources, price bands, competitors, trends).
- **Price watcher:** price drops, sell-outs and restocks, with currency and variant checks so a different size or currency is never reported as a "drop".
- One-click **Shopify draft** with resized photos, tags and a calculated selling price.
- Scheduled daily backups (database + photos), one-click restore, health page.

## Architecture

```
 n8n workflow ──(X-Ingestion-Key)──▶ Node.js server ──▶ PostgreSQL (one table per entity, JSONB rows)
   eBay / Etsy / sitemaps                │                    products, runs, users, boards, ...
   Google Shopping / Trends              ├──▶ data/media  (photos, WebP thumbnails)
                                         ├──▶ CLIP vision model (@huggingface/transformers)
                                         └──▶ Browser SPA (ES modules, SSE, service worker)
```

- **Server:** plain Node.js `http` (no framework), feature modules in `lib/` sharing one context.
- **Storage:** PostgreSQL. The app works on an in-memory copy and writes back only the rows that changed, in one transaction; each table has readable columns (title, status, price ...) for browsing in pgAdmin. Without `DATABASE_URL` it falls back to a single `data/db.json` file for local development.
- **Security:** scrypt passwords, login rate limits per user and per IP, timing-safe key checks, SSRF-safe image fetching (private IPs and redirects blocked), escaped output everywhere, permission checks on every route.
- **Frontend:** vanilla JS, no build step; auto-fit zoom for large screens; light and dark themes.

## Run it

```bash
npm install
cp .env.example .env      # set DASHBOARD_PASSWORD and INGEST_KEY at least
node server.js            # http://localhost:4300
```

Or with Docker (behind Traefik, see `docker-compose.yml`):

```bash
docker compose up -d --build
```

### n8n

1. Import `n8n/morrow-studio.workflow.json`.
2. Put your `INGEST_KEY` in the **Authorized?** node (replace `CHANGE_ME_INGEST_KEY`).
3. Add your eBay (Basic Auth) and Etsy (Header Auth `x-api-key`) credentials and activate the workflow.
4. In the dashboard, **Settings → Hunting**: set the n8n webhook URL and the dashboard URL as n8n sees it.

## Project layout

| Path | What |
| --- | --- |
| `server.js` | HTTP server, ingest, products, hunts, media, thumbnails |
| `lib/pgstore.js` | PostgreSQL storage (load, diff-based save, import, restore) |
| `lib/intel.js` | Duplicate detection, photo fingerprints, embeddings, photo search, profit |
| `lib/users.js`, `lib/perms.js` | Accounts, sessions, permissions |
| `lib/boards.js` | Boards, client share links, Shopify drafts |
| `lib/watch.js` | Price and stock watcher |
| `lib/ops.js` | Scheduler, backups, restore, health, daily summary |
| `lib/insights.js` | Reports and charts data |
| `vision.js` | CLIP model: leather check, style, colour, embeddings |
| `public/` | The single-page app |
| `n8n/` | The hunt workflow |
