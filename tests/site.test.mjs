import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const siteRoot = path.join(repositoryRoot, "site");
const generatorCommit = "56fc260c9d5380315b4f18c572684c31849ed2a3";

async function filesNamed(directory, name) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesNamed(entryPath, name)));
    else if (entry.isFile() && entry.name === name) files.push(entryPath);
  }
  return files.sort();
}

test("the site uses clean root-relative routes", async () => {
  const config = YAML.parse(await readFile(path.join(repositoryRoot, "inkpath.yaml"), "utf8"));
  assert.equal(config.site.basePath, undefined);
  assert.equal((await filesNamed(siteRoot, "index.html")).length, 68);
  await access(path.join(siteRoot, "index.html"));
  await access(path.join(siteRoot, "system-design", "api-network-path", "index.html"));
  await access(path.join(siteRoot, "system-design", "relational-engine-internals", "index.html"));
  await access(
    path.join(siteRoot, "low-level-infrastructure", "observability-and-debugging", "index.html"),
  );
  await access(
    path.join(
      siteRoot,
      "distributed-systems",
      "consensus-and-replicated-state-machines",
      "index.html",
    ),
  );
  await assert.rejects(access(path.join(siteRoot, "learn")));
  await assert.rejects(access(path.join(siteRoot, "tracks")));
});

test("the rendered curriculum follows prerequisite order", async () => {
  const home = await readFile(path.join(siteRoot, "index.html"), "utf8");
  const collectionRoutes = [
    "/cloud-infrastructure/",
    "/low-level-infrastructure/",
    "/distributed-systems/",
    "/system-design/",
    "/ai-inference/",
    "/harness-engineering/",
  ];
  let previous = -1;
  for (const route of collectionRoutes) {
    const position = home.indexOf(`href="${route}"`);
    assert.ok(position > previous, `${route} must follow its prerequisites on the home page`);
    previous = position;
  }

  const inference = await readFile(path.join(siteRoot, "ai-inference", "index.html"), "utf8");
  assert.ok(
    inference.indexOf('href="/ai-inference/serving-lifecycle/"') <
      inference.indexOf('href="/ai-inference/gpu-systems/"'),
    "the request lifecycle must render before GPU microarchitecture",
  );

  const cloud = await readFile(path.join(siteRoot, "cloud-infrastructure", "index.html"), "utf8");
  const cloudOperations = [
    "/cloud-infrastructure/infrastructure-as-code-and-gitops/",
    "/cloud-infrastructure/production-operation/",
    "/cloud-infrastructure/shared-production-services/",
  ];
  let previousCloudOperation = -1;
  for (const route of cloudOperations) {
    const position = cloud.indexOf(`href="${route}"`);
    assert.ok(position > previousCloudOperation, `${route} must follow its prerequisite`);
    previousCloudOperation = position;
  }
});

test("all note pages expose summaries, references, contents, and navigation", async () => {
  const notePages = (await filesNamed(siteRoot, "index.html")).filter((file) => {
    const depth = path.relative(siteRoot, file).split(path.sep).length;
    return depth === 3;
  });
  assert.equal(notePages.length, 61);
  for (const file of notePages) {
    const html = await readFile(file, "utf8");
    assert.match(html, />Contents</);
    assert.match(html, />Summary</);
    assert.match(html, />References</);
    assert.match(html, /aria-label="Adjacent notes"/);
  }
});

test("collection pages omit counts, source links, and empty footers", async () => {
  const home = await readFile(path.join(siteRoot, "index.html"), "utf8");
  const cloud = await readFile(path.join(siteRoot, "cloud-infrastructure", "index.html"), "utf8");
  for (const page of [home, cloud]) {
    assert.doesNotMatch(page, /class="page-source"/);
    assert.doesNotMatch(page, /class="page-footer"/);
    assert.doesNotMatch(page, /class="content-list__meta">\d+ notes<\/span>/);
  }
  assert.doesNotMatch(cloud, /<li>\d+ notes<\/li>/);
});

test("the root lists Collections and every section lists Notes", async () => {
  const home = await readFile(path.join(siteRoot, "index.html"), "utf8");
  const cloud = await readFile(path.join(siteRoot, "cloud-infrastructure", "index.html"), "utf8");
  const renderedPages = await Promise.all(
    (await filesNamed(siteRoot, "index.html")).map((file) => readFile(file, "utf8")),
  );

  assert.match(home, /<h2 id="content-list-title" class="section-heading">Collections<\/h2>/);
  assert.match(cloud, /<h2 id="content-list-title" class="section-heading">Notes<\/h2>/);
  assert.doesNotMatch(
    renderedPages.join("\n"),
    /<h2 id="content-list-title" class="section-heading">Contents<\/h2>/,
  );
});

