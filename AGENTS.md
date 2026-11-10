# Antigravity Chinese Localization — Project Instructions

These instructions apply to every AI agent and contributor working in this repository. The goal is to deliver natural, complete, and maintainable Simplified Chinese localization without breaking Antigravity functionality, user content, or technical identifiers.

## 1. Current target, project structure, and sources of truth

- The current localization release is **v2.30.0**, targeting the official **Antigravity v2.30.0** client. The fixed main release dictionary is `dicts/release.json`; keep the version in `package.json`, `AGENTS.md`, and `README.md` consistent.
- `installer.js` is the zero-dependency, version-independent installation and restoration engine built on a hardened `AsarArchive` binary stream patcher. `localization_engine.js` loads `dicts/*.json` and generates the renderer translation injection (`generateJs()`). Importing `localization_engine.js` is strictly side-effect free; CLI execution delegates to `installer.js`.
- Never introduce `npx`, shell command strings (`execSync` / `shell: true`), or direct in-place mutation of live `app.asar`. System tools must be invoked with `shell: false` and explicit argument arrays.
- Installer compatibility is structural rather than a promise to translate unseen future strings. Unknown or ambiguous application layouts must fail closed without replacing `app.asar`.
- The engine loads **every** `dicts/*.json` file in lexicographic filename order (`dicts/release.json` loads last and overrides earlier keys if needed, though cross-dictionary duplicates are forbidden by `scripts/verify.js`).

## 2. Ownership and dictionary semantics

- `dicts/*.json` contains fixed renderer-facing text. Search existing dictionaries before editing, reuse established wording, and put each entry in the most appropriate module dictionary (`common.json`, `marketplace_plugins.json`, `menu_nav.json`, `page_agents.json`, `page_mcp_knowledge.json`, `page_settings.json`, `page_workspaces.json`, `release.json`).
- `loadDictionary()` reads all dictionaries in lexicographic filename order, collapses whitespace, trims keys, and normalizes curly quotes.
- Align punctuation 1:1 with the English source where appropriate, and keep placeholder tokens (`{name}`, `{{var}}`, `%s`), URLs, CLI flags, code spans, and version numbers intact.
- Preserve `--brand-title`: `english` retains the official `Antigravity` brand, `hidden` removes its visual label, and `translated` permits the Chinese brand translation.
- Treat shipped `.bat` files as GBK/CRLF release artifacts protected by `.gitattributes`.

## 3. Translation quality and protected content

- Translate complete meaning in its real UI context rather than word by word.
- Use consistent terminology:
  - `agent` → “智能体”
  - `conversation`, or a persisted chat/thread/history item → “会话”
  - `chat` used as a visible action, capability, or button → “聊天”
  - `project` → “项目”; `workspace` → “工作区”; `worktree` → “工作树”
  - `goal` → “目标”; `task` → “任务”
  - `artifact` → “交付件”
- Translate only confirmed product-owned wrapper text such as dialog or toast titles, buttons, labels, and fixed explanatory copy. Never translate user prompts or chat bodies, model thought streams (`markThoughtContentSibling`), collapsible tool activity blocks (`isCollapsibleActivityHeader`), file trees, path breadcrumbs, third-party web content, generated model responses, editor or file content, terminal output, stack traces, URLs, paths, commands, code, or shortcuts.

## 4. Dynamic renderer and DOM safety

- Use anchored, context-specific capture groups for dynamic counts, durations, dates, names, refs, and paths.
- Respect `data-testid="user-input-step"`, `data-ag-localization-skip`, editor and terminal guards, blocked tags, content-editable regions, protected descendants, and Shadow DOM ancestor traversal.
- Keep translation idempotent and observer work incremental: use `getBoundedTextContent` and `WeakMap` ancestor caching, and prune `.monaco-editor` / `.view-lines` subtrees without full-tree recursion.
- Inside `generateJs()` template literals, double-escape regex character classes (`\\s`, `\\d`, `\\w`, `\\.`) so template string evaluation does not strip backslashes.

## 5. Verification and safety boundaries

- Run `node scripts/verify.js` (and `node scripts/verify.js --preload "/absolute/path/to/preload.js"` when an official `preload.js` is available in a temporary directory).
- Run `npm run check` and `npm test` (`tests/assets_validation.test.js` and `tests/security_hardening.test.js`).
- Never run `node installer.js`, `node localization_engine.js`, `install.sh`, `uninstall.sh`, `.bat`, or `.command` against the user's real Antigravity installation directory during development or testing. Read-only inspection of an installed `app.asar` into `/tmp` is permitted and must be cleaned up afterward.
