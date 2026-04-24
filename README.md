# puppeteer-scraper-poc

A proof of concept that uses `cpln workload cron run` to spawn on-demand Puppeteer containers on [Control Plane](https://controlplane.com).

Type a URL into the web app. The backend calls `cpln workload cron run` with the URL as an env var; Control Plane provisions a short-lived cron workload from the scraper image, Puppeteer scrapes the page inside it, and the raw HTML is posted to a separate processor workload that extracts the title, favicon, og:image, and links.

Everything runs inside a dedicated GVC (`puppeteer-scraper-poc`) in `aws-eu-central-1`.

## Architecture

```
+----------------+  POST /scrape {url}   +-----------------------------------+
|   Browser      | --------------------> |  webapp  (standard, public)       |
|                | <-- 202 {jobId} ----- |    > cpln workload cron run       |
|  polls         |                       |        --image //image/scraper    |
|  /jobs/:id     |                       |        --env URL=<url>            |
|                |                       |        --env JOB_ID=<uuid>        |
|                |                       |        --env PROCESSOR_URL=...    |
|                |                       |        --background               |
+----------------+                       +------------+----------------------+
                                                      | provisions + runs
                                                      v
                              +------------------------------------------+
                              |  cpln-run-<hash>  (cron, ephemeral)      |
                              |   puppeteer.launch -> page.goto($URL)    |
                              |   POST html to processor.<gvc>.cpln.local|
                              +-------------------+----------------------+
                                                  | internal mTLS
                                                  v
                              +------------------------------------------+
                              |  processor  (standard, internal-only)    |
                              |   cheerio -> {title, favicon, links...}  |
                              |   POST /raw   GET /jobs/:id              |
                              +------------------------------------------+
```

| Component    | Type                    | Role                                                                                                                                                           |
| ------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webapp/`    | standard, public        | Serves the UI and `POST /scrape`. Shells out to `cpln workload cron run` with per-request env overrides. Polling + history are in the browser (localStorage).  |
| `scraper/`   | image only              | Puppeteer container image. `cpln workload cron run` provisions a cron workload from this image on demand and reuses it across calls — no manifest needed.      |
| `processor/` | standard, internal-only | Receives raw HTML, extracts `title` / `description` / `favicon` / `ogImage` / `language` / `canonical` / first 20 links (relative hrefs resolved to absolute). |

## Prerequisites

- A Control Plane org. Sign up at <https://console.cpln.io>.
- The `cpln` CLI installed and authenticated locally: `cpln login` (browser flow) will set up a default profile.

## Quickstart

```bash
cp .env.example .env
# set CPLN_ORG to your org name

./infra/deploy.sh
```

`deploy.sh` creates the `puppeteer-scraper-poc` GVC (in `aws-eu-central-1`), builds and pushes three images, applies the identity, two policies, and two workload manifests, and prints the webapp's public endpoint when done. Rerun it any time — it's idempotent.

Open the endpoint, paste a URL, hit **Scrape**. The card shows the favicon, title, og:image (when present), HTTP status, resolved canonical URL, language, and the first 10 links — each link opens the original site in a new tab. A "Recent scrapes" card below accumulates past scrapes per browser.

### Using a specific cpln profile

`deploy.sh` uses your default profile unless you set `CPLN_PROFILE` in `.env`:

```bash
# one-time: create a profile from a service-account key
cpln profile create ci --token $(cpln serviceaccount add-key my-deployer -o json | jq -r .key)

# then in .env:
# CPLN_PROFILE=ci
```

`CPLN_ORG` is always passed explicitly to every `cpln` call, so even if the selected profile's default org is different, this POC lands in the right place.

## Tearing down

```bash
./infra/teardown.sh
```

Deletes the GVC (and every workload + the `webapp-identity` inside it, including any `cpln-run-<hash>` cron workloads that were provisioned on demand), the two policies, and the three pushed images. Shows what it's about to delete and asks for confirmation; set `YES=1` to skip the prompt in CI.

## Verifying the flow

```bash
export CPLN_ORG=<your-org>
GVC=puppeteer-scraper-poc

# List workloads — you'll see webapp, processor, and one or more cpln-run-<hash>
# cron workloads that were provisioned by `cpln workload cron run`.
cpln workload get --gvc $GVC --org $CPLN_ORG

# Logs — scraper → processor handoff. Replace <workload> with a cpln-run-* name
# from the list above.
cpln logs '{gvc="'"$GVC"'", workload="<workload>"}' --org $CPLN_ORG --tail
cpln logs '{gvc="'"$GVC"'", workload="processor"}' --org $CPLN_ORG --tail

# Webapp logs show "cron run triggered" on each submission.
cpln logs '{gvc="'"$GVC"'", workload="webapp"} |= "cron run triggered"' --org $CPLN_ORG
```
