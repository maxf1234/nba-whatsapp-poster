# NBA Channel Poster

A tiny web page for posting to the NBA WhatsApp channel: pick a post type,
add a photo or video, fill in the fields, then **Add to queue** or **Post now**. The
caption is always built from the same template, so every post keeps the
channel's format.

## The queue

Load up a batch of posts (say ten) and they go out **one at a time** on a
schedule you set on the page:

- **Send one every** 30 min · 1 h · 1.5 h · 2 h · 3 h · 4 h · 6 h · 8 h · 12 h
- **Active hours**, e.g. 9 AM – 11 PM (in `TIMEZONE`): nothing goes out
  overnight; the next post waits for the morning.
- **Set an exact time** for any post: fill in **Send at** before adding it,
  or tap **⏰ Set time** on a queued post (📌 marks posts with a set time).
  Set times go out exactly then — even outside the active hours — and don't
  shift the other posts. **Use queue spacing** puts a post back in line.
- Each queued post shows when it will go out. Move it ↑/↓, delete it, or
  **Send now**. **Pause** stops the queue (set times included) without
  losing anything.
- The first post goes out right away (if inside active hours); each next one
  goes out one interval after the last post, including posts sent with
  **Post now** from the queue.
- The queue is saved on the Railway volume, so redeploys don't lose it. If a
  send fails (e.g. WhatsApp reconnecting), the post stays first in line and is
  retried 5 minutes later; the error shows on the page.

## Photos and videos

- **Photos keep their shape.** For channels, WhatsApp doesn't measure the
  picture itself, so without help it shows a square crop. The server measures
  every photo and sends its real width/height and a thumbnail with it.
  Photos are shrunk in the browser to 1600 px on the long side first.
- **Videos** (up to 100 MB) — iPhone `.mov` included. The server converts them
  with ffmpeg to H.264/AAC MP4, the format WhatsApp plays everywhere (long
  side ≤ 1280 px), and adds the length and a thumbnail. Videos that are
  already MP4/H.264 are only repackaged, which is instant; others take a bit
  (roughly as long as the clip on Railway's small machines).

It's its own WhatsApp bot: it links to a WhatsApp account once (with a
pairing code shown on the page) and posts straight to the channel. It uses
Baileys, the same library as the DealsPulse bot, but it runs separately, so
neither one can break the other. No scraping, no searching: you type it, it
posts it.

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
type, edit `public/templates.js`. The preview and the real post both use it.

## Deploy on Railway

1. **New service** → this repo. It builds from the `Dockerfile` (health check
   comes from `railway.json`).
2. **Add a volume** to the service, mounted at **`/data`**. This stores the
   WhatsApp login and the queue. Without it, every redeploy logs WhatsApp out
   and empties the queue.
3. Settings → Networking → **Generate Domain**.
4. **Variables:**

| Variable | Value |
|---|---|
| `WHATSAPP_CHANNEL` | Optional. Default channel link; normally you set the channel on the page instead (step 6). |
| `POSTER_PASSWORD` | A password you make up. **Set this**, or anyone with the link can post. |
| `POST_FOOTER` | Optional. Added to every post, e.g. `📲 Follow for more NBA updates`. `\n` = new line. |
| `TIMEZONE` | Optional. Time zone for the active hours, default `America/New_York` (e.g. `America/Los_Angeles`, `Europe/London`). |
| `DRY_RUN` | Optional. `1` = log posts instead of sending (for testing the formatting). |

5. **Link WhatsApp (one time):** open the page, enter the password, and in the
   **WhatsApp** card type the phone number (with country code) of the account
   that **owns or admins the channel** → **Get pairing code**. On that phone:
   WhatsApp → Linked devices → Link a device → *Link with phone number
   instead* → type the code. The card turns 🟢.
6. **Set the channel:** in WhatsApp open the channel → tap its name →
   **Share** → **Copy link**, paste it in the card's **Channel to post to**
   box → **Save channel**. The page looks the channel up and shows its name
   and whether the linked account can post there (✅ owner/admin, ❌ only a
   follower). It's saved on the volume, so this is one-time too; paste a
   different link any time to switch channels.

If the phone ever unlinks it (Linked devices → Log out), the page goes back
to 🔴 and you just pair again.

## Run locally

```bash
npm install
DRY_RUN=1 npm start   # http://localhost:3000
npm test
```

Locally the WhatsApp login, the queue and uploads are stored in `./data`
(git-ignored). Photo/video handling needs `ffmpeg` installed (the Docker
image has it); without it, photos still post but may show square-cropped,
and videos are refused.
