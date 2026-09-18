import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
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
  readOnly: boolean;
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
  readOnly: false,
  windowLines: 4000,
};

const PREFS_KEY = "gfe.prefs";
const SEARCH_HISTORY_KEY = "gfe.search-history";
const REPLACE_HISTORY_KEY = "gfe.replace-history";
let prefs: Prefs = { ...DEFAULT_PREFS };
let defaultFontFamily = "";

function readHistory(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function writeHistory(key: string, entries: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(entries.slice(0, 12)));
  } catch {}
}

function updateHistoryDatalist() {
  const searchList = document.querySelector<HTMLDataListElement>("#search-history-list");
  const replaceList = document.querySelector<HTMLDataListElement>("#replace-history-list");
  const searchHistory = readHistory(SEARCH_HISTORY_KEY);
  const replaceHistory = readHistory(REPLACE_HISTORY_KEY);

  if (searchList) {
    searchList.innerHTML = searchHistory
      .map((value) => `<option value="${value.replace(/"/g, "&quot;")}"></option>`)
      .join("");
  }
  if (replaceList) {
    replaceList.innerHTML = replaceHistory
      .map((value) => `<option value="${value.replace(/"/g, "&quot;")}"></option>`)
      .join("");
  }
}

function recordHistoryEntry(key: string, value: string) {
  const trimmed = value.trim();
  if (!trimmed) return;
  const current = readHistory(key);
  const next = [trimmed, ...current.filter((entry) => entry !== trimmed)].slice(0, 12);
  writeHistory(key, next);
  updateHistoryDatalist();
}

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
    readOnly: prefs.readOnly,
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
  updateDocumentState();
}

