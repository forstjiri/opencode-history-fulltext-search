/**
 * opencode TUI plugin: Search fulltext opencode history
 *
 * Ctrl+P → "Search history — This dir" / "Search history — Anywhere" →
 * custom results dialog (filter + scrollbox + keys), live-filtered
 * full-text over the title + session content. Matches are highlighted in the snippet.
 * Enter opens the session; for a different session, `cd "<dir>" && opencode --session <id>`
 * is copied to the clipboard.
 *
 * Reads opencode.db read-only (WAL-safe). Runs only in TUI.
 *
 * Why a custom dialog instead of the built-in DialogSelect: the detail row in DialogSelect
 * is hard-truncated to 76 characters and the match can't be colored. A custom render with
 * box/text/scrollbox/input solves this (arbitrary length, <span> highlight).
 */
/** @jsxImportSource @opentui/solid */

import { createSignal, createMemo, For, Show, onCleanup } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useBindings } from "@opentui/keymap/solid"
import { RGBA, TextAttributes, type ScrollBoxRenderable, type InputRenderable } from "@opentui/core"
import { createBindingLookup } from "@opencode-ai/plugin/tui"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import { statSync } from "node:fs"

type Scope = "dir" | "anywhere"

type Row = {
  id: string
  title: string
  directory: string
  time_updated: number
  snippet: string | null
}

type Val = { id: string; dir: string }

const HOME = homedir()
const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0)

// ----------------------------------------------------------------------------
// SQLite
// ----------------------------------------------------------------------------

function resolveDbPath(api: TuiPluginApi): string {
  const names = ["opencode.db", "opencode-dev.db"]
  const dirs: string[] = []
  const stateDir = api.state.path.state
  if (stateDir) dirs.push(stateDir)
  const xdgData = process.env.XDG_DATA_HOME || join(HOME, ".local", "share")
  dirs.push(join(xdgData, "opencode"))
  dirs.push(join(HOME, ".local", "share", "opencode"))
  dirs.push(join(HOME, ".local", "state", "opencode"))
  for (const d of dirs) {
    for (const n of names) {
      try {
        if (statSync(join(d, n)).isFile()) return join(d, n)
      } catch {
        /* try the next one */
      }
    }
  }
  return join(xdgData, "opencode", "opencode.db")
}

let dbCache: { path: string; db: Database } | null = null

