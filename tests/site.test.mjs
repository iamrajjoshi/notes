import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const siteRoot = path.join(repositoryRoot, "site");
async function filesNamed(directory, name) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesNamed(entryPath, name)));
    else if (entry.isFile() && entry.name === name) files.push(entryPath);
  }
  return files.sort();
}

async function renderedPages() {
  return Promise.all(
    (await filesNamed(siteRoot, "index.html")).map(async (file) => ({
      file,
      html: await readFile(file, "utf8"),
    })),
  );
}

test("Inkpath builds a clean static reading surface", async () => {
  const config = YAML.parse(await readFile(path.join(repositoryRoot, "inkpath.yaml"), "utf8"));
  assert.equal(config.site.basePath, undefined);
  assert.equal(config.theme.showListDetails, false);
  assert.equal(config.theme.showPageDetails, false);
  await access(path.join(siteRoot, "index.html"));
  await assert.rejects(access(path.join(siteRoot, "learn")));
  await assert.rejects(access(path.join(siteRoot, "tracks")));

  const pages = await renderedPages();
  assert.ok(pages.length > 1);
  for (const { html } of pages) {
    assert.match(html, /<link rel="stylesheet" href="\/theme\.css">/);
    assert.doesNotMatch(html, /class="page-source"/);
    assert.doesNotMatch(html, /<script[^>]+src="[^"]*(?:_next|react|vite)/i);
    const backlinks = html.match(/<section class="backlinks"[\s\S]*?<\/section>/)?.[0];
    if (backlinks) assert.doesNotMatch(backlinks, /<span>/);
  }

  const sourceCss = await readFile(path.join(repositoryRoot, "public", "theme.css"), "utf8");
  const builtCss = await readFile(path.join(siteRoot, "theme.css"), "utf8");
  assert.equal(builtCss, sourceCss);
  for (const structuralRule of [
    ".page-meta > li",
    ".page-meta > li:not(:has(.breadcrumbs))",
    ".page-meta > li:has(.breadcrumbs)::after",
    ".page-tags",
    ".heading-permalink",
    "details.annotation",
    ".math-display",
    ".backlinks",
    "@media (hover: none)",
  ]) {
    assert.ok(sourceCss.includes(structuralRule), `theme needs ${structuralRule}`);
  }
  assert.doesNotMatch(sourceCss, /\.backlinks \{[^}]*border-top/);
  assert.doesNotMatch(sourceCss, /\.backlinks span \{/);
  for (const token of [
    "--background: #ffffff",
    "--ink: #171513",
    "--muted: #56534d",
    "--faint: #77736b",
    "--line: #e7e3dc",
    "--willow: #2dd4bf",
    "--accent: var(--willow)",
    "--accent-soft: #f0fdfa",
    "--interactive: #0f766e",
    "--interactive-hover: #0b5f59",
  ]) {
    assert.ok(sourceCss.includes(token), `theme needs ${token}`);
  }
  assert.match(sourceCss, /::selection \{\s*background: var\(--willow\);\s*color: var\(--ink\)/);
  assert.match(
    sourceCss,
    /a \{\s*color: var\(--interactive\);\s*text-decoration-color: currentColor/,
  );
  assert.match(
    sourceCss,
    /a:hover \{\s*color: var\(--interactive-hover\);\s*text-decoration-color: var\(--willow\)/,
  );
  assert.match(
    sourceCss,
    /\.site-brand:hover,\s*\.site-brand:focus-visible \{\s*color: var\(--ink\)/,
  );
  assert.match(
    sourceCss,
    /\.content-list a:hover \.content-list__title-text \{[^}]*text-decoration-color: var\(--willow\)/,
  );
  assert.match(
    sourceCss,
    /\.page-pagination a:hover strong \{\s*text-decoration-color: var\(--willow\)/,
  );
  assert.match(
    sourceCss,
    /\.page-meta > li:not\(:has\(\.breadcrumbs\)\),\s*\.page-tags,\s*\.content-list__meta\s*{\s*display: none;/,
  );
  const visibilityOverride = sourceCss.indexOf("/* Keep the Notes surface minimal");
  assert.ok(visibilityOverride > sourceCss.indexOf(".page-tags {\n  display: flex;"));
  assert.ok(visibilityOverride > sourceCss.indexOf(".content-list__meta {\n  display: block;"));
});

test("every rendered note keeps its reading structure", async () => {
  const notePages = (await renderedPages()).filter(({ file }) => {
    const depth = path.relative(siteRoot, file).split(path.sep).length;
    return depth === 3;
  });
  assert.ok(notePages.length > 0);

  for (const { file, html } of notePages) {
    const relative = path.relative(siteRoot, file);
    assert.match(html, />Contents</, `${relative} needs a table of contents`);
    assert.match(html, />Summary</, `${relative} needs a summary`);
    assert.match(html, />References</, `${relative} needs references`);
    assert.match(html, /aria-label="Adjacent notes"/, `${relative} needs adjacent navigation`);
    assert.match(html, /aria-label="Breadcrumb"/, `${relative} needs breadcrumbs`);
  }
});

test("the root and collection pages use collection and note labels", async () => {
  const home = await readFile(path.join(siteRoot, "index.html"), "utf8");
  assert.match(home, /<h2 id="content-list-title" class="section-heading">Collections<\/h2>/);
  assert.doesNotMatch(home, /class="content-list__meta">\d+ notes<\/span>/);

  const collectionPages = (await renderedPages()).filter(({ file }) => {
    const depth = path.relative(siteRoot, file).split(path.sep).length;
    return depth === 2;
  });
  assert.ok(collectionPages.length > 0);
  for (const { html } of collectionPages) {
    assert.match(html, /<h2 id="content-list-title" class="section-heading">Notes<\/h2>/);
    assert.doesNotMatch(html, /class="content-list__meta">\d+ notes<\/span>/);
  }
});

test("public executable examples ship with the generated notes", async () => {
  for (const source of ["first-tool-loop.mjs", "minimal-harness.mjs", "durable-harness.mjs"]) {
    await access(path.join(siteRoot, "_content", "05-harness-engineering", "examples", source));
  }
  await access(
    path.join(siteRoot, "_content", "04-ai-inference", "examples", "serving-contract-fixture.mjs"),
  );
});

test("Mermaid stays local and diagrams retain accessible descriptions", async () => {
  const pages = await renderedPages();
  const diagramPages = pages.filter(({ html }) => html.includes("data-inkpath-diagram"));
  assert.ok(diagramPages.length > 0);

  for (const { file, html } of diagramPages) {
    const relative = path.relative(siteRoot, file);
    const renderer = html.match(/src="(\/_inkpath\/inkpath-[A-Z0-9]+\.js)"/i)?.[1];
    assert.ok(renderer, `${relative} needs a content-hashed local renderer`);
    await access(path.join(siteRoot, renderer.replace(/^\/+/, "")));
    assert.match(html, /accTitle:/, `${relative} needs a diagram title`);
    assert.match(html, /accDescr:/, `${relative} needs a diagram description`);
  }

  for (const { file, html } of pages.filter(({ html }) => !html.includes("data-inkpath-diagram"))) {
    assert.doesNotMatch(
      html,
      /src="\/_inkpath\/inkpath-[A-Z0-9]+\.js"/i,
      `${path.relative(siteRoot, file)} loads Mermaid without a diagram`,
    );
  }
});

test("the notes repo pins the reviewed Inkpath release", async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(manifest.devDependencies.inkpath, "0.3.0");
  assert.equal(manifest.devDependencies["@iamrajjoshi/inkpath"], undefined);

  const lockfile = YAML.parse(await readFile(path.join(repositoryRoot, "pnpm-lock.yaml"), "utf8"));
  const dependency = lockfile.importers["."].devDependencies.inkpath;
  assert.equal(dependency.specifier, "0.3.0");
  assert.equal(dependency.version, "0.3.0");
});
