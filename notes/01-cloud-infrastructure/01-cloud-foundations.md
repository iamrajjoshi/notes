---
title: "Cloud foundations: failure domains, identity, and traffic"
shortTitle: Cloud foundations
description: Map AWS compute, failure domains, networks, identity, load balancers, storage, and encryption before adding Kubernetes.
collection: cloud-infrastructure
slug: cloud-foundations
order: 1
number: CI1
duration: 190 min
difficulty: Foundation
tags:
  - AWS
  - VPC
  - IAM
  - DNS
  - KMS
  - Cloudflare
---

## Working model

A cloud system is a set of failure boundaries joined by explicit identity and network decisions. Draw those boundaries before naming services.

## Questions this note answers

- Separate a region, Availability Zone, VPC, subnet, and workload cell
- Trace a browser request through DNS, an IP route, transport, TLS, HTTP, and a load balancer
- Define EC2, Auto Scaling, Lambda, ECS, EKS, Fargate, ELB, S3, EBS, and RDS before using them
- Trace ingress and egress through DNS, routes, gateways, and security controls
- Read an IAM decision as principal, action, resource, and condition
- Choose among object, block, and relational storage for a stated failure model
- Choose between an ALB-backed EC2 fleet and an API Gateway-backed Lambda function for a stated workload

## Begin with one service, not with AWS names

A production web service is still application code running in processes. Infrastructure supplies the machines, network path, identity, durable state, and replacement machinery around those processes. Cloud services package some of that work behind provider APIs, but every package still has an input, output, owner, and failure boundary.

Take `https://api.example.com/orders/123` as the starting point:

1. A Domain Name System (DNS) resolver turns `api.example.com` into one or more Internet Protocol (IP) addresses. DNS answers where to try; it does not carry the application request.
2. The client chooses an address and reaches it through IP routing. An IP address names a network interface, while a port identifies the receiving transport endpoint on that address. Hypertext Transfer Protocol Secure (HTTPS) normally uses port 443.
3. Hypertext Transfer Protocol (HTTP) versions 1.1 and 2 ordinarily use a Transmission Control Protocol (TCP) connection. TCP supplies an ordered byte stream and retransmits lost data. HTTP/3 instead runs over QUIC and the User Datagram Protocol (UDP), so “HTTPS always means TCP” is no longer correct.
4. Transport Layer Security (TLS) authenticates the server name with a certificate and negotiates protected communication. The client can then send an HTTP request containing a method, target, headers, and optional body.
5. A reverse proxy or load balancer may terminate that connection, choose a healthy application target, and open or reuse a separate upstream connection. Success on the client connection does not prove the upstream request worked.

That path gives an initial failure split. A name can fail to resolve, packets can lack a route, transport setup can time out, certificate validation can fail, a load balancer can have no healthy target, or the application can return an error. “The site is down” does not identify which boundary failed.

```text
URL
  -> DNS name to IP address
  -> IP route to address and port
  -> TCP + TLS, or QUIC with TLS
  -> HTTP request
  -> edge or load balancer
  -> application process
  -> database, object, or another service
```

## Regions and zones are blast-radius choices

An AWS account is an ownership boundary for resources, identity policy, quotas, billing, and audit records. AWS Organizations groups accounts and can apply service control policies (SCPs). An SCP limits the permissions available to member accounts; it does not grant a permission by itself. Production, development, security, and shared-network accounts are often separated because one credential or configuration error should not reach everything.

A region is a geographic AWS deployment area. Availability Zones inside it have separate facilities and failure risks, yet use low-latency regional links. A Virtual Private Cloud (VPC) is a logically isolated regional IP network. Its Classless Inter-Domain Routing (CIDR) blocks define address ranges; for example, `10.20.0.0/16` covers a larger range that can be divided into smaller subnet ranges. Each subnet belongs to one Availability Zone. A workload reaches the VPC through a network interface with one or more private addresses.

Each subnet uses a route table. A route matches a destination prefix and names a next-hop target; the most specific matching prefix wins. A subnet with a route to an internet gateway is called public, but an IPv4 workload also needs a public address before the internet can initiate a connection to it. A private subnet lacks that direct route. It can still make outbound IPv4 connections through a NAT gateway without becoming a direct inbound target.

