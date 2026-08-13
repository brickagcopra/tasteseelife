# Taste & See — single-VPS deployment runbook

> Zero to a running `dev` overlay on one Contabo VPS.
>
> **Companion documents:** `infra/terraform/README.md`,
> `infra/kubernetes/README.md`, `infra/argocd/README.md`,
> `docs/adrs/0001-vps-contabo-k3s.md`.

---

## 0. What this covers, and what it does not

This runbook targets **one VPS running k3s, serving the `dev` overlay** — the
cheapest configuration that runs the whole platform end to end.

It is deliberately not the topology ADR-0001 describes. That design is three
k3s nodes plus a separate Postgres/Redis data node on a private VLAN, and the
Terraform modules, the `ExternalName` Services, and the egress NetworkPolicies
are all written for it. Section 4 covers the specific places a single box
diverges; skipping that section produces a cluster whose pods start and then
cannot reach a database.

**Nothing in this runbook has been executed against a live cluster.** Every
manifest here renders locally and the generated wiring has been verified with
stub inputs (see § 11 for exactly what that means and what it cannot tell you).

---

## 0.5 The repository comes first

**Repo:** `https://github.com/brickagcopra/tasteseelife.git`
**Registry:** `ghcr.io/brickagcopra/*`

Nothing downstream works until the code is committed and pushed, and this is
easy to underestimate:

- **ArgoCD syncs from git.** Every manifest in `infra/argocd/` points at the
  repo above. With no commits there is nothing to sync.
- **Images are built by CI on push.** The 34 build workflows trigger on a push
  to `main` matching a path filter. No push means **no image has ever been
  built** — there is nothing in `ghcr.io` for the cluster to pull.

So: commit, create the repo, push, and confirm CI produced **54 packages** —
34 workload images plus the 20 `-migrator` images that carry the database
migrations. A missing migrator means that service's schema never gets created.

> **The registry namespace must match the repo owner.** GitHub's `GITHUB_TOKEN`
> can only publish packages under the repository's owner, so `ghcr.io/<owner>/*`
> is not a free choice — pointing it anywhere else fails every push with a
> permission error that does not name the real cause.

> **All 34 build workflows accept `workflow_dispatch`** (TS-009g-followup-8), so
> if the first push does not trigger them — path filtering is unreliable on a
> repository's very first commit — you can ask for every image directly:
>
> ```sh
> for f in .github/workflows/*-build.yml; do
>   gh workflow run "$(basename "$f")" --ref main
> done
> ```
>
> The button only appears once the workflow file exists **on the default
> branch**, so this works from the first push onward, not before it.
>
> The dev-overlay bumper is guarded with `if: github.ref_name == 'main'`. A
> dispatch from a feature branch still builds and pushes an image — useful for
> testing — but will not move dev onto it, because that bumper pushes a commit
> to `main` and would otherwise deploy unreviewed code.

---

## 1. Decisions to make before you spend anything

### 1.1 Your domain

The registered domain is **`tasteseelife.com`**, and it is already committed
throughout the overlays. Nothing here needs renaming.

**DNS is hand-managed in the Contabo control panel, not by Terraform.** The
zone is built and live on `ns1` / `ns2` / `ns3.contabo.net`, which answer for
it authoritatively (AA flag set), with every record pointing at the node
`169.58.147.122` (`vmi3496049.contaboserver.net`).

> ⚠️ **The delegation does not match, so none of it resolves publicly.** The
> `.com` TLD servers still delegate `tasteseelife.com` to
> `orbit.dns-parking.com` / `horizon.dns-parking.com` (Hostinger), which is
> where the domain was registered. Cloudflare, Google and Quad9 all agree, and
> every portal host is **NXDOMAIN** on the public internet while resolving
> correctly against `ns1.contabo.net` directly.
>
> The three `NS` rows inside the Contabo zone are correct but self-referential
> — a zone naming its own nameservers has no effect until the parent
> delegation agrees. **Fix at the registrar**, by setting the domain's
> nameservers to `ns1.contabo.net`, `ns2.contabo.net`, `ns3.contabo.net`. The
> parent `NS` TTL is 172800, so allow up to 48 h. Tracked as
> TS-151-followup-25; **nothing below this line works until it is done.**

