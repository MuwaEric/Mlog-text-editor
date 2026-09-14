// Core engine for editing multi-gigabyte text files without loading them fully into RAM.
//
// NOTE on file layout: Tauri v2 wires up `run()` from `lib.rs` (see `main.rs`, which only calls
// `giant_file_editor_lib::run()`). All commands therefore live here so they can be registered
// with `invoke_handler`; `main.rs` stays a thin OS entry point per Tauri convention.

use memmap2::Mmap;
use rayon::prelude::*;
use serde::Serialize;
use std::fs::File;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};

/// Bytes read per parallel search/scan chunk (64 MiB) — large enough to amortize thread
/// scheduling overhead, small enough to keep memory pressure and progress granularity sane.
const CHUNK_SIZE: usize = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Piece Table
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Source {
    /// Bytes come from the read-only mmap of the original file on disk.
    Original,
    /// Bytes come from the in-RAM, append-only buffer that holds all user-typed text.
    Added,
}

#[derive(Clone, Copy)]
struct Piece {
    source: Source,
    offset: usize,
    length: usize,
}

/// A Piece Table: the original file is never mutated, edits only ever append to `added` and
/// splice small metadata entries into `pieces`. This keeps insert/delete O(pieces) instead of
/// O(file size), which is what makes editing an 8 GB+ file feel instant.
struct PieceTable {
    original: Arc<Mmap>,
    added: String,
    pieces: Vec<Piece>,
}

impl PieceTable {
    fn new(original: Arc<Mmap>) -> Self {
        let length = original.len();
        let pieces = if length > 0 {
            vec![Piece {
                source: Source::Original,
                offset: 0,
                length,
            }]
        } else {
            Vec::new()
        };
        Self {
            original,
            added: String::new(),
            pieces,
        }
    }

    fn total_length(&self) -> usize {
        self.pieces.iter().map(|p| p.length).sum()
    }

    fn piece_bytes(&self, p: &Piece) -> &[u8] {
        match p.source {
            Source::Original => &self.original[p.offset..p.offset + p.length],
            Source::Added => &self.added.as_bytes()[p.offset..p.offset + p.length],
        }
    }

    /// Splits the piece straddling `position` (a byte offset into the *logical* document) so
    /// that `position` always lands exactly on a piece boundary. Returns the index at which a
    /// new piece can be inserted / a deletion range can start.
    fn split_at(&mut self, position: usize) -> usize {
        let mut consumed = 0usize;
        for i in 0..self.pieces.len() {
            let p = self.pieces[i];
            if consumed + p.length == position {
                return i + 1;
            }
            if consumed + p.length > position {
                let left_len = position - consumed;
                let right_len = p.length - left_len;
                let left = Piece {
                    source: p.source,
                    offset: p.offset,
                    length: left_len,
                };
                let right = Piece {
                    source: p.source,
                    offset: p.offset + left_len,
                    length: right_len,
                };
                self.pieces.splice(i..i + 1, [left, right]);
                return i + 1;
            }
            consumed += p.length;
        }
        self.pieces.len()
    }

    /// Appends `text` to the changes buffer and splices a new piece into the table — no large
    /// string is copied or shifted, only metadata is rewritten.
    fn insert_text(&mut self, position: usize, text: &str) {
        if text.is_empty() {
            return;
        }
        let position = position.min(self.total_length());
        let idx = self.split_at(position);
        let offset = self.added.len();
        self.added.push_str(text);
        self.pieces.insert(
            idx,
            Piece {
                source: Source::Added,
                offset,
                length: text.len(),
            },
        );
    }

    /// Removes `length` bytes starting at `position` by dropping/splitting piece metadata only.
    fn delete_text(&mut self, position: usize, length: usize) {
        if length == 0 {
            return;
        }
        let total = self.total_length();
        let position = position.min(total);
        let end = (position + length).min(total);
        if end <= position {
            return;
        }
        let start_idx = self.split_at(position);
        let end_idx = self.split_at(end);
        self.pieces.drain(start_idx..end_idx);
    }

