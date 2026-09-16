import { defineConfig } from "vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // Pre-bundle up front: if the optimizer runs on first request instead, it answers in-flight
  // module requests with 504s and WebKitGTK never recovers (the window hangs on the boot overlay).
  optimizeDeps: {
    include: [
      "monaco-editor",
      "@tauri-apps/api/core",
      "@tauri-apps/api/event",
      "@tauri-apps/plugin-dialog",
    ],
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
