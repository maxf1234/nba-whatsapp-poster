# NBA Channel Poster

A tiny web page for posting to the NBA WhatsApp channel: pick a post type,
add an image, fill in the fields, hit **Post**. The caption is always built
from the same template, so every post keeps the channel's format.

It sends to your **Railway WhatsApp bot** (the same one the deal alerts use)
— `POST { image, caption }` with a bearer token. No scraping, no searching:
you type it, it posts it.

## Post types

| Type | Format |
|---|---|
| 🚨 Breaking News | `🚨 *BREAKING* 🚨` · bold headline · details · _via source_ |
| 🏀 Final Score | `🏀 *FINAL*` · both teams with bold scores · ⭐ top performer · notes |
| 🔄 Trade Alert | headline · "*Team receive:*" bullet lists for both sides · source |
| 🏥 Injury Update | player (team) · *STATUS* · injury · details |
| 📊 Stat Line | player · 🔥 stat line · context |
| ✍️ Custom | optional bold title + free text |

Every post gets `POST_FOOTER` appended. To change a format or add a new post
type, edit `public/templates.js` — the preview and the real post both use it.

## Run locally

```bash
npm start          # http://localhost:3000 (dry-run: posts are just logged)
npm test
```

No dependencies to install. Images are resized in the browser (max 1600px
JPEG) and can be picked, dragged in, or pasted from the clipboard.

## Deploy on Railway

1. New service → this repo (start command and health check come from
   `railway.json`).
2. Settings → Networking → **Generate Domain** (the bot fetches images from it).
3. Variables:

| Variable | Purpose |
|---|---|
| `WHATSAPP_BOT_URL` | Bot's send endpoint (same one the deal alerts use). Unset = dry-run. |
| `WHATSAPP_BOT_TOKEN` | Bearer token for the bot. |
| `POSTER_PASSWORD` | **Set this** — otherwise anyone with the link can post. |
| `POST_FOOTER` | Appended to every post, e.g. `📲 Follow for more NBA updates`. `\n` = new line. |
| `PUBLIC_URL` | Optional; auto-detected from `RAILWAY_PUBLIC_DOMAIN`. |

## What the bot receives

```json
{
  "image": "https://<poster-domain>/i/<uuid>",
  "caption": "🏀 *FINAL*\n\nCeltics *112*\nKnicks *108*\n\n📲 Follow…",
  "image_base64": "…",
  "mimetype": "image/jpeg"
}
```

`image` is a URL, exactly like the deal alerts. `image_base64` is sent too in
case the bot would rather not fetch over the network. Text-only posts have no
image fields. Uploaded images are kept in memory for 24h, so a redeploy clears
them (the bot fetches right away, so that's fine).

**The bot needs to send to the channel, not the deals chat.** If the bot is
hard-wired to one chat/group, give it a target (e.g. a `chatId` field or a
second endpoint) pointing at the NBA channel.
