# opencode-history-fulltext-search

A [opencode](https://github.com/anomalyco/opencode) TUI plugin that adds **full-text search over your session history** to the command palette.

Search across session titles and message content, with a custom results dialog that does live filtering, match highlighting, and keyboard navigation. Two scopes: limit to the current directory, or search everywhere.

## Features

- **Full-text search** across `session.title` + message content (`part.data`).
- **Two scopes** via the palette:
  - `Search history — This dir` — only sessions from the current session's directory.
  - `Search history — Anywhere` — all sessions.
- **Custom results dialog** (not the built-in `DialogSelect`) so snippets can be any length and matches can be highlighted inline.
- **Live filtering** as you type (debounced), with the match centered in a single-line snippet (~120 chars).
- **Smart noise filtering** — only indexes `part.data.type` of `text` or `reasoning`, and excludes `synthetic` rows, so tool I/O, step markers, patches, compaction events and file blobs never pollute results.
- **Keyboard + mouse** navigation (arrows, PgUp/PgDn, Home/End, Enter, Esc, click-to-open).
- **Cross-dir resume** — selecting a session from another directory (or any result in *Anywhere* mode) copies the exact resume command to the clipboard instead of switching context.

## Requirements

- opencode **1.17.x** (TUI plugin system, `@opencode-ai/plugin/tui`)
- **Linux** with one of: `wl-copy` (Wayland), `xclip` or `xsel` (X11) for clipboard support
- Bun (bundled with opencode; provides `bun:sqlite`)

> macOS/Windows clipboard tools are not auto-detected; only Linux is supported out of the box.

## Install

1. Copy the plugin into your opencode plugins directory:

   ```bash
   mkdir -p ~/.config/opencode/plugins
   cp search-history.tsx ~/.config/opencode/plugins/
   ```

2. Register it in `~/.config/opencode/tui.json` (merge with any existing entries):

   ```json
   [
     "./plugins/search-history.tsx", {}
   ]
   ```

3. Make sure the runtime dependencies are present in `~/.config/opencode/package.json`:

   ```json
   {
     "dependencies": {
       "@opencode-ai/plugin": "^1.17.7",
       "solid-js": "^1.9.13",
       "@opentui/core": "^0.4.2",
       "@opentui/solid": "^0.4.2",
       "@opentui/keymap": "^0.4.2"
     }
   }
   ```

   Then install them:

   ```bash
   cd ~/.config/opencode
   bun install
   ```

4. Restart opencode.

## Usage

1. Open the command palette (`Ctrl+P`).
2. Run **Search history — This dir** or **Search history — Anywhere**.
3. Type to filter results live.

### Keybindings

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move selection |
| `PgUp` / `PgDn` | Jump by a page |
| `Home` / `End` | First / last item |
| `Enter` | Open session (*This dir*) · copy resume command (*Anywhere*) |
| `Esc` | Close dialog |
| Mouse hover / click | Highlight / open |

### What gets copied

- **This dir** — selecting a session from the *same* directory opens it directly. Selecting one from a *different* directory copies `cd '<dir>' && opencode --session <id>` to the clipboard and shows a notice.
- **Anywhere** — every selection copies the resume command to the clipboard (no context switch).

## How it works

- Reads `opencode.db` **read-only** and WAL-safe (`PRAGMA query_only = ON`, `busy_timeout = 5000`).
- DB path resolution order: `$XDG_DATA_HOME/opencode`, `~/.local/share/opencode`, `~/.local/state/opencode` (first existing `opencode.db`).
- Searches `session.title` via `LIKE`, and `part.data` via `LIKE` with an `EXISTS` subquery.
- Content filter: `json_extract(part.data, '$.type') IN ('text', 'reasoning')` and `synthetic` rows excluded — this drops ~70% of rows that are pure operational noise (`tool`, `step-start`, `step-finish`, `patch`, `compaction`, `file`, `subtask`).
- Snippets are extracted from the raw JSON window, then newlines/tabs are collapsed to spaces and the excerpt is centered on the match.
- The dialog is forced to `xlarge` width (set after `dialog.replace()`, which resets size to `medium`).
- Clipboard tool is auto-detected in order: `wl-copy` → `xclip` → `xsel`.

## Configuration

The plugin takes no options — the empty `{}` object in `tui.json` is intentional. To change behavior, edit the constants at the top of `search-history.tsx`:

- `SQL_QUERY` / `SQL_RECENT` — query shape and content-type filter.
- `cleanSnippet()` `MAX` — snippet length (default `120`).
- `LIMIT` default (currently `50`).

## License

MIT — see [LICENSE](./LICENSE).
