# Taste & See — Terraform skeleton (TS-150)

> Phase 1 production-deployment infrastructure on Contabo VPS with
> self-managed k3s, per **ADR-0001**.
> Companion docs: `PDD.md §20`, `PRD.md §11.3`, `CLAUDE.md §3.5 / §17.12`.

This tree is **HCL only**. No `terraform apply` is reachable from a
fresh clone until the operator completes the bootstrap below — by
design (CLAUDE.md §3.5 forbids committed secrets, and Contabo /
Cloudflare API access requires per-environment credentials).

---

## Layout

```
infra/terraform/
├── README.md                          ← this file
├── modules/
│   ├── network/                       ← Contabo private VLAN
│   ├── k3s-cluster/                   ← 3× Cloud VPS L, k3s + embedded etcd HA
│   ├── data-node/                     ← 1× Cloud VPS L, Postgres 16 + Redis 7 + pgBackRest
│   ├── object-storage/                ← Contabo Object Storage instance + buckets
│   └── dns/                           ← Cloudflare zone + A records
└── env/
    └── dev/                           ← env root that composes the modules
        ├── backend.tf                 ← Terraform Cloud workspace
        ├── versions.tf                ← provider + CLI pins
        ├── providers.tf               ← provider configuration
        ├── variables.tf
        ├── main.tf                    ← wires the modules
        ├── outputs.tf
        └── terraform.tfvars.example
```

Staging + prod env roots follow the same shape as `env/dev/` once dev
is proven (TS-150-followup).

---

## Bootstrap (one-time, before first `terraform init`)

The TL;DR sequence:

1. Sign up for Terraform Cloud (free tier) and Contabo + Cloudflare accounts.
2. Create a Cloudflare scoped API token + a Contabo API client + a
   Contabo customer API password.
3. Create a Terraform Cloud workspace, drop in sensitive variables.
4. `terraform login`, then `terraform init && terraform plan`.

Detail follows.

### 1. Terraform Cloud workspace

1. Sign in to [app.terraform.io](https://app.terraform.io/) (free tier
   covers ≤ 5 users).
2. Create an organization named `tastesee` (or change the name in
   `env/dev/backend.tf` to match yours).
3. Create a workspace named `tastesee-dev`:
   - Execution mode: **Remote** (default).
   - Terraform version: a 1.6.x or newer release matching
     `env/dev/versions.tf` `required_version`.
   - VCS connection: not required for the first apply; can be wired to
     a GitHub branch later.
4. In the workspace's **Variables** tab, add the following as
   **sensitive** workspace variables:

   | Key                            | Value                                                 |
   | ------------------------------ | ----------------------------------------------------- |
   | `contabo_oauth2_client_id`     | from Contabo API client                               |
   | `contabo_oauth2_client_secret` | from Contabo API client                               |
   | `contabo_oauth2_user`          | your Contabo customer email                           |
   | `contabo_oauth2_pass`          | your Contabo customer API password                    |
   | `cloudflare_api_token`         | from Cloudflare My Profile → API Tokens               |
   | `operator_ssh_public_key`      | the **public** half of an ed25519 keypair you control |

   And as **non-sensitive** workspace variables:

   | Key               | Value                                                 |
   | ----------------- | ----------------------------------------------------- |
   | `zone_name`       | your Cloudflare apex domain (e.g. `tasteseelife.com`) |
   | `ubuntu_image_id` | Contabo image UUID (see step 3)                       |

### 2. Contabo API credentials