That zonal subnet fact explains why a multi-zone service needs subnets, addresses, capacity, and reachable dependencies in more than one zone.

A cell adds an application boundary on top of cloud boundaries. Cells can limit customer impact, deployment risk, and database contention, but they also create routing and data-placement work. Multi-zone and multi-cell solve different problems.

> **Fictional case.** The bookshop used throughout these notes places customers into one of two workload cells. Each cell has its own compute, deployment cohort, and database partition. The names and values describe only this teaching example.

## Start with the AWS service map

AWS service names make more sense when separated into three layers: the program being run, the scheduler or scaling control plane, and the machine or managed runtime that supplies compute.

| Service                          | Contract                                                                                                                                                   | What it does not decide for you                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| EC2 (Elastic Compute Cloud)      | A virtual machine chosen from an Amazon Machine Image (AMI) and instance type                                                                              | Application rollout, process supervision, and multi-zone placement                               |
| EC2 Auto Scaling group           | Maintains a minimum, desired, and maximum EC2 fleet from a launch template; replaces instances that fail its health policy                                 | Container scheduling or application-level recovery                                               |
| Lambda                           | Runs a function in managed execution environments in response to invocations or events; concurrency drives scaling                                         | Long-lived host administration or a general container scheduler                                  |
| ECS (Elastic Container Service)  | AWS-native container orchestration. A task definition is the versioned blueprint, a task is one running copy, and a service maintains a desired task count | The underlying compute choice; tasks can use Fargate, managed instances, or EC2 capacity         |
| EKS (Elastic Kubernetes Service) | A managed Kubernetes control plane that exposes the Kubernetes API                                                                                         | Most workload, policy, data-plane, and application decisions; Chapter 6 draws the exact boundary |
| Fargate                          | Managed compute for supported ECS tasks or EKS Pods                                                                                                        | Orchestration. ECS or EKS still decides what should run                                          |

Elastic Load Balancing (ELB) is another family rather than one interchangeable product. An Application Load Balancer (ALB) terminates and routes HTTP or HTTPS using layer-7 rules. A Network Load Balancer (NLB) handles high-throughput TCP, UDP, or TLS flows at layer 4. A Gateway Load Balancer (GWLB) inserts network appliances such as firewalls; it is not the ordinary front door for an HTTP application. Classic Load Balancers remain for old deployments, but new designs normally start with ALB or NLB.

Storage has a similar split. Amazon Simple Storage Service (S3) is an object API, not a mounted disk. Elastic Block Store (EBS) supplies a block device in one Availability Zone. Relational Database Service (RDS) operates a relational database engine. Elastic File System (EFS) supplies a shared network filesystem when POSIX file access and concurrent mounts are part of the requirement. Start with the access contract rather than asking which service is most managed.

_The orchestrator and compute layer are separate choices._

```text
HTTP request → DNS → ALB → target
                            ├─ EC2 instance in an Auto Scaling group
                            ├─ ECS task on Fargate, managed instances, or EC2
                            └─ EKS Pod on Auto Mode, Fargate, or EC2 nodes

application state → S3 object | EBS block volume | EFS file | RDS database
```

## Worked case: ALB to Auto Scaling to EC2

Suppose the orders API is a long-running process that listens on port `8080`. The initial production shape has four EC2 instances across two Availability Zones. Its Auto Scaling group has minimum `4`, desired `4`, and maximum `12` instances. An internet-facing ALB accepts HTTPS on port `443`, and its target group checks `GET /ready` on each instance.

These are several resources with separate jobs. The launch template describes how to create an instance. The Auto Scaling group decides how many instances should exist and in which subnets. The target group records which instances can receive traffic. The ALB listener accepts client connections and selects a healthy target.

### Deploy the fleet

