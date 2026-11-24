import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const REPO = "bandyo/obsidian-notes";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, process.env.PUBLIC_DIR || "public");
const DEFAULT_GH = "C:/Users/Lingbo/.workbuddy/binaries/gh/gh.exe";
const GH = process.env.GH_CLI_PATH || (fs.existsSync(DEFAULT_GH) ? DEFAULT_GH : "gh");

function api(method, endpoint, body) {
  const args = ["api", "-X", method, endpoint];
  if (body !== undefined) args.push("--input", "-");
  const output = execFileSync(GH, args, {
    input: body === undefined ? undefined : JSON.stringify(body),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    cwd: ROOT,
  });
  return output.trim() ? JSON.parse(output) : null;
}

function walk(dir, base = "") {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...walk(path.join(dir, entry.name), relative));
    else result.push(relative);
  }
  return result;
}

if (!process.env.SKIP_BUILD) {
  console.log("Building site with Quartz...");
  const build = spawnSync("npx", ["quartz", "build"], {
    cwd: ROOT,
    shell: true,
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("Quartz build failed");
}

const files = walk(PUBLIC);
console.log(`Publishing ${files.length} static files to gh-pages...`);

let parent = null;
try {
  parent = api("GET", `/repos/${REPO}/git/ref/heads/gh-pages`).object.sha;
} catch {
  const v5 = api("GET", `/repos/${REPO}/git/ref/heads/v5`);
  api("POST", `/repos/${REPO}/git/refs`, {
    ref: "refs/heads/gh-pages",
    sha: v5.object.sha,
  });
}

const entries = [];
for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const content = fs.readFileSync(path.join(PUBLIC, file)).toString("base64");
  const blob = api("POST", `/repos/${REPO}/git/blobs`, {
    content,
    encoding: "base64",
  });
  entries.push({ path: file, mode: "100644", type: "blob", sha: blob.sha });
  if ((i + 1) % 20 === 0) console.log(`  uploaded ${i + 1}/${files.length}`);
}

const tree = api("POST", `/repos/${REPO}/git/trees`, { tree: entries });
const commit = api("POST", `/repos/${REPO}/git/commits`, {
  message: `Publish Quartz site: ${new Date().toISOString()}`,
  tree: tree.sha,
  parents: parent ? [parent] : [],
  author: { name: "bandyo", email: "bandyo@users.noreply.github.com" },
  committer: { name: "bandyo", email: "bandyo@users.noreply.github.com" },
});

if (parent) {
  api("PATCH", `/repos/${REPO}/git/refs/heads/gh-pages`, {
    sha: commit.sha,
    force: true,
  });
} else {
  api("POST", `/repos/${REPO}/git/refs`, {
    ref: "refs/heads/gh-pages",
    sha: commit.sha,
  });
}

api("PUT", `/repos/${REPO}/pages`, {
  build_type: "legacy",
  source: { branch: "gh-pages", path: "/" },
});

console.log(`Published: https://bandyo.github.io/obsidian-notes/`);