test("breadcrumbs include every ancestor page without repeating the current title", async () => {
  const home = await readFile(path.join(siteRoot, "index.html"), "utf8");
  const cloud = await readFile(path.join(siteRoot, "cloud-infrastructure", "index.html"), "utf8");
  const kubernetes = await readFile(
    path.join(
      siteRoot,
      "cloud-infrastructure",
      "kubernetes-networking-storage-security",
      "index.html",
    ),
    "utf8",
  );

  assert.doesNotMatch(home, /aria-label="Breadcrumb"/);
  assert.match(
    cloud,
    /<nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="\/">Home<\/a><\/li><\/ol><\/nav>/,
  );
  assert.match(
    kubernetes,
    /<nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="\/">Home<\/a><span class="breadcrumbs__separator" aria-hidden="true">\/<\/span><\/li><li><a href="\/cloud-infrastructure\/">Cloud infrastructure<\/a><\/li><\/ol><\/nav>/,
  );
  assert.equal((kubernetes.match(/aria-label="Breadcrumb"/g) ?? []).length, 1);
  assert.match(kubernetes, /<li>CI4<\/li>/);
});

test("the public executable examples ship with the generated notes", async () => {
  for (const source of ["first-tool-loop.mjs", "minimal-harness.mjs", "durable-harness.mjs"]) {
    await access(path.join(siteRoot, "_content", "05-harness-engineering", "examples", source));
  }
  await access(
    path.join(siteRoot, "_content", "04-ai-inference", "examples", "serving-contract-fixture.mjs"),
  );

  const foundation = await readFile(
    path.join(siteRoot, "harness-engineering", "model-agent-and-harness", "index.html"),
    "utf8",
  );
  assert.match(
    foundation,
    /href="\/_content\/05-harness-engineering\/examples\/first-tool-loop\.mjs"/,
  );
  assert.match(
    foundation,
    /href="\/_content\/05-harness-engineering\/examples\/minimal-harness\.mjs"/,
  );
  const durability = await readFile(
    path.join(
      siteRoot,
      "harness-engineering",
      "durable-state-continuity-and-handoffs",
      "index.html",
    ),
    "utf8",
  );
  assert.match(
    durability,
    /href="\/_content\/05-harness-engineering\/examples\/durable-harness\.mjs"/,
  );
  const serving = await readFile(
    path.join(siteRoot, "ai-inference", "serving-engines", "index.html"),
    "utf8",
  );
  assert.match(
    serving,
    /href="\/_content\/04-ai-inference\/examples\/serving-contract-fixture\.mjs"/,
  );
});