> The Terraform `dns` module (`infra/terraform/modules/dns/`) manages
> **Cloudflare** records and reads the zone via `data "cloudflare_zone"`. With
> DNS on Contabo it can never apply, and its default `hostnames` map names
> surfaces that no longer match the Ingresses (`family` / `provider` /
> `academy` / `partner` rather than `app` / `pros`). Treat it as orphaned
> pending TS-151-followup-28 — do not run it expecting these records to appear.

Hosts that actually have an Ingress rule (shown for `dev`; `staging` swaps the
label, and `prod` drops it entirely — `app.tasteseelife.com`, not
`app.prod.tasteseelife.com`):

| Host                           | Serves        |
| ------------------------------ | ------------- |
| `app.dev.tasteseelife.com`     | web-family    |
| `www.dev.tasteseelife.com`     | web-marketing |
| `admin.dev.tasteseelife.com`   | web-admin     |
| `pros.dev.tasteseelife.com`    | web-provider  |
| `grafana.dev.tasteseelife.com` | Grafana       |

**The zone is prod-shaped, by decision.** The Contabo zone carries explicit A
records for the five bare hosts — `admin`, `app`, `grafana`, `pros`, `www` —
and those are the intended public surface. There are deliberately no `dev.` or
`staging.` records.

It also carries a `*.tasteseelife.com` wildcard, which should be deleted. Per
RFC 4592 a wildcard matches multi-label names when no intervening node exists,
so it currently answers for anything at all — `typo123.tasteseelife.com`
returns the node IP. That removes NXDOMAIN as a signal: every typo and every
unconfigured host silently reaches ingress-nginx's default backend and 404s,
which reads as an application bug rather than a DNS mistake. Tracked as
TS-151-followup-26.

> **`api.<env>.tasteseelife.com` is a DNS record with nothing behind it.** The
> wildcard answers it (as does the Terraform `dns` module's `api` entry, if
> that module is ever revived), but **the api-gateway has no Ingress** —
> verified by rendering its base, which emits zero Ingress objects.
> That is architecturally correct, not an oversight: all four portals reach the
> gateway at `http://api-gateway.platform-services.svc.cluster.local:3000`, and
> no `NEXT_PUBLIC_*` variable exposes a gateway URL to the browser. Traffic is
> browser → Next.js portal → gateway, entirely server-side. Requests to the
> `api` hostname will land on the ingress controller's default backend and 404.
> Tracked as TS-151-followup-16.

> Grafana follows the same per-environment shape as the portals
> (`grafana.dev.` / `grafana.staging.` / bare `grafana.` in prod). Its base
> carries the deliberately unresolvable `grafana.example.invalid` — the same
> fail-loud convention as `postgres.data.invalid` — and each overlay patches the
> real host, so an unpatched manifest cannot serve the wrong name.

> `taste-and-see.io/role-ingress` is **not** a domain and was deliberately left
> alone — it is a Kubernetes label key, and renaming it would force a node
> re-label and a DaemonSet selector change for no benefit.

### 1.2 How big the box has to be

This is the decision that most often gets made wrong, because the dev overlay
already sets `replicas: 1` and that makes one box sound obviously sufficient.
Replica count is not the binding constraint — **resource requests are**, and
they are a scheduling floor rather than a usage estimate.

Rendered, the `dev` overlay's 34 workload Deployments request:

|                                                                                                  | CPU            | Memory       |
| ------------------------------------------------------------------------------------------------ | -------------- | ------------ |
| Application workloads (34 Deployments)                                                           | **7.15 cores** | **7.88 GiB** |
| Platform add-ons (Prometheus, Loki, Tempo, Grafana, ingress-nginx, cert-manager, sealed-secrets) | ~2 cores       | ~4–5 GiB     |
| k3s itself + system daemons                                                                      | ~0.5 cores     | ~1 GiB       |
| **Total to schedule everything**                                                                 | **~10 cores**  | **~13 GiB**  |

