# MLog Text Editor

MLog Text Editor is a high-performance text editor built with Tauri, Rust, and TypeScript, specifically designed to handle multi-gigabyte files with ease. It features a piece-table data structure for instant editing and a highly optimized search engine.

## Key Features

- **Large File Support:** Open and edit files larger than your RAM instantly.
- **Fast Search:** Optimized search engine capable of handling millions of matches.
- **Advanced Navigation:** Navigate through up to 200,000 search results with fluid performance.
- **Visual Feedback:** Custom scrollbar markers showing match density across the entire file.
- **Instant Cancellation:** Stop search operations immediately when clearing the form or starting a new query.
- **Concurrent Processing:** Read-only operations (like searching) run in parallel, ensuring the UI remains responsive.

## Installation

For users who want to use MLog Text Editor without building it from source:

### Linux (Debian/Ubuntu)

#### Option 1: Direct Download (Easiest)
1. Download the latest `.deb` package from the [Releases](https://github.com/MuwaEric/Mlog-text-editor/releases) page.
2. Install it using `apt` (recommended, as it handles dependencies automatically by fetching them from official repositories):
   ```bash
   sudo apt install ./MLog-Text-Editor_0.1.0_amd64.deb
   ```
3. Alternatively, use `dpkg` (Note: `dpkg` does not resolve dependencies automatically, so you must follow up with `apt install -f` if it fails):
   ```bash
   sudo dpkg -i MLog-Text-Editor_0.1.0_amd64.deb
   sudo apt install -f  # Fix dependency issues by installing missing requirements
   ```

#### Option 2: Using a PPA or Custom Repository
To install and receive updates via `sudo apt install mlog-text-editor`, you can add the MLog repository to your system:

```bash
# 1. Add the repository GPG key
curl -fsSL https://proget.example.com/api/gpg/mlog | sudo gpg --dearmor -o /etc/apt/keyrings/mlog.gpg

# 2. Add the repository to your sources list
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/mlog.gpg] https://proget.example.com/mlog-apt/ stable main" | sudo tee /etc/apt/sources.list.d/mlog.list

# 3. Update and install
sudo apt update
sudo apt install mlog-text-editor
```
*(Note: Replace URLs with your actual repository endpoints if you set up a custom PPA or hosting service.)*

#### Option 3: AppImage (Portable)
1. Download the `.AppImage` file from the [Releases](https://github.com/MuwaEric/Mlog-text-editor/releases) page.
2. Make it executable: `chmod +x MLog-Text-Editor_0.1.0_amd64.AppImage`
3. Run it!

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
