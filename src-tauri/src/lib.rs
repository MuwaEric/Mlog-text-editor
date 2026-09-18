// Core engine for editing multi-gigabyte text files without loading them fully into RAM.
//
// NOTE on file layout: Tauri v2 wires up `run()` from `lib.rs` (see `main.rs`, which only calls
// `giant_file_editor_lib::run()`). All commands therefore live here so they can be registered
// with `invoke_handler`; `main.rs` stays a thin OS entry point per Tauri convention.

use memmap2::{Mmap, MmapOptions};
use rayon::prelude::*;
use regex::bytes::RegexBuilder;
use serde::Serialize;
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicUsize, Ordering};
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
///
/// Line lookups are served by a two-level index: each buffer keeps a sorted vector of its own
/// `\n` byte positions, and `cum_bytes`/`cum_lines` hold prefix sums across the piece list. A
/// (line, column) query is therefore two binary searches, never a scan of the document.
struct PieceTable {
    original: Arc<Mmap>,
    /// Byte position of every `\n` in the original mmap; built once, off the UI thread.
    original_nl: Arc<Vec<usize>>,
    added: String,
    /// Byte position of every `\n` in the changes buffer; appended to on each insert, so it
    /// stays sorted for free.
    added_nl: Vec<usize>,
    pieces: Vec<Piece>,
    /// Prefix sums over `pieces`, length `pieces.len() + 1`.
    cum_bytes: Vec<usize>,
    cum_lines: Vec<usize>,
}

impl PieceTable {
    fn new(original: Arc<Mmap>, original_nl: Arc<Vec<usize>>) -> Self {
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
        let mut table = Self {
            original,
            original_nl,
            added: String::new(),
            added_nl: Vec::new(),
            pieces,
            cum_bytes: Vec::new(),
            cum_lines: Vec::new(),
        };
        table.rebuild_index();
        table
    }

    fn piece_bytes(&self, p: &Piece) -> &[u8] {
        match p.source {
            Source::Original => &self.original[p.offset..p.offset + p.length],
            Source::Added => &self.added.as_bytes()[p.offset..p.offset + p.length],
        }
    }

    /// The newline positions (absolute within their own buffer) that fall inside `p`.
    fn piece_newlines(&self, p: &Piece) -> &[usize] {
        let nl: &[usize] = match p.source {
            Source::Original => &self.original_nl,
            Source::Added => &self.added_nl,
        };
        let lo = nl.partition_point(|&x| x < p.offset);
        let hi = nl.partition_point(|&x| x < p.offset + p.length);
        &nl[lo..hi]
    }

    /// Recomputes the prefix sums. O(pieces), and every piece's newline count is itself two
    /// binary searches, so this stays cheap as long as the piece list does.
    fn rebuild_index(&mut self) {
        let n = self.pieces.len();
        let mut cum_bytes = Vec::with_capacity(n + 1);
        let mut cum_lines = Vec::with_capacity(n + 1);
        cum_bytes.push(0);
        cum_lines.push(0);
        let (mut bytes, mut lines) = (0usize, 0usize);
        for i in 0..n {
            let p = self.pieces[i];
            bytes += p.length;
            lines += self.piece_newlines(&p).len();
            cum_bytes.push(bytes);
            cum_lines.push(lines);
        }
        self.cum_bytes = cum_bytes;
        self.cum_lines = cum_lines;
    }

    fn total_length(&self) -> usize {
        self.cum_bytes.last().copied().unwrap_or(0)
    }

    /// A document always has one more line than it has newlines (a trailing `\n` yields a final
    /// empty line, which is what editors show).
    fn total_lines(&self) -> usize {
        self.cum_lines.last().copied().unwrap_or(0) + 1
    }

    /// Index of the piece containing logical byte `offset`.
    fn piece_at_offset(&self, offset: usize) -> usize {
        let last = self.pieces.len().saturating_sub(1);
        self.cum_bytes
            .partition_point(|&c| c <= offset)
            .saturating_sub(1)
            .min(last)
    }

    /// Ensures `position` lands exactly on a piece boundary, splitting the straddling piece if
    /// needed. Returns the index of the piece that starts at `position`.
    fn split_at(&mut self, position: usize) -> usize {
        if position == 0 {
            return 0;
        }
        if position >= self.total_length() {
            return self.pieces.len();
        }
        let i = self.piece_at_offset(position);
        let piece_start = self.cum_bytes[i];
        if piece_start == position {
            return i;
        }
        let p = self.pieces[i];
        let left_len = position - piece_start;
        let left = Piece {
            source: p.source,
            offset: p.offset,
            length: left_len,
        };
        let right = Piece {
            source: p.source,
            offset: p.offset + left_len,
            length: p.length - left_len,
        };
        self.pieces.splice(i..i + 1, [left, right]);
        self.rebuild_index();
        i + 1
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
        for rel in memchr::memchr_iter(b'\n', text.as_bytes()) {
            self.added_nl.push(offset + rel);
        }
        self.added.push_str(text);
        self.pieces.insert(
            idx,
            Piece {
                source: Source::Added,
                offset,
                length: text.len(),
            },
        );
        self.rebuild_index();
    }