On a box smaller than that, the tail of the fleet never schedules. The symptom
is confusing because nothing crashes: pods sit `Pending` with
`Insufficient cpu`, and their Deployments report ready replicas of zero.

You have two ways to fit, and they compose:

**(a) Apply the single-node resource profile.** `components/single-node`
cuts CPU requests to `50m` and memory requests to `192Mi` across every workload
Deployment, and deliberately **leaves limits untouched** — so a service under
real load still bursts exactly as far as before, it just stops reserving idle
headroom it never uses. Verified locally:

|          | Before                | After                         |
| -------- | --------------------- | ----------------------------- |
| Requests | 7.15 cores / 7.88 GiB | **1.70 cores / 6.38 GiB**     |
| Limits   | 18 cores / 18 GiB     | 18 cores / 18 GiB (unchanged) |

Opt in by adding it to `infra/kubernetes/overlays/dev/kustomization.yaml`:

```yaml
components:
  - ../../components/single-node
```

**(b) Drop the observability stack** if you do not need dashboards on day one.
Remove `- observability` from `infra/kubernetes/base/kustomization.yaml`. This
is the single largest saving available and is easy to reverse later.

With (a) applied and observability kept, a box with **8 vCPU / 16 GB** is a
reasonable target. Below 4 vCPU / 8 GB, do not attempt this.

> ⚠️ These are _requests_, not measured usage. No load test has been run against
> this platform, so treat the numbers as a scheduling budget only.

### 1.3 Credentials you will need

| Credential                                                            | Used by                                             | Where to get it                                                 |
| --------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| Contabo API client id/secret + customer user/pass                     | Terraform                                           | <https://my.contabo.com/api/permissions> and Account → Security |
| ~~Cloudflare scoped API token~~ — **not needed**                      | nothing (see § 1.1)                                 | n/a — DNS is hand-managed in the Contabo panel                  |
| Operator SSH keypair                                                  | node access                                         | `ssh-keygen -t ed25519 -f ~/.ssh/tastesee-ops`                  |
| GitHub PAT with `read:packages`                                       | pulling images from ghcr.io                         | GitHub → Developer settings                                     |
| Stripe test keys                                                      | service-accounting, subscription, payouts, identity | Stripe dashboard (test mode)                                    |

Nothing else is strictly required for a first boot. Optional secrets are
deliberately omitted from the k8s Secrets so the owning service starts in stub
mode rather than refusing to boot — that is why, for example, PagerDuty paging
and the ads internal API can be left unconfigured.

---

## 2. Local tooling

```sh
kubectl version --client     # 1.32+ (ships kustomize 5.x)
terraform version            # 1.9+
node --version               # 22 LTS — the seal script is plain node, no deps
kubeseal --version           # v0.38.4, matching base/sealed-secrets/controller.yaml
helm version                 # required: base/ inflates 4 charts
```

`helm` is genuinely required — `base/ingress-nginx`, `base/cert-manager`, and
`base/observability` are Helm-inflated, and `kubectl kustomize` silently emits
their parents without their chart children unless `--enable-helm` is passed and
helm is on `PATH`. A cluster built without it comes up with no ingress
controller at all.

---

## 3. Provision the VPS

```sh
cd infra/terraform/env/dev
cp terraform.tfvars.example terraform.tfvars   # gitignored
$EDITOR terraform.tfvars                       # zone_name, image id, product ids

terraform init
terraform plan -out=dev.tfplan                 # READ THIS before applying
terraform apply dev.tfplan
terraform output -json > /tmp/tf-dev.json
```

> The Contabo provider attribute names in `infra/terraform/modules/` were
> written against the provider's documentation and have **never been run**
> against the live API (this is the open task TS-150-followup-6). Expect the
> first `plan` to surface attribute drift — `contabo_object_storage.s3_url`,
> `ip_config.v4.ip` on `contabo_instance`, and the private-network `add_ons`
> block are the three most likely to have moved. Fix them in the module, do not
> work around them in the root.

Then fetch the kubeconfig k3s generated on the node:

