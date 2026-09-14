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

interface Prefs {
  theme: "vs" | "vs-dark" | "hc-black" | "hc-light";
  fontSize: number;
  fontFamily: string;
  fontLigatures: boolean;
  cursorStyle:
    | "line"
    | "block"
    | "underline"
    | "line-thin"
    | "block-outline"
    | "underline-thin";
  tabSize: number;
  wordWrap: boolean;
  lineNumbers: boolean;
  minimap: boolean;
  renderWhitespace: boolean;
  renderControlCharacters: boolean;
  bracketPairColorization: boolean;
  stickyScroll: boolean;
  matchCase: boolean;
  windowLines: number;
}

const DEFAULT_PREFS: Prefs = {
  theme: "vs",
  fontSize: 14,
  fontFamily: "", // empty means Monaco's platform default
  fontLigatures: false,
  cursorStyle: "line",
  tabSize: 4,
  wordWrap: false,
  lineNumbers: true,
  minimap: false,
  renderWhitespace: false,
  renderControlCharacters: true,
  bracketPairColorization: false,
  stickyScroll: false,
  matchCase: false,
  windowLines: 4000,
};

const PREFS_KEY = "gfe.prefs";
let prefs: Prefs = { ...DEFAULT_PREFS };
let defaultFontFamily = "";

const windowLines = () => prefs.windowLines;
const reanchorMargin = () => Math.max(50, Math.floor(prefs.windowLines / 5));

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    prefs = raw
      ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) }
      : { ...DEFAULT_PREFS };
  } catch {
    prefs = { ...DEFAULT_PREFS };
  }
  prefs.windowLines = Math.min(Math.max(prefs.windowLines, 500), 20000);
  prefs.fontSize = Math.min(Math.max(prefs.fontSize, 8), 40);
  prefs.tabSize = Math.min(Math.max(prefs.tabSize, 1), 16);
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    setStatus("Preferences could not be saved");
  }
}

function applyPrefs() {
  monaco.editor.setTheme(prefs.theme);
  editor.updateOptions({
    fontSize: prefs.fontSize,
    fontFamily: prefs.fontFamily.trim() || defaultFontFamily,
    fontLigatures: prefs.fontLigatures,
    cursorStyle: prefs.cursorStyle,
    wordWrap: prefs.wordWrap ? "on" : "off",
    lineNumbers: prefs.lineNumbers
      ? (modelLine) => String(toFileLine(modelLine))
      : "off",
    minimap: { enabled: prefs.minimap },
    renderWhitespace: prefs.renderWhitespace ? "all" : "none",
    renderControlCharacters: prefs.renderControlCharacters,
    bracketPairColorization: { enabled: prefs.bracketPairColorization },
    stickyScroll: { enabled: prefs.stickyScroll },
    tabSize: prefs.tabSize,
    // Without this, Monaco infers tabSize from file contents and ignores the setting.
    detectIndentation: false,
  });
  editor.getModel()?.updateOptions({ tabSize: prefs.tabSize });
}

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
  const maxStart = Math.max(1, totalLines - windowLines() + 1);
  const newStart = Math.min(Math.max(1, Math.round(start)), maxStart);
  const end = Math.min(newStart + windowLines() - 1, totalLines);

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
    (windowStart > 1 && viewTop < windowStart + reanchorMargin()) ||
    (windowStart + windowCount - 1 < totalLines &&
      viewTop + visible > windowStart + windowCount - reanchorMargin());

  if (needsWindow) {
    await anchorWindow(viewTop - Math.floor((windowLines() - visible) / 2));
  }
  scrollToViewTop();
  updateScrollbar();
}

/** Re-anchors when native scrolling inside the window drifts too close to its edges. */
async function maybeReanchor() {
  if (reanchoring) return;
  const visible = linesPerScreen();
  const nearTop = windowStart > 1 && viewTop < windowStart + reanchorMargin();
  const nearBottom =
    windowStart + windowCount - 1 < totalLines &&
    viewTop + visible > windowStart + windowCount - reanchorMargin();
  if (!nearTop && !nearBottom) return;

  reanchoring = true;
  try {
    await anchorWindow(viewTop - Math.floor((windowLines() - visible) / 2));
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
    const range = new monaco.Range(
      startLine,
      hit.column,
      endLine,
      hit.end_column
    );
    syncing = true;
    editor.setSelection(range);
    editor.revealRangeInCenter(range, monaco.editor.ScrollType.Immediate);
    syncing = false;
  }
  updateHitControls();
}

/** Keys whose value is a boolean, so checkbox binding stays type-safe. */
type BoolPrefKey = {
  [K in keyof Prefs]: Prefs[K] extends boolean ? K : never;
}[keyof Prefs];

