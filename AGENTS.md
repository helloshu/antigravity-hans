# Antigravity Chinese Localization — Project Instructions

These instructions apply to every AI agent and contributor working in this repository. The goal is to deliver natural, complete, and maintainable Simplified Chinese localization without breaking Antigravity functionality, user content, or technical identifiers.

## 1. Current target, project structure, and sources of truth

- The current localization release is **v2.29.0**, targeting the official **Antigravity v2.29.0** client. The current version dictionary is `dicts/v2.29.0.json`; keep these values, the release date, and the support statement in `README.md` consistent.
- `installer.js` is the hardened, version-independent installation and restoration engine. `localization_engine.js` generates the renderer translation injection and patches packaged Electron surfaces. The legacy entry point in `localization_engine.js` that previously invoked shell commands directly against `app.asar` is permanently disabled.
- Never reintroduce `npx`, shell command strings, unpinned dependencies, a fixed shared extraction directory, or direct in-place mutation of live `app.asar`. External toolchains must be pinned in `package.json`, resolved within this repository, and invoked with `shell: false` plus an explicit argument array.
- Installer compatibility is structural rather than a promise to translate unseen future strings. Unknown or ambiguous application layouts must fail closed without replacing `app.asar`.
- Treat the repository's actual files and executable behavior as authoritative. If these instructions, `README.md`, a dictionary filename, an engine comment, or the current client disagree, report the mismatch and update only what the requested task requires.
- The engine loads **every** `dicts/*.json` file. A version bump must leave exactly one active version dictionary, migrate the previous dictionary deliberately, update all current-version references, and be checked against official packaged source and metadata. If renderer source is unavailable, verify the package version and relevant packaged injection surfaces, use observed client UI as renderer evidence, and state that limitation instead of claiming a full source audit. Do not change tags or release metadata unless explicitly requested.
- Keep the user-facing installation, restoration, platform, path, dependency, and compatibility claims in `README.md` consistent with the actual engine and supported launchers.

## 2. Ownership and dictionary semantics

- `dicts/*.json` contains fixed renderer-facing text. Search existing dictionaries before editing (e.g. with `rg`), reuse established wording, and put each entry in the most appropriate module dictionary.
- `loadDictionary()` reads all dictionaries in lexicographic filename order, collapses whitespace, trims keys, and normalizes curly quotes. A later normalized key overrides an earlier one; the renderer also has a case-insensitive fallback. Invalid JSON is skipped by the client loader. The repository verifier is responsible for detecting these mechanical failures.
- Prefer exact entries for short labels and complete fixed sentences. Entries longer than 20 characters may also be used for substring replacement, so their source text must remain sufficiently specific. Use a fragment-only key only when the client is confirmed to render that fragment as an independent, unambiguous UI node. Dictionary keys must precisely match client source text; avoid overly broad single-word substitutions that could collide with code or file names.
- `localization_engine.js` both generates the renderer translation injection and patches packaged Electron surfaces while unpacking/repacking `app.asar`. Put fixed native menu, tray, loading, and updater text in the corresponding narrow engine injection block; use bounded engine rules for dynamic or structurally fragmented renderer text.
- Preserve `--brand-title`: English retains the official `Antigravity` brand, hidden removes its visual label, and translated permits the Chinese brand translation.
- `install.sh` and `双击安装中文汉化.bat` are the supported installation entry points; `uninstall.sh` and `双击卸载还原官方英文.bat` are the restoration entry points. `localization_engine.js` is side-effecting and is never a development test command.
- Treat shipped `.bat` files as GBK/CRLF release artifacts protected by `.gitattributes`. Change them only when explicitly requested, using `convert_to_gbk.ps1`, and verify the resulting encoding and line endings.

## 3. Translation quality and protected content

- Translate complete meaning in its real UI context rather than word by word. Keep buttons, menus, prompts, errors, and status text concise and natural, using standard Simplified Chinese punctuation.
- Use the following terminology unless context requires a documented exception:
  - `agent` → “智能体”
  - `conversation`, or a persisted chat/thread/history item → “会话”
  - `chat` used as a visible action, capability, or button → “聊天”
  - a conversational exchange or agent dialogue → “对话” when natural in context
  - `project` → “项目”; `workspace` → “工作区”; `worktree` → “工作树”
  - `goal` → “目标”; `task` → “任务”
  - `file` → “文件”; `folder` → “文件夹”
  - `page` → “页面” or counted “个页面”; `search` → “搜索” or counted “次搜索”
  - `tool` → “工具”
  - UI `artifact` or a generated deliverable → “交付件”; a technical artifact may be “构件”