1. Build the application and its fixed dependencies into an AMI. Create launch-template version `18` that selects that AMI, the instance type, the instance security group, and an IAM instance profile. Do not bake long-lived AWS credentials into the image.
2. Configure the Auto Scaling group to span private subnets in both zones and attach its target group. The group launches four instances from the template and registers them with the target group.
3. Allow client HTTPS to the ALB security group. Allow port `8080` on the instance security group only from the ALB security group. Network permission does not grant the instance role permission to call S3, KMS, or RDS APIs.
4. Wait for each new instance to boot the process and pass the target-group health check. `InService` in the Auto Scaling group and `healthy` in the target group answer different questions; record both.
5. For release `19`, build another AMI and launch-template version. Start an instance refresh with explicit healthy-capacity settings, checkpoints, and bake time. Merely changing the template used for future launches does not replace every existing instance. A refresh rolls the new configuration through the current fleet. When its prerequisites are met, instance refresh can automatically roll back after replacement errors or selected CloudWatch alarms.

### Trace one request

```text
client
  → DNS answer for api.example.com
  → ALB listener :443 and TLS certificate
  → listener rule
  → target group
  → one healthy EC2 instance :8080
  → orders process
  → database or another dependency
  → response through the ALB
```

The ALB health check controls routing. If one instance starts returning the wrong status on `/ready` while other healthy targets remain, the target becomes unhealthy and stops receiving ordinary requests. If every target is unhealthy, ALB fail-open behavior can route to all of them, so “removed from rotation” is not an absolute availability boundary. Target failure alone does not guarantee instance replacement. Configure the Auto Scaling group to use Elastic Load Balancing health checks when target failure should also make the group replace the instance. Otherwise, the group can still consider an EC2-running instance healthy while the ALB refuses to route to it.

A target-tracking policy can adjust desired capacity from a metric such as ALB request count per target or average CPU. It cannot create ready capacity immediately. Instance launch, process startup, health checks, and scaling cooldown or warmup all add delay. The maximum of `12` is a hard policy ceiling until someone changes it, and subnet addresses, EC2 quotas, zonal instance capacity, database connections, and downstream throughput can stop useful scaling before that number.

Treat each instance as replaceable. Store orders in a durable database, objects in S3, and shared session or coordination state outside local process memory. An attached disk can persist bytes according to its own lifecycle policy, but one instance-local disk is not a multi-zone state design. During scale-in or refresh, deregistration and its delay protect in-flight connections only for the configured interval; clients still need bounded timeouts and safe retries.

### Read failure evidence by owner

| Question                              | Evidence                                                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Did the request reach the front door? | DNS result, ALB access record, listener rule, ALB status counts, and request correlation ID                                             |
| Was a target eligible?                | Target registration state, `describe-target-health` state and reason, health-check path, security groups, and application readiness log |
| Did the group maintain capacity?      | Scaling activities plus desired, pending, in-service, and terminating group metrics; failed launch reason; instance-refresh status      |
| Did the host or process fail?         | EC2 system and instance status checks, boot output, process supervisor state, resource metrics, and application logs                    |
| Did durable state fail?               | Database connection and query evidence, storage or KMS request ID, dependency latency, and recovery status                              |

An ALB `5xx` count, an unhealthy target, and a failed instance launch are not interchangeable signals. Keep the timestamp, Availability Zone, instance ID, target-health reason, launch-template version, and application version together so that replacement does not erase the explanation.

## Worked case: API Gateway to Lambda

Now implement `POST /orders` as a bounded function. An API Gateway HTTP API owns the public route. Its Lambda proxy integration invokes the `live` alias of an orders function. The function validates one request, writes the order to durable storage, and returns an HTTP-shaped result.

### Deploy the function

1. Package the handler and dependencies, update the function code and configuration, then publish immutable version `42`. The unpublished `$LATEST` version remains mutable; a published version gives the release a stable address.
2. Point alias `live` at version `42`, and configure the API Gateway integration to invoke the alias. The function's resource-based policy must permit API Gateway to invoke it. The function's execution role separately controls what the handler may call.
3. For version `43`, run direct invocation and integration tests, publish the version, then shift a small weight on `live` to it. Weighted alias routing can expose a bounded share before moving the alias completely, but the sample is probabilistic; a tiny request count is weak evidence.
4. Gate the shift on API errors and latency, Lambda errors, throttles, duration, concurrency, logs, traces, and the order write. Retain version `42` and its compatible configuration until the recovery window closes.

