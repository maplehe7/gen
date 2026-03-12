# Standalone Forge

This repo now includes a GitHub Pages-compatible frontend under `site/` plus a GitHub Actions workflow that runs `unity_standalone.py` on demand.

## Architecture

- `site/` contains the static HTML, CSS, and JavaScript that can be deployed to GitHub Pages.
- `.github/workflows/build-game.yml` rebuilds the Pages payload and optionally exports a new game when the browser dispatches the workflow.
- `build_pages_site.py` merges the existing deployed Pages state with the current site files, runs `unity_standalone.py`, and updates `published_games.json`.
- `unity_standalone.py` remains the actual exporter used during the Actions run.

## Why this works on GitHub Pages

GitHub Pages serves static files only. It does not execute Python or other server-side code. The browser page handles the UI and calls the GitHub Actions API, while the conversion itself runs inside GitHub Actions.

## Required setup

1. Push this repo to GitHub.
2. In the repository settings, enable GitHub Pages and choose `GitHub Actions` as the source.
3. Open `site/config.js`.
4. Fill in:
   - `owner`
   - `repo`
   - `ref`, usually `main`
   - `token`, using a fine-grained personal access token with repository access plus `Actions: read and write` and `Contents: read and write`
5. Commit and push `site/config.js`.
6. Open the deployed site.
7. Submit a direct game URL or a name from `game_catalog.json`.

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