    /// Removes `length` bytes starting at `position` by dropping/splitting piece metadata only.
    /// Bytes orphaned in the changes buffer are intentionally left behind: the buffer is
    /// append-only so that existing piece offsets never need rewriting.
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
        self.rebuild_index();
    }

    /// Copies the logical byte range `[start, end)`, touching only the pieces that overlap it.
    /// This is the only place piece bytes are actually materialized.
    fn get_bytes_range(&self, start: usize, end: usize) -> Vec<u8> {
        let total = self.total_length();
        let start = start.min(total);
        let end = end.min(total);
        if end <= start {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(end - start);
        let mut i = self.piece_at_offset(start);
        while i < self.pieces.len() && self.cum_bytes[i] < end {
            let piece_start = self.cum_bytes[i];
            let p = self.pieces[i];
            let local_start = start.saturating_sub(piece_start);
            let local_end = (end - piece_start).min(p.length);
            if local_end > local_start {
                out.extend_from_slice(&self.piece_bytes(&p)[local_start..local_end]);
            }
            i += 1;
        }
        out
    }

    fn get_text_range(&self, start: usize, end: usize) -> String {
        String::from_utf8_lossy(&self.get_bytes_range(start, end)).into_owned()
    }

    /// Logical byte offset at which 0-indexed `line` begins. Two binary searches, no scanning.
    fn offset_of_line(&self, line: usize) -> usize {
        if line == 0 {
            return 0;
        }
        let target = line - 1; // the newline that terminates the preceding line
        if target >= self.cum_lines.last().copied().unwrap_or(0) {
            return self.total_length();
        }
        let i = self.cum_lines.partition_point(|&c| c <= target) - 1;
        let p = self.pieces[i];
        let local = target - self.cum_lines[i];
        let nl_pos = self.piece_newlines(&p)[local];
        self.cum_bytes[i] + (nl_pos - p.offset) + 1
    }

    /// 0-indexed line containing logical byte `offset`.
    fn line_for_offset(&self, offset: usize) -> usize {
        if self.pieces.is_empty() {
            return 0;
        }
        let offset = offset.min(self.total_length());
        let i = self.piece_at_offset(offset);
        let p = self.pieces[i];
        let within = offset - self.cum_bytes[i];
        let count = self
            .piece_newlines(&p)
            .partition_point(|&x| x < p.offset + within);
        self.cum_lines[i] + count
    }

    /// Text of 0-indexed lines `[start_line, end_line)`, newline-inclusive.
    fn get_lines(&self, start_line: usize, end_line: usize) -> String {
        if end_line <= start_line {
            return String::new();
        }
        let start = self.offset_of_line(start_line);
        let end = self.offset_of_line(end_line);
        self.get_text_range(start, end)
    }

    /// Text of 0-indexed `line`, without its trailing line break.
    fn line_text(&self, line: usize) -> String {
        let start = self.offset_of_line(line);
        let end = self.offset_of_line(line + 1);
        let text = self.get_text_range(start, end);
        let text = text.strip_suffix('\n').unwrap_or(&text);
        text.strip_suffix('\r').unwrap_or(text).to_owned()
    }

    /// Converts a Monaco position (1-based line, 1-based UTF-16 column) to a logical byte
    /// offset. The column must be walked through the real line text because Monaco counts
    /// UTF-16 code units while the piece table counts bytes.
    fn offset_of_position(&self, line: usize, column: usize) -> usize {
        let line0 = line.saturating_sub(1);
        let line_start = self.offset_of_line(line0);
        let text = self.line_text(line0);
        line_start + utf16_column_to_byte(&text, column.saturating_sub(1))
    }

    /// Inverse of `offset_of_position`.
    fn position_of_offset(&self, offset: usize) -> (usize, usize) {
        let line0 = self.line_for_offset(offset);
        let line_start = self.offset_of_line(line0);
        let prefix = self.get_text_range(line_start, offset);
        (line0 + 1, utf16_len(&prefix) + 1)
    }
}

/// Byte index within `line` of the character at UTF-16 offset `column`.
fn utf16_column_to_byte(line: &str, column: usize) -> usize {
    let mut units = 0usize;
    for (idx, ch) in line.char_indices() {
        if units >= column {
            return idx;
        }
        units += ch.len_utf16();
    }
    line.len()
}

fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

// ---------------------------------------------------------------------------------------------
// Initial newline scan over the mmap
// ---------------------------------------------------------------------------------------------