### Trace one synchronous request

```text
client
  → API Gateway DNS, TLS, stage, and POST /orders route
  → authentication, authorization, and throttling policy
  → Lambda proxy event
  → live alias → published function version
  → execution environment → handler
  → durable database or object API
  → proxy response → API Gateway → client
```

With a proxy integration, API Gateway passes request data such as the method, path, headers, query values, body, and request context in an event. The handler must validate that input and return the integration's expected response shape. API Gateway accepting a client connection does not mean Lambda ran, and a successful Lambda invocation does not mean the order write was correct.

Lambda adds execution environments as concurrent invocations increase, subject to the function's scaling rate, reserved or provisioned concurrency, regional concurrency, and request-rate quotas. For a synchronous handler with an average duration of `0.4` seconds at `120` requests per second, the first capacity estimate is `120 × 0.4 = 48` concurrent executions. Bursts, tail latency, retries, cold starts, and slow dependencies raise the observed value. Reserved concurrency can protect the function from neighbors and cap its downstream pressure; once no permitted concurrency is available, Lambda throttles new invocations.

Do not use a reused execution environment as the system of record. Runtime objects, connections, and temporary files may survive for a later invocation and can be useful caches, but the platform may replace the environment. Put orders, idempotency records, sessions, and durable workflow state in an external store. A retry of `POST /orders` can otherwise create two orders after the first write succeeds but its response is lost.

Lambda also imposes a different execution envelope from an EC2 process. A standard invocation runs for at most 15 minutes, and memory, deployment-package, payload, temporary-storage, concurrency, and request-rate quotas apply. Check the current quota page and the account's actual quota before design review. Provisioned concurrency can reduce environment-initialization delay, but it does not remove application latency, dependency limits, or the need for overload policy.

### Separate gateway, invocation, and application evidence

| Question                                       | Evidence                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Did API Gateway match and forward the request? | Access log with request ID, route and stage, status, `Count`, `4xx`, `5xx`, `Latency`, and `IntegrationLatency`                 |
| Did Lambda accept and run it?                  | `Invocations`, `Errors`, `Throttles`, `Duration`, `ConcurrentExecutions`, function version, alias weight, and Lambda request ID |
| Did initialization or code fail?               | Structured function log, initialization duration where available, exception, trace, timeout, and memory evidence                |
| Did the state change once?                     | Idempotency key, database transaction or object request ID, resulting record, and audit event                                   |

API Gateway can reject a request before invocation because no route, authorization, throttle budget, integration permission, or valid integration exists. Lambda can reject it for concurrency or request-rate limits. The handler can then time out, raise an error, or return a malformed proxy response. Preserve both gateway and Lambda request identifiers so a generic client `5xx` does not hide the boundary.

## Choose the compute contract explicitly

Both designs can serve an HTTP API. The choice is about the execution and operating contract, not which diagram has fewer boxes.

| Decision        | ALB → Auto Scaling → EC2                                                                                                     | API Gateway → Lambda                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Running unit    | A long-lived process on a team-selected virtual machine                                                                      | A bounded handler in a provider-managed execution environment                                                          |
| Scale control   | A policy changes instance desired capacity; boot and health-check time delay new capacity                                    | Invocation concurrency drives environments within scaling and account limits                                           |
| Deployment unit | AMI and numbered launch-template version, rolled through the fleet                                                           | Published function version reached through an alias                                                                    |
| Health model    | ALB target health gates traffic; EC2 and load-balancer health can drive replacement                                          | No per-request target fleet to probe; use test invocations, synthetic requests, metrics, logs, and dependency evidence |
| State           | Process and disk exist across many requests but hosts remain replaceable                                                     | Environment reuse is opportunistic; durable and user-specific state stays external                                     |
| Strong fit      | Long-lived services, host or runtime control, steady work, specialized agents, or protocols and jobs outside Lambda's limits | Independent short requests or events, uneven or idle traffic, little host control, and safe external state             |
| Common overload | Too few ready instances, slow scale-out, zonal capacity, or a saturated dependency                                           | Concurrency or request-rate throttle, cold-start burst, timeout, or a saturated dependency                             |