- Keep project and workspace distinct even when the UI visually groups them.
- Translate only confirmed product-owned wrapper text such as dialog or toast titles, buttons, labels, and fixed explanatory copy. Never translate user prompts or chat bodies, third-party web content, generated model responses, editor or file content, terminal or subprocess output, CLI/Git diagnostics, stack traces, URLs, paths, commands, code, shortcuts, secrets, credentials, model or product names, MCP/API/configuration identifiers, environment variables, version numbers, Git refs or hashes, exit codes, or error IDs.
- Preserve placeholders and runtime values exactly. Do not drop, ambiguously reorder, or hard-code project, workspace, file, model, branch, email, date, count, shortcut, or status values.

## 4. Dynamic renderer and DOM safety

- For every screenshot report, identify the original English source, UI location, expected Chinese output, and whether the source is fixed, variable, or split across DOM nodes. Do not infer a key solely from the final mixed-language rendering.
- Use anchored, context-specific capture groups for dynamic counts, durations, dates, names, refs, and paths. Count rules must cover singular and plural forms and use the correct Chinese classifier; never add screenshot-specific numeric variants.
- React may split a sentence or briefly render an incomplete state. Combine only the smallest relevant container, wait for a semantically complete source, and update only the necessary text nodes (e.g. via `getCombinedStatusTranslation` or `translateFragmentedStatus`). Preserve icons, links, emphasis, shortcuts, buttons, event handlers, selection, accessibility attributes, and React-owned structure.
- Respect `data-testid="user-input-step"`, `data-ag-localization-skip`, editor and terminal guards, blocked tags, content-editable regions, protected descendants, and Shadow DOM ancestor traversal. Never concatenate text across a protected boundary or use broad `innerHTML`/`textContent` replacement on interactive containers.
- Keep translation idempotent and observer work incremental: compare before every observed write, keep `startEngine()` single-start, use cheap text/length prefilters before ancestor or container scans, and do not add recurring full-document scans or delayed rescans to hide a missing rule.
- Do not write translation markers or observed attributes to SVG/path/icon nodes. A structural rule must not create observer loops, cross-item translation, lost click behavior, or material panel slowdown.

## 5. Implementation workflow

1. Inspect `git status --short --untracked-files=all` before editing and preserve every unrelated user change. Do not stage or include it implicitly.
2. Inspect the relevant dictionaries, engine functions, screenshots, current-version dictionary, callers, and available official client source. Confirm source text and DOM composition before choosing an implementation.
3. Apply the ownership, matching, translation, and DOM rules above using the smallest safe change. Do not reorder large dictionaries, reformat unrelated files, add speculative variants or dependencies, or expand release scope without authorization.
4. Document only non-obvious dynamic or structural invariants next to the rule. For performance-sensitive changes, compare observer activity and DOM writes on representative containers.

## 6. Verification and handoff

- For dictionary-only changes to fixed renderer text, run the repository-owned non-installing verifier `node scripts/verify.js`, inspect each reported failure or skip, and review the intended dictionary diff.
- Run `npm run check` to perform static syntax and compile verification on `localization_engine.js`, `installer.js`, and test scripts.
- Run `npm test` to execute the synthetic ASAR fixture tests (`tests/assets_validation.test.js` and `tests/security_hardening.test.js`), ensuring installer security, SHA-256 backup, and atomic replacement integrity.
- Add or update focused cases in `tests/renderer-regression.js` only when changing dynamic matching, structural/fragmented DOM handling, protected boundaries, attribute translation, observer behavior, or fixing confirmed renderer regressions.
- The lightweight DOM contract suite prevents known engine regressions but does not prove compatibility with an official renderer. Confirm source text, DOM composition, interactions, and representative performance in the target client for release-sensitive engine changes, and state when that validation is unavailable.
- When a confirmed official `preload.js` is available, additionally run `node scripts/verify.js --preload "/absolute/path/to/preload.js"`. Without the option, preload compatibility is skipped rather than passed.
- For a version-dictionary migration, review the verifier's old/new entry totals and every reported missing or changed existing entry. Use `--acknowledge-version-entry-changes` only after confirming each such change is intentional.
- Review the final diff and every untracked path reported by the verifier.

## 7. Installation, destructive actions, and Git

- Never run `node installer.js`, `node localization_engine.js`, `install.sh`, `uninstall.sh`, either Windows batch launcher, or any equivalent command that installs, injects, restores, repacks, or otherwise modifies the user's real Antigravity client during development or audit. Read-only extraction of a confirmed official package into a separate temporary directory is allowed for verification; never write the result into the application directory. Synthetic tests must only operate on fixtures created under temporary directories.
- Do not delete `_temp_asar`, backups, application files, or user data unless the user explicitly requests the exact destructive action and the target has been verified.
- Instruct users to prepare dependencies without elevation using `npm ci --ignore-scripts`. For installation, Linux users run `./install.sh` (using `sudo` only when write permissions require it); Windows users double-click `双击安装中文汉化.bat` (using “Run as administrator” only after a permission failure). Restoration follows the same escalation rule with the corresponding uninstall entry point.
- Update versions, tags, releases, Git staging, commits, pushes, rebases, or history only when explicitly requested. Before staging, verify the exact file list and exclude unrelated user changes.
