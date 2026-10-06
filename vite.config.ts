import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
