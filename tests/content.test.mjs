import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const notesRoot = path.join(repositoryRoot, "notes");
const overviewFile = "INDEX.md";

const expectedCollections = [
  [
    "01-cloud-infrastructure",
    "cloud-infrastructure",
    "CI",
    [
      "cloud-foundations",
      "containers-and-kubernetes-objects",
      "control-planes-and-reconciliation",
      "kubernetes-networking-storage-security",
      "scheduling-and-noisy-neighbors",
      "eks-and-ecs",
      "kafka-replicated-event-log",
      "celery-task-processing",
      "infrastructure-as-code-and-gitops",
      "production-operation",
      "shared-production-services",
    ],
  ],
  [
    "02-low-level-infrastructure",
    "low-level-infrastructure",
    "LL",
    [
      "kernel-boundary",
      "cpu-scheduling-and-locality",
      "virtual-memory",
      "storage-and-io",
      "linux-networking-and-ebpf",
      "containers-and-cgroups",
      "observability-and-debugging",
      "kvm-qemu-and-virtio",
      "microvms-and-kata",
      "device-assignment-and-nested-virtualization",
    ],
  ],
  [
    "06-distributed-systems",
    "distributed-systems",
    "DS",
    [
      "system-model-and-rpc",
      "time-causality-and-snapshots",
      "failure-detection-gossip-membership",
      "multicast-election-and-distributed-locks",
      "consensus-and-replicated-state-machines",
      "partitioning-dhts-and-key-value-stores",
      "replication-consistency-and-transactions",
      "distributed-dataflow-and-scheduling",
      "filesystems-shared-memory-and-edge",
      "security-incidents-and-capstone",
    ],
  ],
  [
    "03-system-design",
    "system-design",
    "SD",
    [
      "frame-the-problem",
      "api-network-path",
      "storage-data-modeling",
      "relational-engine-internals",
      "partitioning-replication-hot-keys",
      "time-consistency-coordination",
      "async-streaming-designs",
      "caching-overload-control",
      "control-planes-schedulers",
      "reliability-observability",
      "interview-studios",
    ],
  ],
  [
    "04-ai-inference",
    "ai-inference",
    "AI",
    [
      "inference-fundamentals",
      "serving-lifecycle",
      "gpu-systems",
      "serving-engines",
      "single-node-optimization",
      "distributed-inference",
      "gpu-orchestration",
      "inference-performance-and-sre",
      "production-safety-and-capstone",
    ],
  ],
  [
    "05-harness-engineering",
    "harness-engineering",
    "HE",
    [
      "model-agent-and-harness",
      "intent-and-executable-contracts",
      "context-architecture-and-agents-md",
      "tools-environments-and-sandboxes",
      "durable-state-continuity-and-handoffs",
      "verification-and-feedback-loops",
      "production-safety-and-control",
      "agent-orchestration",
      "evaluation-engineering",
      "maintenance-and-capstone",
    ],
  ],
];

const expectedNoteCount = expectedCollections.reduce(
  (total, collection) => total + collection[3].length,
  0,
);
const expectedMarkdownCount = 1 + expectedCollections.length + expectedNoteCount;

function parseMarkdown(file, raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(match, `${file} must begin with YAML frontmatter`);
  return { attributes: YAML.parse(match[1]), body: raw.slice(match[0].length).trim() };
}

function wordCount(value) {
  return (value.match(/[\p{L}\p{N}]+(?:['’./_-][\p{L}\p{N}]+)*/gu) ?? []).length;
}

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(entryPath)));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(entryPath);
  }
  return files.sort();
}

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

async function loadCollections() {
  const collections = [];
  for (const [directory] of expectedCollections) {
    const root = path.join(notesRoot, directory);
    const section = parseMarkdown(
      `${directory}/${overviewFile}`,
      await readFile(path.join(root, overviewFile), "utf8"),
    );
    const files = (await readdir(root)).filter(
      (file) => file.endsWith(".md") && file !== overviewFile,
    );
    const notes = await Promise.all(
      files.map(async (file) => ({
        file,
        ...parseMarkdown(`${directory}/${file}`, await readFile(path.join(root, file), "utf8")),
      })),
    );
    notes.sort((left, right) => left.attributes.order - right.attributes.order);
    collections.push({ directory, ...section, notes });
  }
  return collections;
}

const collections = await loadCollections();

function noteBody(collectionSlug, noteSlug) {
  const collection = collections.find((candidate) => candidate.attributes.slug === collectionSlug);
  const note = collection?.notes.find((candidate) => candidate.attributes.slug === noteSlug);
  assert.ok(note, `${collectionSlug}/${noteSlug} must exist`);
  return note.body;
}

