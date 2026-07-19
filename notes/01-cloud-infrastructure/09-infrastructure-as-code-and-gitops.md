---
title: Infrastructure as code and GitOps
shortTitle: IaC and GitOps
description: Trace Terraform ownership and state recovery, then promote one immutable artifact through GitOps and controller evidence.
collection: cloud-infrastructure
slug: infrastructure-as-code-and-gitops
order: 9
number: CI9
duration: 125 min
difficulty: Advanced
tags:
  - Terraform
  - GitOps
  - Argo CD
  - Kustomize
  - delivery
---

## Working model

Infrastructure delivery joins two ownership records. Terraform maps declared resource addresses to provider objects, while a GitOps controller compares versioned workload intent with live cluster objects. Neither record proves that the resulting service works.

## Questions this note answers

- Separate a Terraform provider, resource, module, backend, and state entry
- Trace `init`, plan, apply, drift, import, replacement, and state recovery without treating them as one operation
- Protect state and saved plans as production data
- Promote one immutable artifact through environments with separately owned identities and state
- Build and review a release candidate from a pinned source revision, Kustomize overlay, and image digest
- Distinguish successful reconciliation from a healthy rollout
- Choose the rollback owner for a render, sync, rollout, migration, service, or Terraform failure
- Assemble a release record for a self-contained fictional repository

## Production adds ownership after deployment

Running code once proves little about operating it for months. A production service needs a repeatable change path, an owner, access control, capacity limits, health evidence, alerts with actions, backup and recovery, and a way to stop a bad rollout. Those duties continue after the first successful deployment.

The change tools in this note solve different pieces:

| Term                   | Meaning                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Infrastructure as code | Versioned source describes infrastructure through a provider API instead of relying on undocumented console actions                              |
| Terraform state        | Terraform's recorded mapping between configuration objects and provider resources; it requires controlled storage, locking, access, and recovery |
| Plan and apply         | A plan proposes a change from configuration, state, and provider observations; apply requests those changes from provider APIs                   |
| Kustomize              | Renders Kubernetes YAML by combining a base with selected overlays and patches                                                                   |
| Helm                   | Packages parameterized Kubernetes templates and related files as a chart, then records a release when a client installs or upgrades it           |
| GitOps                 | A reconciler compares versioned desired state from Git with a live system and reports or repairs drift according to policy                       |
| Argo CD                | A GitOps controller for Kubernetes resources; it renders or consumes manifests and compares them with cluster state                              |

A tool does not supply the operating policy. Someone still decides who may approve a deletion, how state is recovered, which drift is repaired automatically, and what service evidence blocks promotion.

## Plans predict; reconcilers apply and keep checking

Terraform compares configuration, recorded state, and provider observations to produce a plan. Review the plan as a proposed state transition, including replacements and deletions; plan files can contain sensitive values and don't belong in Git. Apply changes through a controlled workflow rather than an engineer's laptop session.

Kustomize renders bases plus environment overlays. Argo CD compares rendered target state with live Kubernetes state and syncs differences according to policy. A successful sync still needs rollout health, migration safety, and product signals before the release counts as healthy.

[CI3: Control planes and reconciliation](./03-control-planes-and-reconciliation.md) explains `ApplicationSet` → `Application` → workload-object discovery and Deployment → ReplicaSet → Pod ownership. This note does not repeat that controller walk. It starts earlier with the release candidate and ends later with promotion, service evidence, and recovery.

The two loops also have different scopes. Terraform state records ownership of provider resources such as a VPC, database, or bucket. Argo CD owns Kubernetes objects selected by an `Application` or `ApplicationSet`. If both tools try to own the same field or object, their reconciliation loops can fight. Record one writer for each declared field and make the handoff between infrastructure outputs and workload inputs explicit.

## Worked case: add one audit bucket with Terraform

Suppose a team needs an S3 bucket named `example-prod-audit-01` in `us-west-2`. The name is illustrative; a real S3 bucket name must be globally unique. The bucket should be owned by code, changed through review, and recoverable into Terraform ownership if state is damaged.

Five nouns describe the ownership model:

| Term     | Role in this case                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider | The AWS provider plugin translates Terraform resource operations into AWS API calls. Provider releases are separate from Terraform releases.               |
| Resource | `aws_s3_bucket.this` declares one managed remote object. Its full address identifies where Terraform owns it.                                              |
| Module   | The root module is the working directory. It calls the child module in `./modules/audit-store` so more environments can reuse the same bucket declaration. |
| Backend  | The backend stores Terraform state and may coordinate state locking. It does not create the S3 bucket being managed.                                       |
| State    | State maps a resource address to the remote object ID and recorded attributes. It is not a backup of the bucket or its objects.                            |

The root module selects the provider, backend, region, and child module. The child module owns the resource:

```hcl
# root/main.tf
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  backend "s3" {
    use_lockfile = true
  }
}

provider "aws" {
  region = "us-west-2"
}

module "audit_store" {
  source = "./modules/audit-store"
  name   = "example-prod-audit-01"
}

# modules/audit-store/main.tf
variable "name" {
  type = string
}

resource "aws_s3_bucket" "this" {
  bucket = var.name
  tags = {
    ManagedBy = "Terraform"
  }
}
```

The backend block is intentionally partial: supply the state bucket, key, and region through the protected initialization workflow rather than committing environment-specific values here. `use_lockfile = true` opts the current S3 backend into S3-based state locking. DynamoDB-based locking is deprecated; an older configuration that still uses it is migration work, not a pattern for a new backend.

The constraint selects the reviewed major release line, while `.terraform.lock.hcl` records the exact provider build selected by `init`; commit that lock file and review upgrades. Supply AWS credentials through a short-lived role rather than source code. Create the remote backend through a separate bootstrap path because Terraform must initialize its backend before it can apply this configuration.

1. **Initialize.** Run `terraform init`. Terraform configures the backend, installs the provider, initializes child modules, and selects provider versions in the dependency lock file. A remote child module would be downloaded; this local `./modules/audit-store` source is read from the working tree. Re-run `init` after changing a provider, module source, or backend configuration.
2. **Plan.** Run `terraform validate`, then `terraform plan -out=tfplan`. Terraform reads state, asks the provider about managed remote objects, and compares those observations with the configuration. The first plan should show one create action at `module.audit_store.aws_s3_bucket.this`. Review the exact create, update, replace, and destroy actions. Treat the saved plan as sensitive, short-lived data and never commit it.
3. **Apply and record ownership.** After approval, run `terraform apply tfplan`. The provider calls AWS, and Terraform records the bucket ID under the resource address in state. If AWS accepts the create but Terraform cannot write state, the bucket may exist without a durable mapping. Stop, preserve any recovery state Terraform wrote, inspect AWS and the backend, and repair the mapping instead of blindly applying again.
4. **Handle drift as a decision.** If someone removes the `ManagedBy` tag in the AWS console, the next normal plan refreshes observations and proposes restoring the declared tag. If the console change was intentional, update configuration and review that change. A refresh-only plan can update state to match remote objects, but it does not edit configuration, so it is not a lasting way to adopt an intentional configuration change.
5. **Import before managing an existing object.** If the bucket already exists, keep the matching resource configuration and add this block to the root module:

   ```hcl
   import {
     to = module.audit_store.aws_s3_bucket.this
     id = "example-prod-audit-01"
   }
   ```

   Review a plan and apply the import before later changes. Import binds the remote ID to the address; it does not prove the configuration describes every existing setting. Bind one remote object to only one Terraform address.

6. **Separate replacement from repair.** When a provider cannot update an argument in place, the plan marks a destroy-and-create or create-and-destroy replacement. Review data retention, dependent resources, name reuse, temporary capacity, and order before approval. `terraform plan -replace=module.audit_store.aws_s3_bucket.this` can request a replacement for a damaged object, but it should not become a routine restart command. `create_before_destroy` works only when the API, name, dependencies, and available capacity allow both objects to exist at once.

State is production data. Use a remote backend with encryption, narrow write access, versioned storage where available, and locking where the backend supports it. Keep separate state scopes where one mistake should not affect every environment. State may contain sensitive values, so do not place it in Git or edit its JSON directly. If a lock appears stale, first prove that no live writer exists; only then use `terraform force-unlock`. If state is lost or corrupt, restore the correct backend version or import the surviving objects. A state restore repairs Terraform's mapping, not the cloud resources. Before an exceptional `terraform state push`, save `terraform state pull`, verify lineage and serial, and treat the push as a last resort. Finish every recovery with a new plan that explains all proposed actions.

## Promote one artifact through separately owned state

