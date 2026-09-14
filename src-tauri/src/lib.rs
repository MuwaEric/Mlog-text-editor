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

/// Searches the *logical* document (original bytes plus user edits) in parallel.
///
/// Every piece is scanned independently, and pieces larger than `CHUNK_SIZE` are split further
/// so the 8 GB original piece saturates all cores and the SSD's sequential read path. Two kinds
/// of boundary are handled explicitly so no match is missed or double-counted:
///   * chunk boundaries inside a piece — each chunk scans `pattern.len() - 1` bytes past its
///     primary region, and reports only matches that *start* in the primary region;
///   * piece boundaries — a small window around each one is re-scanned for matches that
///     straddle it, which is the only way a match can span the original buffer and an edit.
fn search_document(table: &PieceTable, pattern: &[u8]) -> Vec<usize> {
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

    let mut hits: Vec<usize> = tasks
        .par_iter()
        .flat_map(|&(i, s)| {
            let p = table.pieces[i];
            let bytes = table.piece_bytes(&p);
            let primary_end = (s + CHUNK_SIZE).min(p.length);
            let scan_end = (primary_end + overlap).min(p.length);
            let base = table.cum_bytes[i] + s;
            boyer_moore_horspool(&bytes[s..scan_end], pattern)
                .into_iter()
                .filter(move |&local| s + local < primary_end)
                .map(move |local| base + local)
                .collect::<Vec<_>>()
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
            boyer_moore_horspool(&window, pattern)
                .into_iter()
                .map(move |local| lo + local)
                .filter(move |&abs| abs < b && abs + m > b)
                .collect::<Vec<_>>()
        })
        .collect();

    hits.extend(boundary_hits);
    hits.sort_unstable();
    hits.dedup(); // a match spanning several tiny pieces is found at each boundary it crosses
    hits
}

// ---------------------------------------------------------------------------------------------
// Session / Tauri state
// ---------------------------------------------------------------------------------------------

/// Matches returned to the UI are capped: a search for "e" in an 8 GB file has billions of
/// hits, and serializing them over IPC would defeat the whole point of streaming the file.
const MAX_REPORTED_HITS: usize = 5_000;

#[derive(Default)]
struct AppState(Arc<Mutex<Option<PieceTable>>>);

#[derive(Serialize, Clone)]
struct FileMeta {
    total_lines: usize,
    size_bytes: usize,
}

/// 1-based line and UTF-16 column, i.e. directly usable as a Monaco `IPosition`.
#[derive(Serialize, Clone)]
struct SearchHit {
    byte_offset: usize,
    line: usize,
    column: usize,
}

#[derive(Serialize, Clone)]
struct SearchResult {
    total_matches: usize,
    truncated: bool,
    hits: Vec<SearchHit>,
}

#[derive(Serialize, Clone)]
struct ScanProgress {
    bytes_scanned: usize,
    total_bytes: usize,
}

/// Runs `f` against the open document on a blocking thread so neither the mmap page faults nor
/// the index work ever land on the UI thread.
async fn with_table<T, F>(state: &State<'_, AppState>, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut PieceTable) -> T + Send + 'static,
{
    let inner = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = inner.lock().map_err(|e| e.to_string())?;
        let table = guard.as_mut().ok_or("no file open")?;
        Ok(f(table))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens `path` with `mmap` and scans it for line breaks on a background task, then stores the
/// resulting Piece Table in app state.
#[tauri::command]
async fn open_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<FileMeta, String> {
    let inner = state.0.clone();

    let table = tauri::async_runtime::spawn_blocking(move || -> Result<PieceTable, String> {
        let file = File::open(&path).map_err(|e| e.to_string())?;
        // SAFETY: as with any mmap, behaviour is undefined if another process truncates the
        // file while it is mapped. That is the standard, unavoidable caveat of this approach.
        let mmap = unsafe { Mmap::map(&file) }.map_err(|e| e.to_string())?;

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
        Ok(PieceTable::new(Arc::new(mmap), Arc::new(newlines)))
    })
    .await
    .map_err(|e| e.to_string())??;

    let meta = FileMeta {
        total_lines: table.total_lines(),
        size_bytes: table.total_length(),
    };
    *inner.lock().map_err(|e| e.to_string())? = Some(table);
    Ok(meta)
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

/// Multi-threaded Boyer-Moore-Horspool search over the live document, with hits mapped back to
/// Monaco positions through the piece table's line index.
#[tauri::command]
async fn search_text(state: State<'_, AppState>, query: String) -> Result<SearchResult, String> {
    with_table(&state, move |table| {
        let offsets = search_document(table, query.as_bytes());
        let total_matches = offsets.len();
        let hits = offsets
            .iter()
            .take(MAX_REPORTED_HITS)
            .map(|&byte_offset| {
                let (line, column) = table.position_of_offset(byte_offset);
                SearchHit {
                    byte_offset,
                    line,
                    column,
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
            get_lines,
            insert_text,
            delete_text,
            search_text,
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
    fn search_finds_matches_spanning_pieces() {
        let mut t = table("hello wor");
        t.insert_text(t.total_length(), "ld and hello world");
        assert_eq!(whole(&t), "hello world and hello world");

        let hits = search_document(&t, b"hello world");
        assert_eq!(hits, vec![0, 16]); // the first match straddles the piece boundary
        assert_eq!(t.position_of_offset(16), (1, 17));
    }

    #[test]
    fn search_handles_overlapping_and_absent_patterns() {
        let t = table("aaaa");
        assert_eq!(search_document(&t, b"aa"), vec![0, 1, 2]);
        assert!(search_document(&t, b"zz").is_empty());
        assert!(search_document(&t, b"").is_empty());
    }
}