For the sample `120` requests per second, load testing might show that one EC2 instance can safely serve `30` requests per second at the chosen latency target. Four instances cover the average but leave no instance-failure headroom, so the minimum fleet must be higher or the per-instance target lower. The Lambda estimate starts near `48` concurrent executions, but the same database may still be the real limit. Calculate both paths with tail latency, one-zone loss, deployment overlap, retries, quotas, and downstream capacity before deciding. Neither service is automatically cheaper or more available.

## Identity is evaluated, not inherited by proximity

An IAM principal is the caller, an action is the requested API operation, a resource is the target, and a condition narrows when the rule applies. AWS Identity and Access Management (IAM) evaluates the signed request against applicable identity policies, resource policies, permission boundaries, session policies, organization policy, and explicit denies. Being inside a VPC doesn't grant an AWS API permission. Prefer short-lived role credentials tied to a workload identity; static access keys age badly and spread quietly.

AWS Key Management Service (KMS) controls permission to use encryption keys, while a service such as S3 or EBS performs the data encryption. Envelope encryption keeps bulk data under a data key and protects that smaller key with KMS. Key policy, caller policy, rotation, and recovery procedure all matter.

- Authentication proves the caller; authorization decides the allowed operation.
- A security group filters packets. It cannot replace IAM for an API call.
- An explicit deny wins even when another policy allows the request.
- Encryption without tested key recovery can turn an outage into permanent loss.

## Routes move packets; storage keeps consequences

The Domain Name System (DNS) resolves a name, a load balancer accepts a connection, route tables select the next hop, and security groups admit or reject flows. An internet gateway connects eligible public addresses to the internet. A network address translation (NAT) gateway gives private workloads outbound IPv4 access without making them inbound targets. A zonal NAT gateway belongs to one Availability Zone, so resilient designs either route each private subnet through a NAT gateway in its own zone or use a Regional NAT Gateway that expands across zones. Gateway and interface VPC endpoints can keep supported AWS-service traffic off a NAT path. Security groups are stateful: an allowed flow admits its reply traffic. Network access control lists (ACLs) are stateless subnet filters, so their inbound and outbound rules are evaluated separately.

Networks also need explicit connections beyond one VPC. VPC peering connects two VPCs and is not transitive. Transit Gateway supplies a regional hub for many VPC and on-premises attachments. Site-to-Site VPN carries encrypted tunnels over an IP network, while Direct Connect supplies a dedicated network connection whose traffic encryption is a separate design choice. Route propagation does not replace address planning; overlapping CIDR ranges still prevent ordinary routing between networks.

Storage choices preserve different shapes of state. General-purpose S3 buckets provide strong read-after-write consistency for object PUT, DELETE, GET, and LIST operations, but S3 has no multi-key transaction; one-zone storage classes have a different failure boundary from ordinary multi-zone classes. An EBS volume is replicated within one zone and attaches to compute in that zone. EBS snapshots are a separate backup object replicated across zones in a Region and can create a volume in another zone. Persistence of the volume does not mean a snapshot exists.

RDS owns database installation, backups, monitoring hooks, and engine-specific failover machinery, but the chosen deployment still matters. A Multi-AZ DB _instance_ has a synchronous standby for failover that does not serve reads. A Multi-AZ DB _cluster_ has two readable standby instances. Read replicas primarily add read capacity and use engine-dependent replication; do not describe every read replica as the failover contract. Ask about access pattern, consistency, zone or Region scope, backup, restore time, encryption, and tested recovery before choosing a store.

_Treat each arrow as a routing, identity, timeout, and failure decision._

```text
client → DNS → edge → L7 load balancer → private service
private service → route table → zonal or Regional NAT → external API
private service → VPC endpoint → supported AWS service
private service → block/object/database storage → encrypted backup
```

## A proxied DNS record inserts an HTTP boundary