function getDb(api: TuiPluginApi): Database {
  const path = resolveDbPath(api)
  if (dbCache && dbCache.path === path) return dbCache.db
  let db: Database
  try {
    db = new Database(path, { readonly: true })
  } catch {
    db = new Database(path)
  }
  db.run("PRAGMA query_only = ON")
  db.run("PRAGMA busy_timeout = 5000")
  dbCache = { path, db }
  return db
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

const SQL_QUERY = `
SELECT s.id, s.title, s.directory, s.time_updated,
  (SELECT substr(p.data, max(1, instr(lower(p.data), lower(?)) - 30), 240)
   FROM part p
   WHERE p.session_id = s.id AND p.data LIKE ? ESCAPE '\\'
     AND json_extract(p.data, '$.type') IN ('text', 'reasoning')
     AND COALESCE(json_extract(p.data, '$.synthetic'), 0) = 0
   LIMIT 1) AS snippet
FROM session s
WHERE s.time_archived IS NULL
  AND (? = 1 OR s.directory = ?)
  AND (s.title LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM part p
                   WHERE p.session_id = s.id AND p.data LIKE ? ESCAPE '\\'
                     AND json_extract(p.data, '$.type') IN ('text', 'reasoning')
                     AND COALESCE(json_extract(p.data, '$.synthetic'), 0) = 0))
ORDER BY s.time_updated DESC
LIMIT ?`

const SQL_RECENT = `
SELECT s.id, s.title, s.directory, s.time_updated, NULL AS snippet
FROM session s
WHERE s.time_archived IS NULL
  AND (? = 1 OR s.directory = ?)
ORDER BY s.time_updated DESC
LIMIT ?`

function search(api: TuiPluginApi, scope: Scope, cwd: string, query: string, limit = 50): Row[] {
  const conn = getDb(api)
  const anywhere = scope === "anywhere" ? 1 : 0
  const q = query.trim()
  try {
    if (q === "") return conn.prepare(SQL_RECENT).all(anywhere, cwd, limit) as Row[]
    const qlike = "%" + escapeLike(q) + "%"
    return conn.prepare(SQL_QUERY).all(q, qlike, anywhere, cwd, qlike, qlike, limit) as Row[]
  } catch (e) {
    console.error("[search-history] query failed:", e)
    return []
  }
}

// ----------------------------------------------------------------------------
// Formatting
// ----------------------------------------------------------------------------

function shortDir(d: string): string {
  if (!d) return "?"
  return d.startsWith(HOME) ? "~" + d.slice(HOME.length) : d
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function resumeCommand(dir: string, id: string): string {
  return `cd ${shellQuote(dir)} && opencode --session ${id}`
}

function relTime(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return Math.floor(s / 60) + "m ago"
  if (s < 86400) return Math.floor(s / 3600) + "h ago"
  if (s < 2592000) return Math.floor(s / 86400) + "d ago"
  return Math.floor(s / 2592000) + "mo ago"
}

// Clean single-line snippet: normalizes whitespace to one line,
// centers on the match (so it is visible). No wrapping/tabs.
function cleanSnippet(raw: string | null, query: string): string | undefined {
  if (!raw) return undefined
  const text = raw.replace(/[\r\n\t\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim()
  if (!text) return undefined
  const q = query.trim()
  let line = text
  const MAX = 120
  if (line.length > MAX) {
    const mp = q ? line.toLowerCase().indexOf(q.toLowerCase()) : -1
    const center = mp >= 0 ? mp + Math.max(1, Math.floor(q.length / 2)) : Math.floor(line.length / 2)
    let start = Math.max(0, center - Math.floor(MAX / 2))
    start = Math.min(start, Math.max(0, line.length - MAX + 2))
    const body = line.slice(start, start + MAX - 2)
    line = (start > 0 ? "…" : "") + body + (start + MAX - 2 < line.length ? "…" : "")
  }
  return line
}

// Splits text into parts labeled as matches (for <span> highlight).
function splitHighlight(text: string, query: string): { text: string; match: boolean }[] {
  const q = query.trim()
  if (!q) return [{ text, match: false }]
  const lower = text.toLowerCase()
  const ql = q.toLowerCase()
  const parts: { text: string; match: boolean }[] = []
  let i = 0
  while (i < text.length) {
    const idx = lower.indexOf(ql, i)
    if (idx === -1) {
      parts.push({ text: text.slice(i), match: false })
      break
    }
    if (idx > i) parts.push({ text: text.slice(i, idx), match: false })
    parts.push({ text: text.slice(idx, idx + q.length), match: true })
    i = idx + q.length
  }
  return parts
}

function currentDir(api: TuiPluginApi): string {
  const route = api.route.current
  if (route.name === "session") {
    const id = (route.params as { sessionID?: string } | undefined)?.sessionID
    if (id) {
      const sess = api.state.session.get(id)
      if (sess?.directory) return sess.directory
    }
  }
  return api.state.path.directory
}

async function copyToClipboard(text: string): Promise<boolean> {
  const cmds: string[][] = [
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
  ]
  for (const cmd of cmds) {
    try {
      const proc = Bun.spawn({ cmd, stdin: new Blob([text]) })
      if ((await proc.exited) === 0) return true
    } catch {
      /* tool is not installed → try the next one */
    }
  }
  return false
}

// ----------------------------------------------------------------------------
// Custom results dialog
// ----------------------------------------------------------------------------

const keys = createBindingLookup({
  "sh.up": "up",
  "sh.down": "down",
  "sh.pgup": "pageup",
  "sh.pgdn": "pagedown",
  "sh.home": "home",
  "sh.end": "end",
  "sh.submit": "enter,return",
  "sh.close": "escape",
})

function ResultsDialog(props: { api: TuiPluginApi; scope: Scope }) {
  const api = props.api
  const scope = props.scope
  const cwd = currentDir(api)
  const theme = api.theme.current
  const selFg = theme.selectedListItemText
  const dim = useTerminalDimensions()

  const [rows, setRows] = createSignal<Row[]>(search(api, scope, cwd, ""))
  const [selected, setSelected] = createSignal(0)
  const [resultQuery, setResultQuery] = createSignal("")
  const [copyNotice, setCopyNotice] = createSignal<{ variant: "success" | "warning"; title: string; message: string } | null>(null)
  let timer: ReturnType<typeof setTimeout> | null = null
  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  let scroll: ScrollBoxRenderable | undefined
  let inputRef: InputRenderable | undefined
  let done = false

  const showCopyNotice = (variant: "success" | "warning", title: string, message: string) => {
    setCopyNotice({ variant, title, message })
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => setCopyNotice(null), 10000)
  }

  const choose = (v: Val) => {
    if (done || !v.id) return
    if (scope === "dir") {
      done = true
      if (timer) clearTimeout(timer)
      api.ui.dialog.clear()
      api.route.navigate("session", { sessionID: v.id })
      if (v.dir && v.dir !== cwd) {
        const cmd = resumeCommand(v.dir, v.id)
        copyToClipboard(cmd).then((ok) =>
          api.ui.toast({
            variant: ok ? "success" : "warning",
            title: ok ? "Command copied to clipboard ✓" : "Clipboard unavailable — command:",
            message: cmd,
            duration: 8000,
          }),
        )
      }
      return
    }

    const cmd = resumeCommand(v.dir, v.id)
    copyToClipboard(cmd).then((ok) => {
      showCopyNotice(ok ? "success" : "warning", ok ? "Copied to clipboard" : "Clipboard unavailable", cmd)
    })
  }

  const scrollToSelected = () => {
    const sc = scroll
    if (!sc) return
    const children = sc.getChildren()
    const target = children[selected()]
    if (!target) return
    const top = target.y - sc.y
    const bottom = top + target.height
    if (top < 0) sc.scrollBy(top)
    else if (bottom > sc.height) sc.scrollBy(bottom - sc.height)
  }

  const move = (d: number) => {
    const list = rows()
    if (!list.length) return
    setSelected((s) => (s + d + list.length) % list.length)
    scrollToSelected()
  }
  const goTo = (i: number) => {
    const list = rows()
    if (!list.length) return
    setSelected(Math.max(0, Math.min(i, list.length - 1)))
    scrollToSelected()
  }
  const submit = () => {
    const r = rows()[selected()]
    if (r) choose({ id: r.id, dir: r.directory })
  }

  useBindings(() => ({
    commands: [
      { name: "sh.up", run: () => move(-1) },
      { name: "sh.down", run: () => move(1) },
      { name: "sh.pgup", run: () => move(-8) },
      { name: "sh.pgdn", run: () => move(8) },
      { name: "sh.home", run: () => goTo(0) },
      { name: "sh.end", run: () => goTo(rows().length - 1) },
      { name: "sh.submit", run: submit },
      { name: "sh.close", run: () => api.ui.dialog.clear() },
    ],
    bindings: keys.gather("sh", ["sh.up", "sh.down", "sh.pgup", "sh.pgdn", "sh.home", "sh.end", "sh.submit", "sh.close"]),
  }))

  onCleanup(() => {
    if (timer) clearTimeout(timer)
    if (noticeTimer) clearTimeout(noticeTimer)
  })

  const runSearch = (q: string) => {
    setRows(search(api, scope, cwd, q))
    setResultQuery(q.trim())
    setSelected(0)
    if (scroll) scroll.scrollTo(0)
  }

  const maxH = () => Math.max(8, Math.floor(dim().height / 2) - 3)

  return (
    <box flexDirection="column" flexGrow={1} gap={1} paddingBottom={1}>
      <box paddingLeft={4} paddingRight={4} flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {scope === "dir" ? `Search history — This dir (${shortDir(cwd)})` : "Search history — Anywhere"}
        </text>
        <text fg={theme.textMuted}>esc to close</text>
      </box>

      <Show when={copyNotice()}>
        {(notice) => (
          <box paddingLeft={4} paddingRight={4}>
            <box
              flexDirection="column"
              gap={0}
              paddingLeft={2}
              paddingRight={2}
              paddingTop={1}
              paddingBottom={1}
              backgroundColor={theme.backgroundPanel}
            >
              <text fg={notice().variant === "success" ? theme.success : theme.warning} attributes={TextAttributes.BOLD}>
                {notice().title}
              </text>
              <text fg={theme.textMuted} overflow="hidden" wrapMode="none">
                {notice().message}
              </text>
            </box>
          </box>
        )}
      </Show>

      <box paddingLeft={4} paddingRight={4}>
        <input
          placeholder="Type to full-text search session titles and content…"
          placeholderColor={theme.textMuted}
          focusedBackgroundColor={theme.backgroundPanel}
          cursorColor={theme.primary}
          ref={(r: InputRenderable) => {
            inputRef = r
            setTimeout(() => {
              if (inputRef && !inputRef.isDestroyed) inputRef.focus()
            }, 1)
          }}
          onInput={(e: string) => {
            if (timer) clearTimeout(timer)
            timer = setTimeout(() => runSearch(e), 250)
          }}
        />
      </box>

      <scrollbox
        paddingLeft={1}
        paddingRight={1}
        scrollbarOptions={{ visible: false }}
        maxHeight={maxH()}
        ref={(r: ScrollBoxRenderable) => {
          scroll = r
        }}
      >
        <Show
          when={rows().length > 0}
          fallback={
            <box paddingLeft={4} paddingRight={4} paddingTop={1}>
              <text fg={theme.textMuted}>(no sessions found)</text>
            </box>
          }
        >
          <For each={rows()}>
            {(r, i) => {
              const isSel = createMemo(() => i() === selected())
              const titleFg = () => (isSel() ? selFg : theme.text)
              const metaFg = () => (isSel() ? selFg : theme.textMuted)
              return (
                <box
                  flexDirection="column"
                  backgroundColor={isSel() ? theme.primary : TRANSPARENT}
                  paddingLeft={3}
                  paddingRight={3}
                  onMouseOver={() => setSelected(i())}
                  onMouseUp={() => {
                    goTo(i())
                    submit()
                  }}
                >
                  <text fg={titleFg()} attributes={isSel() ? TextAttributes.BOLD : undefined} overflow="hidden" wrapMode="none">
                    {r.title || "(untitled)"}
                  </text>
                  <Show when={cleanSnippet(r.snippet, resultQuery())}>
                    {(snip) => (
                      <text fg={metaFg()} overflow="hidden" wrapMode="none">
                        <For each={splitHighlight(snip(), resultQuery())}>
                          {(p) => (
                            <span style={{ fg: p.match ? (isSel() ? selFg : theme.accent) : metaFg() }}>{p.text}</span>
                          )}
                        </For>
                      </text>
                    )}
                  </Show>
                  <text fg={metaFg()} overflow="hidden" wrapMode="none">
                    {relTime(r.time_updated)}
                  </text>
                  <Show when={scope === "anywhere"}>
                    <text fg={metaFg()} overflow="hidden" wrapMode="none">
                      in {shortDir(r.directory)}
                    </text>
                  </Show>
                </box>
              )
            }}
          </For>
        </Show>
      </scrollbox>
    </box>
  )
}

// ----------------------------------------------------------------------------
// Registration
// ----------------------------------------------------------------------------

function openResults(api: TuiPluginApi, scope: Scope) {
  try {
    getDb(api) // verifies the DB can be opened (otherwise a toast instead of an empty dialog)
  } catch (e) {
    api.ui.toast({
      variant: "error",
      title: "search-history",
      message: `Cannot open DB (${resolveDbPath(api)}): ${String(e)}`,
      duration: 7000,
    })
    return
  }
  api.ui.dialog.replace(() => <ResultsDialog api={api} scope={scope} />)
  // Only after replace — replace() resets size to "medium".
  api.ui.dialog.setSize("xlarge")
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "search-history.this-dir",
        title: "Search history — This dir",
        category: "Search history",
        namespace: "palette",
        slashName: "search-history-dir",
        run() {
          openResults(api, "dir")
        },
      },
      {
        name: "search-history.anywhere",
        title: "Search history — Anywhere",
        category: "Search history",
        namespace: "palette",
        slashName: "search-history-any",
        run() {
          openResults(api, "anywhere")
        },
      },
    ],
    bindings: [],
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "search-history",
  tui,
}

export default plugin