Development, staging, and production are operating boundaries, not merely labels in one manifest. Each environment needs an owner, cloud identity, Terraform state boundary, secret source, network and data policy, capacity, and rollback path. A shared module can define common structure, while inputs and policy express the differences. Do not make a production state file readable or writable by a lower environment just because both use the same module.

Build an immutable application artifact once, verify its digest, and promote that same artifact rather than rebuilding different bytes for each environment. Render the Kustomize base plus the chosen overlay and review the structural diff. For Terraform, refresh provider observations through the normal workflow, save a plan only in protected temporary storage, and review create, update, replace, and destroy actions. A plan can contain sensitive values and can become stale when configuration or remote objects change before apply.

Promotion gates should cover migration compatibility, probes, rollout capacity, error and latency limits, queue behavior, and a tested stop condition. Staging proves the declared test set against staging state; it cannot prove production scale, data shape, quotas, or third-party behavior. In production, begin with a bounded cohort when the controller supports it, compare against the prior version, and keep the prior artifact and configuration addressable until recovery evidence is complete. The relational-internals note's [concurrent PostgreSQL index build](../03-system-design/04-relational-engine-internals.md#creating-an-index-concurrently-is-a-state-machine) is a concrete example: an “online” migration still has transitional states, wait barriers, resource cost, and a failed-artifact cleanup path.

_Promotion reuses an artifact; it does not reuse credentials, state files, private addresses, or unreviewed environment values._

```text
shared module/base + environment-owned inputs/overlay
immutable artifact digest: build once → staging → production
Terraform: plan → protected review → apply → observed state
Kubernetes: render → diff → sync → rollout → service evidence
```

## Worked case: promote one rendered release candidate

Suppose staging already runs the orders image `registry.example/orders@sha256:111...`, and release `43` produced `registry.example/orders@sha256:843...`. The production overlay is in Git. An Argo CD `Application` selects that path and a revision. The goal is not to “deploy the branch.” It is to prove which bytes and objects were approved, which controller changed them, and which evidence allowed promotion.

Use a release record with stable identifiers:

| Field                | Example                                           | Why it exists                                                           |
| -------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| Source revision      | Git commit `8ac4...`                              | Reproduces the reviewed files rather than whatever a branch names later |
| Application artifact | `orders@sha256:843...`                            | Identifies the same image bytes in staging and production               |
| Render input         | `deploy/overlays/production`                      | Names the selected environment composition                              |
| Render tool          | Recorded `kubectl` or Kustomize version           | Makes a render difference explainable                                   |
| Destination          | Sanitized environment and namespace identifier    | Prevents approval for one target from becoming authority for another    |
| Prior release        | Commit plus image digest for release `42`         | Gives recovery a known desired state                                    |
| Gates                | Test, policy, rollout, service, and stop criteria | States what evidence can advance or stop the release                    |

### 1. Pin and render before approval

Check out the exact source revision. Run `kubectl kustomize deploy/overlays/production` in a controlled job and retain the rendered output as review evidence. The overlay can compose a base, patches, generated ConfigMaps, and image substitutions, so reviewing only the handwritten patch misses the resulting object set.

Inspect the rendered candidate for:

- object additions and deletions, kinds, names, namespaces, labels, selectors, and owner boundaries;
- the exact image digest, command, environment-variable names, service account, ports, probes, and resource requests or limits;
- rollout strategy, disruption and traffic policy, storage claims, and any sync hook or wave annotation;
- secret _references_ and access paths without printing secret values.

Run schema and policy checks against the rendered objects, then compare the candidate with the live application using the delivery system's diff. `argocd app diff` compares target and live state and can compare a selected revision or local manifests. Explain every deletion, immutable-field replacement, selector change, privilege change, and diff-suppression rule. A clean renderer exit only proves that it produced objects.

### 2. Gate promotion before changing desired state

The same image digest should pass staging before production. Promotion changes environment-owned desired state; it should not rebuild the application under a reused tag. The production gate should name:

1. tests and policy checks that must pass;
2. migration compatibility with both the old and new application during overlap;
3. spare capacity for surge, one-zone loss, and slow startup;
4. allowed error, latency, saturation, and queue changes;
5. a maximum observation window and the person or controller allowed to stop;
6. the prior source revision and artifact digest, plus any reason rollback would be unsafe.