Cloudflare can host authoritative DNS and act as an edge reverse proxy. Suppose its zone marks an application record as proxied. DNS answers with Cloudflare edge addresses rather than exposing the configured origin address. A client opens TCP and Transport Layer Security (TLS) to an edge location, sends an HTTP request, and the edge applies the zone's security, routing, and cache rules before opening or reusing a separate connection to the origin. The origin may then be an AWS load balancer that selects a healthy target in a private subnet.

There are now two TLS relationships: client to edge, then edge to origin. In Full (strict) mode, Cloudflare requires an unexpired origin certificate from a publicly trusted authority or Cloudflare Origin CA whose name matches the requested or target hostname. A valid edge certificate does not prove the origin leg is healthy. Cache behavior is another decision: response directives and cache rules determine whether an eligible response can be stored and for how long. Never assume that putting a hostname behind an edge proxy makes every response cached.

_Record the DNS, certificate, cache, origin-health, and request-correlation evidence at each boundary._

```text
authoritative DNS → proxied edge address
client TLS → Cloudflare edge
edge policy/cache decision → origin TLS
origin load balancer → healthy private target
```

## Test reachability, authority, and state as separate paths

Start outside the service. Use `dig` or an equivalent resolver query to confirm the authoritative answer and proxy status, then use `curl -v` against a harmless health path to capture DNS, connection, TLS, status, and timing. At the edge, inspect request identifiers, cache status, and origin errors. At the load balancer, inspect listener rules, target health, and connection or response errors. VPC Flow Logs can show accepted or rejected network flows, but they cannot explain an application 500 or an IAM deny.

For an AWS API failure, record the caller identity, action, resource, region, and request ID before reading policy evaluation or CloudTrail evidence. For encrypted storage, separate data reachability from permission to use the KMS key. A timeout reaching S3 differs from an S3 access deny, which differs again from a KMS deny while S3 handles an otherwise valid request. For a zonal incident, remove the failed zone from the diagram and verify DNS, load-balancer targets, NAT, compute, database, and key access on the surviving path rather than stopping after the replicas look healthy.

- DNS failure: answer, authority, TTL, and proxy mode.
- Transport failure: route, security rule, target listener, and timeout.
- Application failure: target health, version, logs, and dependency timing.
- AWS API failure: signed caller, evaluated policies, explicit deny, and service request ID.
- State failure: backend availability, encryption-key access, backup, and restore evidence.

## Summary

A useful cloud diagram names failure domains, identities, packet paths, and state boundaries before it names products. That map makes availability claims testable and keeps network access, API authorization, and data durability from collapsing into one vague idea of “the cloud.”

- A VPC spans a region, but each subnet belongs to one Availability Zone. Multi-zone service design therefore needs usable subnets, capacity, egress, and dependencies on every surviving path. Zonal and Regional NAT gateways have different routing and failure models.
- Zones limit infrastructure failure; application cells limit workload and customer impact. Neither boundary substitutes for the other.
- EC2 supplies virtual machines; an Auto Scaling group manages an EC2 fleet; Lambda runs event-driven functions; ECS and EKS orchestrate containers; Fargate supplies managed compute to either orchestrator. Fargate is not a third scheduler.
- An ALB routes only to eligible targets, while an Auto Scaling group maintains fleet capacity. Connect load-balancer health to the group when an application-unhealthy instance should be replaced, and allow time for launch, startup, health checks, and draining.
- API Gateway and Lambda have separate routing, permission, scaling, and error boundaries. Lambda concurrency is approximately request rate multiplied by average duration, but burst behavior, tail latency, quotas, and downstream capacity determine the safe limit.
- IAM evaluates principal, action, resource, conditions, and explicit denies. Network reachability does not grant API authority, and short-lived workload roles are safer than static keys.
- Trace ingress as DNS → edge proxy → load balancer → healthy target. A proxied hostname creates separate client-to-edge and edge-to-origin TLS connections, each with its own certificate and failure state.
- S3 objects, zonal EBS volumes, EBS snapshots, and RDS deployments make different consistency, attachment, failover, and backup promises. Multi-AZ database failover and read scaling are separate requirements.
- Diagnose DNS, transport, application, AWS API, and storage failures separately. Flow logs can establish packet acceptance or rejection, but cannot explain an HTTP 500, policy deny, or failed KMS operation.