/// Records the byte position of every `\n` in `data` with a fast SIMD byte loop (`memchr`),
/// parallelized across `CHUNK_SIZE` chunks. This is the single full pass over the file, and it
/// runs off the UI thread. Note the inherent cost: one `usize` per line, so a file with 200 M
/// lines needs ~1.6 GB for the index alone.
fn scan_newlines(data: &[u8], mut on_chunk: impl FnMut(usize) + Send) -> Vec<usize> {
    let starts: Vec<usize> = (0..data.len()).step_by(CHUNK_SIZE).collect();
    let per_chunk: Vec<Vec<usize>> = starts
        .par_iter()
        .map(|&s| {
            let e = (s + CHUNK_SIZE).min(data.len());
            memchr::memchr_iter(b'\n', &data[s..e])
                .map(|rel| s + rel)
                .collect()
        })
        .collect();

    let total: usize = per_chunk.iter().map(Vec::len).sum();
    let mut out = Vec::with_capacity(total);
    for mut chunk in per_chunk {
        out.append(&mut chunk); // frees each chunk as it is merged, keeping peak memory down
        on_chunk(out.len());
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Search: Boyer-Moore-Horspool, parallelized across byte chunks with rayon
// ---------------------------------------------------------------------------------------------

/// ASCII case-folding table. Non-ASCII bytes pass through untouched, so this matches
/// `Spain`/`sPain`/`SPAIN` but not `É`/`é` — proper Unicode folding cannot be done byte-wise,
/// because folding can change a string's length.
static FOLD: [u8; 256] = {
    let mut t = [0u8; 256];
    let mut i = 0;
    while i < 256 {
        t[i] = if i >= b'A' as usize && i <= b'Z' as usize {
            i as u8 + 32
        } else {
            i as u8
        };
        i += 1;
    }
    t
};

fn fold_bytes(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().map(|&b| FOLD[b as usize]).collect()
}

/// Single-threaded Boyer-Moore-Horspool search over one slice. Returns match start offsets
/// relative to the start of `haystack`. When `fold_case` is set, `pattern` must already be
/// folded; the haystack is folded byte-by-byte as it is scanned.
fn boyer_moore_horspool(haystack: &[u8], pattern: &[u8], fold_case: bool) -> Vec<usize> {
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
        let tail = if fold_case {
            FOLD[window[m - 1] as usize]
        } else {
            window[m - 1]
        };
        let hit = tail == last
            && if fold_case {
                window
                    .iter()
                    .zip(pattern)
                    .all(|(&h, &p)| FOLD[h as usize] == p)
            } else {
                window == pattern
            };
        if hit {
            matches.push(i);
            i += 1; // keep scanning to allow overlapping matches
        } else {
            i += shift[tail as usize];
        }
    }
    matches
}

/// Searches the *logical* document (original bytes plus user edits) in parallel.
///
/// Every piece is scanned independently, and pieces larger than `CHUNK_SIZE` are split further
/// so the 8 GB original piece saturates all cores and the SSD's sequential read path. Two kinds
/// of boundary are handled explicitly so no match is missed or double-counted:
///   * chunk boundaries inside a piece — each chunk scans `pattern.len() - 1` bytes past its
///     primary region, and reports only matches that *start* in the primary region;
///   * piece boundaries — a small window around each one is re-scanned for matches that
///     straddle it, which is the only way a match can span the original buffer and an edit.
#[allow(dead_code)]
fn search_document(table: &PieceTable, pattern: &[u8], fold_case: bool) -> Vec<usize> {
    search_document_with_progress(table, pattern, fold_case, false, None, 0)
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn is_whole_word_match(table: &PieceTable, offset: usize, length: usize) -> bool {
    let before = if offset > 0 {
        table.get_bytes_range(offset - 1, offset).first().copied()
    } else {
        None
    };
    let after = if offset + length < table.total_length() {
        table
            .get_bytes_range(offset + length, offset + length + 1)
            .first()
            .copied()
    } else {
        None
    };
    !before.is_some_and(is_word_byte) && !after.is_some_and(is_word_byte)
}

fn search_regex_document(
    table: &PieceTable,
    regex: &regex::bytes::Regex,
    whole_word: bool,
) -> Vec<(usize, usize)> {
    let mut matches = Vec::new();
    for (piece_index, piece) in table.pieces.iter().enumerate() {
        let base = table.cum_bytes[piece_index];
        let bytes = table.piece_bytes(piece);
        for found in regex.find_iter(bytes) {
            let offset = base + found.start();
            let length = found.end().saturating_sub(found.start());
            if length > 0 && (!whole_word || is_whole_word_match(table, offset, length)) {
                matches.push((offset, length));
            }
        }
    }
    matches.sort_unstable_by_key(|&(offset, _)| offset);
    matches.dedup_by_key(|(offset, _)| *offset);
    matches
}

fn search_document_with_progress(
    table: &PieceTable,
    pattern: &[u8],
    fold_case: bool,
    whole_word: bool,
    app: Option<&tauri::AppHandle>,
    request_id: u64,
) -> Vec<usize> {
    let m = pattern.len();
    if m == 0 {
        return Vec::new();
    }
    let overlap = m - 1;

    let tasks: Vec<(usize, usize)> = table
        .pieces
        .iter()
        .enumerate()
        .flat_map(|(i, p)| (0..p.length).step_by(CHUNK_SIZE).map(move |s| (i, s)))
        .collect();

    let bytes_scanned = Arc::new(AtomicUsize::new(0));
    let matches_found = Arc::new(AtomicUsize::new(0));
    let total_bytes = table.total_length();

    let mut hits: Vec<usize> = tasks
        .par_iter()
        .flat_map(|&(i, s)| {
            let p = table.pieces[i];
            let bytes = table.piece_bytes(&p);
            let primary_end = (s + CHUNK_SIZE).min(p.length);
            let scan_end = (primary_end + overlap).min(p.length);
            let base = table.cum_bytes[i] + s;
            let local_hits = boyer_moore_horspool(&bytes[s..scan_end], pattern, fold_case)
                .into_iter()
                .filter(move |&local| s + local < primary_end)
                .map(move |local| base + local)
                .filter(|&offset| {
                    !whole_word || is_whole_word_match(table, offset, pattern.len())
                })
                .collect::<Vec<_>>();
            let streamed_hits = local_hits
                .iter()
                .map(|&byte_offset| {
                    let (line, column) = table.position_of_offset(byte_offset);
                    let (end_line, end_column) =
                        table.position_of_offset(byte_offset + pattern.len());
                    SearchHit {
                        byte_offset,
                        line,
                        column,
                        end_line,
                        end_column,
                    }
                })
                .collect();
            bytes_scanned.fetch_add(primary_end - s, Ordering::Relaxed);
            matches_found.fetch_add(local_hits.len(), Ordering::Relaxed);
            if let Some(app) = app {
                let _ = app.emit(
                    "search-progress",
                    SearchProgress {
                        request_id,
                        bytes_scanned: bytes_scanned.load(Ordering::Relaxed),
                        total_bytes,
                        matches_found: matches_found.load(Ordering::Relaxed),
                        hits: streamed_hits,
                    },
                );
            }
            local_hits
        })
        .collect();

    let total = table.total_length();
    let boundary_hits: Vec<usize> = (1..table.pieces.len())
        .into_par_iter()
        .flat_map(|i| {
            let b = table.cum_bytes[i];
            let lo = b.saturating_sub(overlap);
            let hi = (b + overlap).min(total);
            let window = table.get_bytes_range(lo, hi);
            boyer_moore_horspool(&window, pattern, fold_case)
                .into_iter()
                .map(move |local| lo + local)
                .filter(move |&abs| abs < b && abs + m > b)
                .collect::<Vec<_>>()
        })
        .collect();

    hits.extend(boundary_hits);
    hits.sort_unstable();
    hits.dedup(); // a match spanning several tiny pieces is found at each boundary it crosses
    if let Some(app) = app {
        let _ = app.emit(
            "search-progress",
            SearchProgress {
                request_id,
                bytes_scanned: total_bytes,
                total_bytes,
                matches_found: hits.len(),
                hits: Vec::new(),
            },
        );
    }
    hits
}

// ---------------------------------------------------------------------------------------------
// Session / Tauri state
// ---------------------------------------------------------------------------------------------

/// Matches returned to the UI are capped: a search for "e" in an 8 GB file has billions of
/// hits, and serializing them over IPC would defeat the whole point of streaming the file.
const MAX_REPORTED_HITS: usize = 5_000;

fn empty_piece_table() -> PieceTable {
    let mmap = MmapOptions::new().len(0).map_anon().unwrap();
    let mmap = mmap.make_read_only().unwrap();
    PieceTable::new(Arc::new(mmap), Arc::new(Vec::new()))
}

struct AppState {
    table: Arc<Mutex<Option<PieceTable>>>,
    path: Arc<Mutex<Option<PathBuf>>>,
    last_modified_ms: Arc<Mutex<u64>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            table: Arc::new(Mutex::new(Some(empty_piece_table()))),
            path: Arc::new(Mutex::new(None)),
            last_modified_ms: Arc::new(Mutex::new(0)),
        }
    }
}