Staging cannot prove production data shape, traffic, quotas, or third-party behavior. It proves only the checks actually run there. Production therefore starts with a bounded exposure when the rollout controller supports it and compares new-version evidence with the prior version.

### 3. Sync the reviewed candidate

Merge or otherwise advance the approved production reference according to repository policy. Argo CD resolves the selected revision, generates target manifests, compares them with live resources, and either reports `OutOfSync` for manual action or begins automated sync when that policy is enabled. Record the resolved Git revision, operation initiator, start time, sync policy, object results, and any hook output.

Sync phases and waves order eligible resources; they are not a general transaction across Kubernetes and external systems. A `PreSync` migration can change a database before the application rollout, and failure after that point may not be reversible by changing an image. Pruning can delete objects that disappeared from desired state, so deletion policy belongs in review rather than being discovered during recovery.

### 4. Observe rollout separately from sync

After objects are applied, the workload controller performs its rollout. For a Kubernetes Deployment, `maxSurge`, `maxUnavailable`, readiness, and `progressDeadlineSeconds` shape progress. Argo CD convergence and health are useful controller signals, but the release gate should also read the workload generation, rollout conditions, unavailable replicas, Pod reasons, ready endpoints, gateway or load-balancer errors, application latency and errors, queue depth, and dependency saturation.

Keep these states separate:

```text
source accepted
  → render reproduced and diff approved
    → Argo sync operation completed
      → workload rollout completed
        → ready endpoints served bounded traffic
          → service and dependency gates passed
```

A release can be `Synced` while Pods crash, `Healthy` by a generic resource check while the business operation fails, or healthy at low traffic while a dependency saturates during ramp-up. The release record closes only after the declared service window passes.

## Roll back the owner that introduced the bad state

“Rollback” is not one command. First identify which state changed and whether an earlier artifact remains compatible with the current database, messages, and external effects.

| Failure                                           | Recovery owner                                    | First safe move                                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Render or policy check fails before sync          | Git/release workflow                              | Do not promote; fix or revert the candidate and render again                                                                         |
| Argo sync rejects an object                       | Git desired state and Argo operation              | Stop further promotion, inspect the rejected object, then fix or revert Git and resync                                               |
| New Pods fail before serving traffic              | Workload rollout plus Git desired state           | Stop or pause exposure, restore the prior digest in Git, sync, and verify the replacement rollout                                    |
| Service metrics fail after partial exposure       | Traffic/rollout controller plus Git desired state | Remove new exposure, restore prior desired state, then verify service and dependency recovery                                        |
| Forward-only schema or data change ran            | Database migration owner                          | Do not blindly restore the old image; use the written roll-forward, compatibility, or restore procedure                              |
| Terraform changed a provider resource incorrectly | Terraform configuration and provider API          | Describe the prior safe configuration in code, review a fresh plan, and apply only after replacement and data effects are understood |
| Terraform state mapping is missing or corrupt     | Backend/state recovery owner                      | Restore the correct state version or import surviving objects; do not call that a resource rollback                                  |

In a GitOps application, prefer restoring the desired revision or image in Git so the reconciler and audit record agree. A direct `kubectl rollout undo` changes live state but leaves Git pointing at the bad template, so a self-healing controller can reverse the emergency action. Argo CD's own rollback operation also cannot run while automated sync is enabled. If an emergency live action is necessary, record it, control reconciliation deliberately, repair Git immediately, and prove convergence afterward.

Terraform has no universal application-style rollback. Reverting a configuration commit merely proposes another plan, and the provider may require replacement or destruction to reach the earlier shape. Restoring an old state file changes Terraform's ownership record; it does not undo remote API calls. Review the new plan, data retention, names, dependencies, and temporary capacity before claiming recovery.

## Fictional practice: assemble a release record

Suppose the bookshop uses the repository below. The layout, revisions, cluster names, and image digests exist only for this exercise:

```text
clusters/
  root.yaml                         → Argo CD root Application
  storefront-appset.yaml            → generates one Application per environment
apps/storefront/base/
  kustomization.yaml
  deployment.yaml
  service.yaml
apps/storefront/overlays/staging/
  kustomization.yaml
apps/storefront/overlays/production/
  kustomization.yaml
```

The staging candidate points at Git revision `4d2c0f1` and image digest `sha256:111...`; the prior release points at revision `8a7b3e2` and digest `sha256:000...`. Treat the shortened values as placeholders, not usable artifact identifiers.

