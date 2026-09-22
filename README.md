# MLog Text Editor

MLog Text Editor is a high-performance text editor built with Tauri, Rust, and TypeScript, specifically designed to handle multi-gigabyte files with ease. It features a piece-table data structure for instant editing and a highly optimized search engine.

## Key Features

- **Large File Support:** Open and edit files larger than your RAM instantly.
- **Fast Search:** Optimized search engine capable of handling millions of matches.
- **Advanced Navigation:** Navigate through up to 200,000 search results with fluid performance.
- **Visual Feedback:** Custom scrollbar markers showing match density across the entire file.
- **Instant Cancellation:** Stop search operations immediately when clearing the form or starting a new query.
- **Concurrent Processing:** Read-only operations (like searching) run in parallel, ensuring the UI remains responsive.

---

##  User Guide

### Getting Started
1. **Open a File:** Click the "Open File..." button or use `Ctrl + O`.
2. **Finding Text:** Press `Ctrl + F` to open the search bar. As you type, matches will stream into the editor.
3. **Navigating Matches:** Use the arrows in the search bar to jump between matches. The status bar shows the total number of hits.
4. **Replace Text:** Press `Ctrl + H` to open the replace interface.

### Performance Notes
- **Search Limit:** While the editor scans the entire file for an accurate count, it allows direct navigation for the first **200,000** results to maintain stability.
- **Visual Markers:** Yellow markers on the scrollbar represent match density. To keep the UI fast, these are capped at 5,000 markers for extremely common terms.

---

## Developer Guide

### Prerequisites
- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- [Node.js](https://nodejs.org/) (LTS)
- **Linux Dependencies:** `libwebkit2gtk-4.0-dev`, `build-essential`, `curl`, `wget`, `file`, `libssl-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`

### Development Workflow
1. **Install Dependencies:**
   ```bash
   npm install
   ```
2. **Run in Development Mode:**
   ```bash
   npm run tauri dev
   ```
3. **Build Production Artifacts:**
   ```bash
   npm run tauri build
   ```

### Project Structure
- `src/`: Frontend code (TypeScript, CSS, HTML).
  - `main.ts`: Editor logic and Monaco integration.
  - `styles.css`: Custom UI styling and scrollbar markers.
- `src-tauri/`: Backend code (Rust).
  - `src/lib.rs`: Piece table implementation and search logic.
  - `tauri.conf.json`: Tauri configuration and permissions.

---

## Technical Architecture

### Piece Table Implementation
The core of the editor is a **Piece Table** data structure. Unlike traditional buffers, the piece table keeps the original file as a read-only buffer and records edits in a separate "append-only" buffer. This allows for:
- Instant file opening (constant time).
- Low memory usage during editing.
- Unlimited undo/redo capability.

### Optimized Search Engine
- **Parallel Scanning:** Uses the `rayon` library to scan chunks of the file across all CPU cores.
- **RwLock Concurrency:** The document state is protected by a Read-Write Lock, allowing multiple search tasks to run concurrently without blocking each other.
- **Atomic Cancellation:** Search tasks check an `AtomicU64` request ID at every chunk boundary. If a new search starts, old tasks terminate immediately.
- **Binary Search Rendering:** The frontend uses binary search to identify visible matches in the current view, ensuring $O(\log N)$ rendering performance even with 200,000 matches.

---

##  Trade-offs and Considerations
- **Memory vs. Capacity:** We chose a 200,000 hit limit to balance deep navigation with browser memory stability (~30-50MB for 200k objects).
- **Marker Capping:** Visual markers are capped at 5,000 to prevent DOM saturation while still providing a representative density map.