```sh
ssh tastesee-ops@<node-ip> sudo cat /etc/rancher/k3s/k3s.yaml > ~/.kube/tastesee-dev
sed -i "s/127.0.0.1/<node-ip>/" ~/.kube/tastesee-dev
export KUBECONFIG=~/.kube/tastesee-dev
kubectl get nodes
```

---

## 4. Single-node divergences

### 4.1 Ingress node label

NGINX runs as a DaemonSet pinned to nodes carrying an explicit label and taint.
On one box, that box is the edge:

```sh
kubectl label node <node> taste-and-see.io/role-ingress=true
kubectl taint node <node> taste-and-see.io/role-ingress=true:NoSchedule
```

> The taint means _only_ tolerating pods schedule there. On a single-node
> cluster that is every pod you own, so confirm the platform workloads still
> schedule after tainting — if they go `Pending`, remove the taint and keep the
> label. The taint exists to reserve edge nodes in a multi-node cluster; it has
> no useful meaning when there is one node.

### 4.2 Postgres and Redis

The cluster reaches its datastores through two `ExternalName` Services in
`platform-data` — `postgres-primary` and `redis-primary` — that resolve to a
data node on a private VLAN. The base ships them pointing at
`postgres.data.invalid` / `redis.data.invalid` deliberately, so an unpatched
manifest cannot connect to the wrong host.