test("the Markdown tree contains the complete ordered catalog", async () => {
  assert.equal((await markdownFiles(notesRoot)).length, expectedMarkdownCount);
  const root = parseMarkdown(
    `notes/${overviewFile}`,
    await readFile(path.join(notesRoot, overviewFile), "utf8"),
  );
  assert.equal(root.attributes.title, "Raj's Notes");
  assert.equal(root.body, "", "the home Markdown should contain no implementation copy");
  assert.equal(collections.length, 6);
  assert.equal(collections.flatMap((collection) => collection.notes).length, expectedNoteCount);

  for (
    let collectionIndex = 0;
    collectionIndex < expectedCollections.length;
    collectionIndex += 1
  ) {
    const collection = collections[collectionIndex];
    const [, slug, numberPrefix, slugs] = expectedCollections[collectionIndex];
    assert.equal(collection.attributes.slug, slug);
    assert.equal(collection.attributes.order, collectionIndex + 1);
    assert.deepEqual(
      collection.notes.map((note) => note.attributes.slug),
      slugs,
    );
    assert.deepEqual(
      collection.notes.map((note) => note.attributes.order),
      slugs.map((_, index) => index + 1),
    );
    assert.deepEqual(
      collection.notes.map((note) => note.attributes.number),
      slugs.map((_, index) => `${numberPrefix}${index + 1}`),
    );
    assert.match(collection.body, /^## Scope$/m);
    assert.match(collection.body, /^## Useful background$/m);
  }
});

test("every note remains substantial, summarized, and sourced", () => {
  const routes = new Set();
  let referenceCount = 0;
  let mermaidCount = 0;

  for (const collection of collections) {
    for (const note of collection.notes) {
      const route = `${collection.attributes.slug}/${note.attributes.slug}`;
      assert.equal(note.attributes.collection, collection.attributes.slug, `${route} collection`);
      assert.ok(!routes.has(route), `${route} must be unique`);
      routes.add(route);
      for (const field of [
        "title",
        "shortTitle",
        "description",
        "number",
        "duration",
        "difficulty",
        "tags",
      ]) {
        assert.ok(note.attributes[field], `${route} needs ${field}`);
      }
      assert.match(note.body, /^## Working model$/m, `${route} working model`);
      assert.match(note.body, /^## Questions this note answers$/m, `${route} guiding questions`);
      assert.match(note.body, /^## Summary$/m, `${route} summary`);
      assert.match(note.body, /^## References$/m, `${route} references`);

      const mainContent = note.body.split(/\n## Summary\n/)[0];
      assert.ok(wordCount(mainContent) >= 700, `${route} needs at least 700 words before Summary`);
      const references = note.body.split(/\n## References\n/)[1] ?? "";
      const links = [...references.matchAll(/\]\((https:\/\/[^)]+)\)/g)].map((match) => match[1]);
      assert.ok(links.length >= 3, `${route} needs at least three direct references`);
      referenceCount += links.length;

      mermaidCount += (note.body.match(/^```mermaid$/gm) ?? []).length;
    }
  }

  assert.ok(referenceCount >= 400, "the catalog must retain its direct-source coverage");
  assert.equal(mermaidCount, 3);
});

test("release files contain no environment-specific material", async () => {
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
    [/\barn:(?:aws|aws-cn|aws-us-gov):[^\s)`"']+/i, "an AWS ARN"],
    [
      /https:\/\/(?:www\.)?(?:notion\.so|slack\.com|linear\.app|app\.asana\.com)\//i,
      "a workspace URL",
    ],
  ];
  const denylist = (process.env.NOTES_RELEASE_DENYLIST ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim().toLocaleLowerCase())
    .filter(Boolean);

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

test("named infrastructure products are introduced before advanced failure mechanics", () => {
  const eksAndEcs = noteBody("cloud-infrastructure", "eks-and-ecs");
  assert.ok(
    eksAndEcs.indexOf("## Start with the two products") <
      eksAndEcs.indexOf("## EKS manages Kubernetes control-plane availability"),
  );
  assert.match(
    eksAndEcs,
    /Amazon Elastic Container Service \(ECS\).*AWS's own container orchestrator/s,
  );
  assert.match(eksAndEcs, /Amazon Elastic Kubernetes Service \(EKS\).*managed Kubernetes service/s);

  const kafka = noteBody("cloud-infrastructure", "kafka-replicated-event-log");
  assert.ok(
    kafka.indexOf("## Learn the nouns before the failure modes") <
      kafka.indexOf("## Replication factor is not the whole durability policy"),
  );
  assert.match(kafka, /## Follow one record from write to committed progress/);
  for (const term of [
    "Broker",
    "Topic",
    "Partition",
    "Offset",
    "Producer",
    "Consumer group",
    "Leader replica",
    "ISR",
  ]) {
    assert.match(kafka, new RegExp(`\\|\\s*${term}\\s*\\|`), `Kafka glossary needs ${term}`);
  }

  const celery = noteBody("cloud-infrastructure", "celery-task-processing");
  assert.ok(
    celery.indexOf("## Start with one background job") <
      celery.indexOf("## Late acknowledgement requires idempotent work"),
  );
  assert.match(celery, /Celery is the task framework and worker runtime; it is not the broker/);

  const asyncDesign = noteBody("system-design", "async-streaming-designs");
  assert.ok(
    asyncDesign.indexOf("## Learn Kafka's nouns before its failure modes") <
      asyncDesign.indexOf("## Keep Kafka's current control plane straight"),
  );
  assert.match(asyncDesign, /## Follow one Kafka record end to end/);
});

test("the relational-internals note preserves source-backed database mechanics", () => {
  const relational = noteBody("system-design", "relational-engine-internals");
  assert.match(relational, /## A connection owns a backend process/);
  assert.match(relational, /## A commit makes a version durable, not a page current/);
  assert.match(relational, /WAL records.*durable storage.*data pages/is);
  assert.match(relational, /InnoDB.*clustered primary-key B-tree/is);
  assert.match(relational, /## Creating an index concurrently is a state machine/);
  assert.match(relational, /indisready/);
  assert.match(relational, /indisvalid/);
  assert.match(relational, /pg_stat_progress_create_index/);
  assert.match(relational, /ON orders \(tenant_id, status, created_at DESC, id DESC\)/);
  assert.match(relational, /invalid unique index can also continue enforcing uniqueness/i);
  assert.match(
    relational,
    /schew2381\.github\.io\/posts\/how-postgres-concurrent-index-creation-works/,
  );
});

test("the overload note teaches a fleet-scoped rate limit rather than naming one", () => {
  const overload = noteBody("system-design", "caching-overload-control");
  assert.match(overload, /## A rate limit needs four nouns before an algorithm/);
  for (const term of ["Identity", "Cost unit", "Steady rate", "Burst capacity"]) {
    assert.match(overload, new RegExp(`\\*\\*${term}:\\*\\*`), `rate limit needs ${term}`);
  }
  assert.match(overload, /token bucket/i);
  assert.match(overload, /R = 100/);
  assert.match(overload, /B = 200/);
  assert.match(overload, /ten replicas.*roughly 1,000/s);
  assert.match(overload, /fails open or closed/i);
  assert.match(overload, /rate limit does not bound how much work is already running/i);
});

test("the curriculum introduces prerequisite mechanisms before their dependents", () => {
  assert.deepEqual(
    collections.map((collection) => collection.attributes.slug),
    [
      "cloud-infrastructure",
      "low-level-infrastructure",
      "distributed-systems",
      "system-design",
      "ai-inference",
      "harness-engineering",
    ],
  );

  const inference = collections.find((collection) => collection.attributes.slug === "ai-inference");
  assert.deepEqual(
    inference.notes.slice(0, 3).map((note) => note.attributes.slug),
    ["inference-fundamentals", "serving-lifecycle", "gpu-systems"],
  );

  const reconciliation = noteBody("cloud-infrastructure", "control-planes-and-reconciliation");
  assert.ok(
    reconciliation.indexOf("## Begin at the persisted object and name its controller") <
      reconciliation.indexOf("## One write becomes several independently observed transitions"),
  );
  for (const term of ["Kustomize", "`Application`", "`ApplicationSet`"]) {
    assert.match(reconciliation, new RegExp(term.replaceAll("`", "\\`")));
  }
  assert.match(
    reconciliation,
    /ApplicationSet controller.*Application.*application controller.*Deployment/is,
  );
  assert.match(reconciliation, /CI9: Infrastructure as code and GitOps/);

  assert.match(
    noteBody("low-level-infrastructure", "cpu-scheduling-and-locality"),
    /control group \(cgroup\).*resource accounting and control/is,
  );
  assert.match(
    noteBody("low-level-infrastructure", "virtual-memory"),
    /control group \(cgroup\).*kernel-managed resource-accounting boundary/is,
  );
  assert.match(
    noteBody("low-level-infrastructure", "kvm-qemu-and-virtio"),
    /physical host hypervisor \*\*L0\*\*.*\*\*L1\*\*.*\*\*L2\*\*/s,
  );
  assert.match(
    noteBody("cloud-infrastructure", "infrastructure-as-code-and-gitops"),
    /use_lockfile = true/,
  );
});

test("cloud day-two operation is split into delivery, reliability, and shared-service decisions", () => {
  const delivery = noteBody("cloud-infrastructure", "infrastructure-as-code-and-gitops");
  assert.ok(
    delivery.indexOf("## Worked case: promote one rendered release candidate") <
      delivery.indexOf("## Fictional practice: assemble a release record"),
  );
  assert.match(delivery, /terraform plan -out=tfplan/);
  assert.match(delivery, /Import binds the remote ID to the address/i);
  assert.match(delivery, /Build an immutable application artifact once/i);
  assert.match(delivery, /## Roll back the owner that introduced the bad state/);

  const operation = noteBody("cloud-infrastructure", "production-operation");
  assert.match(operation, /## Autoscaling is a delayed control loop/);
  assert.match(operation, /## Define “good” before choosing dashboards/);
  assert.match(operation, /## High availability and disaster recovery answer different questions/);
  assert.match(operation, /## Capacity includes quotas and downstream budgets/);
  assert.ok(
    operation.indexOf("## Review a cloud design in a fixed order") <
      operation.indexOf("## Fictional case: compare one cell and its scaling loop"),
  );

  const shared = noteBody("cloud-infrastructure", "shared-production-services");
  assert.match(shared, /## Choose an asynchronous contract, not an “event service”/);
  assert.match(shared, /## PgBouncer multiplexes clients onto a bounded server pool/);
  assert.match(shared, /## Durable workflows persist progress, not process lifetime/);
  assert.match(shared, /stable operation identity.*reconciliation/is);
  assert.ok(
    shared.indexOf("## Durable workflows persist progress, not process lifetime") <
      shared.indexOf("## Fictional case: recover a durable export workflow"),
  );
});

test("cloud foundations traces both long-running and function compute from deploy to failure", () => {
  const cloud = noteBody("cloud-infrastructure", "cloud-foundations");
  assert.match(cloud, /## Worked case: ALB to Auto Scaling to EC2/);
  assert.match(cloud, /launch-template version `18`/);
  assert.match(cloud, /ALB health check controls routing/i);
  assert.match(cloud, /Auto Scaling group to use Elastic Load Balancing health checks/i);
  assert.match(cloud, /## Worked case: API Gateway to Lambda/);
  assert.match(cloud, /publish immutable version `42`/);
  assert.match(cloud, /120 × 0\.4 = 48/);
  assert.match(cloud, /at most 15 minutes/);
  assert.match(cloud, /ALB target health gates traffic/);
});

test("the low-level track builds storage and TCP from concrete operating-system boundaries", () => {
  const storage = noteBody("low-level-infrastructure", "storage-and-io");
  assert.match(storage, /## Build the block stack from media to application/);
  assert.match(storage, /NVMe.*host-controller protocol.*not a synonym for SSD media/is);
  assert.match(
    storage,
    /physical SSDs or HDDs \/ cloud block volumes[\s\S]*optional MD RAID[\s\S]*device-mapper[\s\S]*filesystem[\s\S]*application/,
  );
  for (const layout of ["RAID 0", "RAID 1", "RAID 10", "RAID 5", "RAID 6"]) {
    assert.match(storage, new RegExp(`\\|\\s*${layout}\\s*\\|`), `storage note needs ${layout}`);
  }
  assert.match(storage, /Neither mechanism is an independent backup by definition/);
  assert.match(storage, /32 operations \/ 0\.004 s = 8,000 operations\/s/);
  assert.match(storage, /32\.768 MB\/s decimal[\s\S]*31\.25 MiB\/s binary/);
  assert.match(storage, /Deeper queues.*p95 or p99/is);

  const networking = noteBody("low-level-infrastructure", "linux-networking-and-ebpf");
  assert.match(networking, /## Trace one TCP connection before tracing namespaces/);
  assert.match(
    networking,
    /SYN-ACK[\s\S]*completed connections until the server calls `accept\(\)`/,
  );
  assert.match(networking, /SYN backlog.*listen\(backlog\).*accept queue/is);
  assert.match(networking, /min\(rwnd, cwnd\)/);
  assert.match(networking, /1,000,000,000 × 0\.040 \/ 8 = 5,000,000/);
  assert.match(networking, /20,000 \/ 40 = 500/);
  assert.match(networking, /PMTUD \*\*black hole\*\*[\s\S]*larger TLS or application record/is);
  for (const evidence of ["ss -lnt", "ip route get", "ip -s link", "tcpdump -ni"]) {
    assert.ok(networking.includes(evidence), `networking note needs ${evidence}`);
  }
});

test("system-design notes now carry the beginner through schema, queue, cache, and recovery decisions", () => {
  const api = noteBody("system-design", "api-network-path");
  assert.match(api, /## Evolve readers before writers/);
  assert.match(api, /do not reuse a deleted field number.*reserve the number and name/is);
  assert.match(api, /stored queue or replayable log extends that population/i);
  assert.match(api, /Scope a key to the authenticated tenant and operation/i);

  const storage = noteBody("system-design", "storage-data-modeling");
  assert.match(storage, /## Trace an order model from product nouns to access paths/);
  assert.match(storage, /CREATE TABLE order_line_items/);
  assert.match(storage, /ON orders \(tenant_id, created_at DESC, id DESC\)/);
  assert.match(storage, /B-tree.*candidate row version.*transaction visibility/is);
  assert.match(storage, /`orders` uses `\(tenant_id, id\)` as its identity/);
  assert.match(storage, /Recent-order pages use `\(tenant_id, created_at DESC, id DESC\)`/);
  for (const store of [
    "Relational",
    "Key-value or document",
    "Wide-column",
    "Columnar",
    "Object",
    "Search",
    "Time-series",
    "Vector",
  ]) {
    assert.match(storage, new RegExp(`\\| ${store.replaceAll("-", "\\-")}`));
  }

  const asyncDesign = noteBody("system-design", "async-streaming-designs");
  assert.match(asyncDesign, /## Follow one queue delivery from claim to redrive/);
  assert.match(asyncDesign, /dies after committing the effect but before the acknowledgement/is);
  assert.match(asyncDesign, /dead-letter queue needs a named owning team/i);
  assert.match(asyncDesign, /Amazon SQS\s*\|\s*RabbitMQ\s*\|\s*Celery/);
  assert.match(asyncDesign, /order_id.*FIFO message group or ordered partition/is);
  assert.match(asyncDesign, /Routing by itself would not preserve order/);
  assert.match(asyncDesign, /poison event.*blocks later transitions.*dead-letter policy/is);

  const caching = noteBody("system-design", "caching-overload-control");
  assert.match(caching, /T2 reader: database returns order version 18/);
  assert.match(caching, /T3 writer: commits order version 19/);
  assert.match(caching, /compare-and-set.*rejects the stale fill/is);
  assert.match(caching, /TTL answers how long a cache copy may reside after population/i);
  assert.match(caching, /stale-if-error=300/);

  const coordination = noteBody("system-design", "time-consistency-coordination");
  assert.match(
    coordination,
    /## Choose the commit boundary before naming 2PC, a saga, or an outbox/,
  );
  assert.match(coordination, /Two-phase commit \(2PC\).*prepare phase.*can remain blocked/is);
  assert.match(
    coordination,
    /outbox.*does not make the broker and database one distributed transaction/is,
  );

  const partitioning = noteBody("system-design", "partitioning-replication-hot-keys");
  assert.match(
    partitioning,
    /## Shard a relational database without losing the transaction boundary/,
  );
  assert.match(partitioning, /hash\(tenant_id\) modulo database_count.*remap most tenants/is);
  assert.match(partitioning, /snapshot.*Stream changes.*validate.*fence.*switch/is);
  assert.match(
    partitioning,
    /Rollback is easy only before the target accepts new authoritative writes/i,
  );
  assert.match(partitioning, /Bloom filter.*probabilistic negative test.*false positive/is);

  const reliability = noteBody("system-design", "reliability-observability");
  assert.match(reliability, /## Work one regional failure from authority to failback/);
  assert.match(reliability, /Failback is another migration/i);
  assert.match(reliability, /## Turn the SLO into an error budget and burn-rate alert/);
  assert.match(reliability, /burn rate = 0\.02 \/ 0\.001 = 20x/);
  assert.match(reliability, /short window.*longer window.*both windows/is);
});

test("the system-design collection carries one decision ledger from scope through recovery", () => {
  const systemDesign = collections.find(
    (collection) => collection.attributes.slug === "system-design",
  );
  assert.ok(systemDesign);
  assert.match(systemDesign.body, /## Orientation and decision ledger/);
  assert.match(systemDesign.body, /1,000 average and 5,000 peak order creates each second/);
  assert.match(systemDesign.body, /10\.4 TB raw hot data/);
  assert.equal(systemDesign.notes.length, 11);
  for (const note of systemDesign.notes.slice(0, 10)) {
    assert.match(
      note.body,
      /## Running design checkpoint/,
      `${note.attributes.number} needs the running checkpoint`,
    );
  }
  assert.match(systemDesign.notes[10].body, /## Running design: assemble the ledger/);
  assert.match(systemDesign.notes[10].body, /15-minute RTO and 30-second RPO/);
  assert.match(
    systemDesign.notes[10].body,
    /regional RPO becomes zero[\s\S]*asynchronous regional copy no longer satisfies the contract/is,
  );
});

test("the interview studios exercise every prompt with a complete decision chain", () => {
  const studios = noteBody("system-design", "interview-studios");
  assert.match(studios, /## Use six compact practice briefs for the remaining prompts/);
  for (const brief of [
    "social feed and activity history",
    "multi-Region chat and presence",
    "search and autocomplete",
    "notification service",
    "multi-tenant scheduler and workflow",
    "inference service",
  ]) {
    assert.match(studios, new RegExp(`### Compact practice brief: ${brief}`, "i"));
  }
  for (const artifact of [
    "Opening clarification questions",
    "Functional and non-functional requirements",
    "Illustrative sizing",
    "API and minimal data model",
    "Normal and failure trace",
    "Technology alternatives and trade-offs",
    "Changed requirement that invalidates the first design",
    "Rubric evidence",
  ]) {
    const occurrences =
      studios.match(new RegExp(`\\*\\*${artifact.replaceAll(".", "\\.")}\\.\\*\\*`, "g")) ?? [];
    assert.equal(occurrences.length, 6, `all six compact briefs need ${artifact}`);
  }
  assert.match(studios, /Conversation\(id, home_region, writer_epoch, next_seq\)/);
  assert.match(studios, /writer.*unexpired authority lease.*higher writer epoch/is);
  assert.match(
    studios,
    /RPO zero plus writes accepted in both Regions.*cannot preserve one total conversation order/is,
  );
  assert.match(studios, /one 50M-follower author = 50M inserts/);
  assert.match(studios, /index generation.*source position.*switches an alias/is);
  assert.match(studios, /provider accepts a request but its reply is lost/is);
  assert.match(studios, /stale worker cannot publish the visible result/i);
  assert.match(studios, /70-billion-parameter model.*single-80-GiB-device replica is invalid/is);
});

test("the AI path distinguishes workload families and completes one capacity decision", () => {
  const fundamentals = noteBody("ai-inference", "inference-fundamentals");
  assert.match(fundamentals, /## Scope: shared method, one deepest worked path/);
  for (const workload of [
    "Online autoregressive generation",
    "Embeddings and reranking",
    "Streaming speech",
    "Vision and image classification",
    "Diffusion image and video generation",
    "Asynchronous batch inference",
  ]) {
    assert.match(fundamentals, new RegExp(`### ${workload}`));
  }
  assert.match(fundamentals, /token IDs.*\[1, 3\].*embedding.*\[1, 3, 8\].*logits.*\[1, 12\]/is);
  assert.match(fundamentals, /prefix-cache identity.*RoPE/is);

  const engines = noteBody("ai-inference", "serving-engines");
  assert.match(engines, /## Run one serving contract before loading a model/);
  assert.match(
    engines,
    /\[serving-contract-fixture\.mjs\]\(examples\/serving-contract-fixture\.mjs\)/,
  );
  assert.match(
    engines,
    /not.*language model, tokenizer, inference engine, or performance benchmark/is,
  );
  assert.match(
    engines,
    /1 normal \+ 1 complete stream \+ 1 cancelled stream \+ 8 load = 11 requests/,
  );
  assert.match(engines, /10 completed \+ 1 cancelled = 11 terminal requests/);
  assert.match(engines, /Real pinned engine and model evidence/);
  assert.match(engines, /one of two named tenant-selected LoRA adapters for each request/i);
  assert.match(engines, /composing two LoRA adapters.*unsupported in this fixture/is);

  const capstone = noteBody("ai-inference", "production-safety-and-capstone");
  assert.match(
    capstone,
    /deliberately hypothetical inputs.*not specifications or performance guarantees/is,
  );
  assert.match(capstone, /KV bytes\/token[\s\S]*= 327,680 bytes\/token/);
  assert.match(capstone, /fleet size = 4 groups x 4 accelerators\/group = 16 accelerators/);
  assert.match(capstone, /input headroom after failure[\s\S]*= 12\.5%/);
  assert.match(capstone, /80 percent operational KV watermark.*313,562/is);
  assert.match(capstone, /8 groups, or 32 accelerators, during the full cutover/i);

  const gpu = noteBody("ai-inference", "gpu-systems");
  assert.match(gpu, /## Trace the deployable software stack before tuning a kernel/);
  for (const layer of [
    "host NVIDIA kernel-mode driver",
    "CUDA user-mode driver",
    "CUDA Runtime API",
    "framework",
    "serving engine",
  ]) {
    assert.match(gpu, new RegExp(layer, "i"));
  }
  assert.match(gpu, /Tensor Cores.*specialized matrix multiply-accumulate/is);
  assert.match(gpu, /not a faster mode for every CUDA instruction/i);
  assert.match(gpu, /HBM.*GDDR.*not a synonym for every GPU's memory/is);
  assert.match(gpu, /allocator fragmentation or OOM.*ECC report.*Xid.*Failed distributed rank/is);
  for (const evidence of ["Nsight Systems", "Nsight Compute", "DCGM"])
    assert.match(gpu, new RegExp(evidence));

  const orchestration = noteBody("ai-inference", "gpu-orchestration");
  for (const component of [
    "Host GPU driver",
    "NVIDIA Container Toolkit or CDI path",
    "Kubernetes device plugin",
    "DCGM and DCGM Exporter",
    "GPU Operator",
  ]) {
    assert.match(
      orchestration,
      new RegExp(`\\|\\s*${component.replaceAll("/", "\\/")}\\s*\\|`, "i"),
    );
  }
  assert.match(orchestration, /kind: Deployment[\s\S]*nvidia\.com\/gpu: "4"[\s\S]*kind: Service/);
  assert.match(orchestration, /node capacity = min\(2, 2, 2\) = 2 complete TP4 groups/);
  assert.match(orchestration, /Host GPU works, but Node allocatable is zero/);
  assert.match(orchestration, /Node allocatable is correct, but the container sees no GPU/);
  assert.match(
    orchestration,
    /inside-domain lower bound[\s\S]*1\.875 ms[\s\S]*wrong-path lower bound[\s\S]*15\.000 ms/,
  );
  assert.match(orchestration, /one failed-group spare = 6 \+ 1 = 7 warm groups/);
  assert.match(
    orchestration,
    /startup taint[\s\S]*Route only ready groups[\s\S]*Drain before scale-down/is,
  );
});

test("the harness track has an executable path through its capstone", () => {
  const foundation = noteBody("harness-engineering", "model-agent-and-harness");
  assert.match(foundation, /## Run one read-only tool loop first/);
  assert.match(foundation, /\[first tool loop\]\(examples\/first-tool-loop\.mjs\)/);
  assert.match(
    foundation,
    /Model proposal:[\s\S]*Host validation:[\s\S]*Tool execution:[\s\S]*Observation returned:[\s\S]*Model terminal answer:/,
  );
  assert.match(foundation, /\[minimal harness example\]\(examples\/minimal-harness\.mjs\)/);
  assert.match(foundation, /scripted model.*runs offline.*same trace every time/is);

  const context = noteBody("harness-engineering", "context-architecture-and-agents-md");
  assert.match(context, /## Assemble one model call from a context ledger/);
  assert.match(context, /8,192-token model context/);
  assert.match(context, /At most 3,192 tokens remain for retrieved evidence/);
  assert.match(context, /\.env\.production[\s\S]*Deny before retrieval/is);
  assert.match(context, /generated at `r39`[\s\S]*opens only the named function at `r42`/is);
  assert.match(context, /Render the final input in a fixed order/);

  const durability = noteBody("harness-engineering", "durable-state-continuity-and-handoffs");
  assert.match(durability, /\[durable harness\]\(\.\/examples\/durable-harness\.mjs\)/);
  assert.match(
    durability,
    /commits the maintenance change and operation record in one SQLite transaction/is,
  );
  assert.match(
    durability,
    /deliberately exits with code 86 before updating checkpoint version 0/is,
  );
  assert.match(durability, /effect counter remains 1/is);
  assert.match(
    durability,
    /A worker name is only a label.*same name while its lease is active conflicts.*after expiry creates a new epoch/is,
  );
  assert.match(
    durability,
    /SQLite is a local teaching store here, not a multi-host workflow service/is,
  );
  assert.match(durability, /production PostgreSQL implementation.*isolation and locking design/is);

  const capstone = noteBody("harness-engineering", "maintenance-and-capstone");
  assert.match(capstone, /## Assemble the production topology before tuning a worker/);
  for (const component of [
    "Run API",
    "Run store",
    "Scheduler and queue",
    "Model gateway",
    "Tool broker",
    "Sandbox pool",
    "Artifact store",
    "Verifier",
  ]) {
    assert.match(capstone, new RegExp(`\\|\\s*${component.replaceAll("/", "\\/")}\\s*\\|`));
  }
  assert.match(capstone, /R204:publish-draft/);
  assert.match(capstone, /epoch 12[\s\S]*epoch 11 and fails/is);
  assert.match(capstone, /operator stop[\s\S]*needs_operator.*uncertainty terminal state/is);
  assert.match(capstone, /## Complete the public minimal-harness capstone/);
  assert.match(
    capstone,
    /default capstone.*No model key, external repository, or network call is needed/is,
  );
  assert.match(capstone, /## Optional advanced capstone: add resumable approval/);

  const orchestration = noteBody("harness-engineering", "agent-orchestration");
  assert.match(orchestration, /## A team is a manifest executed by one runner/);
  for (const field of [
    "model_profile",
    "allowed_writes",
    "aggregate_budget",
    "depends_on",
    "terminal_states",
    "late_result",
  ]) {
    assert.match(orchestration, new RegExp(field));
  }
  assert.match(orchestration, /manager calls specialists as bounded tools/i);
  assert.match(orchestration, /handoff transfers ownership/i);
  assert.match(orchestration, /planner fans out readers.*one writer.*evaluator/is);
  assert.match(orchestration, /45.*seconds.*24.*seconds.*\$0\.65/is);
  assert.match(orchestration, /epoch 7 to epoch 8.*rejects/is);

  const evaluation = noteBody("harness-engineering", "evaluation-engineering");
  assert.match(evaluation, /pass@k.*1 - \(1 - p\)\^k/is);
  assert.match(evaluation, /pass\^k.*p\^k/is);
  assert.match(evaluation, /paired bootstrap.*0 to 62\.5 percentage points/is);
  assert.match(evaluation, /invalid_infrastructure.*outside the pass-rate denominator/is);
  assert.match(evaluation, /capability suite.*regression suite/is);
  assert.match(evaluation, /reference solution.*known-bad near misses/is);
  assert.match(evaluation, /Grader hacking.*Contamination/is);
});

test("each advanced track preserves a beginner-first entry point", () => {
  const cloudCollection = collections.find(
    (collection) => collection.attributes.slug === "cloud-infrastructure",
  );
  assert.match(cloudCollection.body, /## Optional practice ladder/);
  assert.match(cloudCollection.body, /\|\s*8\. Profile inference\s*\|/);

  const cloud = noteBody("cloud-infrastructure", "cloud-foundations");
  assert.ok(
    cloud.indexOf("## Begin with one service, not with AWS names") <
      cloud.indexOf("## Regions and zones are blast-radius choices"),
  );

  const lowLevel = noteBody("low-level-infrastructure", "kernel-boundary");
  assert.ok(
    lowLevel.indexOf("## Name the layers before tracing them") <
      lowLevel.indexOf("## A syscall is a controlled entry, not a library call"),
  );

  const systemDesign = noteBody("system-design", "frame-the-problem");
  assert.ok(
    systemDesign.indexOf("## Start with a one-sentence restatement") <
      systemDesign.indexOf("## Produce the design artifacts in a stable order"),
  );
  assert.match(systemDesign, /## Ask only questions whose answers can change the design/);

  const inference = noteBody("ai-inference", "inference-fundamentals");
  assert.ok(
    inference.indexOf("## Start at the service boundary") <
      inference.indexOf("## Attention changes cost with sequence length"),
  );
  assert.match(
    noteBody("ai-inference", "inference-performance-and-sre"),
    /## Measure power, energy, and useful work separately/,
  );

  const harness = noteBody("harness-engineering", "model-agent-and-harness");
  assert.ok(
    harness.indexOf("## Learn the runtime vocabulary before tracing a failure") <
      harness.indexOf("## Assign each decision to the layer that can enforce it"),
  );

  const distributed = noteBody("distributed-systems", "system-model-and-rpc");
  assert.ok(
    distributed.indexOf("## Begin with one call across one boundary") <
      distributed.indexOf("## A reply can be lost after the work commits"),
  );
});

test("the distributed-systems cluster maps every supplied lecture and corrects historical examples", async () => {
  const sourceMap = await readFile(
    path.join(notesRoot, "06-distributed-systems", overviewFile),
    "utf8",
  );
  for (const lecture of [
    "L1.FA25.pdf",
    "L2-3.FA25.pdf",
    "L4.FA25.pdf",
    "L5.FA25.pdf",
    "L6.FA25.pdf",
    "L7-8.FA25.pdf",
    "L9-11.FA25.pdf",
    "L12.FA25.pdf",
    "L16.FA25.pdf",
    "L17.FA25.pdf",
    "L18.FA25.pdf",
    "L19-20.FA25.pdf",
    "L21.FA25.pdf",
    "L22.FA25.pdf",
    "L22.B.FA25.pdf",
    "L23.FA25.pdf",
    "L24.A.FA25.pdf",
    "L24.B.FA25.pdf",
    "L25.A.FA25.pdf",
    "L25.B.FA25.pdf",
    "L26.FA25.pdf",
    "L27.FA25.pdf",
    "L28.FA25.pdf",
    "Llast.FA25.pdf",
  ]) {
    assert.match(
      sourceMap,
      new RegExp(lecture.replaceAll(".", "\\.")),
      `source map needs ${lecture}`,
    );
  }

  const rpc = noteBody("distributed-systems", "system-model-and-rpc");
  assert.match(rpc, /stable operation ID/i);
  assert.match(rpc, /deadline/i);
  assert.match(rpc, /at-most-once/i);

  const failures = noteBody("distributed-systems", "failure-detection-gossip-membership");
  assert.match(failures, /false positive/i);
  assert.match(failures, /SWIM/);

  const time = noteBody("distributed-systems", "time-causality-and-snapshots");
  assert.match(time, /monotonic clock/i);
  assert.match(time, /vector clock/i);
  assert.match(time, /Chandy-Lamport/);

  const coordination = noteBody("distributed-systems", "multicast-election-and-distributed-locks");
  assert.match(coordination, /receive.*deliver/is);
  assert.match(coordination, /fencing token/i);

  const consensus = noteBody("distributed-systems", "consensus-and-replicated-state-machines");
  assert.match(consensus, /## Read the client-visible history before claiming consistency/);
  assert.match(consensus, /Quorum intersection is one part of an implementation proof/);
  assert.match(consensus, /Passes:[\s\S]*Fails:/);
  assert.match(consensus, /FLP/);
  assert.match(consensus, /current-term rule/i);
  assert.match(
    consensus,
    /business mutation and deduplication record are one atomic state-machine update/i,
  );
  assert.match(consensus, /process-local cache.*never the authority/is);

  const stores = noteBody("distributed-systems", "partitioning-dhts-and-key-value-stores");
  assert.match(
    stores,
    /A consistency level says which acknowledgements let the coordinator respond; it does not by itself say which client-visible histories are legal\./,
  );
  assert.match(stores, /ordinary `QUORUM` operations do not inherit that claim\./);
  assert.match(
    stores,
    /If the read must answer in both executions, one answer violates linearizability\./,
  );
  assert.match(stores, /wide-column.*analytical columnar/is);
  assert.match(stores, /hints are best effort/i);
  assert.match(stores, /lightweight transactions.*Paxos/is);

  const transactions = noteBody("distributed-systems", "replication-consistency-and-transactions");
  assert.match(transactions, /R \+ W > N/);
  assert.match(transactions, /MVCC is a storage and visibility mechanism/i);
  assert.match(transactions, /two-phase commit can block/i);

  const dataflow = noteBody("distributed-systems", "distributed-dataflow-and-scheduling");
  assert.match(dataflow, /Storm.*historical/is);
  assert.match(dataflow, /event time/i);
  assert.match(dataflow, /backpressure/i);
  assert.match(dataflow, /## Follow one event through a current stream engine/);
  assert.match(dataflow, /Kafka is a retained log.*Kafka Streams.*library.*Flink.*distributed/is);
  assert.match(dataflow, /checkpoint barrier.*restore.*replay.*sink/is);

  const sharedData = noteBody("distributed-systems", "filesystems-shared-memory-and-edge");
  assert.match(sharedData, /NFSv4.*stateful/is);
  assert.match(
    sharedData,
    /Opening a file and fetching its contents are separate protocol actions/i,
  );
  assert.match(sharedData, /`OPEN`.*file descriptor.*need not return any file data/is);
  assert.match(sharedData, /`READ`.*absolute offset.*byte count/is);
  assert.match(sharedData, /## Follow one HDFS write through the replica pipeline/);
  assert.match(sharedData, /NameNode.*DN-A -> DN-B -> DN-C.*acknowledgement/is);
  assert.match(sharedData, /block reports.*under-replicated.*copy/is);
  assert.match(sharedData, /`hflush\(\)`.*`hsync\(\)`.*EditLog/is);
  assert.match(sharedData, /RDMA does not automatically/i);
  assert.match(sharedData, /228 microamps/i);

  const security = noteBody("distributed-systems", "security-incidents-and-capstone");
  assert.match(security, /TLS 1\.3/);
  assert.match(security, /digital signature/i);
  assert.match(security, /postmortem/i);
});

test("the source contains none of the retired course interface copy", async () => {
  const source = (
    await Promise.all((await markdownFiles(notesRoot)).map((file) => readFile(file, "utf8")))
  ).join("\n");
  for (const phrase of [
    "Reading guide",
    "Reference policy",
    "Mark complete",
    "Reading progress",
    "Search notes",
  ]) {
    assert.doesNotMatch(source, new RegExp(phrase, "i"));
  }
  assert.doesNotMatch(source, /Generated by/i);
});