#[derive(Serialize, Clone)]
struct FileMeta {
    total_lines: usize,
    size_bytes: usize,
    newline: String,
    encoding: String,
}

/// 1-based line and UTF-16 column, i.e. directly usable as a Monaco `IPosition`. The end pair
/// is the position just past the match, so the two form a selectable range.
#[derive(Serialize, Clone)]
struct SearchHit {
    byte_offset: usize,
    line: usize,
    column: usize,
    end_line: usize,
    end_column: usize,
}

#[derive(Serialize, Clone)]
struct SearchResult {
    total_matches: usize,
    truncated: bool,
    hits: Vec<SearchHit>,
}

#[derive(Serialize, Clone)]
struct ReplaceAllResult {
    replaced_count: usize,
    total_lines: usize,
}

#[derive(Serialize, Clone)]
struct ScanProgress {
    bytes_scanned: usize,
    total_bytes: usize,
}

#[derive(Serialize, Clone)]
struct SearchProgress {
    request_id: u64,
    bytes_scanned: usize,
    total_bytes: usize,
    matches_found: usize,
    hits: Vec<SearchHit>,
}

/// Runs `f` against the open document on a blocking thread so neither the mmap page faults nor
/// the index work ever land on the UI thread.
async fn with_table<T, F>(state: &State<'_, AppState>, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut PieceTable) -> T + Send + 'static,
{
    let inner = state.table.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = inner.lock().map_err(|e| e.to_string())?;
        let table = guard.as_mut().ok_or("no file open")?;
        Ok(f(table))
    })
    .await
    .map_err(|e| e.to_string())?
}

use std::time::UNIX_EPOCH;

fn get_file_mtime_ms(path: &str) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64)
        .unwrap_or(0)
}

fn detect_newline_format(bytes: &[u8]) -> String {
    let has_crlf = bytes.windows(2).any(|w| w == b"\r\n");
    if has_crlf {
        "CRLF".to_string()
    } else if bytes.iter().any(|&b| b == b'\r') {
        "CR".to_string()
    } else {
        "LF".to_string()
    }
}