    /// Reconstructs the logical byte range `[start, end)` by walking only the pieces that
    /// overlap it — the only place where piece bytes are actually copied/materialized.
    #[allow(dead_code)]
    fn get_text_range(&self, start: usize, end: usize) -> String {
        let mut out = Vec::with_capacity(end.saturating_sub(start));
        let mut consumed = 0usize;
        for p in &self.pieces {
            let piece_start = consumed;
            let piece_end = consumed + p.length;
            consumed = piece_end;
            if piece_end <= start || piece_start >= end {
                continue;
            }
            let local_start = start.saturating_sub(piece_start);
            let local_end = (end - piece_start).min(p.length);
            out.extend_from_slice(&self.piece_bytes(p)[local_start..local_end]);
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    /// Returns the text of logical lines `[start_line, end_line)` (0-indexed, newline-inclusive)
    /// without ever materializing the whole document. Stops walking as soon as `end_line` is
    /// reached, so viewport fetches near the start of the file stay cheap even on huge files.
    fn get_lines(&self, start_line: usize, end_line: usize) -> String {
        if end_line <= start_line {
            return String::new();
        }
        let mut current_line = 0usize;
        let mut out = Vec::new();

        'pieces: for p in &self.pieces {
            let bytes = self.piece_bytes(p);
            let mut pos = 0usize;
            while pos < bytes.len() {
                if current_line >= end_line {
                    break 'pieces;
                }
                let collecting = current_line >= start_line;
                match memchr::memchr(b'\n', &bytes[pos..]) {
                    Some(rel) => {
                        let nl = pos + rel;
                        if collecting {
                            out.extend_from_slice(&bytes[pos..=nl]);
                        }
                        pos = nl + 1;
                        current_line += 1;
                    }
                    None => {
                        if collecting {
                            out.extend_from_slice(&bytes[pos..]);
                        }
                        break;
                    }
                }
            }
            if current_line >= end_line {
                break;
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }
}

// ---------------------------------------------------------------------------------------------
// Line index (built once from the original mmap, used to map byte offsets -> line numbers)
// ---------------------------------------------------------------------------------------------

/// Byte offset of the start of each line in the *original* file, computed with a single fast
/// byte loop over the mmap (via `memchr`) on a background thread so the UI never blocks.
#[derive(Default)]
struct LineIndex {
    /// `line_starts[i]` = byte offset where line `i` begins in the original file.
    line_starts: Vec<usize>,
}

impl LineIndex {
    fn build(data: &[u8]) -> Self {
        let mut line_starts = Vec::with_capacity(data.len() / 40 + 1);
        line_starts.push(0);
        for pos in memchr::memchr_iter(b'\n', data) {
            if pos + 1 < data.len() {
                line_starts.push(pos + 1);
            }
        }
        Self { line_starts }
    }

    fn line_count(&self) -> usize {
        self.line_starts.len()
    }

    /// Maps a byte offset in the original file to a 0-indexed line number via binary search.
    fn line_for_offset(&self, offset: usize) -> usize {
        match self.line_starts.binary_search(&offset) {
            Ok(idx) => idx,
            Err(idx) => idx.saturating_sub(1),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Search: Boyer-Moore-Horspool, parallelized across byte chunks with rayon
// ---------------------------------------------------------------------------------------------

/// Single-threaded Boyer-Moore-Horspool search over one slice. Returns match start offsets
/// relative to the start of `haystack`.
fn boyer_moore_horspool(haystack: &[u8], pattern: &[u8]) -> Vec<usize> {
    let mut matches = Vec::new();
    let m = pattern.len();
    if m == 0 || haystack.len() < m {
        return matches;
    }

    let mut shift = [m; 256];
    for (i, &b) in pattern[..m - 1].iter().enumerate() {
        shift[b as usize] = m - 1 - i;
    }
    let last = pattern[m - 1];

    let mut i = 0usize;
    while i + m <= haystack.len() {
        let window = &haystack[i..i + m];
        if window[m - 1] == last && window == pattern {
            matches.push(i);
            i += 1; // keep scanning to allow overlapping matches
        } else {
            i += shift[window[m - 1] as usize];
        }
    }
    matches
}

/// Splits `data` into `CHUNK_SIZE` chunks (each padded with `pattern.len() - 1` bytes of overlap
/// so matches straddling a chunk boundary are never missed) and searches them in parallel with
/// rayon's work-stealing thread pool, maximizing sequential SSD read throughput.
fn parallel_search(data: &[u8], pattern: &[u8]) -> Vec<usize> {
    if pattern.is_empty() || data.len() < pattern.len() {
        return Vec::new();
    }
    let chunk_size = CHUNK_SIZE;
    let overlap = pattern.len() - 1;

    let chunk_starts: Vec<usize> = (0..data.len()).step_by(chunk_size).collect();
    let mut results: Vec<usize> = chunk_starts
        .par_iter()
        .flat_map(|&start| {
            let end = (start + chunk_size + overlap).min(data.len());
            let slice = &data[start..end];
            boyer_moore_horspool(slice, pattern)
                .into_iter()
                // Drop matches found only inside the overlap tail; they belong to the next
                // chunk's primary region and would otherwise be reported twice.
                .filter(|&local| local < chunk_size)
                .map(move |local| start + local)
                .collect::<Vec<_>>()
        })
        .collect();
    results.sort_unstable();
    results
}

// ---------------------------------------------------------------------------------------------
// Session / Tauri state
// ---------------------------------------------------------------------------------------------

struct EditorSession {
    table: PieceTable,
    line_index: Arc<LineIndex>,
}

#[derive(Default)]
struct AppState(Arc<Mutex<Option<EditorSession>>>);

#[derive(Serialize, Clone)]
struct FileMeta {
    total_lines: usize,
    size_bytes: usize,
}

#[derive(Serialize, Clone)]
struct SearchHit {
    byte_offset: usize,
    line: usize,
    column: usize,
}

#[derive(Serialize, Clone)]
struct ScanProgress {
    bytes_scanned: usize,
    total_bytes: usize,
}

/// Opens `path` with `mmap`, scans it for line breaks on a background (blocking) task so the UI
/// thread is never blocked, then stores the resulting Piece Table + line index in app state.
#[tauri::command]
async fn open_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<FileMeta, String> {
    let inner = state.0.clone();

    let (mmap, line_index) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let file = File::open(&path).map_err(|e| e.to_string())?;
        // SAFETY: the file is not expected to be truncated by another process while mapped;
        // this is the standard caveat of memory-mapped I/O.
        let mmap = unsafe { Mmap::map(&file) }.map_err(|e| e.to_string())?;

        let total = mmap.len();
        let _ = app.emit(
            "scan-progress",
            ScanProgress {
                bytes_scanned: 0,
                total_bytes: total,
            },
        );
        let line_index = LineIndex::build(&mmap);
        let _ = app.emit(
            "scan-progress",
            ScanProgress {
                bytes_scanned: total,
                total_bytes: total,
            },
        );
        Ok((mmap, line_index))
    })
    .await
    .map_err(|e| e.to_string())??;

    let mmap = Arc::new(mmap);
    let size_bytes = mmap.len();
    let table = PieceTable::new(mmap);
    let line_index = Arc::new(line_index);
    let total_lines = line_index.line_count().max(1);

    *inner.lock().map_err(|e| e.to_string())? = Some(EditorSession { table, line_index });

    Ok(FileMeta {
        total_lines,
        size_bytes,
    })
}

/// Fetches only the lines Monaco currently needs to render (its "virtual viewport"), never the
/// whole document.
#[tauri::command]
async fn get_lines(
    state: State<'_, AppState>,
    start_line: usize,
    end_line: usize,
) -> Result<String, String> {
    let inner = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = inner.lock().map_err(|e| e.to_string())?;
        let session = guard.as_ref().ok_or("no file open")?;
        Ok(session.table.get_lines(start_line, end_line))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Inserts `text` at logical byte offset `position` by splicing Piece Table metadata only.
#[tauri::command]
async fn insert_text(state: State<'_, AppState>, position: usize, text: String) -> Result<(), String> {
    let inner = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = inner.lock().map_err(|e| e.to_string())?;
        let session = guard.as_mut().ok_or("no file open")?;
        session.table.insert_text(position, &text);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deletes `length` bytes starting at logical byte offset `position`, metadata-only.
#[tauri::command]
async fn delete_text(state: State<'_, AppState>, position: usize, length: usize) -> Result<(), String> {
    let inner = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = inner.lock().map_err(|e| e.to_string())?;
        let session = guard.as_mut().ok_or("no file open")?;
        session.table.delete_text(position, length);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Multi-threaded Boyer-Moore-Horspool search over the original file, with hits mapped back to
/// line/column using the pre-built line index.
#[tauri::command]
async fn search_text(state: State<'_, AppState>, query: String) -> Result<Vec<SearchHit>, String> {
    let inner = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = inner.lock().map_err(|e| e.to_string())?;
        let session = guard.as_ref().ok_or("no file open")?;
        let pattern = query.as_bytes();
        let offsets = parallel_search(&session.table.original, pattern);

        let hits = offsets
            .into_iter()
            .map(|offset| {
                let line = session.line_index.line_for_offset(offset);
                let line_start = session.line_index.line_starts[line];
                SearchHit {
                    byte_offset: offset,
                    line,
                    column: offset - line_start,
                }
            })
            .collect();
        Ok(hits)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            open_file,
            get_lines,
            insert_text,
            delete_text,
            search_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
