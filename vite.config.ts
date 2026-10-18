import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
// The build's commit (set by Vercel) so Settings and error reports show exactly which build a phone runs.
const commit = (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7);
const appVersion = commit ? `${version}+${commit}` : version;

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  // legacy/ holds the old prototype page for reference only.
  optimizeDeps: { entries: ["index.html"] },
  build: {
    target: "es2022",
    // Firebase (auth + firestore) is one ~160 KB gzip chunk, cached separately.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/firebase") || id.includes("node_modules/@firebase")) return "firebase";
          if (id.includes("node_modules/react")) return "react";
        },
      },
    },
  },
});