1. Read `storefront-appset.yaml` and identify which fields select the source revision, overlay path, destination namespace, and automated-sync policy.
2. Render `apps/storefront/overlays/staging` from revision `4d2c0f1`. Record the object kinds, image digest, labels and selectors, probes, resource requests, service ports, identity, and rollout strategy. Keep the exact render as the review artifact.
3. Confirm whether the workload is a Deployment or an Argo Rollout. Installing the Rollouts controller does not make it the owner of an ordinary Deployment.
4. Write a release record containing source revision, render command and version, output checksum, artifact digest, destination, diff, test evidence, rollout owner, health gates, stop conditions, migration compatibility, and the prior release.
5. Decide recovery for a render rejection, an unready workload after sync, and rising errors after partial exposure. Name the Git change, controller convergence, service evidence, and any database state that prevents the earlier image from running.

_The exercise ends with a reproducible render, release gates, and a recovery decision._

```text
source identifier + selected base/overlay + artifact identity
  → reproducible render → sanitized diff categories → promotion gates
    → Argo target revision and sync result
      → actual rollout owner and status
        → service evidence or named recovery path
```

## Summary

Infrastructure delivery starts with explicit ownership. Terraform records provider objects under resource addresses; GitOps controllers compare rendered workload intent with live cluster objects. Neither replaces rollout or service evidence.

- Providers implement resource operations, modules group configuration, backends store state, and state maps addresses to remote objects.
- `init`, plan, apply, import, replacement, drift repair, and state recovery solve different problems. Review their boundaries instead of using apply as a general repair command.
- Protect remote state and saved plans, prove a lock is stale before forcing it open, and finish recovery with a plan that accounts for every proposed action.
- Promote one verified artifact digest through environments that keep separate identities, state, secrets, networks, data, and rollback policy.
- A release record ties the source revision, artifact digest, render input and tool, destination, gates, and prior release together. Render the selected overlay before approving its effects.
- Distinguish Argo comparison and sync, workload rollout, ready traffic, and service behavior. Each transition has a different owner and different evidence.
- Roll back the state that actually changed. Restore Git intent for a bad application release, use the migration recovery contract after a forward-only data change, and use a reviewed Terraform plan for provider resources. Restoring state alone does not reverse remote calls.
- A fictional repository is enough to practice the evidence chain; source revision, render, artifact identity, controller status, service health, and recovery decision must still agree.

## References

- [Terraform providers](https://developer.hashicorp.com/terraform/language/providers): Provider plugins, version constraints, installation, and the dependency lock file.
- [Terraform resources](https://developer.hashicorp.com/terraform/language/resources): Resource creation, in-place updates, replacement, destruction, and state updates.
- [Terraform modules](https://developer.hashicorp.com/terraform/language/modules): Root and child module boundaries.
- [Terraform init command](https://developer.hashicorp.com/terraform/cli/commands/init): Backend, provider, and module initialization.
- [Terraform backends, state storage, and locking](https://developer.hashicorp.com/terraform/language/state/backends)
- [Terraform S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3): Native `use_lockfile` locking, partial configuration, and the deprecated DynamoDB locking fields.
- [Terraform import](https://developer.hashicorp.com/terraform/language/import): Configuration-driven import into a resource address.
- [Terraform state recovery](https://developer.hashicorp.com/terraform/cli/state/recover): State pull, push, locking, and recovery cautions.
- [Terraform plan workflow](https://developer.hashicorp.com/terraform/tutorials/cli/plan): Includes the warning that saved plans may contain sensitive data.
- [Terraform plan command reference](https://developer.hashicorp.com/terraform/cli/commands/plan)
- [Argo CD automated sync policy](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)
- [Argo CD ApplicationSet](https://argo-cd.readthedocs.io/en/stable/user-guide/application-set/)
- [Argo CD application diff](https://argo-cd.readthedocs.io/en/stable/user-guide/commands/argocd_app_diff/)
- [Argo CD sync phases and waves](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/)
- [Kubernetes Kustomize task](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)
- [Kubernetes Deployment update, rollout status, and rollback](https://kubernetes.io/docs/tasks/run-application/update-deployment-rolling/)
- [Helm chart format](https://helm.sh/docs/topics/charts/)
- [Argo Rollouts concepts](https://argo-rollouts.readthedocs.io/en/stable/concepts/)
