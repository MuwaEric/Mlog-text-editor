import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";

// Monaco resolves its workers through this global; without it the bundled build fails to start.
self.MonacoEnvironment = { getWorker: () => new editorWorker() };

// Monaco's model holds a bounded WINDOW of the file, never the whole thing. Giving it the real
// line count is fatal twice over: the model allocates per-line state for every line, and the
// compositor allocates tile memory for a scroll layer lineCount * lineHeight pixels tall (1M
// lines is ~19 million pixels, which exhausted RAM as soon as the user scrolled).
//
// Consequences of windowing: Monaco's own scrollbar would only describe the window, so it is
// hidden and replaced by a custom one spanning the file; and model line N is file line
// windowStart + N - 1, so every position crossing the IPC boundary must be translated.
const WINDOW_LINES = 4000;
const REANCHOR_MARGIN = 800;

interface FileMeta {
  total_lines: number;
  size_bytes: number;
}

interface SearchHit {
  byte_offset: number;
  line: number;
  column: number;
  end_line: number;
  end_column: number;
}

interface SearchResult {
  total_matches: number;
  truncated: boolean;
  hits: SearchHit[];
}

let editor: monaco.editor.IStandaloneCodeEditor;
let totalLines = 1;
let windowStart = 1; // file line shown as model line 1
let windowCount = 0; // lines currently in the model
let viewTop = 1; // file line at the top of the viewport
let syncing = false; // suppresses scroll/content handling while we re-anchor
let reanchoring = false;
let pendingEdits: Promise<unknown> = Promise.resolve();

let hits: SearchHit[] = [];
let hitIndex = -1;
let hitsTruncated = false;
let lastQuery: string | null = null;
let lastMatchCase = false;

const toFileLine = (modelLine: number) => windowStart + modelLine - 1;
const toModelLine = (fileLine: number) => fileLine - windowStart + 1;

function setStatus(message: string) {
  const el = document.querySelector<HTMLElement>("#status");
  if (el) el.textContent = message;
}

function lineHeight(): number {
  return editor.getOption(monaco.editor.EditorOption.lineHeight);
}

/** First and last *model* lines on screen. Reflects wrapping, unlike scrollTop arithmetic. */
function visibleModelRange(): { start: number; end: number } | null {
  const ranges = editor.getVisibleRanges();
  if (!ranges.length) return null;
  return {
    start: ranges[0].startLineNumber,
    end: ranges[ranges.length - 1].endLineNumber,
  };
}

function linesPerScreen(): number {
  const r = visibleModelRange();
  if (r) return Math.max(1, r.end - r.start + 1);
  return Math.max(1, Math.floor(editor.getLayoutInfo().height / lineHeight()));
}

function maxViewTop(): number {
  return Math.max(1, totalLines - linesPerScreen() + 1);
}

/** Loads a fresh window of lines into the model, starting at `start`. */
async function anchorWindow(start: number) {
  const maxStart = Math.max(1, totalLines - WINDOW_LINES + 1);
  const newStart = Math.min(Math.max(1, Math.round(start)), maxStart);
  const end = Math.min(newStart + WINDOW_LINES - 1, totalLines);

  await pendingEdits; // never read lines the backend has not applied edits to yet
  const raw = await invoke<string>("get_lines", {
    startLine: newStart,
    endLine: end,
  });
  // Every line arrives newline-terminated; keeping the last one would add a phantom empty line.
  const text = end < totalLines ? raw.replace(/\n$/, "") : raw;

  const model = editor.getModel();
  if (!model) return;
  syncing = true;
  model.setValue(text);
  windowStart = newStart;
  windowCount = model.getLineCount();
  syncing = false;
}

function scrollToViewTop() {
  syncing = true;
  // getTopForLineNumber accounts for wrapped lines; scrollTop/lineHeight would not.
  const modelLine = Math.min(
    Math.max(1, toModelLine(viewTop)),
    Math.max(1, windowCount)
  );
  editor.setScrollTop(editor.getTopForLineNumber(modelLine));
  syncing = false;
}

/** Moves the viewport so `fileLine` is the top visible line, re-anchoring the window if needed. */
async function goToLine(fileLine: number) {
  viewTop = Math.min(Math.max(1, Math.round(fileLine)), maxViewTop());
  const visible = linesPerScreen();
  const needsWindow =
    windowCount === 0 ||
    (windowStart > 1 && viewTop < windowStart + REANCHOR_MARGIN) ||
    (windowStart + windowCount - 1 < totalLines &&
      viewTop + visible > windowStart + windowCount - REANCHOR_MARGIN);

  if (needsWindow) {
    await anchorWindow(viewTop - Math.floor((WINDOW_LINES - visible) / 2));
  }
  scrollToViewTop();
  updateScrollbar();
}