1. Go to [my.contabo.com → API](https://my.contabo.com/api/permissions).
2. Create a new API client. Save the **client ID** + **client secret**.
3. Go to **Account → Security → Customer API Password**. Set it.
   This is NOT your Contabo panel password — it's a separate credential
   for the Contabo public API.

### 3. Cloudflare scoped API token

The provider is configured to use a scoped token, **not** the legacy
global key. Cloudflare My Profile → API Tokens → Create Token →
Custom Token:

- **Permissions**:
  - Zone → Zone → Read
  - Zone → DNS → Edit
- **Zone Resources**:
  - Include → Specific zone → `tasteseelife.com` (your apex)
- **TTL**: leave blank (no expiry) or set a rotation cadence (CLAUDE.md
  §3.5 recommends 180 days for service-account secrets).

### 4. Contabo image UUID

The Ubuntu LTS image UUIDs are not stable across regions. Look them up:

```sh
TOKEN=$(curl -s -d 'client_id=<id>&client_secret=<secret>&username=<user>&password=<pass>&grant_type=password' \
  https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token | jq -r .access_token)

curl -s -H "Authorization: Bearer $TOKEN" \
  -H "x-request-id: $(uuidgen)" \
  https://api.contabo.com/v1/compute/images \
  | jq '.data[] | select(.standardImage == true and (.name | test("Ubuntu 24.04"))) | {id, name, region}'
```

Pick the entry that matches `region == "US-central"` and copy its `id`
into the `ubuntu_image_id` workspace variable.

### 5. Operator SSH key

The operator account is `tastesee-ops`. Generate the keypair locally:

```sh
ssh-keygen -t ed25519 -C "operator@tastesee" -f ~/.ssh/tastesee-ops
```

Store the **private** key (`~/.ssh/tastesee-ops`) where it stays under
your control — Vault personal namespace, password manager, 1Password
ssh-agent, etc. Drop the **public** key (`~/.ssh/tastesee-ops.pub`) into
the `operator_ssh_public_key` workspace variable.

---

## First apply

```sh
cd infra/terraform/env/dev
terraform login                # one-time TF Cloud auth
terraform init                 # downloads providers + initialises remote state
terraform fmt -check -recursive
terraform validate
terraform plan
terraform apply
```

Expected plan: 1 private network + 1 object-storage instance + 4
object-storage buckets + 4 VPS instances (3 k3s + 1 data) + N
Cloudflare records, where N = `len(hostnames)` × `len(ingress_target_ips)`
(default 7 × 3 = 21).

Apply wall-clock is dominated by Contabo's instance-provisioning hop
(~5 min per VPS, in parallel) plus cloud-init bootstrap (~3–4 min for
k3s install, ~5–6 min for the data node's package installs). Plan on
~30 min total.

---

## Validate without TF Cloud credentials

`terraform fmt` and `terraform validate` don't need backend init.
The skeleton's CI gate can run them with:

```sh
cd infra/terraform/env/dev
TF_CLI_ARGS_init="-backend=false" terraform init
terraform fmt -check -recursive
terraform validate
```

Provider plugins still download, but no TF Cloud auth is required.

---

## Post-apply verification

### a. SSH to a cluster node

The Contabo control panel shows each VPS's public IP after apply.
Cross-check with `terraform output k3s_node_public_ips`. Then:

```sh
ssh -i ~/.ssh/tastesee-ops tastesee-ops@<node-0-public-ip>
```

### b. Pull the kubeconfig

```sh
ssh tastesee-ops@<node-0-public-ip> sudo cat /etc/rancher/k3s/k3s.yaml \
  | sed 's/127.0.0.1/<node-0-public-ip>/' > ~/.kube/tastesee-dev
export KUBECONFIG=~/.kube/tastesee-dev
kubectl get nodes
```

Expect three `Ready` nodes with role `control-plane,etcd,master`.

### c. First-boot data-node bootstrap

The data-node cloud-init leaves three `<FILL_IN_OPERATOR>` placeholders.
SSH to `<data-node-public-ip>` as `tastesee-ops`, then:

1. **Postgres role + database**

   ```sh
   sudo -u postgres psql <<'SQL'
     CREATE ROLE tastesee_app LOGIN PASSWORD 'STRONG_PASSWORD_FROM_VAULT';
     CREATE DATABASE tastesee OWNER tastesee_app;
     GRANT ALL PRIVILEGES ON DATABASE tastesee TO tastesee_app;
   SQL
   ```

2. **pgBackRest S3 credentials**

   - Create a Contabo Object Storage S3 access key in the Contabo panel
     scoped to the `<env>-backups` bucket only.
   - Fill in `/etc/pgbackrest/pgbackrest.conf.template`, then:

     ```sh
     sudo mv /etc/pgbackrest/pgbackrest.conf.template /etc/pgbackrest/pgbackrest.conf
     sudo chown postgres:postgres /etc/pgbackrest/pgbackrest.conf
     sudo chmod 0640 /etc/pgbackrest/pgbackrest.conf
     sudo -u postgres pgbackrest --stanza=tastesee stanza-create
     sudo -u postgres pgbackrest --stanza=tastesee --type=full backup
     ```

3. **Redis password**

   - Edit `/etc/redis/redis.conf.d/10-tastesee.conf`, replace
     `<FILL_IN_OPERATOR>` on the `requirepass` line.
   - `sudo systemctl restart redis-server`.

Document the actual values in the team password manager — they don't
belong in Terraform.

### d. Cluster health

```sh
kubectl get nodes -o wide
kubectl get pods -A
kubectl top nodes              # requires metrics-server install (TS-151)
```

---

## DR drill (quarterly, per PDD §20.6)

1. Pick a backup point: `sudo -u postgres pgbackrest --stanza=tastesee info`.
2. Provision a scratch VPS in a different Contabo region (Seattle).
3. Restore from S3:
   ```sh
   sudo -u postgres pgbackrest --stanza=tastesee --type=time \
     --target="2026-05-18 12:00:00" restore
   ```
4. Verify row counts on a curated table set (`subscriptions`, `bookings`,
   `accounting.journals`).
5. Tear down the scratch VPS. Record the drill outcome + RTO actual in
   the team runbook.

---

## Known caveats

- **No managed load balancer.** NGINX Ingress runs in-cluster with
  `hostPort: 443` pinned to one or two edge nodes, fronted by
  Cloudflare. Failover of an edge-pinned node currently requires a DNS
  flip or a keepalived setup. Deferred to a TS-150-followup if uptime
  warrants it.
- **Contabo Private Networking attachment.** Some `contabo` provider
  versions don't expose VLAN attachment as a first-class instance
  argument — the `add_ons` block here is the documented workaround
  (Contabo add-on ID `1477`). If a future provider version exposes
  `private_network_id` directly on `contabo_instance`, prefer that
  over `add_ons`.
- **No BAA from Contabo.** PRD §11.3 + PDD §16.4 require BAA-ready
  architecture for healthcare partner workflows (TS-410, Phase 3).
  Contabo does not sign BAAs. Phase 1 is family-pay marketplace only,
  no PHI; Phase 3 forces a managed-cloud migration. See ADR-0001 for
  the migration trigger.
- **Provider attribute drift.** `contabo_object_storage`'s S3-endpoint
  attribute has been spelled both `s3_url` and `endpoint` across 0.1.x
  releases. The object-storage module wraps the read in a `try()` to
  stay forward-compatible; if you upgrade the provider, run
  `terraform plan` and confirm the endpoint output still resolves.

---

## Follow-ups tracked in `Pending_tasks.md`

- TS-150-followup-1 — Scaffold `env/staging/` and `env/prod/`.
- TS-150-followup-2 — Streaming Postgres replica + automatic failover.
- TS-150-followup-3 — Off-provider backup mirror (Backblaze B2) for prod.
- TS-150-followup-4 — keepalived (or BGP) for ingress-node failover.
- TS-150-followup-5 — Phase 3 migration plan to a BAA-eligible managed
  cloud, triggered by TS-410 entering implementation.
- TS-150-followup-6 — `terraform apply`-time verification once Contabo
  credentials are in TF Cloud (can't be done from a fresh clone).
