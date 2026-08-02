# Infograph Sidebar

Obsidian plugin for research notes: **sidebar multi-panel infographics** powered by an OpenAI-compatible LLM, plus upstream **AntV Infographic** fenced code-block rendering.

**Based on [shuuul/obsidian-infographic](https://github.com/shuuul/obsidian-infographic)** (Apache-2.0). See `NOTICE` and `LICENSE`.

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README_CN.md">简体中文</a>
</p>

## Features

1. **Code blocks** — render ````infographic` fences (JSON or AntV DSL), live preview, export PNG/SVG, PDF snapshot support (upstream)
2. **Sidebar** — LLM generates a **logic brief + takeaways + multi-panel** pack; muted B&W palette with a touch of Claude orange
3. **Source anchors** — jump from panels back to quotes/headings in the note
4. **Auto-generation policy** — configurable (default: regenerate after save only if the throttle interval has elapsed)
5. **Stop generation** — cancel an in-flight LLM request from the sidebar

Version label format: `vYYYYMMDD.bN` (auto-bumped on production build).

## Install (manual / dev)

1. Build the plugin (see below)
2. Copy `main.js`, `manifest.json`, and `styles.css` into:

   ```text
   <your-vault>/.obsidian/plugins/infograph-sidebar/
   ```

3. In Obsidian: **Settings → Community plugins** — disable Restricted Mode if needed, enable **Infograph Sidebar**, reload

Or use the deploy script:

```bash
pnpm install
pnpm run build:esbuild
# PowerShell:
$env:INFOGRAPH_OBSIDIAN_PLUGIN_DIR = "D:\path\to\Vault\.obsidian\plugins\infograph-sidebar"
pnpm deploy
# or: pnpm release   # build:esbuild + deploy
```

> **Security:** API keys are stored only in the vault plugin `data.json` (gitignored). Never commit `data.json` or put keys in the repo.

## Settings

| Area | Options |
|------|---------|
| Code blocks | auto-render, theme, error behavior |
| LLM | OpenAI-compatible base URL / API key / model, temperature, max input chars, max output tokens, reasoning effort |
| Auto-gen | policy, min interval, debounce, cache size, min note length |

## Commands

| Command | Action |
|---------|--------|
| Open Infograph sidebar | Open right sidebar view |
| Regenerate infographic for current note | Force LLM (ignore cache) |
| Clear infographic cache (current / all) | Drop cached packs |
| Insert template / Refresh in current note | Upstream code-block helpers |

## Workflow

1. Open a long Markdown research note
2. Open the sidebar (ribbon pie-chart icon or command)
3. Configure LLM under plugin settings, then click **Regenerate**
4. Scroll stacked panels; use source chips to jump into the note
5. **Copy DSL** / **Insert into note** / **Export** as needed

Cache is keyed by note path + content hash (and panel-count version).

### Density tips

- Prefer a strong reasoning model for long research notes
- Settings → Max panels = 4–5, Max input chars ≥ 28000, Max output tokens ≥ 8192
- If output is slogan-only, Regenerate once (plugin may auto-retry when digit density is low)

## Develop

```bash
pnpm install
pnpm run dev          # esbuild watch
pnpm run build        # tsc + production bundle
pnpm run lint
pnpm run test:sanitize
```

CLI one-shot extraction (uses local `data.json` for credentials — do not commit it):

```bash
node scripts/cli-gen.mjs --note path/to.md --data path/to/plugin/data.json --out tmp/pack_out.md
```

## Privacy / secrets checklist

| Item | Status |
|------|--------|
| API keys | Only in vault `data.json` (gitignored) |
| Deploy path | Env `INFOGRAPH_OBSIDIAN_PLUGIN_DIR` only |
| `main.js` | Generated, gitignored |
| `tmp/` | Local smoke/debug, gitignored |
| `.env` | Ignored |

## License

Apache-2.0 — see `LICENSE` and `NOTICE`.
