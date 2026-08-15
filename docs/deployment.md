# Azure Container Apps deployment example

This example is replaceable hosting scaffolding. It does not add Azure product logic to the tool
server.

## Prerequisites

- Azure CLI with the Bicep CLI installed
- Docker
- permission to create subscription deployments, a resource group, role assignments, and the
  included resources
- a signed-in human user that can be granted Key Vault Secrets Officer during bootstrap
- a selected subscription (`az account set --subscription ...`)

Do not place subscription IDs, tenant IDs, credentials, or generated deployment names in tracked
files.

## Choose a corpus mode first

`corpusSource` is the most important parameter, because **a hosted app deployed with `none` will
never report ready.** That is intentional: an instance without a usable corpus must not accept
traffic.

| Mode         | Use when                                       | Required parameters                              |
| ------------ | ---------------------------------------------- | ------------------------------------------------ |
| `azure-blob` | Hosted corpus maintained separately (default)  | `storageContainerName`, optional `storagePrefix` |
| `filesystem` | Corpus delivered as a read-only mounted share  | `corpusFileShareStorageName`, `docsRoot`         |
| `none`       | Infrastructure only; app intentionally unready | none                                             |

### Blob mode

`infra/modules/storage.bicep` creates a private account with `allowBlobPublicAccess=false` and
`allowSharedKeyAccess=false`, so SAS tokens and account keys cannot be used even by accident. The
app's user-assigned identity receives **Storage Blob Data Reader scoped to the container**, not the
account. The application reads that container through `DefaultAzureCredential` and cannot widen its
own scope.

Upload the corpus separately; this deployment never writes documents.

### Filesystem mode

Create a managed environment storage entry for a read-only Azure Files share, pass its name as
`corpusFileShareStorageName`, and the app mounts it at `docsRoot` (default `/corpus`). The
container never treats `/app` as a corpus.

## Safe two-pass provisioning

```bash
./scripts/bootstrap/provision.sh dev eastus
```

The script:

1. validates and deploys shared resources with `deployApp=false`;
2. prompts for or generates an API key and writes it directly to Key Vault;
3. signs in to the created registry, builds and pushes the image;
4. deploys again with `deployApp=true`.

The first pass prevents Container Apps from repeatedly starting with a missing Key Vault secret. The
second pass adds the app, probes, scale rules, and monitoring after its prerequisites exist.

For automation, set `API_KEY` in the job's protected secret environment and set `IMAGE_TAG` to an
immutable commit SHA. Do not use `latest` for production releases.

## Probes, cold indexing, and replicas

Liveness uses `/health`, which only reports that the process is running. Readiness uses `/ready`,
which requires a validated, non-empty index. The readiness probe allows a generous failure threshold
so a large corpus can finish its first build before traffic arrives.

`minReplicas` defaults to **1** so readiness is predictable. With `minReplicas=0`, every cold start
re-enumerates and re-indexes the entire corpus before the first request succeeds; the delay scales
with corpus size. Choose scale-to-zero only if that latency is acceptable.

## Limits and capacity

The container defaults to 0.25 CPU and 0.5 GiB, and the default ingestion budgets are sized to fit
that envelope. If you raise `corpusMaxDocuments`, `corpusMaxTotalBytes` or `indexMaxChunks`, raise
`containerCpu` and `containerMemory` with them — the index is held in memory.

`corpusRefreshIntervalMs` bounds background refresh; `0` disables it. `searchMaxConcurrent`,
`searchQueueLimit` and `searchTimeoutMs` bound request handling.

## Preserving parameters across releases

`infra/parameters/dev.bicepparam` is the record of a deployment's corpus source, scope, refresh
interval, limits, replica settings, and tags. Deploy from a parameter file rather than ad-hoc
`--parameters` flags, so a later release cannot silently reset the corpus boundary or the budgets.

Copy it per environment and keep account-specific values out of the repository.

## Identity, secrets, and alerts

The Container App uses a user-assigned managed identity to pull from ACR, read the Key Vault secret,
and read the corpus container. No registry password, API key, or storage key is embedded in Bicep.

The interactive bootstrap user receives Key Vault Secrets Officer so it can seed and rotate the
secret. Remove that assignment after handoff if a separate deployment identity manages rotation.

Set `alertActionGroupId` to route server-error alerts to an existing action group. Configure
receivers in your organization rather than committing personal addresses.

## Operations

Rotate the API key by adding the replacement to `API_KEYS`, deploying, moving clients, then removing
the old key. Key Vault references are versionless; create a new revision or restart replicas after
rotation.

Destroy the example by deleting its generated resource group after confirming it contains no shared
resources.
