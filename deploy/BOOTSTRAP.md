# Arcadia relay deployment candidate

This is a candidate for dev-ai first, then a separately reviewed prd-ai
promotion. As of the 2026-10-20 inventory, neither account has the Buzz ECR
repositories or SSM parameters, and neither GitOps branch has a Buzz
Application. The earlier Buzz deployment PR and CCI PRs were closed unmerged.
Passing the local checks below does not mean the relay has been deployed.

## Source and render validation

The wrapper packages upstream chart 0.1.11 unchanged, including its locked
optional postgres/redis dependencies. Private Argo rendering consumes the
committed `charts/buzz-0.1.11.tgz`; it does not need Docker Hub or GHCR.
When upstream changes, regenerate with
`python deploy/scripts/package-arcadia-chart.py`, review the archive and lock,
then run:

```sh
python deploy/scripts/test-arcadia-chart.py
python deploy/scripts/test-ecr-release-plan.py
python deploy/scripts/test-provision-secrets.py
```

These use real Helm renders of both dummy environment files
(`charts/buzz-arcadia/ci/*-values.example.yaml`) and reject zero identity/image
placeholders, missing rollout metadata, incorrect registry/host wiring, and
unsupported bundled services; the last drives `provision-secrets.sh` against
stub `aws`/`buzz-admin` binaries, so it needs bash and openssl but no AWS
access. They require Helm 3.14 and Python 3.12 with PyYAML 6.0.3. Test identities and image tags are synthetic and must not be used
in an Application.

## Environment records are private

This repository is public. Real account ids, subnets, CIDRs, certificate ARNs,
hosts and SSM prefixes live only in `cloud-config-infrastructures`, per cluster
branch: `<cluster dir>/global-helm-values-patch.yaml` (cluster globals) and
`<cluster dir>/buzz/values.yaml` (this chart's values). See the
[chart README](charts/buzz-arcadia/README.md#environment-records). Point the
tools at a checkout of the cluster's branch:

```sh
BUZZ_ENV_DIR=<cci>/preprd/dev-ai python deploy/scripts/test-arcadia-chart.py
deploy/scripts/provision-secrets.sh --verify dev-ai --env-dir <cci>/preprd/dev-ai
```

## Infrastructure and publication

Use the existing Arcadia infrastructure review process to provision, in the
accounts named by each cluster's private `global-helm-values-patch.yaml`:

- dev-ai: `buzz/relay` and `buzz/relay-buildcache` ECR repositories, plus a
  GitHub OIDC role for this repository's main ref.
- prd-ai: `buzz/relay` and its corresponding OIDC role.
  Scope each role to its own account/repositories and deny repository creation.
- The reviewed relay SSM values and operator key custody described in
  [PREFLIGHT.md](charts/buzz-arcadia/PREFLIGHT.md). Verify the current bridge
  ExternalSecret inventory separately in `aria-frontend`; the restored bridge
  runbook is not proof that its consumer contract has stayed unchanged.
- Existing cluster prerequisites: Crossplane RDS composition/provider,
  External Secrets and the SSM store, AWS load balancer controller, VPC CNI
  policy enforcement, private DNS/ACM certificate, and the in-account Redis
  mirror. Confirm the referenced subnet/certificate IDs before applying.

No new AWS account, cluster, or custom control plane is required by this
candidate. These missing repositories, credentials, parameters, and Application
records are still real deployment prerequisites.

Only after the roles exist, set four repository **secrets** (not variables:
variable values print unmasked in this public repository's run logs):
`AWS_ACCOUNT_ID_DEV_AI` and `AWS_ACCOUNT_ID_PRD_AI` from the private records,
and `ECR_ROLE_ARN_DEV_AI` and `ECR_ROLE_ARN_PRD_AI`. The workflow's plan job
rejects a role outside its environment's account. Keep
`BUZZ_ECR_PUBLISH_ENABLED` unset until the first publication has been
verified. After this workflow is merged to main:

```sh
# Assumes the two roles and only describes the required ECR repositories.
# No image is built, pushed, or deployed.
gh workflow run build-and-push-ecr.yml --repo arcadia/buzz --ref main \
  -f mode=preflight -f deploy_dev=false

# Explicit first publication after successful preflight.
gh workflow run build-and-push-ecr.yml --repo arcadia/buzz --ref main \
  -f mode=publish -f deploy_dev=false
```

The publish run builds one linux/amd64 image from its exact workflow SHA and
pushes `main-<first 10 SHA characters>` to both account registries; the run
summary gives the digest. Check both registries for that tag and record the
digest on the rollout ticket before creating the Application. Authentication,
repository lookup, build, or push errors fail the job; a read-only preflight
never claims publication.
Setting `BUZZ_ECR_PUBLISH_ENABLED=true` later enables publication on relevant
main pushes. With it unset, main performs local validation and explicitly
reports that no publication was attempted.

## First GitOps rollout and ARIA connection

Prepare new CCI changes against current `ai-dev` and `ai`; do not reopen the
stale closed deployment branches. Use the `deploy/charts/buzz-arcadia` path from
the reviewed Buzz revision, the published image tag, actual owner public key,
and rollout ticket. Preserve cluster-injected globals. Render the composed
private record plus a reviewed values file as shown in the
[chart README](charts/buzz-arcadia/README.md).

Create the relay Application and namespace wiring before the separate ARIA
bridge Application. The relay gets only its own Secret; bridge agent identities
and ARIA service credentials remain in the bridge's Secret. Verify the current
bridge chart's relay URL, roster/enrollment flow, secret keys, and authorization
configuration together with its producer before rollout. Run
[SMOKE.md](charts/buzz-arcadia/SMOKE.md) after dev sync and attach results to the
ticket. RDS provisioning and ESO composition must finish before relay health
can pass. The privacy review is internal, in `aa-product-docs`
(`agent-platform/harness/decisions/2026-10-20-buzz-relay-privacy-review.md`),
and remains unsigned; prd cannot go live without its sign-off.

Automatic dev image bumps are separately disabled. Only after the reviewed
Application exists and the repository-manager GitHub App is installed on CCI,
configure its two secrets and opt in with `BUZZ_DEV_GITOPS_ENABLED=true`, or
dispatch publish with `deploy_dev=true`. A missing Application or superseded
source SHA fails the requested deployment; it does not claim success. The
workflow never promotes prd. Production requires its own CCI PR, approved ACM
change, SRE review, and a deployer distinct from the implementer.