With one VPS there is no separate data node. Run Postgres 16 and Redis 7 on the
host (outside k3s, via the distribution's packages or docker compose), then:

1. **Point the ExternalName Services at the host.** The `dev` overlay already
   carries JSON patches at `/spec/externalName` for both — set them to the
   host's address.

2. **Widen the egress NetworkPolicy.** This is the step that gets missed.
   `base/data-access/egress-network-policies.yaml` permits egress to
   `10.40.0.0/24` on 5432/6379 only; every namespace is otherwise default-deny.
   If your Postgres is on the node's own IP rather than that VLAN range, add
   an overlay patch widening the `ipBlock` to cover it — **otherwise every pod
   starts, passes its liveness probe, and fails every query**, which reads like
   a credentials problem and is not.

3. **Create one database and role per service.** There are 20 schema-owning
   services and CLAUDE.md §2.3 forbids sharing a schema across bounded
   contexts. Each needs its own database, its own role, and its own
   `DATABASE_URL` in § 5.

> Running the datastore on the same box as the cluster means an OOM in the
> cluster can take the database with it, and there is no replica. That is an
> accepted trade for a dev environment and is not acceptable for production —
> ADR-0001's separate data node exists for this reason.

---

## 5. Secrets

The sealed-secrets controller is installed by the base
(`base/sealed-secrets/`, upstream v0.38.4 vendored). Its private key is
generated in-cluster on first start.

**Back that key up before anything else.** A SealedSecret is decryptable only
by the cluster that sealed it; rebuild the cluster without the key and every
committed SealedSecret becomes permanently unreadable:

```sh
kubectl -n platform-system get secret \
  -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml \
  > sealed-secrets-key-backup.yaml     # gitignored — store in a password manager
```

Then generate the credential set. The key inventory is derived from the
per-service `secret-placeholder.yaml` files, so it cannot drift from what the
pods actually mount — 30 workloads, 133 keys:

```sh
node infra/kubernetes/scripts/seal-secrets.mjs --template > secrets.dev.env
$EDITOR secrets.dev.env
node infra/kubernetes/scripts/seal-secrets.mjs --check --values secrets.dev.env

kubeseal --fetch-cert --controller-namespace platform-system \
  --controller-name sealed-secrets-controller > /tmp/pub-cert.pem

node infra/kubernetes/scripts/seal-secrets.mjs --seal --env dev \
  --values secrets.dev.env --cert /tmp/pub-cert.pem

shred -u secrets.dev.env
```

`--check` runs entirely offline and rejects missing, empty, still-templated,
whitespace-padded, and misspelled entries. Run it before you go looking for the
cluster's public key.

`--seal` writes `overlays/dev/sealed-secrets/` and adds
`components: [./sealed-secrets]` to the overlay. The generated component's
`$patch: delete` directives retire all 30 `secret-placeholder.yaml` Secrets, so
a placeholder can never overwrite a live credential on a later sync. **Commit
the generated directory** — the ciphertext is the artefact that belongs in git.

Grafana's admin login is separate and stays a one-off:

```sh
kubectl -n observability create secret generic grafana-admin \
  --from-literal=admin-user=admin \
  --from-literal=admin-password='<32+ chars>'
```

---

## 6. Container images

Every workload pulls from `ghcr.io/brickagcopra/*`, and the packages are private
until you make them public. Give the cluster a pull secret:

```sh
kubectl -n platform-services create secret docker-registry ghcr \
  --docker-server=ghcr.io --docker-username=<gh-user> --docker-password=<PAT>
# repeat for platform-frontends and platform-workers
```

> The ServiceAccounts do not currently reference an `imagePullSecrets` entry —
> patch the three namespaces' default ServiceAccounts, or make the packages
> public. This is an open gap, listed in § 11.

Images are built and pushed by the per-service GitHub Actions workflows on push
to `main`. Before the first deploy, confirm the workflows have actually run and
that both the service image and its `-migrator` sibling exist for the tag the
overlay pins.

---

## 7. Database migrations

**These now run themselves, and you should know how before the first sync.**

Each of the 20 schema-owning services ships a `migrate-job.yaml`: an ArgoCD
`PreSync` hook at `sync-wave: -10` that runs `prisma migrate deploy` from a
dedicated `<service>-migrator` image. It runs ahead of the pods and ahead of
the wave-0 seed Jobs, injects only `DATABASE_URL` (not the service's whole
Secret), and **a failure aborts the sync** rather than rolling code onto a
schema that did not land.

Two consequences worth internalising:

- **`kubectl apply -k` does not honour hook annotations.** It applies the
  migration Jobs as ordinary resources, concurrently with everything else. If
  you deploy by hand rather than through ArgoCD, apply the Jobs first and wait
  for them (`infra/kubernetes/README.md` § "Order of apply" has the command).
- **The migrator and the service must be on the same tag.** The build workflow
  pushes both under the same `sha-<short-sha>`, and the dev bumper and the
  promotion workflow move both together. Do not pin them apart by hand.

The RBAC catalog seed (`service-identity`) and the plan catalog seed
(`service-subscription`) are separate wave-0 PreSync hooks, and are idempotent.
The long-standing "`pnpm seed:rbac` must re-run on deploy" note in the task
history is handled by that Job — you do not need to run it manually.

---

## 8. ArgoCD

Follow `infra/argocd/README.md`. In summary: install ArgoCD, apply the
AppProjects, then the root app-of-apps for `dev`.

> ArgoCD's repo-server needs read access to this repository. Until the deploy
> key is wired (an open task), **the repo must be public** or the Applications
> will fail to sync with an authentication error. If the repo is private,
> configure a repository credential in ArgoCD before applying the root app.

After the root Application syncs, watch the migration hooks land first:

```sh
argocd app list
kubectl -n platform-services get jobs -l app.kubernetes.io/component=db-migrate
kubectl -n platform-services logs job/service-identity-migrate
```

---

## 9. DNS and TLS

The A records already exist in the Contabo panel and point at the node (§ 1.1).
Nothing creates them for you and Terraform is not involved. What matters here
is that they resolve **publicly**, which today they do not.

Check delegation first — it is the one failure that makes every other symptom
in this section a red herring:

```sh
# What the internet uses. Must list ns1/ns2/ns3.contabo.net, NOT dns-parking.com.
dig +short NS tasteseelife.com @1.1.1.1

# What Contabo actually serves. This has been correct all along.
dig +short A app.tasteseelife.com @ns1.contabo.net

# The two agreeing is the thing you are waiting for.
dig +short A app.tasteseelife.com @1.1.1.1
```

Before re-delegating, **drop every record's TTL to 300** in the Contabo panel.
The apex, `www`, the wildcard and `mail` currently sit at 86400, so a wrong IP
costs you a day; the portal records are already at 3600. Raise them again once
the cutover is stable.

The `dev` overlay uses the **Let's Encrypt staging** issuer, which produces
certificates your browser will not trust. That is intentional — staging has
generous rate limits and dev exists to be rebuilt. Only the `prod` overlay
points at the production issuer.

Both ClusterIssuers solve **HTTP-01** only
(`base/cert-manager/cluster-issuer-letsencrypt.yaml`), so certificate issuance
needs two things and no others: the name must resolve publicly, and port 80
must be reachable from the internet to the ingress controller. At the time of
writing ports 80, 443 and 25 are all closed or filtered on the node — expected
if the cluster is not up yet, but it will block issuance. Check the Contabo
firewall. There is no Cloudflare proxy in this topology, so the "turn the
orange cloud off" advice you will find elsewhere does not apply.

---

## 10. Verify

```sh
kubectl get nodes
kubectl get pods -A | grep -v Running | grep -v Completed   # should be empty
kubectl get jobs -A
kubectl get certificate -A
kubectl get ingress -A

# The portals are the only publicly-reachable surfaces (see § 1.1).
curl -sI https://app.dev.tasteseelife.com
curl -sI https://www.dev.tasteseelife.com

# The gateway has no Ingress — reach it in-cluster.
kubectl -n platform-services port-forward svc/api-gateway 3000:3000 &
curl -s localhost:3000/healthz
curl -s localhost:3000/readyz     # exercises the DB/Redis path
```

A healthy first sync shows all 7 namespaces `Active`, 20 `*-migrate` Jobs
`Complete`, both seed Jobs `Complete`, and 34 Deployments available.

If pods are `Pending`, read § 1.2 — it is a resource-request problem, not a
config problem. If pods are `Running` but `/readyz` returns 503, read § 4.2 —
it is the egress NetworkPolicy or the ExternalName target.

---

## 11. What is not done, and what "verified" means here

**Verified locally (in this repository, without a cluster):**

- All 34 per-service bases and all 3 overlays render with `kubectl kustomize`.
- The 20 migration Jobs render with correct images, namespaces, and the
  wave `-10` PreSync annotations; the dev overlay renders 22 Jobs total.
- The dev bumper's `awk` rewrite moves exactly the service tag and its migrator
  tag, and nothing else — tested against a copy of the real overlay.
- The seal script's inventory, validation (missing / empty / unfilled /
  whitespace / unknown), namespace resolution (21 `platform-services` +
  9 `platform-workers`), and generated component were exercised with stub
  ciphertext: the rendered overlay contained 30 SealedSecrets, 0 placeholder
  Secrets, and 0 `REPLACE_WITH` strings.