fn detect_text_encoding(bytes: &[u8]) -> &'static str {
    if bytes.is_empty() {
        return "UTF-8";
    }
    if bytes.starts_with(b"\xEF\xBB\xBF") {
        return "UTF-8";
    }
    if bytes.starts_with(b"\xFF\xFE") {
        return "UTF-16LE";
    }
    if bytes.starts_with(b"\xFE\xFF") {
        return "UTF-16BE";
    }

    let odd_nulls = bytes.iter().skip(1).step_by(2).filter(|&&b| b == 0).count();
    let even_nulls = bytes.iter().step_by(2).filter(|&&b| b == 0).count();
    let total_nulls = odd_nulls + even_nulls;

    if total_nulls > 0 && odd_nulls > even_nulls * 3 {
        return "UTF-16LE";
    }
    if total_nulls > 0 && even_nulls > odd_nulls * 3 {
        return "UTF-16BE";
    }
    if std::str::from_utf8(bytes).is_ok() {
        return "UTF-8";
    }

    "Binary"
}

/// Opens `path` with `mmap` and scans it for line breaks on a background task, then stores the
/// resulting Piece Table in app state.
#[tauri::command]
async fn open_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<FileMeta, String> {
    let inner = state.table.clone();
    let open_path = path.clone();
    let mtime = get_file_mtime_ms(&open_path);

    let (table, newline_format, encoding) = tauri::async_runtime::spawn_blocking(move || -> Result<(PieceTable, String, String), String> {
        let file = File::open(&path).map_err(|e| e.to_string())?;
        // SAFETY: as with any mmap, behaviour is undefined if another process truncates the
        // file while it is mapped. That is the standard, unavoidable caveat of this approach.
        let mmap = unsafe { Mmap::map(&file) }.map_err(|e| e.to_string())?;

        let sample_len = mmap.len().min(64 * 1024);
        let newline_format = detect_newline_format(&mmap[..sample_len]);
        let encoding = detect_text_encoding(&mmap[..sample_len]).to_string();

        let total_bytes = mmap.len();
        let newlines = scan_newlines(&mmap, |scanned| {
            let _ = app.emit(
                "scan-progress",
                ScanProgress {
                    bytes_scanned: scanned,
                    total_bytes,
                },
            );
        });
        Ok((PieceTable::new(Arc::new(mmap), Arc::new(newlines)), newline_format, encoding))
    })
    .await
    .map_err(|e| e.to_string())??;

    let meta = FileMeta {
        total_lines: table.total_lines(),
        size_bytes: table.total_length(),
        newline: newline_format,
        encoding,
    };
    *inner.lock().map_err(|e| e.to_string())? = Some(table);
    *state.path.lock().map_err(|e| e.to_string())? = Some(PathBuf::from(open_path));
    *state.last_modified_ms.lock().map_err(|e| e.to_string())? = mtime;
    Ok(meta)
}

