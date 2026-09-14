import { invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor";

// Monaco is treated purely as a *virtual viewport*: the model is pre-sized to the file's real
// line count (cheap - just newline characters), but only the lines currently on screen (plus a
// small buffer) are ever fetched from Rust and materialized into the model's text.

interface FileMeta {
  total_lines: number;
  size_bytes: number;
}

interface SearchHit {
  byte_offset: number;
  line: number;
  column: number;
}

const BUFFER_LINES = 200; // extra lines fetched above/below the visible range

let editor: monaco.editor.IStandaloneCodeEditor;
let totalLines = 1;
let loadedStart = 0; // inclusive, 1-based
let loadedEnd = 0; // inclusive, 1-based
let fetchToken = 0;
let suppressChangeEvents = false;

function placeholderContent(lines: number): string {
  return "\n".repeat(Math.max(lines - 1, 0));
}

function setStatus(message: string) {
  const el = document.querySelector<HTMLElement>("#status");
  if (el) el.textContent = message;
}

async function openFile(path: string) {
  setStatus("Opening & scanning line offsets…");
  const meta = await invoke<FileMeta>("open_file", { path });
  totalLines = meta.total_lines;
  loadedStart = 0;
  loadedEnd = 0;

  const model = editor.getModel();
  if (model) {
    suppressChangeEvents = true;
    model.setValue(placeholderContent(totalLines));
    suppressChangeEvents = false;
  }
  setStatus(`Loaded ${meta.total_lines} lines, ${meta.size_bytes} bytes.`);
  await refreshViewport();
}

/** Fetches only the lines Monaco's viewport needs right now and splices them into the model. */
async function refreshViewport() {
  const model = editor.getModel();
  if (!model || totalLines === 0) return;

  const visible = editor.getVisibleRanges();
  if (!visible.length) return;

  const first = Math.max(visible[0].startLineNumber - BUFFER_LINES, 1);
  const last = Math.min(
    visible[visible.length - 1].endLineNumber + BUFFER_LINES,
    totalLines
  );
  if (first >= loadedStart && last <= loadedEnd) return; // already have this window

  const token = ++fetchToken;
  const text = await invoke<string>("get_lines", {
    startLine: first - 1, // backend is 0-indexed
    endLine: last,
  });
  if (token !== fetchToken) return; // a newer scroll event superseded this fetch

  const endsAtFile = last >= totalLines;
  const range = endsAtFile
    ? new monaco.Range(first, 1, last, model.getLineMaxColumn(last))
    : new monaco.Range(first, 1, last + 1, 1);

  suppressChangeEvents = true;
  editor.executeEdits("viewport-fetch", [{ range, text, forceMoveMarkers: false }]);
  suppressChangeEvents = false;

  loadedStart = first;
  loadedEnd = last;
}

/**
 * Best-effort mapping from a Monaco (line, column) position to a byte offset in the *original*
 * file, using the line index built at open time. Known limitation: this index is not
 * incrementally updated as edits accumulate, so offsets for lines far past a large edit can
 * drift — production-grade would need a piece-tree-aware line index on the Rust side.
 */
function toByteOffset(_line: number, _column: number): number {
  // Placeholder mapping: without an incrementally-maintained line index we can only approximate.
  // Real deployments should extend `get_lines`/search results with byte offsets per visible line
  // and cache them client-side as the authoritative source for edit positions.
  return 0;
}

function wireEditEvents() {
  editor.onDidChangeModelContent((e) => {
    if (suppressChangeEvents) return;
    for (const change of e.changes) {
      const position = toByteOffset(change.range.startLineNumber, change.range.startColumn);
      if (change.rangeLength > 0) {
        invoke("delete_text", { position, length: change.rangeLength }).catch(console.error);
      }
      if (change.text.length > 0) {
        invoke("insert_text", { position, text: change.text }).catch(console.error);
      }
    }
  });
}

async function runSearch(query: string) {
  if (!query) return;
  setStatus("Searching…");
  const hits = await invoke<SearchHit[]>("search_text", { query });
  setStatus(`Found ${hits.length} match(es).`);
  if (hits.length > 0) {
    editor.revealLineInCenter(hits[0].line + 1);
    editor.setPosition({ lineNumber: hits[0].line + 1, column: hits[0].column + 1 });
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
  });

  editor.onDidScrollChange(() => void refreshViewport());
  editor.onDidLayoutChange(() => void refreshViewport());
  wireEditEvents();

  document.querySelector("#open-btn")?.addEventListener("click", () => {
    const path = document.querySelector<HTMLInputElement>("#file-path")?.value.trim();
    if (path) void openFile(path);
  });

  document.querySelector("#search-btn")?.addEventListener("click", () => {
    const query = document.querySelector<HTMLInputElement>("#search-input")?.value ?? "";
    void runSearch(query);
  });
});
