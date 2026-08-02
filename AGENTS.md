# PROJECT KNOWLEDGE BASE

**Branch:** master  
**Plugin id:** `infograph-sidebar`  
**Package version:** see `package.json` / `manifest.json`  
**Upstream:** [shuuul/obsidian-infographic](https://github.com/shuuul/obsidian-infographic) (Apache-2.0)

## Project Overview

Obsidian plugin that:

1. Renders [AntV Infographic](https://github.com/antvis/Infographic) from fenced `infographic` code blocks (upstream behavior).
2. Adds a **sidebar** that calls an OpenAI-compatible LLM to extract a multi-panel pack (logic brief, takeaways, AntV DSL panels) from the active research note, with cache, auto-gen policy, and source-anchor navigation.

## Repo Structure

```
./
├── src/
│   ├── main.ts                 # Plugin entry, commands, code-block processor
│   ├── settings.ts             # Settings schema + tab UI
│   ├── constants.ts            # View type, deploy hint (no personal paths)
│   ├── version.ts / build-info.json
│   ├── llm/                    # OpenAI-compatible client + pack extract
│   ├── cache/                  # DSL/pack cache helpers
│   ├── policy/                 # Auto-generation policy
│   ├── service/                # DSL service orchestration
│   ├── view/                   # Sidebar ItemView
│   ├── utils/                  # sanitize, anchors, markdown, hash
│   ├── parser/                 # JSON / DSL validation
│   ├── renderer/               # Live render + PDF snapshot
│   ├── theme.ts
│   └── ui/                     # Export / Source modals
├── scripts/
│   ├── deploy.mjs              # Copy artifacts (needs INFOGRAPH_OBSIDIAN_PLUGIN_DIR)
│   ├── bump-build.mjs
│   ├── cli-gen.mjs             # Offline pack gen (needs --note + --data)
│   └── test-sanitize.mjs
├── skills/obsidian-infographic/
├── styles.css
├── esbuild.config.mjs
├── manifest.json
├── README.md / README_CN.md
├── NOTICE / LICENSE
└── AGENTS.md
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript (strict) |
| Host | Obsidian API |
| Viz | `@antv/infographic` |
| Bundler | esbuild → `main.js` (gitignored) |
| Package manager | pnpm preferred |

## Commands

| Task | Command |
|------|---------|
| Install | `pnpm install` |
| Dev | `pnpm run dev` |
| Build | `pnpm run build` |
| Deploy | set `INFOGRAPH_OBSIDIAN_PLUGIN_DIR`, then `pnpm deploy` |
| Lint | `pnpm run lint` |

## Secrets & hygiene

- **Never commit** `data.json`, `.env`, API keys, or personal vault paths.
- Deploy path is **only** via `INFOGRAPH_OBSIDIAN_PLUGIN_DIR`.
- `tmp/` is local smoke/debug output — gitignored.
- `main.js` is build output — gitignored; edit `src/` only.
- LLM credentials live in vault plugin settings (`data.json`).

## Coding conventions

- Strict TypeScript; relative imports under `src/`.
- DOM lifecycle via `MarkdownRenderChild` / `ItemView`; register events with plugin APIs.
- Unknown errors: `e instanceof Error ? e.message : String(e)`.
- CSS: `infographic-` / `infograph-` prefixes.

## Gotchas

- Do not hardcode machine-specific vault or source paths.
- AntV `destroy()` may throw if already destroyed — wrap cleanup in try/catch.
- Prefer `activeWindow` for popout-window compatibility.
- API key field is password-type in settings; never log it.

## License

Apache-2.0 — upstream attribution in `NOTICE`.