## References

- [AWS Regions and Availability Zones](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-regions-availability-zones.html)
- [AWS account and Organizations terminology](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_getting-started_concepts.html)
- [AWS Organizations service control policies](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)
- [Amazon EC2 concepts](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/concepts.html)
- [Amazon EC2 Auto Scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/what-is-amazon-ec2-auto-scaling.html)
- [Use Elastic Load Balancing with an Auto Scaling group](https://docs.aws.amazon.com/autoscaling/ec2/userguide/autoscaling-load-balancer.html)
- [Application Load Balancer target groups and draining](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html)
- [Application Load Balancer target-health states and reason codes](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/check-target-health.html)
- [How an EC2 Auto Scaling instance refresh works](https://docs.aws.amazon.com/autoscaling/ec2/userguide/instance-refresh-overview.html)
- [EC2 Auto Scaling instance-refresh rollback](https://docs.aws.amazon.com/autoscaling/ec2/userguide/instance-refresh-rollback.html)
- [EC2 Auto Scaling CloudWatch metrics](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-metrics.html)
- [Choosing an AWS container service](https://docs.aws.amazon.com/decision-guides/latest/containers-on-aws-how-to-choose/choosing-aws-container-service.html)
- [AWS Lambda concurrency](https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html)
- [AWS Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
- [AWS Lambda versions](https://docs.aws.amazon.com/lambda/latest/dg/configuration-versions.html)
- [AWS Lambda aliases and weighted routing](https://docs.aws.amazon.com/lambda/latest/dg/configuring-alias-routing.html)
- [AWS Lambda metrics](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html)
- [AWS Lambda application design](https://docs.aws.amazon.com/lambda/latest/dg/concepts-application-design.html)
- [API Gateway Lambda proxy integrations](https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html)
- [API Gateway HTTP API metrics](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-metrics.html)
- [AWS IAM introduction](https://docs.aws.amazon.com/IAM/latest/UserGuide/introduction.html)
- [How Amazon VPC works](https://docs.aws.amazon.com/vpc/latest/userguide/how-it-works.html)
- [Amazon VPC IP addressing](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-ip-addressing.html)
- [Amazon VPC subnet route tables](https://docs.aws.amazon.com/vpc/latest/userguide/subnet-route-tables.html)
- [Amazon VPC internet gateways](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html)
- [Regional NAT gateways](https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateways-regional.html)
- [AWS PrivateLink concepts](https://docs.aws.amazon.com/vpc/latest/privatelink/concepts.html)
- [Amazon VPC peering](https://docs.aws.amazon.com/vpc/latest/peering/what-is-vpc-peering.html)
- [AWS Transit Gateway concepts](https://docs.aws.amazon.com/vpc/latest/tgw/what-is-transit-gateway.html)
- [AWS Site-to-Site VPN concepts](https://docs.aws.amazon.com/vpn/latest/s2svpn/VPC_VPN.html)
- [AWS Direct Connect concepts](https://docs.aws.amazon.com/directconnect/latest/UserGuide/Welcome.html)
- [How Elastic Load Balancing works](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html)
- [Amazon S3 consistency and storage model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html)
- [Amazon EBS volumes](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volumes.html)
- [Amazon EBS snapshots](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-snapshots.html)
- [Amazon RDS Multi-AZ deployments](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html)
- [Amazon RDS read replicas](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html)
- [Amazon EFS concepts](https://docs.aws.amazon.com/efs/latest/ug/whatisefs.html)
- [AWS KMS concepts](https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html)
- [Cloudflare proxied DNS records](https://developers.cloudflare.com/dns/proxy-status/)
- [Cloudflare Full (strict) origin encryption](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
- [Cloudflare origin cache control](https://developers.cloudflare.com/cache/concepts/cache-control/)
- [DNS concepts, RFC 1034](https://www.rfc-editor.org/rfc/rfc1034.html)
- [TLS 1.3, RFC 9846](https://www.rfc-editor.org/info/rfc9846)
- [HTTP semantics, RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html)
- [HTTP/3, RFC 9114](https://www.rfc-editor.org/rfc/rfc9114.html)