/** Re-anchors when native scrolling inside the window drifts too close to its edges. */
async function maybeReanchor() {
  if (reanchoring) return;
  const visible = linesPerScreen();
  const nearTop = windowStart > 1 && viewTop < windowStart + REANCHOR_MARGIN;
  const nearBottom =
    windowStart + windowCount - 1 < totalLines &&
    viewTop + visible > windowStart + windowCount - REANCHOR_MARGIN;
  if (!nearTop && !nearBottom) return;

  reanchoring = true;
  try {
    await anchorWindow(viewTop - Math.floor((WINDOW_LINES - visible) / 2));
    scrollToViewTop();
    updateScrollbar();
  } finally {
    reanchoring = false;
  }
}

// --- custom scrollbar spanning the whole file -------------------------------------------------

function updateScrollbar() {
  const track = document.querySelector<HTMLElement>("#vscroll");
  const thumb = document.querySelector<HTMLElement>("#vthumb");
  if (!track || !thumb) return;

  const trackH = track.clientHeight;
  const frac = Math.min(1, linesPerScreen() / Math.max(1, totalLines));
  const thumbH = Math.max(24, Math.round(trackH * frac));
  const span = maxViewTop() - 1;
  const pos = span > 0 ? (viewTop - 1) / span : 0;

  thumb.style.height = `${thumbH}px`;
  thumb.style.transform = `translateY(${Math.round(pos * (trackH - thumbH))}px)`;
}