test("the generated surface is static, minimal, and free of retired UI", async () => {
  const htmlFiles = await filesNamed(siteRoot, "index.html");
  const renderedPages = await Promise.all(htmlFiles.map((file) => readFile(file, "utf8")));
  for (const page of renderedPages) {
    assert.match(
      page,
      /<a class="site-brand"[^>]*>\s*<img class="site-logo" src="\/favicon\.svg" alt="" width="28" height="28">\s*<span class="site-title">/,
    );
    assert.equal((page.match(/class="site-logo"/g) ?? []).length, 1);
    assert.doesNotMatch(page, /class="site-mark"/);
    assert.doesNotMatch(page, /class="page-source"/);
    assert.doesNotMatch(page, /<h[1-4][^>]*>[\s\S]*?class="site-logo"[\s\S]*?<\/h[1-4]>/i);
    assert.match(page, /<link rel="stylesheet" href="\/theme\.css">/);
    assert.doesNotMatch(page, /_inkpath\/theme\.css/);
  }
  const html = renderedPages.join("\n");
  for (const phrase of [
    "Reading guide",
    "Reference policy",
    "Mark complete",
    "Reading progress",
    "Search notes",
  ]) {
    assert.doesNotMatch(html, new RegExp(phrase, "i"));
  }
  assert.doesNotMatch(html, /<script[^>]+src="[^"]*(?:_next|react|vite)/i);
  assert.doesNotMatch(html, /class="site-nav"/i);
  const sourceCss = await readFile(path.join(repositoryRoot, "public", "theme.css"), "utf8");
  const css = await readFile(path.join(siteRoot, "theme.css"), "utf8");
  assert.equal(css, sourceCss);
  await assert.rejects(access(path.join(siteRoot, "_inkpath", "theme.css")));
  assert.match(css, /font-family:\s*system-ui/);
  assert.match(css, /--reading-width: 43\.75rem/);
  assert.match(css, /--accent: #0f766e/);
  assert.match(css, /--interactive: #0f766e/);
  assert.match(css, /--inline-code: #f0fdfa/);
  assert.match(css, /\.page-toc h2 \{[^}]*font-size: 1\.25rem/);
  assert.match(
    css,
    /\.site-brand:hover \.site-title,[\s\S]*background-color: var\(--accent-soft\)/,
  );
  assert.match(css, /\.content-list__title-text \{[^}]*text-decoration-line: underline/);
  assert.doesNotMatch(
    css,
    /\.content-list a:hover \.content-list__title-text[^}]*background-color/,
  );
  assert.doesNotMatch(css, /--accent: #f36f21/);
  assert.doesNotMatch(css, /font-family:[^;]*(?:Inter|Roboto)|gradient|box-shadow|animation/i);
  assert.doesNotMatch(css, /\.(?:page-header h1|prose h[234]|section-heading)::(?:before|after)/);
});

test("the vector logo carries the bright palette while the reading UI stays dark teal", async () => {
  const sourceLogo = await readFile(path.join(repositoryRoot, "public", "favicon.svg"), "utf8");
  const builtLogo = await readFile(path.join(siteRoot, "favicon.svg"), "utf8");
  assert.equal(builtLogo, sourceLogo);
  assert.match(sourceLogo, /viewBox="0 0 64 64"/);
  for (const color of ["#152a3a", "#ef6a5b", "#f8f4ea", "#315ef4", "#4eb6b2"]) {
    assert.match(sourceLogo, new RegExp(color, "i"), `logo needs ${color}`);
  }

  const css = await readFile(path.join(siteRoot, "theme.css"), "utf8");
  assert.match(css, /--interactive: #0f766e/);
  assert.match(css, /--inline-code: #f0fdfa/);
  assert.doesNotMatch(css, /--(?:accent|interactive): #(?:ef6a5b|4eb6b2)/i);
});

test("database, streaming, and load-balancing coverage survives rendering", async () => {
  const html = (
    await Promise.all(
      (await filesNamed(siteRoot, "index.html")).map((file) => readFile(file, "utf8")),
    )
  ).join("\n");
  for (const term of [
    "PostgreSQL",
    "MySQL",
    "InnoDB",
    "ClickHouse",
    "Cassandra",
    "CDC",
    "transactional outbox",
    "L4",
    "L7",
  ]) {
    assert.match(html, new RegExp(term, "i"), `generated notes need ${term}`);
  }
});

test("the interview studio renders the cloud decision map", async () => {
  const page = await readFile(
    path.join(siteRoot, "system-design", "interview-studios", "index.html"),
    "utf8",
  );
  for (const term of [
    "Route 53",
    "CloudFront",
    "Application Load Balancer",
    "Network Load Balancer",
    "ECS",
    "EKS",
    "Fargate",
    "RDS",
    "DynamoDB",
    "Cassandra",
    "ClickHouse",
    "SQS",
    "Kafka",
    "Celery",
    "IAM",
    "CloudTrail",
    "RTO",
    "RPO",
  ]) {
    assert.match(page, new RegExp(term, "i"), `interview studio needs ${term}`);
  }
});

test("Mermaid is local, accessible in source, and loaded only where needed", async () => {
  const page = await readFile(
    path.join(siteRoot, "system-design", "api-network-path", "index.html"),
    "utf8",
  );
  assert.match(page, /data-inkpath-diagram/);
  assert.match(page, /accTitle: An idempotent payment retry/);
  assert.match(page, /class="annotation annotation--note"/);
  assert.match(
    page,
    />The operation identity belongs to the business action, not to one network attempt\.</,
  );
  await access(path.join(siteRoot, "_inkpath", "inkpath.js"));

  const html = (
    await Promise.all(
      (await filesNamed(siteRoot, "index.html")).map((file) => readFile(file, "utf8")),
    )
  ).join("\n");
  assert.equal((html.match(/src="\/_inkpath\/inkpath\.js"/g) ?? []).length, 3);
});

test("the notes repo pins the verified Inkpath commit", async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(
    manifest.devDependencies["@iamrajjoshi/inkpath"],
    `github:iamrajjoshi/inkpath#${generatorCommit}`,
  );
  assert.match(
    await readFile(path.join(repositoryRoot, "pnpm-lock.yaml"), "utf8"),
    new RegExp(generatorCommit),
  );
});
