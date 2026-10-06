/**
 * Inspect, test, deploy and roll back Firestore security rules for the legacy
 * project, using the same service-account secret as the migration.
 *
 *   node scripts/firebase/rules.ts show                 # print the live rules (read-only)
 *   node scripts/firebase/rules.ts test                 # run firebase/firestore.rules against the test suite (no deploy)
 *   node scripts/firebase/rules.ts deploy               # backup live rules → test → deploy
 *   node scripts/firebase/rules.ts rollback <ruleset>   # point the release back at a previous ruleset
 *
 * Deploy refuses to run if the test suite fails, or if Firestore contains root
 * collections these rules don't cover (another app might depend on them).
 * Only rules change — no Firestore data is read or written by this tool,
 * apart from listing root collection ids.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const PROJECT = process.env.FIREBASE_PROJECT_ID ?? "amigo-world-ebfab";
const API = "https://firebaserules.googleapis.com/v1";
const RELEASE = `projects/${PROJECT}/releases/cloud.firestore`;
const COVERED = new Set(["users", "posts", "globalChat"]);

async function credential() {
  const { cert } = await import("firebase-admin/app");
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const raw = b64 ? Buffer.from(b64, "base64").toString("utf8") : process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Set FIREBASE_SERVICE_ACCOUNT_BASE64 in the environment's secrets.");
  return cert(JSON.parse(raw));
}

async function call(path: string, init: RequestInit = {}) {
  const token = (await (await credential()).getAccessToken()).access_token;
  const res = await fetch(`${API}/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${JSON.stringify(body.error?.message ?? body)}`);
  return body;
}

async function liveRuleset(): Promise<{ name: string; source: string }> {
  const release = await call(RELEASE);
  const ruleset = await call(release.rulesetName);
  return { name: release.rulesetName, source: ruleset.source.files.map((f: { content: string }) => f.content).join("\n") };
}

// Each case: who (null = signed out), operation, path, expected allow/deny.
const CASES: [string | null, "get" | "list" | "create" | "update" | "delete", string, boolean][] = [
  [null, "get", "users/alice", false],          // the privacy fix
  [null, "list", "users", false],
  ["bob", "get", "users/alice", false],
  ["bob", "list", "users", false],
  ["alice", "get", "users/alice", true],
  ["alice", "update", "users/alice", true],
  ["alice", "get", "users/alice/following/bob", true],
  [null, "get", "users/alice/following/bob", false],
  ["alice", "create", "users/alice/following/bob", true],
  ["alice", "create", "users/bob/followers/alice", true],
  ["alice", "create", "users/bob/followers/carol", false],
  [null, "list", "posts", true],                // legacy feed listener before sign-in
  [null, "get", "posts/p1/comments/c1", true],
  [null, "list", "globalChat", true],
  [null, "create", "posts/p1", false],
  ["alice", "create", "posts/p1", true],
  ["alice", "update", "posts/p1", true],
  ["alice", "delete", "posts/p1", false],
  ["alice", "create", "globalChat/m1", true],
  ["alice", "get", "someOtherCollection/x", false],
];

async function runTests(source: string) {
  const testCases = CASES.map(([uid, method, path, allow]) => ({
    expectation: allow ? "ALLOW" : "DENY",
    request: {
      auth: uid ? { uid, token: { sub: uid } } : null,
      method,
      path: `/databases/(default)/documents/${path}`,
      ...(method === "create" || method === "update" ? { resource: { data: {} } } : {}),
    },
    ...(method === "update" || method === "get" ? { resource: { data: {} } } : {}),
  }));
  const res = await call(`projects/${PROJECT}:test`, {
    method: "POST",
    body: JSON.stringify({ source: { files: [{ name: "firestore.rules", content: source }] }, testSuite: { testCases } }),
  });
  let failed = 0;
  (res.testResults ?? []).forEach((r: { state: string }, i: number) => {
    const [uid, method, path, allow] = CASES[i];
    const ok = r.state === "SUCCESS";
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${uid ?? "signed-out"} ${method} ${path} → expect ${allow ? "allow" : "deny"}`);
  });
  if (res.issues?.length) console.log("issues:", JSON.stringify(res.issues));
  return failed === 0 && !(res.issues ?? []).some((x: { severity: string }) => x.severity === "ERROR");
}

async function rootCollections(): Promise<string[]> {
  const { initializeApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const app = initializeApp({ credential: await credential(), projectId: PROJECT }, "rules-tool");
  return (await getFirestore(app).listCollections()).map((c) => c.id);
}

const [cmd, arg] = process.argv.slice(2);
const proposed = readFileSync("firebase/firestore.rules", "utf8");

if (cmd === "show") {
  const live = await liveRuleset();
  console.log(`# live ruleset: ${live.name}\n${live.source}`);
} else if (cmd === "test") {
  process.exit((await runTests(proposed)) ? 0 : 1);
} else if (cmd === "deploy") {
  const roots = await rootCollections();
  const uncovered = roots.filter((c) => !COVERED.has(c));
  if (uncovered.length && !process.argv.includes("--allow-uncovered")) {
    throw new Error(`Firestore has collections these rules would lock out: ${uncovered.join(", ")}. Review them first (or pass --allow-uncovered).`);
  }
  if (!(await runTests(proposed))) throw new Error("Rules tests failed — not deploying.");
  const live = await liveRuleset();
  mkdirSync("migration-data", { recursive: true });
  const backup = `migration-data/firestore-rules-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.rules`;
  writeFileSync(backup, `// ruleset ${live.name}\n${live.source}`);
  const created = await call(`projects/${PROJECT}/rulesets`, {
    method: "POST",
    body: JSON.stringify({ source: { files: [{ name: "firestore.rules", content: proposed }] } }),
  });
  await call(RELEASE, { method: "PATCH", body: JSON.stringify({ release: { name: RELEASE, rulesetName: created.name } }) });
  console.log(`deployed ${created.name}\nprevious ruleset ${live.name} (backup: ${backup})\nrollback: node scripts/firebase/rules.ts rollback ${live.name}`);
} else if (cmd === "rollback" && arg) {
  await call(RELEASE, { method: "PATCH", body: JSON.stringify({ release: { name: RELEASE, rulesetName: arg } }) });
  console.log(`release now points at ${arg}`);
} else {
  console.log("usage: rules.ts show | test | deploy [--allow-uncovered] | rollback <ruleset-name>");
}
