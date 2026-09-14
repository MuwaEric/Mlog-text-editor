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

const toFileLine = (modelLine: number) => windowStart + modelLine - 1;
const toModelLine = (fileLine: number) => fileLine - windowStart + 1;

function setStatus(message: string) {
  const el = document.querySelector<HTMLElement>("#status");
  if (el) el.textContent = message;
}

function lineHeight(): number {
  return editor.getOption(monaco.editor.EditorOption.lineHeight);
}

function linesPerScreen(): number {
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
  editor.setScrollTop(Math.max(0, (viewTop - windowStart) * lineHeight()));
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
  setStatus("Searching…");
  await pendingEdits;
  const result = await invoke<SearchResult>("search_text", { query });
  const shown = result.truncated ? ` (showing first ${result.hits.length})` : "";
  setStatus(`${result.total_matches.toLocaleString()} match(es)${shown}`);

  if (result.hits.length > 0) {
    const hit = result.hits[0];
    await goToLine(hit.line - Math.floor(linesPerScreen() / 2));
    const modelLine = toModelLine(hit.line);
    if (modelLine >= 1 && modelLine <= windowCount) {
      editor.setPosition({ lineNumber: modelLine, column: hit.column });
      editor.focus();
    }
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const container = document.querySelector<HTMLDivElement>("#editor-container");
  if (!container) return;

  editor = monaco.editor.create(container, {
    value: "",
    language: "plaintext",
    automaticLayout: true,
    minimap: { enabled: false },
    // Word wrap would break the 1:1 model-line-to-file-line mapping.
    wordWrap: "off",
    scrollBeyondLastLine: false,
    scrollbar: { vertical: "hidden", verticalScrollbarSize: 0 },
    lineNumbers: (modelLine) => String(toFileLine(modelLine)),
  });

  editor.onDidScrollChange(() => {
    if (syncing) return;
    viewTop = windowStart + Math.round(editor.getScrollTop() / lineHeight());
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

  document.querySelector("#search-btn")?.addEventListener("click", () => {
    const query =
      document.querySelector<HTMLInputElement>("#search-input")?.value ?? "";
    void runSearch(query).catch((err) => setStatus(`Search failed: ${err}`));
  });

  void invoke<string | null>("startup_path")
    .then((path) => (path ? openFile(path) : undefined))
    .catch((err) => setStatus(`Open failed: ${err}`));
});