interface FileMeta {
  total_lines: number;
  size_bytes: number;
  newline: string;
  encoding: string;
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

interface SearchProgress {
  request_id: number;
  bytes_scanned: number;
  total_bytes: number;
  matches_found: number;
  hits: SearchHit[];
}

let editor: monaco.editor.IStandaloneCodeEditor;
let totalLines = 1;
let windowStart = 1; // file line shown as model line 1
let windowCount = 0; // lines currently in the model
let viewTop = 1; // file line at the top of the viewport
let syncing = false; // suppresses scroll/content handling while we re-anchor
let reanchoring = false;
let navRequestId = 0;
let pendingEdits: Promise<unknown> = Promise.resolve();

let hits: SearchHit[] = [];
let hitIndex = -1;
let hitsTruncated = false;
let lastQuery: string | null = null;
let lastMatchCase = false;
let lastWholeWord = false;
let lastRegex = false;
let searchDecorationIds: string[] = [];
let searchRequestId = 0;
let activeSearchRequestId: number | null = null;
let streamedNavigationRequestId: number | null = null;
let positionRequestId = 0;
let currentPath: string | null = null;
let dirty = false;

const RECOVERY_KEY = "gfe.recovery";
const LINE_CACHE_KEY = "gfe.line-cache";

interface RecoveryRecord {
  path: string;
  timestamp: number;
}

interface FilePositionRecord {
  line: number;
  column: number;
}

function readLineCache(): Record<string, FilePositionRecord> {
  try {
    const raw = localStorage.getItem(LINE_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, FilePositionRecord>) : {};
  } catch {
    return {};
  }
}

function writeLineCache(path: string, position: FilePositionRecord) {
  try {
    const cache = readLineCache();
    cache[path] = position;
    localStorage.setItem(LINE_CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

function persistRecoveryState() {
  if (!currentPath || !dirty) return;
  try {
    const record: RecoveryRecord = {
      path: currentPath,
      timestamp: Date.now(),
    };
    localStorage.setItem(RECOVERY_KEY, JSON.stringify(record));
  } catch {}
}

function clearRecoveryState() {
  try {
    localStorage.removeItem(RECOVERY_KEY);
  } catch {}
}

function checkRecoveryState(path: string): boolean {
  try {
    const raw = localStorage.getItem(RECOVERY_KEY);
    if (!raw) return false;
    const record = JSON.parse(raw) as RecoveryRecord;
    return record.path === path;
  } catch {
    return false;
  }
}

const toFileLine = (modelLine: number) => windowStart + modelLine - 1;
const toModelLine = (fileLine: number) => fileLine - windowStart + 1;

/** Paints navigable search hits in the current bounded Monaco window. */
function updateSearchDecorations() {
  if (!editor) return;
  const decorations: monaco.editor.IModelDeltaDecoration[] = [];
  for (let index = 0; index < hits.length; index++) {
    const hit = hits[index];
    const startLine = toModelLine(hit.line);
    const endLine = toModelLine(hit.end_line);
    if (startLine < 1 || endLine > windowCount) continue;
    decorations.push({
      range: new monaco.Range(
        startLine,
        hit.column,
        endLine,
        hit.end_column
      ),
      options: {
        inlineClassName:
          index === hitIndex ? "gfe-search-current" : "gfe-search-match",
        overviewRuler: {
          color: index === hitIndex ? "#22d3ee" : "#f59e0b",
          position: monaco.editor.OverviewRulerLane.Center,
        },
      },
    });
  }
  searchDecorationIds = editor.deltaDecorations(
    searchDecorationIds,
    decorations
  );
}

function setStatus(message: string) {
  const el = document.querySelector<HTMLElement>("#status");
  if (el) el.textContent = message;
}

function updateDocumentState() {
  const save = document.querySelector<HTMLButtonElement>("#save-btn");
  const saveAs = document.querySelector<HTMLButtonElement>("#save-as-btn");
  const gotoBtn = document.querySelector<HTMLButtonElement>("#goto-btn");
  const convertCrlf = document.querySelector<HTMLButtonElement>("#convert-crlf-btn");
  const convertLf = document.querySelector<HTMLButtonElement>("#convert-lf-btn");
  const replaceBtn = document.querySelector<HTMLButtonElement>("#replace-btn");
  const replaceAllBtn = document.querySelector<HTMLButtonElement>("#replace-all-btn");
  const name = document.querySelector<HTMLElement>("#file-name");

  const hasModel = !!editor?.getModel();
  const hasFile = Boolean(currentPath);
  const isReadOnly = prefs.readOnly;

  if (save) save.disabled = !hasModel || !dirty || isReadOnly;
  if (saveAs) saveAs.disabled = !hasModel || isReadOnly;
  if (gotoBtn) gotoBtn.disabled = !hasFile;
  if (convertCrlf) convertCrlf.disabled = !hasFile || isReadOnly;
  if (convertLf) convertLf.disabled = !hasFile || isReadOnly;
  if (replaceBtn) replaceBtn.disabled = !hasFile || isReadOnly;
  if (replaceAllBtn) replaceAllBtn.disabled = !hasFile || isReadOnly;
  if (name) {
    const readOnlyTag = isReadOnly ? " [Read-Only]" : "";
    if (hasFile) {
      name.textContent = `${currentPath!.split("/").pop() ?? currentPath}${dirty ? " *" : ""}${readOnlyTag}`;
    } else if (hasModel) {
      name.textContent = `Untitled${dirty ? " *" : ""}${readOnlyTag}`;
    } else {
      name.textContent = `No file open`;
    }
  }
}

function updateHistoryControls() {
  const model = editor?.getModel();
  const undo = document.querySelector<HTMLButtonElement>("#undo-btn");
  const redo = document.querySelector<HTMLButtonElement>("#redo-btn");
  if (undo) undo.disabled = !model?.canUndo();
  if (redo) redo.disabled = !model?.canRedo();
}

async function saveDocument(path: string | null = currentPath) {
  if (!path) {
    const selected = await saveFileDialog({ title: "Save text file" });
    if (typeof selected !== "string") return;
    path = selected;
  }
  setStatus("Saving…");
  const meta = await invoke<FileMeta>("save_file", { path });
  currentPath = path;
  dirty = false;
  clearRecoveryState();
  updateDocumentState();
  setStatus(`${meta.total_lines.toLocaleString()} lines · ${meta.size_bytes.toLocaleString()} bytes · ${meta.newline} saved`);
}

async function convertLineEndingsTo(target: "LF" | "CRLF") {
  if (!currentPath) {
    return setStatus("No file open to convert line endings");
  }
  setStatus(`Converting line endings to ${target}…`);
  await pendingEdits;
  const meta = await invoke<FileMeta>("convert_line_endings", { targetFormat: target });
  totalLines = meta.total_lines;
  dirty = true;
  updateDocumentState();
  persistRecoveryState();
  const reqId = ++navRequestId;
  await anchorWindow(viewTop, reqId);
  if (reqId === navRequestId) {
    scrollToViewTop();
    updateScrollbar();
  }
  setStatus(`Converted line endings to ${meta.newline} (${meta.total_lines.toLocaleString()} lines)`);
}

function wireExternalChangeDialog() {
  const overlay = document.querySelector<HTMLElement>("#external-change-overlay");
  const reloadBtn = document.querySelector<HTMLButtonElement>("#reload-file-btn");
  const ignoreBtn = document.querySelector<HTMLButtonElement>("#ignore-change-btn");

  const close = () => {
    overlay?.setAttribute("hidden", "");
    editor?.focus();
  };

  reloadBtn?.addEventListener("click", () => {
    close();
    if (currentPath) {
      void openFile(currentPath);
    }
  });

  ignoreBtn?.addEventListener("click", close);
  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
}

function promptExternalChange() {
  const overlay = document.querySelector<HTMLElement>("#external-change-overlay");
  if (overlay && overlay.hasAttribute("hidden")) {
    overlay.removeAttribute("hidden");
  }
}

async function checkExternalChange() {
  if (!currentPath) return;
  const overlay = document.querySelector<HTMLElement>("#external-change-overlay");
  if (overlay && !overlay.hasAttribute("hidden")) return;

  try {
    const changed = await invoke<boolean>("check_file_changed");
    if (changed) {
      promptExternalChange();
    }
  } catch {}
}

function wireGotoDialog() {
  const overlay = document.querySelector<HTMLElement>("#goto-overlay");
  const input = document.querySelector<HTMLInputElement>("#goto-input");
  const submitBtn = document.querySelector<HTMLButtonElement>("#goto-submit-btn");
  const closeBtn = document.querySelector<HTMLButtonElement>("#goto-close-btn");

  const close = () => {
    overlay?.setAttribute("hidden", "");
    editor?.focus();
  };

  const submit = () => {
    const value = input?.value.trim();
    if (!value) return close();
    void (async () => {
      if (value.startsWith("byte:")) {
        const offset = Number(value.slice(5).trim());
        if (!Number.isSafeInteger(offset) || offset < 0) return setStatus("Invalid byte offset");
        const [line, column] = await invoke<[number, number]>("position_at_byte", { offset });
        await goToLine(line);
        editor.setPosition({ lineNumber: toModelLine(line), column });
        close();
        return;
      }
      const parts = value.split(":").map(Number);
      const line = parts[0];
      const column = parts.length > 1 ? parts[1] : 1;
      if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) {
        return setStatus("Invalid line or column");
      }
      await goToLine(line);
      editor.setPosition({ lineNumber: toModelLine(line), column });
      close();
    })().catch((err) => setStatus(`Navigation failed: ${err}`));
  };

  submitBtn?.addEventListener("click", submit);
  closeBtn?.addEventListener("click", close);
  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
}

function openGotoDialog() {
  const overlay = document.querySelector<HTMLElement>("#goto-overlay");
  const input = document.querySelector<HTMLInputElement>("#goto-input");
  if (overlay && input) {
    overlay.removeAttribute("hidden");
    input.value = "";
    input.focus();
  }
}

function goToPosition() {
  openGotoDialog();
}

function updatePosition(modelLine: number, column: number) {
  const position = document.querySelector<HTMLElement>("#position");
  if (!position) return;
  const fileLine = toFileLine(modelLine);
  position.textContent = `Ln ${fileLine.toLocaleString()}, Col ${column.toLocaleString()}`;
  if (!currentPath) return;
  const requestId = ++positionRequestId;
  void invoke<number>("byte_offset", { line: fileLine, column })
    .then((offset) => {
      if (requestId !== positionRequestId) return;
      position.textContent =
        `Ln ${fileLine.toLocaleString()}, Col ${column.toLocaleString()} · Byte ${offset.toLocaleString()}`;
    })
    .catch(() => undefined);
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

/** Loads a fresh window of lines into the model, starting at `start`. Returns true if applied. */
async function anchorWindow(start: number, reqId: number = navRequestId): Promise<boolean> {
  if (!currentPath) return false;
  const maxStart = Math.max(1, totalLines - windowLines() + 1);
  const newStart = Math.min(Math.max(1, Math.round(start)), maxStart);
  const end = Math.min(newStart + windowLines() - 1, totalLines);

  await pendingEdits; // never read lines the backend has not applied edits to yet
  if (reqId !== navRequestId) return false;

  const raw = await invoke<string>("get_lines", {
    startLine: newStart,
    endLine: end,
  });

  if (reqId !== navRequestId) return false;

  // Every line arrives newline-terminated; keeping the last one would add a phantom empty line.
  const text = end < totalLines ? raw.replace(/\n$/, "") : raw;

  const model = editor.getModel();
  if (!model) return false;
  syncing = true;
  model.setValue(text);
  windowStart = newStart;
  windowCount = model.getLineCount();
  updateSearchDecorations();
  syncing = false;
  return true;
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
  const reqId = ++navRequestId;
  viewTop = Math.min(Math.max(1, Math.round(fileLine)), maxViewTop());
  if (currentPath) {
    const pos = editor?.getPosition();
    writeLineCache(currentPath, {
      line: viewTop,
      column: pos ? pos.column : 1,
    });
  }
  const visible = linesPerScreen();
  const needsWindow =
    windowCount === 0 ||
    (windowStart > 1 && viewTop < windowStart + reanchorMargin()) ||
    (windowStart + windowCount - 1 < totalLines &&
      viewTop + visible > windowStart + windowCount - reanchorMargin());

  if (needsWindow) {
    const targetStart = viewTop - Math.floor((windowLines() - visible) / 2);
    const ok = await anchorWindow(targetStart, reqId);
    if (!ok || reqId !== navRequestId) return;
  }
  if (reqId !== navRequestId) return;
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
  const reqId = ++navRequestId;
  try {
    const targetStart = viewTop - Math.floor((windowLines() - visible) / 2);
    const ok = await anchorWindow(targetStart, reqId);
    if (ok && reqId === navRequestId) {
      scrollToViewTop();
      updateScrollbar();
    }
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
  let rafId: number | null = null;
  let lastClientY = 0;

  const lineFromClientY = (clientY: number) => {
    const rect = track.getBoundingClientRect();
    const thumbH = thumb.clientHeight;
    const usable = Math.max(1, rect.height - thumbH);
    const pos = (clientY - rect.top - thumbH / 2) / usable;
    return 1 + Math.min(Math.max(0, pos), 1) * (maxViewTop() - 1);
  };

  const processDrag = () => {
    rafId = null;
    if (dragging) {
      void goToLine(lineFromClientY(lastClientY));
    }
  };

  thumb.addEventListener("pointerdown", (e) => {
    dragging = true;
    thumb.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  thumb.addEventListener("pointermove", (e) => {
    if (dragging) {
      lastClientY = e.clientY;
      if (rafId === null) {
        rafId = requestAnimationFrame(processDrag);
      }
    }
  });
  const stop = (e: PointerEvent) => {
    if (dragging) {
      dragging = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      thumb.releasePointerCapture(e.pointerId);
      void goToLine(lineFromClientY(e.clientY));
    }
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

  const cachedPos = readLineCache()[path];
  const targetFileLine = cachedPos && Number.isFinite(cachedPos.line) ? Math.max(1, cachedPos.line) : 1;
  const targetCol = cachedPos && Number.isFinite(cachedPos.column) ? Math.max(1, cachedPos.column) : 1;
  viewTop = targetFileLine;

  const hasUnsavedRecovery = checkRecoveryState(path);
  const nameEl = document.querySelector<HTMLElement>("#file-name");
  if (nameEl) nameEl.textContent = path.split("/").pop() ?? path;
  currentPath = path;
  dirty = false;
  updateDocumentState();

  hits = [];
  hitIndex = -1;
  lastQuery = null;
  updateHitControls();

  const reqId = ++navRequestId;
  await anchorWindow(viewTop, reqId);
  if (reqId === navRequestId) {
    scrollToViewTop();
    updateScrollbar();
  }

  const modelLine = toModelLine(targetFileLine);
  if (modelLine >= 1 && modelLine <= windowCount) {
    editor.setPosition({ lineNumber: modelLine, column: targetCol });
  }

  const baseStatus = `${meta.total_lines.toLocaleString()} lines · ${meta.size_bytes.toLocaleString()} bytes · ${meta.newline} · ${meta.encoding}`;
  setStatus(
    hasUnsavedRecovery
      ? `${baseStatus} (⚠️ previous session had unsaved changes)`
      : baseStatus
  );
}

/**
 * Forwards user edits to the piece table. Monaco columns are 1-based UTF-16 offsets and its
 * lines are window-relative, so both are translated before crossing the IPC boundary.
 */
function wireEditEvents() {
  editor.onDidChangeModelContent((e) => {
    if (syncing || prefs.readOnly) return;

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
    dirty = true;
    updateDocumentState();
    updateHistoryControls();
    persistRecoveryState();
  });
}

async function runSearch(query: string) {
  if (!currentPath) return setStatus("Open a file to search");
  if (!query) return;
  const requestId = ++searchRequestId;
  activeSearchRequestId = requestId;
  streamedNavigationRequestId = null;
  hits = [];
  hitIndex = -1;
  updateSearchDecorations();
  updateHitControls();
  const matchCase =
    document.querySelector<HTMLInputElement>("#match-case")?.checked ?? false;
  const wholeWord =
    document.querySelector<HTMLInputElement>("#whole-word")?.checked ?? false;
  const regex =
    document.querySelector<HTMLInputElement>("#regex-search")?.checked ?? false;
  setStatus("Searching…");
  await pendingEdits;
  if (requestId !== searchRequestId) return;
  const result = await invoke<SearchResult>("search_text", {
    query,
    matchCase,
    requestId,
    wholeWord,
    regex,
  });
  if (requestId !== searchRequestId) return;
  activeSearchRequestId = null;
  const shown = result.truncated ? ` (first ${result.hits.length} navigable)` : "";
  setStatus(`${result.total_matches.toLocaleString()} match(es)${shown}`);

  hits = result.hits;
  hitsTruncated = result.truncated;
  hitIndex = -1;
  lastQuery = query;
  lastMatchCase = matchCase;
  lastWholeWord = wholeWord;
  lastRegex = regex;
  updateSearchDecorations();
  updateHitControls();

  if (hits.length > 0) await gotoHit(0);
}

function updateHitControls() {
  const counter = document.querySelector<HTMLInputElement>("#hit-counter");
  const prev = document.querySelector<HTMLButtonElement>("#prev-hit");
  const next = document.querySelector<HTMLButtonElement>("#next-hit");
  const replaceBtn = document.querySelector<HTMLButtonElement>("#replace-btn");
  const replaceAllBtn = document.querySelector<HTMLButtonElement>("#replace-all-btn");
  if (counter) {
    const value = hits.length ? `${hitIndex + 1}/${hits.length}${hitsTruncated ? "+" : ""}` : "";
    if (document.activeElement !== counter) {
      counter.value = value;
      counter.setAttribute("title", value ? `Jump to result ${hitIndex + 1}` : "No matches");
    }
  }
  const hasHits = hits.length > 0;
  const isReadOnly = prefs.readOnly;
  if (prev) prev.disabled = !hasHits;
  if (next) next.disabled = !hasHits;
  if (replaceBtn) replaceBtn.disabled = !currentPath || isReadOnly;
  if (replaceAllBtn) replaceAllBtn.disabled = !currentPath || isReadOnly;
}

function jumpToResultInput() {
  const counter = document.querySelector<HTMLInputElement>("#hit-counter");
  if (!counter || !hits.length) return;

  const raw = counter.value.trim();
  if (!raw) {
    counter.value = hits.length ? `${hitIndex + 1}/${hits.length}${hitsTruncated ? "+" : ""}` : "";
    return;
  }

  const normalized = raw.replace(/\s+/g, "").replace(/[^0-9/]+/g, "");
  if (!normalized) {
    counter.value = hits.length ? `${hitIndex + 1}/${hits.length}${hitsTruncated ? "+" : ""}` : "";
    return;
  }

  let target = Number(normalized.split("/")[0]);
  if (!Number.isFinite(target) || target < 1) {
    counter.value = hits.length ? `${hitIndex + 1}/${hits.length}${hitsTruncated ? "+" : ""}` : "";
    return;
  }

  target = Math.min(Math.max(Math.round(target), 1), hits.length);
  void gotoHit(target - 1);
  counter.value = `${target}/${hits.length}${hitsTruncated ? "+" : ""}`;
}

async function replaceCurrentMatch() {
  if (prefs.readOnly) return setStatus("Cannot replace: editor is in read-only mode");
  if (!currentPath) return setStatus("Open a file first");
  const searchInput = document.querySelector<HTMLInputElement>("#search-input");
  const query = searchInput?.value ?? "";
  if (!query) return setStatus("Enter search text to replace");

  if (hitIndex < 0 || hitIndex >= hits.length) {
    await runSearch(query);
    if (hits.length === 0) return setStatus("No matches found to replace");
  }

  const hit = hits[hitIndex];
  const replaceInput = document.querySelector<HTMLInputElement>("#replace-input");
  const replacement = replaceInput?.value ?? "";

  await pendingEdits;
  totalLines = await invoke<number>("replace_match", {
    startLine: hit.line,
    startColumn: hit.column,
    endLine: hit.end_line,
    endColumn: hit.end_column,
    text: replacement,
  });

  dirty = true;
  updateDocumentState();
  persistRecoveryState();
  let reqId = ++navRequestId;
  await anchorWindow(viewTop, reqId);
  if (reqId === navRequestId) {
    scrollToViewTop();
    updateScrollbar();
  }

  if (lastQuery) {
    await runSearch(lastQuery);
  }
}

async function replaceAllMatches() {
  if (prefs.readOnly) return setStatus("Cannot replace: editor is in read-only mode");
  if (!currentPath) return setStatus("Open a file first");
  const searchInput = document.querySelector<HTMLInputElement>("#search-input");
  const replaceInput = document.querySelector<HTMLInputElement>("#replace-input");
  const query = searchInput?.value ?? "";
  if (!query) return setStatus("Enter search text to replace all");
  const replacement = replaceInput?.value ?? "";

  const matchCase =
    document.querySelector<HTMLInputElement>("#match-case")?.checked ?? false;
  const wholeWord =
    document.querySelector<HTMLInputElement>("#whole-word")?.checked ?? false;
  const regex =
    document.querySelector<HTMLInputElement>("#regex-search")?.checked ?? false;

  await pendingEdits;
  setStatus("Replacing all occurrences…");
  const result = await invoke<{ replaced_count: number; total_lines: number }>(
    "replace_all",
    {
      query,
      replacement,
      matchCase,
      wholeWord,
      regex,
    }
  );

  totalLines = result.total_lines;
  dirty = true;
  updateDocumentState();
  persistRecoveryState();
  const reqId = ++navRequestId;
  await anchorWindow(viewTop, reqId);
  if (reqId === navRequestId) {
    scrollToViewTop();
    updateScrollbar();
  }
  setStatus(`Replaced ${result.replaced_count.toLocaleString()} occurrence(s)`);

  hits = [];
  hitIndex = -1;
  updateSearchDecorations();
  updateHitControls();
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
    updatePosition(startLine, hit.column);
  }
  updateSearchDecorations();
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
  set("#pref-read-only", (el) => (el.checked = prefs.readOnly));
  set("#pref-window-lines", (el) => (el.value = String(prefs.windowLines)));
  set("#word-wrap", (el) => (el.checked = prefs.wordWrap));
  set("#match-case", (el) => (el.checked = prefs.matchCase));
  set("#read-only", (el) => (el.checked = prefs.readOnly));
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

function openPreferencesDialog() {
  syncPrefControls();
  document.querySelector<HTMLElement>("#prefs-overlay")?.removeAttribute("hidden");
}

function wirePreferences() {
  const overlay = document.querySelector<HTMLElement>("#prefs-overlay");
  const close = () => overlay?.setAttribute("hidden", "");

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
  bindCheckbox("#pref-read-only", "readOnly");
  bindCheckbox("#word-wrap", "wordWrap");
  bindCheckbox("#read-only", "readOnly");

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

function initApp() {
  const container = document.querySelector<HTMLDivElement>("#editor-container");
  if (!container) return;

  const actionsMenu = document.querySelector<HTMLDetailsElement>("#actions-menu");

  const closeActionsMenu = () => {
    if (actionsMenu) actionsMenu.open = false;
  };

  const chooseFile = () => {
    closeActionsMenu();
    void (async () => {
      setStatus("Choose a file…");
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: "Open a text file",
      });
      if (typeof selected === "string") {
        await openFile(selected);
      } else {
        setStatus(currentPath ? "" : "No file open");
      }
    })().catch((err) => setStatus(`Open failed: ${err}`));
  };

  const openPreferences = () => {
    closeActionsMenu();
    openPreferencesDialog();
  };

  document.querySelector("#open-btn")?.addEventListener("click", chooseFile);
  document.querySelector("#prefs-btn")?.addEventListener("click", openPreferences);
  wirePreferences();
  wireGotoDialog();
  wireExternalChangeDialog();

  window.addEventListener("click", (event) => {
    if (actionsMenu?.open && !actionsMenu.contains(event.target as Node)) {
      actionsMenu.open = false;
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && actionsMenu?.open) {
      actionsMenu.open = false;
    }
  });

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
    maxTokenizationLineLength: 10000,
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
    if (currentPath) {
      const pos = editor?.getPosition();
      writeLineCache(currentPath, {
        line: viewTop,
        column: pos ? pos.column : 1,
      });
    }
    updateScrollbar();
    if (!reanchoring) {
      void maybeReanchor();
    }
  });
  editor.onDidLayoutChange(() => updateScrollbar());
  editor.onDidChangeCursorPosition(({ position }) => {
    if (!syncing) {
      updatePosition(position.lineNumber, position.column);
      if (currentPath) {
        writeLineCache(currentPath, {
          line: viewTop,
          column: position.column,
        });
      }
    }
  });

  wireEditEvents();
  wireScrollbar();
  updateDocumentState();
  updateHistoryControls();

  document.querySelector("#save-btn")?.addEventListener("click", () => {
    closeActionsMenu();
    void saveDocument().catch((error) => setStatus(`Save failed: ${error}`));
  });
  document.querySelector("#save-as-btn")?.addEventListener("click", () => {
    closeActionsMenu();
    void saveDocument(null).catch((error) => setStatus(`Save failed: ${error}`));
  });
  document.querySelector("#goto-btn")?.addEventListener("click", () => {
    closeActionsMenu();
    goToPosition();
  });
  document.querySelector("#convert-crlf-btn")?.addEventListener("click", () => {
    closeActionsMenu();
    void convertLineEndingsTo("CRLF").catch((error) => setStatus(`Conversion failed: ${error}`));
  });
  document.querySelector("#convert-lf-btn")?.addEventListener("click", () => {
    closeActionsMenu();
    void convertLineEndingsTo("LF").catch((error) => setStatus(`Conversion failed: ${error}`));
  });
  document.querySelector("#undo-btn")?.addEventListener("click", () => {
    closeActionsMenu();
    editor.focus();
    const model = editor.getModel() as any;
    if (typeof model?.undo === "function") {
      model.undo();
    } else {
      editor.trigger("ui", "undo", null);
    }
    updateHistoryControls();
  });
  document.querySelector("#redo-btn")?.addEventListener("click", () => {
    closeActionsMenu();
    editor.focus();
    const model = editor.getModel() as any;
    if (typeof model?.redo === "function") {
      model.redo();
    } else {
      editor.trigger("ui", "redo", null);
    }
    updateHistoryControls();
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    void saveDocument().catch((error) => setStatus(`Save failed: ${error}`));
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO, chooseFile);
  editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS,
    () => {
      void saveDocument(null).catch((error) => setStatus(`Save failed: ${error}`));
    }
  );
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG, () => {
    goToPosition();
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, () => {
    const model = editor.getModel() as any;
    if (typeof model?.undo === "function") {
      model.undo();
    } else {
      editor.trigger("ui", "undo", null);
    }
    updateHistoryControls();
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, () => {
    const model = editor.getModel() as any;
    if (typeof model?.redo === "function") {
      model.redo();
    } else {
      editor.trigger("ui", "redo", null);
    }
    updateHistoryControls();
  });

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
  void listen<SearchProgress>("search-progress", ({ payload }) => {
    if (payload.request_id !== activeSearchRequestId) return;
    if (payload.total_bytes === 0) return;
    const pct = Math.floor(
      (payload.bytes_scanned / payload.total_bytes) * 100
    );
    setStatus(
      `Searching… ${pct}% · ${payload.matches_found.toLocaleString()} match(es) found`
    );
    if (payload.hits.length === 0) return;
    hits = [...hits, ...payload.hits];
    hits.sort((left, right) => left.byte_offset - right.byte_offset);
    hits = hits.filter(
      (hit, index, all) => index === 0 || hit.byte_offset !== all[index - 1].byte_offset
    );
    hitsTruncated = hits.length >= 5000;
    updateSearchDecorations();
    updateHitControls();
    if (streamedNavigationRequestId !== activeSearchRequestId && hits.length > 0) {
      streamedNavigationRequestId = activeSearchRequestId;
      void gotoHit(0);
    }
  });

  const searchInput =
    document.querySelector<HTMLInputElement>("#search-input");
  const replaceInput =
    document.querySelector<HTMLInputElement>("#replace-input");
  updateHistoryDatalist();
  const matchCaseBox =
    document.querySelector<HTMLInputElement>("#match-case");
  const wholeWordBox =
    document.querySelector<HTMLInputElement>("#whole-word");
  const regexBox =
    document.querySelector<HTMLInputElement>("#regex-search");

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
  const focusReplace = () => {
    replaceInput?.focus();
    replaceInput?.select();
  };
  const noop = () => {};
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, focusSearch);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH, focusReplace);
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

  document.querySelector("#search-btn")?.addEventListener("click", () => {
    const query = searchInput?.value ?? "";
    recordHistoryEntry(SEARCH_HISTORY_KEY, query);
    search();
  });
  document.querySelector("#replace-btn")?.addEventListener("click", () => {
    const value = replaceInput?.value ?? "";
    recordHistoryEntry(REPLACE_HISTORY_KEY, value);
    void replaceCurrentMatch().catch((err) => setStatus(`Replace failed: ${err}`));
  });
  document.querySelector("#replace-all-btn")?.addEventListener("click", () => {
    const value = replaceInput?.value ?? "";
    recordHistoryEntry(REPLACE_HISTORY_KEY, value);
    void replaceAllMatches().catch((err) => setStatus(`Replace all failed: ${err}`));
  });

  replaceInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      recordHistoryEntry(REPLACE_HISTORY_KEY, replaceInput.value);
      void replaceCurrentMatch().catch((err) => setStatus(`Replace failed: ${err}`));
    }
  });

  // Enter steps through existing results; it only re-runs the search when the query changed.
  searchInput?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    recordHistoryEntry(SEARCH_HISTORY_KEY, searchInput.value);
    const stale =
      searchInput.value !== lastQuery ||
      currentMatchCase() !== lastMatchCase ||
      (wholeWordBox?.checked ?? false) !== lastWholeWord ||
      (regexBox?.checked ?? false) !== lastRegex;
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
  document.querySelector<HTMLInputElement>("#hit-counter")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      jumpToResultInput();
      (event.currentTarget as HTMLInputElement).blur();
    }
  });
  document.querySelector<HTMLInputElement>("#hit-counter")?.addEventListener("blur", () => {
    updateHitControls();
  });
  document.querySelector<HTMLInputElement>("#hit-counter")?.addEventListener("focus", () => {
    const counter = document.querySelector<HTMLInputElement>("#hit-counter");
    if (counter && hits.length) {
      counter.select();
    }
  });

  matchCaseBox?.addEventListener("change", () => {
    lastQuery = null; // force a fresh search rather than stepping stale results
    void updatePref("matchCase", currentMatchCase());
  });
  wholeWordBox?.addEventListener("change", () => {
    lastQuery = null;
  });
  regexBox?.addEventListener("change", () => {
    lastQuery = null;
  });

  window.addEventListener("beforeunload", () => {
    if (dirty) persistRecoveryState();
  });
  window.addEventListener("focus", () => {
    void checkExternalChange();
  });
  setInterval(() => {
    if (dirty) persistRecoveryState();
    void checkExternalChange();
  }, 4000);

  void invoke<string | null>("startup_path")
    .then((path) => (path ? openFile(path) : undefined))
    .catch((err) => setStatus(`Open failed: ${err}`));
}

const bootStatus = document.querySelector<HTMLElement>("#boot-status");
if (bootStatus) {
  bootStatus.classList.remove("hidden");
}

// A throw in initApp() used to leave the boot overlay up forever with no clue why.
function boot() {
  try {
    initApp();
    if (bootStatus) bootStatus.classList.add("hidden");
  } catch (error) {
    if (bootStatus) {
      bootStatus.textContent = `Startup failed: ${
        error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
      }`;
      bootStatus.style.whiteSpace = "pre-wrap";
      bootStatus.style.padding = "2em";
      bootStatus.style.overflow = "auto";
    }
    throw error;
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