- The `single-node` component reduces requests to 1.70 cores / 6.38 GiB and
  leaves limits at 18/18 unchanged.

**Not verified, and only a live run can settle it:**

- **No image has been built from the new `migrator` Dockerfile stage.** Docker
  was not available on the authoring machine. The first CI run for any
  schema-owning service is the real test. The most likely failure is the
  Prisma CLI's engine download in the `migrator-cli` stage.
- **No Helm-inflated base has been rendered** (no local helm), so
  `base/observability`, `base/ingress-nginx`, and `base/cert-manager` are
  CI-confirmed only. `base/sealed-secrets` was deliberately vendored as plain
  YAML partly to escape this.
- **Terraform has never been applied.** See the warning in § 3.
- **No SealedSecret has been produced by real `kubeseal`** — only stubs.

**Known gaps, in rough priority order:**

1. `imagePullSecrets` are not wired into the ServiceAccounts (§ 6).
2. ArgoCD repo credentials are not wired, so the repo must be public (§ 8).
3. There is no `infra/terraform/env/prod` — only `dev` exists.
4. The `platform-data` namespace has no Cassandra or Elasticsearch. Services
   that would use them run in degraded/stub mode; `service-search` in
   particular runs without Elasticsearch.
5. There is no backup or restore procedure for the datastores.
6. The `single-node` component's request values are engineering judgement, not
   measurements — no load test has ever been run against this platform.