function wireScrollbar() {
  const track = document.querySelector<HTMLElement>("#vscroll");
  const thumb = document.querySelector<HTMLElement>("#vthumb");
  if (!track || !thumb) return;

  let dragging = false;

  const lineFromClientY = (clientY: number) => {
    const rect = track.getBoundingClientRect();
    const thumbH = thumb.clientHeight;
    const usable = Math.max(1, rect.height - thumbH);
    const pos = (clientY - rect.top - thumbH / 2) / usable;
    return 1 + Math.min(Math.max(0, pos), 1) * (maxViewTop() - 1);
  };

  thumb.addEventListener("pointerdown", (e) => {
    dragging = true;
    thumb.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  thumb.addEventListener("pointermove", (e) => {
    if (dragging) void goToLine(lineFromClientY(e.clientY));
  });
  const stop = (e: PointerEvent) => {
    dragging = false;
    thumb.releasePointerCapture(e.pointerId);
  };
  thumb.addEventListener("pointerup", stop);
  thumb.addEventListener("pointercancel", stop);

  track.addEventListener("pointerdown", (e) => {
    if (e.target !== thumb) void goToLine(lineFromClientY(e.clientY));
  });
}

// --- file loading -----------------------------------------------------------------------------

async function openFile(path: string) {
  setStatus("Opening & scanning line offsets…");
  const meta = await invoke<FileMeta>("open_file", { path });
  totalLines = meta.total_lines;
  windowStart = 1;
  windowCount = 0;
  viewTop = 1;

  const nameEl = document.querySelector<HTMLElement>("#file-name");
  if (nameEl) nameEl.textContent = path.split("/").pop() ?? path;

  hits = [];
  hitIndex = -1;
  lastQuery = null;
  updateHitControls();

  await anchorWindow(1);
  scrollToViewTop();
  updateScrollbar();
  setStatus(
    `${meta.total_lines.toLocaleString()} lines · ${meta.size_bytes.toLocaleString()} bytes`
  );
}

/**
 * Forwards user edits to the piece table. Monaco columns are 1-based UTF-16 offsets and its
 * lines are window-relative, so both are translated before crossing the IPC boundary.
 */
function wireEditEvents() {
  editor.onDidChangeModelContent((e) => {
    if (syncing) return;

    for (const change of e.changes) {
      const { range, text, rangeLength } = change;
      const startLine = toFileLine(range.startLineNumber);
      const endLine = toFileLine(range.endLineNumber);
      // Serialize edits: each one shifts the positions the next is expressed against.
      pendingEdits = pendingEdits
        .then(async () => {
          if (rangeLength > 0) {
            totalLines = await invoke<number>("delete_text", {
              startLine,
              startColumn: range.startColumn,
              endLine,
              endColumn: range.endColumn,
            });
          }
          if (text.length > 0) {
            totalLines = await invoke<number>("insert_text", {
              line: startLine,
              column: range.startColumn,
              text,
            });
          }
        })
        .catch((err) => setStatus(`Edit failed: ${err}`));
    }

    const model = editor.getModel();
    if (model) windowCount = model.getLineCount();
    updateScrollbar();
  });
}

async function runSearch(query: string) {
  if (!query) return;
  const matchCase =
    document.querySelector<HTMLInputElement>("#match-case")?.checked ?? false;
  setStatus("Searching…");
  await pendingEdits;
  const result = await invoke<SearchResult>("search_text", { query, matchCase });
  const shown = result.truncated ? ` (first ${result.hits.length} navigable)` : "";
  setStatus(`${result.total_matches.toLocaleString()} match(es)${shown}`);

  hits = result.hits;
  hitsTruncated = result.truncated;
  hitIndex = -1;
  lastQuery = query;
  lastMatchCase = matchCase;
  updateHitControls();

  if (hits.length > 0) await gotoHit(0);
}

function updateHitControls() {
  const counter = document.querySelector<HTMLElement>("#hit-counter");
  const prev = document.querySelector<HTMLButtonElement>("#prev-hit");
  const next = document.querySelector<HTMLButtonElement>("#next-hit");
  if (counter) {
    counter.textContent = hits.length
      ? `${hitIndex + 1}/${hits.length}${hitsTruncated ? "+" : ""}`
      : "";
  }
  if (prev) prev.disabled = hits.length === 0;
  if (next) next.disabled = hits.length === 0;
}

/** Centres the given match in the viewport and selects it. Wraps around at either end. */
async function gotoHit(index: number) {
  if (!hits.length) return;
  hitIndex = ((index % hits.length) + hits.length) % hits.length;
  const hit = hits[hitIndex];

  await goToLine(hit.line - Math.floor(linesPerScreen() / 2));

  const startLine = toModelLine(hit.line);
  const endLine = toModelLine(hit.end_line);
  if (startLine >= 1 && endLine <= windowCount) {
    syncing = true;
    editor.setSelection(
      new monaco.Range(startLine, hit.column, endLine, hit.end_column)
    );
    syncing = false;
  }
  updateHitControls();
}

window.addEventListener("DOMContentLoaded", () => {
  const container = document.querySelector<HTMLDivElement>("#editor-container");
  if (!container) return;

  editor = monaco.editor.create(container, {
    value: "",
    language: "plaintext",
    automaticLayout: true,
    minimap: { enabled: false },
    wordWrap: "off",
    scrollBeyondLastLine: false,
    scrollbar: { vertical: "hidden", verticalScrollbarSize: 0 },
    // Everything loads as plaintext, so Monaco's "tokenization skipped on long lines" and
    // "rendering paused" hovers warn about work this app never does.
    hover: { showLongLineWarning: false },
    lineNumbers: (modelLine) => String(toFileLine(modelLine)),
  });

  editor.onDidScrollChange(() => {
    if (syncing) return;
    const r = visibleModelRange();
    if (!r) return;
    viewTop = toFileLine(r.start);
    updateScrollbar();
    void maybeReanchor();
  });
  editor.onDidLayoutChange(() => updateScrollbar());

  wireEditEvents();
  wireScrollbar();

  void listen<{ bytes_scanned: number; total_bytes: number }>(
    "scan-progress",
    ({ payload }) => {
      if (payload.total_bytes === 0) return;
      const pct = Math.floor(
        (payload.bytes_scanned / payload.total_bytes) * 100
      );
      setStatus(`Scanning line offsets… ${pct}%`);
    }
  );

  document.querySelector("#open-btn")?.addEventListener("click", () => {
    void (async () => {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: "Open a text file",
      });
      if (typeof selected === "string") await openFile(selected);
    })().catch((err) => setStatus(`Open failed: ${err}`));
  });

  const searchInput =
    document.querySelector<HTMLInputElement>("#search-input");
  const matchCaseBox =
    document.querySelector<HTMLInputElement>("#match-case");

  const currentMatchCase = () => matchCaseBox?.checked ?? false;
  const search = () => {
    const query = searchInput?.value ?? "";
    void runSearch(query).catch((err) => setStatus(`Search failed: ${err}`));
  };

  // Monaco has no option to disable its find widget, and it would only ever search the loaded
  // window, so its keybindings are captured and routed to the file-wide search instead.
  const focusSearch = () => {
    searchInput?.focus();
    searchInput?.select();
  };
  const noop = () => {};
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, focusSearch);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH, focusSearch);
  editor.addCommand(monaco.KeyCode.F3, () => void gotoHit(hitIndex + 1));
  editor.addCommand(
    monaco.KeyMod.Shift | monaco.KeyCode.F3,
    () => void gotoHit(hitIndex - 1)
  );
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.F3, noop);
  editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.F3,
    noop
  );

  document.querySelector("#search-btn")?.addEventListener("click", search);

  // Enter steps through existing results; it only re-runs the search when the query changed.
  searchInput?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const stale =
      searchInput.value !== lastQuery || currentMatchCase() !== lastMatchCase;
    if (stale || hits.length === 0) {
      search();
    } else {
      void gotoHit(hitIndex + (e.shiftKey ? -1 : 1));
    }
  });

  document
    .querySelector("#prev-hit")
    ?.addEventListener("click", () => void gotoHit(hitIndex - 1));
  document
    .querySelector("#next-hit")
    ?.addEventListener("click", () => void gotoHit(hitIndex + 1));

  matchCaseBox?.addEventListener("change", () => {
    lastQuery = null; // force a fresh search rather than stepping stale results
  });

  document.querySelector("#word-wrap")?.addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    editor.updateOptions({ wordWrap: on ? "on" : "off" });
    // Wrapping changes visual line heights, so re-pin the viewport to the same file line.
    scrollToViewTop();
    updateScrollbar();
  });

  void invoke<string | null>("startup_path")
    .then((path) => (path ? openFile(path) : undefined))
    .catch((err) => setStatus(`Open failed: ${err}`));
});