/** Pushes current prefs into every control, so the toolbar and the panel never disagree. */
function syncPrefControls() {
  const set = (id: string, fn: (el: HTMLInputElement) => void) => {
    const el = document.querySelector<HTMLInputElement>(id);
    if (el) fn(el);
  };
  const theme = document.querySelector<HTMLSelectElement>("#pref-theme");
  if (theme) theme.value = prefs.theme;
  const cursor = document.querySelector<HTMLSelectElement>("#pref-cursor-style");
  if (cursor) cursor.value = prefs.cursorStyle;
  set("#pref-font-size", (el) => (el.value = String(prefs.fontSize)));
  set("#pref-font-family", (el) => (el.value = prefs.fontFamily));
  set("#pref-ligatures", (el) => (el.checked = prefs.fontLigatures));
  set("#pref-tab-size", (el) => (el.value = String(prefs.tabSize)));
  set("#pref-word-wrap", (el) => (el.checked = prefs.wordWrap));
  set("#pref-line-numbers", (el) => (el.checked = prefs.lineNumbers));
  set("#pref-minimap", (el) => (el.checked = prefs.minimap));
  set("#pref-whitespace", (el) => (el.checked = prefs.renderWhitespace));
  set(
    "#pref-control-chars",
    (el) => (el.checked = prefs.renderControlCharacters)
  );
  set(
    "#pref-bracket-colors",
    (el) => (el.checked = prefs.bracketPairColorization)
  );
  set("#pref-sticky-scroll", (el) => (el.checked = prefs.stickyScroll));
  set("#pref-match-case", (el) => (el.checked = prefs.matchCase));
  set("#pref-window-lines", (el) => (el.value = String(prefs.windowLines)));
  set("#word-wrap", (el) => (el.checked = prefs.wordWrap));
  set("#match-case", (el) => (el.checked = prefs.matchCase));
}

/** Applies a preference change everywhere and persists it. */
async function updatePref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  const windowChanged = key === "windowLines" && value !== prefs.windowLines;
  prefs[key] = value;
  savePrefs();
  applyPrefs();
  syncPrefControls();

  if (windowChanged) {
    await anchorWindow(viewTop - Math.floor(windowLines() / 2));
  }
  // Wrapping and font size change visual line heights, so re-pin to the same file line.
  scrollToViewTop();
  updateScrollbar();
}

function wirePreferences() {
  const overlay = document.querySelector<HTMLElement>("#prefs-overlay");
  const open = () => {
    syncPrefControls();
    overlay?.removeAttribute("hidden");
  };
  const close = () => overlay?.setAttribute("hidden", "");

  document.querySelector("#prefs-btn")?.addEventListener("click", open);
  document.querySelector("#prefs-close")?.addEventListener("click", close);
  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  document.querySelector("#prefs-reset")?.addEventListener("click", () => {
    prefs = { ...DEFAULT_PREFS };
    savePrefs();
    applyPrefs();
    syncPrefControls();
    void anchorWindow(viewTop - Math.floor(windowLines() / 2)).then(() => {
      scrollToViewTop();
      updateScrollbar();
    });
  });

  const bindCheckbox = (id: string, key: BoolPrefKey) =>
    document.querySelector(id)?.addEventListener("change", (e) => {
      void updatePref(key, (e.target as HTMLInputElement).checked);
    });

  bindCheckbox("#pref-word-wrap", "wordWrap");
  bindCheckbox("#pref-line-numbers", "lineNumbers");
  bindCheckbox("#pref-minimap", "minimap");
  bindCheckbox("#pref-whitespace", "renderWhitespace");
  bindCheckbox("#pref-control-chars", "renderControlCharacters");
  bindCheckbox("#pref-bracket-colors", "bracketPairColorization");
  bindCheckbox("#pref-sticky-scroll", "stickyScroll");
  bindCheckbox("#pref-ligatures", "fontLigatures");
  bindCheckbox("#pref-match-case", "matchCase");
  bindCheckbox("#word-wrap", "wordWrap");

  const bindNumber = (
    id: string,
    key: "fontSize" | "tabSize" | "windowLines",
    min: number,
    max: number
  ) =>
    document.querySelector(id)?.addEventListener("change", (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(v)) {
        void updatePref(key, Math.min(Math.max(Math.round(v), min), max));
      }
    });

  bindNumber("#pref-font-size", "fontSize", 8, 40);
  bindNumber("#pref-tab-size", "tabSize", 1, 16);
  bindNumber("#pref-window-lines", "windowLines", 500, 20000);

  document.querySelector("#pref-theme")?.addEventListener("change", (e) => {
    void updatePref(
      "theme",
      (e.target as HTMLSelectElement).value as Prefs["theme"]
    );
  });

  document
    .querySelector("#pref-cursor-style")
    ?.addEventListener("change", (e) => {
      void updatePref(
        "cursorStyle",
        (e.target as HTMLSelectElement).value as Prefs["cursorStyle"]
      );
    });

  document
    .querySelector("#pref-font-family")
    ?.addEventListener("change", (e) => {
      void updatePref("fontFamily", (e.target as HTMLInputElement).value);
    });
}

window.addEventListener("DOMContentLoaded", () => {
  const container = document.querySelector<HTMLDivElement>("#editor-container");
  if (!container) return;

  const chooseFile = () => {
    void (async () => {
      setStatus("Choose a file…");
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: "Open a text file",
      });
      if (typeof selected === "string") await openFile(selected);
    })().catch((err) => setStatus(`Open failed: ${err}`));
  };
  document.querySelector("#open-btn")?.addEventListener("click", chooseFile);
  wirePreferences();

  loadPrefs();

  editor = monaco.editor.create(container, {
    value: "",
    language: "plaintext",
    automaticLayout: true,
    scrollBeyondLastLine: false,
    scrollbar: { vertical: "hidden", verticalScrollbarSize: 0 },
    // Everything loads as plaintext, so Monaco's "tokenization skipped on long lines" and
    // "rendering paused" hovers warn about work this app never does.
    hover: { showLongLineWarning: false },
  });

  // Captured before any preference is applied, so "default" font can be restored later.
  defaultFontFamily = editor.getOption(monaco.editor.EditorOption.fontFamily);
  applyPrefs();
  syncPrefControls();

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
    void updatePref("matchCase", currentMatchCase());
  });

  void invoke<string | null>("startup_path")
    .then((path) => (path ? openFile(path) : undefined))
    .catch((err) => setStatus(`Open failed: ${err}`));
});
