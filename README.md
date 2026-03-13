# Standalone Forge

This repo now includes a GitHub Pages frontend under `site/`, a Cloudflare Worker proxy under `worker/`, and a GitHub Actions workflow that runs `unity_standalone.py` on demand.

## Architecture

- `site/` contains the static HTML, CSS, and JavaScript that can be deployed to GitHub Pages.
- `worker/` contains a Cloudflare Worker that stores your GitHub PAT as a secret and proxies dispatch/status requests.
- `.github/workflows/build-game.yml` rebuilds the Pages payload and optionally exports a new game when the browser dispatches the workflow.
- `build_pages_site.py` merges the existing deployed Pages state with the current site files, runs `unity_standalone.py`, and updates `published_games.json`.
- `unity_standalone.py` remains the actual exporter used during the Actions run.

## Why this works on GitHub Pages

GitHub Pages serves static files only. It does not execute Python or other server-side code. The browser page calls your Cloudflare Worker, the Worker calls the GitHub API using a secret PAT, and the conversion itself runs inside GitHub Actions.

## Cloudflare Worker setup

1. Push this repo to GitHub.
2. In the repository settings, enable GitHub Pages and choose `GitHub Actions` as the source.
3. In `Settings -> Actions -> General`, enable Actions and set `Workflow permissions` to `Read and write permissions`.
4. Create a new fine-grained PAT for this repo with:
   - `Actions: read and write`
   - `Contents: read and write`
5. Install Node.js if it is not already installed.
6. Open a terminal in `worker/`.
7. Run `npm install -D wrangler`.
8. Run `npx wrangler login`.
9. Edit `worker/wrangler.toml` and confirm:
   - `GITHUB_OWNER`
   - `GITHUB_REPO`
   - `GITHUB_REF`
   - `ALLOWED_ORIGIN`
10. Run `npx wrangler secret put GITHUB_TOKEN` and paste your PAT when prompted.
11. Run `npx wrangler deploy`.
12. Copy the deployed Worker URL, for example `https://standalone-forge-proxy.<subdomain>.workers.dev`.
13. Open `site/config.js`.
14. Set:

```js
window.STANDALONE_FORGE_CONFIG = {
  workerUrl: "https://standalone-forge-proxy.<subdomain>.workers.dev",
};
```

15. Commit and push `site/config.js`.
16. Open the deployed site.
17. Submit a direct game URL or a name from `game_catalog.json`.

## What the Worker does

- `GET /config` returns the repo target the Worker is wired to.
- `POST /dispatch` triggers the GitHub Actions workflow.
- `GET /status?runId=...` returns run and job status so the Pages frontend can show progress for a private repo.

## Name support

Plain names are resolved through `game_catalog.json`. The file can be either:

```json
{
  "My Catalog Game": "https://example.com/game/"
}
```

or:

```json
[
  {
    "name": "My Catalog Game",
    "url": "https://example.com/game/"
  }
]
```

If a submitted value is already an `http` or `https` URL, the site uses it directly.

## Published output

Each successful run creates a folder under:

```text
games/<slug>-<request-id>/
```

That folder contains `Build/`, `index.html`, and `standalone-build-info.json`. The site catalog is written to `published_games.json`.
