# RosterWarden sync worker

A Cloudflare Worker that stores each device's **encrypted** RosterWarden database.

It is a dumb blob store. It takes an opaque lump of bytes under an opaque id
and hands it back on request. It has no idea what a roster is, and **it cannot
read anything it holds** — the app encrypts everything on the device, and the
key never leaves it.

That is the point. Hosting other people's staff names and availability would
make you responsible for them. Hosting ciphertext you cannot decrypt does not.

It also does one small job for Planning Center sign-in: `POST /pco/token` and
`POST /pco/refresh` add the app's client secret to a token request and pass
Planning Center's answer straight back. Nothing is stored, and roster data never
comes through here (the app calls Planning Center's API directly).

## Planning Center (optional)

1. Register an app at <https://api.planningcenteronline.com/oauth/applications>
   (callback URLs: the site's address, and `http://localhost:8123/` for testing).
2. Put its client id in `wrangler.toml` under `[vars]` as `PCO_CLIENT_ID`, and in
   the app's `js/config.js`.
3. Store the secret on Cloudflare, never in a file:

   ```bash
   npx wrangler secret put PCO_CLIENT_SECRET
   ```

4. `npx wrangler deploy`.

Until both are set, the endpoints answer `501` and the app's Planning Center
card says it isn't set up.

## What it costs

Nothing, at this scale, and it cannot surprise you with a bill:

| | Free allowance | What you'd use |
|---|---|---|
| Worker requests | 100,000/day | a few dozen |
| D1 storage | 5 GB | a few KB per person |
| D1 writes | 100,000/day | a few dozen |

The Cloudflare free plan has no card on file and does not overage-bill — it
stops at the limit rather than charging you. That is the main reason this sits
here rather than on AWS.

## Setting it up

You need a free Cloudflare account. No domain, no credit card.

```bash
# 1. Sign up at https://dash.cloudflare.com/sign-up   (free plan is fine)

# 2. From this folder, log in. It opens a browser once.
npx wrangler login

# 3. Create the database. This prints a database_id — copy it.
npx wrangler d1 create rosterwarden

# 4. Paste that id into wrangler.toml, replacing PASTE_YOUR_DATABASE_ID_HERE

# 5. Create the table.
npx wrangler d1 execute rosterwarden --remote --file=./schema.sql

# 6. Deploy. This prints your worker URL.
npx wrangler deploy
```

Then put the URL it printed into `js/config.js` in the app:

```js
export const SYNC_URL = 'https://rosterwarden-sync.your-name.workers.dev';
```

Commit that, and the **Sync** section appears in the app's Settings. Leave
`SYNC_URL` empty and sync simply does not exist — the app works exactly as it
does now, entirely on the device.

## Checking it works

```bash
# Should return {"error":"No data for that code"} — a 404 with valid JSON.
curl https://YOUR-WORKER-URL/db/0000000000000000000000000000000000000000000000000000000000000000
```

## How the encryption works

One secret — the sync code the user sees — produces two unrelated things:

```
secret (random, shown as the sync code)
  ├─ SHA-256("rosterwarden-id:"  + secret) ──▶ storage id   → sent to this worker
  └─ SHA-256("rosterwarden-key:" + secret) ──▶ AES-GCM key  → never sent anywhere
```

Neither can be worked back to the other, so the id this server receives tells
it nothing about the key. Data is AES-GCM encrypted with a fresh nonce per
write, which also means tampering is detected rather than silently accepted.

**Losing the sync code means losing the data.** Not recoverable by the user,
and not by you, because nobody but that device has ever held the key. The app
says so plainly next to the code. This is the unavoidable cost of the server
genuinely not being able to read what it stores.

## What the server can still see

Encryption is not invisibility. Whoever runs this can see:

- how many databases exist, and their ids
- how large each one is
- when each was last written

It cannot see names, rosters, availability, or which organisation a blob
belongs to.

## Files

| File | Purpose |
|---|---|
| `src/index.js` | the Worker — two endpoints, GET and PUT |
| `schema.sql` | the single D1 table |
| `wrangler.toml` | deploy config; holds your `database_id` |
