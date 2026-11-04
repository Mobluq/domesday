# Deploying Domesday to Vercel

The web app and its API deploy as one Vercel project. The static app is built by Vite; the
functions in `api/` keep the shared data in Redis and call the Anthropic API with the
server's key, so the key never reaches a browser.

## Project settings

- Root directory: `apps/web` (the monorepo is installed from the root; `vercel.json` sets the
  install and build commands)
- Framework: Vite, output `dist`
- Node.js: 22.x

## Environment variables

| Name | Needed | What it is |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | For recognition | A key from console.anthropic.com. Mark it Sensitive. |
| `DOMESDAY_ACCESS_CODE` | Recommended | A phrase people type once per device. Without it, anyone with the link can use the app and your API credits. |
| `REDIS_URL` | One store is needed | Set by a Redis store from the Vercel Marketplace (`redis://` or `rediss://`). |
| `KV_REST_API_URL` and `KV_REST_API_TOKEN` | Alternative store | Set by the Upstash for Redis integration. Upstash's own `UPSTASH_REDIS_REST_URL` and `_TOKEN` work too. |
| `ANTHROPIC_MODEL`, `ANTHROPIC_MODEL_QUICK` | Optional | Override the models (defaults: `claude-sonnet-5-5`, `claude-haiku-5-5`). |

After changing a variable, redeploy for it to take effect.

## What the API does

- `GET /api/health`: which features are on (store, recognition, access code). Public; it never
  shows a key.
- `POST /api/db`: documents and collections, with a version number the page polls every two
  seconds so everyone sees changes.
- `POST /api/assets`, `GET /api/blob?id=`: stored frames and label shots.
- `POST /api/claude`: one recognition call to the Messages API, with up to 12 images.

Every endpoint except health needs the access code when `DOMESDAY_ACCESS_CODE` is set. Pages
send it as the `x-domesday-code` header, and as a cookie for images.

## First run

Open the site. If the store is empty, choose **Try the demo site** or **Set up your own site**.
The demo can be reset from Site setup at any time.

## Costs

Recognition reads up to 8 frames and the label shots per room. At the Sonnet price of $2 per
million input tokens and $10 per million output tokens, a room costs a few US cents. Set a
monthly spend limit in the Anthropic Console.
