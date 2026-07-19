import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const releaseTextExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".svg",
  ".txt",
  ".yaml",
  ".yml",
]);

async function releaseTextFiles(target) {
  let targetStat;
  try {
    targetStat = await stat(target);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  if (targetStat.isDirectory()) {
    const files = [];
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      files.push(...(await releaseTextFiles(path.join(target, entry.name))));
    }
    return files;
  }

  if (!targetStat.isFile()) return [];
  const basename = path.basename(target);
  return releaseTextExtensions.has(path.extname(target)) || basename === ".gitignore"
    ? [target]
    : [];
}

test("public release files contain no private or environment-specific material", async () => {
  const roots = [
    ".gitignore",
    ".oxfmtrc.json",
    ".oxlintrc.json",
    "README.md",
    "inkpath.yaml",
    "package.json",
    "pnpm-lock.yaml",
    "notes",
    "public",
    "tests",
    "site",
  ].map((entry) => path.join(repositoryRoot, entry));
  const files = (await Promise.all(roots.map((root) => releaseTextFiles(root)))).flat();
  const patterns = [
    [/\/Users\/[^\s)`"']+/i, "a local macOS user path"],
    [/\/var\/folders\/[^\s)`"']+/i, "a local macOS temporary path"],
    [/[A-Za-z]:\\Users\\[^\s)`"']+/i, "a local Windows user path"],
    [/[a-z0-9.-]+\.(?:internal|corp)(?=[:/\s)`"']|$)/i, "an internal hostname"],
    [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, "an AWS access key identifier"],
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "a private key"],
    [/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}\b/, "a GitHub token"],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "a Slack token"],
    [/\bnpm_[A-Za-z0-9]{36}\b/, "an npm token"],
    [/\b\d{12}\b/, "a 12-digit cloud account identifier"],
    [
      /https:\/\/(?:www\.)?(?:notion\.so|slack\.com|linear\.app|app\.asana\.com)\//i,
      "a workspace URL",
    ],
  ];
  const fixedDenylist = [
    ["Ever", "green"].join(""),
    ["Green", "bax"].join(""),
    ["github.com/", "Green", "bax"].join(""),
  ];
  const configuredDenylist = (process.env.NOTES_RELEASE_DENYLIST ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const denylist = [...fixedDenylist, ...configuredDenylist].map((entry) =>
    entry.toLocaleLowerCase(),
  );

  for (const file of files) {
    const relative = path.relative(repositoryRoot, file);
    const raw = await readFile(file, "utf8");
    for (const [pattern, description] of patterns) {
      assert.doesNotMatch(raw, pattern, `${relative} contains ${description}`);
    }

    const normalized = raw.toLocaleLowerCase();
    for (const term of denylist) {
      assert.ok(!normalized.includes(term), `${relative} contains a denylisted release term`);
    }
  }
});
