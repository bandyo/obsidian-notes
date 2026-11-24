import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const REPO = "bandyo/obsidian-notes";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.join(ROOT, "content");
const DEFAULT_GH = "C:/Users/Lingbo/.workbuddy/binaries/gh/gh.exe";
const GH = process.env.GH_CLI_PATH || (fs.existsSync(DEFAULT_GH) ? DEFAULT_GH : "gh");
const CHECK_ONLY = process.argv.includes("--check");
const NO_PUBLISH = process.argv.includes("--no-publish");

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

function blobSha(buffer) {
  return crypto
    .createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${buffer.length}\0`), buffer]))
    .digest("hex");
}

function walk(dir, base = "") {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (base === "" && entry.name === ".obsidian") continue;
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...walk(path.join(dir, entry.name), relative));
    else result.push(relative);
  }
  return result;
}

const remoteTree = api("GET", `/repos/${REPO}/git/trees/v5?recursive=1`);
const remoteMap = new Map(
  remoteTree.tree
    .filter((item) => item.type === "blob" && item.path.startsWith("content/"))
    .map((item) => [item.path, item.sha])
);

const localMap = new Map(
  walk(CONTENT).map((file) => {
    const remotePath = `content/${file.split(path.sep).join("/")}`;
    return [remotePath, blobSha(fs.readFileSync(path.join(CONTENT, file)))];
  })
);

const changes = [];
for (const [remotePath, sha] of localMap) {
  if (!remoteMap.has(remotePath)) changes.push({ path: remotePath, action: "新增", sha });
  else if (remoteMap.get(remotePath) !== sha)
    changes.push({ path: remotePath, action: "更新", sha });
}
for (const remotePath of remoteMap.keys()) {
  if (!localMap.has(remotePath)) changes.push({ path: remotePath, action: "删除", sha: null });
}

if (changes.length === 0) {
  console.log("笔记内容没有变化，无需同步。");
} else {
  console.log(`发现 ${changes.length} 处变更：`);
  for (const change of changes) console.log(`  [${change.action}] ${change.path}`);
}

if (CHECK_ONLY || changes.length === 0) {
  if (!NO_PUBLISH && !CHECK_ONLY && changes.length === 0) {
    console.log("跳过源码提交，检查网站是否已是最新...");
  }
} else {
  const entries = [];
  for (const change of changes) {
    if (change.sha === null) {
      entries.push({
        path: change.path,
        mode: "100644",
        type: "blob",
        sha: null,
      });
      continue;
    }
    const localFile = path.join(ROOT, change.path.split("/").join(path.sep));
    const blob = api("POST", `/repos/${REPO}/git/blobs`, {
      content: fs.readFileSync(localFile).toString("base64"),
      encoding: "base64",
    });
    entries.push({ path: change.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const tree = api("POST", `/repos/${REPO}/git/trees`, {
    base_tree: remoteTree.sha,
    tree: entries,
  });
  const ref = api("GET", `/repos/${REPO}/git/ref/heads/v5`);
  const commit = api("POST", `/repos/${REPO}/git/commits`, {
    message: `Sync Obsidian notes: ${new Date().toLocaleString("zh-CN")}`,
    tree: tree.sha,
    parents: [ref.object.sha],
    author: { name: "bandyo", email: "bandyo@users.noreply.github.com" },
    committer: { name: "bandyo", email: "bandyo@users.noreply.github.com" },
  });
  api("PATCH", `/repos/${REPO}/git/refs/heads/v5`, {
    sha: commit.sha,
    force: true,
  });
  console.log("源码已同步到 GitHub 的 v5 分支。");
}

if (!CHECK_ONLY && !NO_PUBLISH) {
  console.log("正在更新线上网站...");
  const result = spawnSync(process.execPath, [path.join(ROOT, "publish.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, SKIP_BUILD: "" },
  });
  if (result.status !== 0) throw new Error("网站发布失败");
}
