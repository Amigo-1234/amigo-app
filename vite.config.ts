import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
// The build's commit (set by Vercel) so Settings and error reports show exactly which build a phone runs.
const commit = (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7);
const appVersion = commit ? `${version}+${commit}` : version;

// `npm run dev:verify` only: the isolated Neon test branch verify-1029. Never Production.
const VERIFY_BRANCH = {
  NEON_AUTH_URL_OVERRIDE: "https://ep-proud-truth-zaymjmni.neonauth.c-2.eu-west-2.aws.neon.tech/neondb/auth",
  NEON_REST_URL_OVERRIDE: "https://ep-proud-truth-zaymjmni.apirest.c-2.eu-west-2.aws.neon.tech/neondb/rest/v1",
};

/**
 * Dev server only (mode "verify"): runs the api/ routes in-process, as Vercel would, so the app can
 * talk to the test branch locally: /neon/* -> api/neon.ts, /api/media/<key> -> api/media.ts,
 * /api/<name> -> api/<name>.ts. Not part of any build.
 */
function localApi(): Plugin {
  return {
    name: "amigo-local-api",
    apply: "serve",
    config(_, { mode }) {
      if (mode === "verify") Object.assign(process.env, VERIFY_BRANCH);
    },
    configureServer(server) {
      if (server.config.mode !== "verify") return;
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        let file: string | null = null;
        if (url.pathname.startsWith("/neon/")) {
          url.searchParams.set("path", decodeURIComponent(url.pathname.slice("/neon/".length)));
          file = "/api/neon.ts";
        } else if (url.pathname.startsWith("/api/media/")) {
          url.searchParams.set("path", decodeURIComponent(url.pathname.slice("/api/media/".length)));
          file = "/api/media.ts";
        } else {
          const name = /^\/api\/([a-z0-9-]+)$/.exec(url.pathname)?.[1];
          if (name && existsSync(new URL(`./api/${name}.ts`, import.meta.url))) file = `/api/${name}.ts`;
        }
        if (!file) return next();
        try {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
          const method = req.method ?? "GET";
          const request = new Request(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks) });
          const handler = (await server.ssrLoadModule(file)).default as (r: Request) => Promise<Response>;
          const response = await handler(request);
          res.statusCode = response.status;
          response.headers.forEach((v, k) => k !== "set-cookie" && res.setHeader(k, v));
          const cookies = response.headers.getSetCookie();
          if (cookies.length) res.setHeader("set-cookie", cookies);
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (e) {
          server.config.logger.error(`[local api] ${file}: ${(e as Error).message}`);
          res.statusCode = 502;
          res.end("local api error");
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    localApi(),
    // /version.json: what the running app compares itself with to offer a reload (src/features/update).
    {
      name: "amigo-version-file",
      apply: "build",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version: appVersion }) });
      },
    },
  ],
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
