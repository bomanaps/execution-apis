import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exit } from "node:process";

const MAX_VERSIONS = 10;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...opts,
  });
}

function semverDesc(a, b) {
  const pa = String(a)
    .replace(/^v/, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const pb = String(b)
    .replace(/^v/, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  }
  return 0;
}

function listReleases() {
  try {
    const raw = sh("gh", [
      "release",
      "list",
      "--json",
      "tagName,isDraft,isPrerelease,publishedAt",
      "-L",
      "100",
    ]);
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`assemble-versions: gh release list failed: ${err.message}`);
    return [];
  }
}

function downloadAndExtract(tag) {
  const dir = mkdtempSync(join(tmpdir(), `snap-${tag.replace(/[^A-Za-z0-9.-]/g, "_")}-`));
  try {
    sh("gh", [
      "release",
      "download",
      tag,
      "-p",
      "docs-snapshot-*.tar.gz",
      "-D",
      dir,
    ]);
    const files = readdirSync(dir).filter((f) => f.endsWith(".tar.gz"));
    if (files.length === 0) {
      console.warn(`assemble-versions: ${tag} has no docs-snapshot asset; skipping`);
      return false;
    }
    sh("tar", ["-xzf", join(dir, files[0])], { stdio: "inherit" });
    return true;
  } catch (err) {
    console.warn(`assemble-versions: failed to fetch snapshot for ${tag}: ${err.message}`);
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parsePending(argv) {
  const i = argv.indexOf("--pending");
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v) {
    console.error("assemble-versions: --pending requires a tag value");
    exit(2);
  }
  return v;
}

const pendingTag = parsePending(process.argv.slice(2));
const pendingVer = pendingTag ? pendingTag.replace(/^v/, "") : null;

const released = listReleases()
  .filter((r) => !r.isDraft && !r.isPrerelease)
  .map((r) => r.tagName);

const allTags = [...new Set([...(pendingTag ? [pendingTag] : []), ...released])];

if (allTags.length === 0) {
  console.log("assemble-versions: no published or pending releases; nothing to assemble");
  exit(0);
}

// Sort desc, cap to MAX_VERSIONS, but always retain pending if provided.
let tags = allTags.sort(semverDesc);
if (pendingTag) {
  const others = tags.filter((t) => t !== pendingTag).slice(0, MAX_VERSIONS - 1);
  tags = [pendingTag, ...others].sort(semverDesc);
} else {
  tags = tags.slice(0, MAX_VERSIONS);
}

const kept = [];
for (const tag of tags) {
  const ver = tag.replace(/^v/, "");
  if (pendingVer && ver === pendingVer) {
    // Pending version is materialized locally by the caller via
    // `docusaurus docs:version:api $VER` — its release doesn't exist yet
    // (or may be a draft on re-runs), so skip the download path.
    kept.push(ver);
    continue;
  }
  if (downloadAndExtract(tag)) kept.push(ver);
}

if (kept.length === 0) {
  console.log("assemble-versions: no snapshots successfully extracted");
  exit(0);
}

writeFileSync("api_versions.json", JSON.stringify(kept, null, 2) + "\n");
console.log(`assemble-versions: wrote api_versions.json with ${kept.length} version(s):`);
for (const v of kept) console.log(`  - ${v}`);