/// Streams the logical piece table to disk through a temporary sibling file, then replaces the target.
#[tauri::command]
async fn save_file(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<FileMeta, String> {
    let target = match path {
        Some(path) => PathBuf::from(path),
        None => state
            .path
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or("no file path selected")?,
    };
    let inner = state.table.clone();
    let meta = tauri::async_runtime::spawn_blocking({
        let target = target.clone();
        move || {
            let guard = inner.lock().map_err(|e| e.to_string())?;
            let table = guard.as_ref().ok_or("no file open")?;
            let mut temporary = target.clone();
            temporary.set_extension(format!("gfe-tmp-{}", std::process::id()));
            let result = (|| -> Result<FileMeta, String> {
                let mut output = File::create(&temporary).map_err(|e| e.to_string())?;
                for piece in &table.pieces {
                    output.write_all(table.piece_bytes(piece)).map_err(|e| e.to_string())?;
                }
                output.sync_all().map_err(|e| e.to_string())?;
                fs::rename(&temporary, &target).map_err(|e| e.to_string())?;
                let sample = table.get_bytes_range(0, table.total_length().min(64 * 1024));
                Ok(FileMeta {
                    total_lines: table.total_lines(),
                    size_bytes: table.total_length(),
                    newline: detect_newline_format(&sample),
                    encoding: detect_text_encoding(&sample).to_string(),
                })
            })();
            if result.is_err() { let _ = fs::remove_file(&temporary); }
            result
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    let new_mtime = get_file_mtime_ms(&target.to_string_lossy());
    *state.path.lock().map_err(|e| e.to_string())? = Some(target);
    *state.last_modified_ms.lock().map_err(|e| e.to_string())? = new_mtime;
    Ok(meta)
}

/// Checks if the currently opened file on disk has been modified externally.
#[tauri::command]
async fn check_file_changed(state: State<'_, AppState>) -> Result<bool, String> {
    let path_opt = state.path.lock().map_err(|e| e.to_string())?.clone();
    let path = match path_opt {
        Some(p) => p,
        None => return Ok(false),
    };
    let recorded_mtime = *state.last_modified_ms.lock().map_err(|e| e.to_string())?;
    if recorded_mtime == 0 {
        return Ok(false);
    }
    let current_mtime = get_file_mtime_ms(&path.to_string_lossy());
    // If mtime is newer by more than a tiny tolerance (10ms)
    Ok(current_mtime > recorded_mtime)
}

/// Fetches only the lines Monaco currently needs to render (its virtual viewport), never the
/// whole document. `start_line`/`end_line` are 1-based and inclusive, matching Monaco.
#[tauri::command]
async fn get_lines(
    state: State<'_, AppState>,
    start_line: usize,
    end_line: usize,
) -> Result<String, String> {
    with_table(&state, move |table| {
        table.get_lines(start_line.saturating_sub(1), end_line)
    })
    .await
}

/// Inserts `text` at a Monaco position, splicing Piece Table metadata only. Returns the
/// document's new line count so the frontend can keep its virtual viewport in sync.
#[tauri::command]
async fn insert_text(
    state: State<'_, AppState>,
    line: usize,
    column: usize,
    text: String,
) -> Result<usize, String> {
    with_table(&state, move |table| {
        let offset = table.offset_of_position(line, column);
        table.insert_text(offset, &text);
        table.total_lines()
    })
    .await
}

/// Deletes a Monaco range (1-based, end-exclusive column semantics), metadata only.
#[tauri::command]
async fn delete_text(
    state: State<'_, AppState>,
    start_line: usize,
    start_column: usize,
    end_line: usize,
    end_column: usize,
) -> Result<usize, String> {
    with_table(&state, move |table| {
        let start = table.offset_of_position(start_line, start_column);
        let end = table.offset_of_position(end_line, end_column);
        table.delete_text(start, end.saturating_sub(start));
        table.total_lines()
    })
    .await
}

/// Returns the zero-based byte offset for a 1-based file position.
#[tauri::command]
async fn byte_offset(
    state: State<'_, AppState>,
    line: usize,
    column: usize,
) -> Result<usize, String> {
    with_table(&state, move |table| table.offset_of_position(line, column))
        .await
}

#[tauri::command]
async fn position_at_byte(
    state: State<'_, AppState>,
    offset: usize,
) -> Result<(usize, usize), String> {
    with_table(&state, move |table| table.position_of_offset(offset.min(table.total_length())))
        .await
}

/// Multi-threaded Boyer-Moore-Horspool search over the live document, with hits mapped back to
/// Monaco positions through the piece table's line index. Case-insensitive unless `match_case`.
#[tauri::command]
async fn search_text(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    query: String,
    match_case: bool,
    request_id: u64,
    whole_word: bool,
    regex: bool,
) -> Result<SearchResult, String> {
    let regex_engine = if regex {
        Some(
            RegexBuilder::new(&query)
                .case_insensitive(!match_case)
                .unicode(false)
                .build()
                .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };
    with_table(&state, move |table| {
        let matches = if regex {
            search_regex_document(
                table,
                regex_engine.as_ref().expect("regex engine is present"),
                whole_word,
            )
        } else {
            let pattern = if match_case {
                query.as_bytes().to_vec()
            } else {
                fold_bytes(query.as_bytes())
            };
            search_document_with_progress(
                table,
                &pattern,
                !match_case,
                whole_word,
                Some(&app),
                request_id,
            )
            .into_iter()
            .map(|offset| (offset, pattern.len()))
            .collect()
        };
        let total_matches = matches.len();
        let hits = matches
            .iter()
            .take(MAX_REPORTED_HITS)
            .map(|&(byte_offset, match_length)| {
                let (line, column) = table.position_of_offset(byte_offset);
                let (end_line, end_column) =
                    table.position_of_offset(byte_offset + match_length);
                SearchHit {
                    byte_offset,
                    line,
                    column,
                    end_line,
                    end_column,
                }
            })
            .collect();
        SearchResult {
            total_matches,
            truncated: total_matches > MAX_REPORTED_HITS,
            hits,
        }
    })
    .await
}

/// Replaces a single match range and returns the new document line count.
#[tauri::command]
async fn replace_match(
    state: State<'_, AppState>,
    start_line: usize,
    start_column: usize,
    end_line: usize,
    end_column: usize,
    text: String,
) -> Result<usize, String> {
    with_table(&state, move |table| {
        let start = table.offset_of_position(start_line, start_column);
        let end = table.offset_of_position(end_line, end_column);
        let len = end.saturating_sub(start);
        if len > 0 {
            table.delete_text(start, len);
        }
        if !text.is_empty() {
            table.insert_text(start, &text);
        }
        table.total_lines()
    })
    .await
}

/// Replaces all occurrences across the entire document piece table in reverse order.
#[tauri::command]
async fn replace_all(
    state: State<'_, AppState>,
    query: String,
    replacement: String,
    match_case: bool,
    whole_word: bool,
    regex: bool,
) -> Result<ReplaceAllResult, String> {
    if query.is_empty() {
        return Err("search query cannot be empty".to_string());
    }
    let regex_engine = if regex {
        Some(
            RegexBuilder::new(&query)
                .case_insensitive(!match_case)
                .unicode(false)
                .build()
                .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };

    with_table(&state, move |table| {
        let matches: Vec<(usize, usize)> = if regex {
            search_regex_document(
                table,
                regex_engine.as_ref().expect("regex engine is present"),
                whole_word,
            )
        } else {
            let pattern = if match_case {
                query.as_bytes().to_vec()
            } else {
                fold_bytes(query.as_bytes())
            };
            search_document_with_progress(
                table,
                &pattern,
                !match_case,
                whole_word,
                None,
                0,
            )
            .into_iter()
            .map(|offset| (offset, pattern.len()))
            .collect()
        };

        let replaced_count = matches.len();
        // Splicing in reverse order preserves byte offsets of earlier matches.
        for &(offset, length) in matches.iter().rev() {
            if length > 0 {
                table.delete_text(offset, length);
            }
            if !replacement.is_empty() {
                table.insert_text(offset, &replacement);
            }
        }

        ReplaceAllResult {
            replaced_count,
            total_lines: table.total_lines(),
        }
    })
    .await
}

/// Converts line endings across the piece table to either LF or CRLF.
#[tauri::command]
async fn convert_line_endings(
    state: State<'_, AppState>,
    target_format: String,
) -> Result<FileMeta, String> {
    with_table(&state, move |table| {
        let total = table.total_length();
        let bytes = table.get_bytes_range(0, total);
        let mut text = String::from_utf8_lossy(&bytes).into_owned();

        if target_format.eq_ignore_ascii_case("LF") {
            text = text.replace("\r\n", "\n").replace('\r', "\n");
        } else if target_format.eq_ignore_ascii_case("CRLF") {
            text = text.replace("\r\n", "\n").replace('\r', "\n").replace('\n', "\r\n");
        }

        if total > 0 {
            table.delete_text(0, total);
        }
        table.insert_text(0, &text);

        let sample = table.get_bytes_range(0, table.total_length().min(64 * 1024));
        FileMeta {
            total_lines: table.total_lines(),
            size_bytes: table.total_length(),
            newline: detect_newline_format(&sample),
            encoding: detect_text_encoding(&sample).to_string(),
        }
    })
    .await
}

/// Path given on the command line, so `giant-file-editor foo.txt` works.
#[tauri::command]
fn startup_path() -> Option<String> {
    std::env::args().nth(1).filter(|a| !a.starts_with('-'))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_file,
            save_file,
            get_lines,
            insert_text,
            delete_text,
            byte_offset,
            position_at_byte,
            search_text,
            replace_match,
            replace_all,
            check_file_changed,
            convert_line_endings,
            startup_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Builds a table over a real temp file, since the original buffer must be an `Mmap`.
    fn table(contents: &str) -> PieceTable {
        let path = std::env::temp_dir().join(format!(
            "gfe-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let mut f = File::create(&path).unwrap();
        f.write_all(contents.as_bytes()).unwrap();
        f.sync_all().unwrap();
        let mmap = unsafe { Mmap::map(&File::open(&path).unwrap()) }.unwrap();
        let _ = std::fs::remove_file(&path); // unlinked but still mapped
        let nl = scan_newlines(&mmap, |_| {});
        PieceTable::new(Arc::new(mmap), Arc::new(nl))
    }

    fn whole(t: &PieceTable) -> String {
        t.get_text_range(0, t.total_length())
    }

    #[test]
    fn untitled_documents_start_with_an_empty_table() {
        let state = AppState::default();
        let guard = state.table.lock().unwrap();
        assert!(guard.is_some(), "new untitled documents should have a backing table");
        let table = guard.as_ref().unwrap();
        assert_eq!(table.total_length(), 0);
        assert_eq!(table.total_lines(), 1);
    }

    #[test]
    fn line_index_matches_naive_scan() {
        let t = table("alpha\nbeta\ngamma\n\ndelta");
        assert_eq!(t.total_lines(), 5);
        assert_eq!(t.get_lines(0, 1), "alpha\n");
        assert_eq!(t.get_lines(2, 4), "gamma\n\n");
        assert_eq!(t.get_lines(4, 5), "delta");
        assert_eq!(t.offset_of_line(1), 6);
        assert_eq!(t.line_for_offset(6), 1);
        assert_eq!(t.line_for_offset(5), 0); // the newline itself belongs to its own line
    }

    #[test]
    fn trailing_newline_yields_final_empty_line() {
        let t = table("a\nb\n");
        assert_eq!(t.total_lines(), 3);
        assert_eq!(t.get_lines(2, 3), "");
    }

    #[test]
    fn index_survives_inserts_and_deletes() {
        let mut t = table("one\ntwo\nthree\n");

        // Insert a multi-line block in the middle of line 2.
        let at = t.offset_of_position(2, 2);
        t.insert_text(at, "X\nY");
        assert_eq!(whole(&t), "one\ntX\nYwo\nthree\n");
        assert_eq!(t.total_lines(), 5);
        assert_eq!(t.get_lines(1, 3), "tX\nYwo\n");
        assert_eq!(t.line_for_offset(whole(&t).find("three").unwrap()), 3);

        // Delete across the piece boundary we just created.
        let start = t.offset_of_position(2, 2);
        let end = t.offset_of_position(3, 2);
        t.delete_text(start, end - start);
        assert_eq!(whole(&t), "one\ntwo\nthree\n");
        assert_eq!(t.total_lines(), 4);
    }

    #[test]
    fn positions_are_utf16_like_monaco() {
        // "é" is 2 bytes / 1 UTF-16 unit; "𝄞" is 4 bytes / 2 UTF-16 units (a surrogate pair).
        let t = table("aé𝄞b\nnext");
        assert_eq!(t.offset_of_position(1, 1), 0);
        assert_eq!(t.offset_of_position(1, 2), 1); // after 'a'
        assert_eq!(t.offset_of_position(1, 3), 3); // after 'é'
        assert_eq!(t.offset_of_position(1, 5), 7); // after the surrogate pair
        assert_eq!(t.position_of_offset(7), (1, 5));
        assert_eq!(t.position_of_offset(9), (2, 1));
    }

    #[test]
    fn detect_encoding_handles_utf8_utf16_and_binary() {
        let utf8 = b"hello\nworld";
        assert_eq!(detect_text_encoding(utf8), "UTF-8");

        let utf16le = "hello\nworld"
            .encode_utf16()
            .flat_map(|ch| ch.to_le_bytes())
            .collect::<Vec<u8>>();
        assert_eq!(detect_text_encoding(&utf16le), "UTF-16LE");

        let binary = vec![0, 159, 255, 0, 2, 3, 4];
        assert_eq!(detect_text_encoding(&binary), "Binary");
    }

    #[test]
    fn search_finds_matches_spanning_pieces() {
        let mut t = table("hello wor");
        t.insert_text(t.total_length(), "ld and hello world");
        assert_eq!(whole(&t), "hello world and hello world");

        let hits = search_document(&t, b"hello world", false);
        assert_eq!(hits, vec![0, 16]); // the first match straddles the piece boundary
        assert_eq!(t.position_of_offset(16), (1, 17));
    }

    #[test]
    fn search_handles_overlapping_and_absent_patterns() {
        let t = table("aaaa");
        assert_eq!(search_document(&t, b"aa", false), vec![0, 1, 2]);
        assert!(search_document(&t, b"zz", false).is_empty());
        assert!(search_document(&t, b"", false).is_empty());
    }

    #[test]
    fn case_insensitive_search_matches_any_casing() {
        let t = table("Spain sPain SPAIN spain rain");
        let hits = search_document(&t, &fold_bytes(b"spain"), true);
        assert_eq!(hits, vec![0, 6, 12, 18]);

        // An upper-case query folds to the same thing.
        assert_eq!(search_document(&t, &fold_bytes(b"SpAiN"), true), hits);

        // Case-sensitive mode still discriminates.
        assert_eq!(search_document(&t, b"spain", false), vec![18]);
    }

    #[test]
    fn case_insensitive_search_spans_pieces() {
        let mut t = table("SPA");
        t.insert_text(t.total_length(), "in and Spain");
        assert_eq!(whole(&t), "SPAin and Spain");
        assert_eq!(search_document(&t, &fold_bytes(b"spain"), true), vec![0, 10]);
    }

    #[test]
    fn regex_search_returns_variable_length_matches() {
        let t = table("Spain spainish SPAIN");
        let regex = RegexBuilder::new(r"spain\w*")
            .case_insensitive(true)
            .unicode(false)
            .build()
            .unwrap();
        assert_eq!(
            search_regex_document(&t, &regex, false),
            vec![(0, 5), (6, 8), (15, 5)]
        );
    }

    #[test]
    fn regex_whole_word_filter_uses_document_boundaries() {
        let t = table("Spain spainish SPAIN");
        let regex = RegexBuilder::new("spain")
            .case_insensitive(true)
            .unicode(false)
            .build()
            .unwrap();
        assert_eq!(search_regex_document(&t, &regex, true), vec![(0, 5), (15, 5)]);
    }

    #[test]
    fn replace_all_in_reverse_order_updates_piece_table() {
        let mut t = table("the quick red fox jumps over the red dog\n");
        let pattern = b"red";
        let matches: Vec<(usize, usize)> = search_document(&t, pattern, false)
            .into_iter()
            .map(|offset| (offset, pattern.len()))
            .collect();
        assert_eq!(matches, vec![(10, 3), (33, 3)]);

        let replacement = "bright blue";
        for &(offset, length) in matches.iter().rev() {
            t.delete_text(offset, length);
            t.insert_text(offset, replacement);
        }

        assert_eq!(
            whole(&t),
            "the quick bright blue fox jumps over the bright blue dog\n"
        );
        assert_eq!(t.total_lines(), 2);
    }

    #[test]
    fn rapid_get_lines_on_large_table() {
        // Construct a large piece table representation
        let mut large_content = String::with_capacity(1_000_000);
        for i in 0..50_000 {
            use std::fmt::Write;
            let _ = writeln!(large_content, "Line {}: sample data text for piece table line indexing test", i);
        }
        let t = table(&large_content);
        assert_eq!(t.total_lines(), 50_001);

        // Perform fast repeated line range queries across distant offsets
        for start in (1..45_000).step_by(1_000) {
            let res = t.get_lines(start, start + 4000);
            assert!(!res.is_empty());
        }
    }

    #[test]
    fn convert_line_endings_between_lf_and_crlf() {
        let mut t = table("line 1\nline 2\nline 3\n");
        assert_eq!(detect_newline_format(whole(&t).as_bytes()), "LF");

        // Convert to CRLF
        let total = t.total_length();
        let bytes = t.get_bytes_range(0, total);
        let crlf_text = String::from_utf8_lossy(&bytes).replace('\n', "\r\n");
        t.delete_text(0, total);
        t.insert_text(0, &crlf_text);

        assert_eq!(detect_newline_format(whole(&t).as_bytes()), "CRLF");
        assert_eq!(whole(&t), "line 1\r\nline 2\r\nline 3\r\n");

        // Convert back to LF
        let total2 = t.total_length();
        let bytes2 = t.get_bytes_range(0, total2);
        let lf_text = String::from_utf8_lossy(&bytes2).replace("\r\n", "\n");
        t.delete_text(0, total2);
        t.insert_text(0, &lf_text);

        assert_eq!(detect_newline_format(whole(&t).as_bytes()), "LF");
        assert_eq!(whole(&t), "line 1\nline 2\nline 3\n");
    }
}
