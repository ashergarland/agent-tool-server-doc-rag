# Agent Tool Server Doc RAG

Bounded lexical retrieval over **one** documentation corpus, exposed through stdio MCP, stateless
Streamable HTTP MCP, and HTTP/OpenAPI.

**This server retrieves evidence. The caller generates the answer.** It returns the smallest set of
relevant, cited chunks instead of whole documents, so an agent can ground a response without loading
an entire documentation set into its context window.

## What it deliberately does not do

It has no generation, no embeddings, no vector database, no web search, no arbitrary URL fetching,
no uploads, no document management, and no mutation of any kind. There is exactly one read-only
tool. If you need any of the above, this is the wrong component.

## Included contract

| Method            | Path                | Authentication | Purpose                                       |
| ----------------- | ------------------- | -------------- | --------------------------------------------- |
| `GET`             | `/health`           | Public         | Liveness only; ignores index state            |
| `GET`             | `/ready`            | Public         | Readiness; requires a usable configured index |
| `GET`             | `/version`          | Public         | Build and capability metadata                 |
| `GET`             | `/openapi.json`     | Public         | OpenAPI 3.1 generated from the registry       |
| `GET`             | `/tools`            | Required       | Tool catalogue, routing instructions, schemas |
| `GET`             | `/metrics`          | Required       | Safe aggregate counters                       |
| `POST`            | `/tools/{toolName}` | Required       | Invoke one registered tool                    |
| `GET/POST/DELETE` | `/mcp`              | Required       | Stateless Streamable HTTP MCP                 |

[`src/tools/definitions.ts`](src/tools/definitions.ts) is the single source of truth. Zod schemas
drive runtime validation, MCP registration, JSON Schema, and OpenAPI operations. Do not define
transport-specific tool lists.

## Breaking change before 1.0

`search_local_docs` is now **`search_docs`**. The old name is gone, not aliased. The rename is
deliberate: hosted corpora are not local, so the previous name described the deployment incorrectly.
This project is pre-1.0 and this break is not backwards compatible. Update any caller, registry
entry, or prompt that referenced `search_local_docs`.

The response shape also changed. It is no longer a bare `{ results }` array; every response now
carries retrieval status, corpus identity, counts, truncation and warnings.

## Architecture

```text
stdio MCP | Streamable HTTP MCP | HTTP OpenAPI
                      |
                 ToolRegistry            (one tool, one schema, all transports)
                      |
           DocumentationSearchService     (thresholds, dedup, diversity, budgets, deadline, queue)
                      |
                 IndexManager             (states, atomic swap, last-good, refresh, cancellation)
                      |
     ingestion -> chunking -> inverted index (BM25 / TF-IDF)
                      |
                 CorpusSource             (FileSystemCorpusSource | AzureBlobCorpusSource)
```

- Transports contain no retrieval or corpus logic.
- The corpus port, index lifecycle, and measurement helpers contain no ranking-specific code.
- One process serves exactly one corpus and one authorization boundary.

## The one-corpus boundary

A process indexes one filesystem root **or** one private Blob container prefix. Every authenticated
principal on a hosted instance shares that corpus and its authorization. There are no per-caller
ACLs and no caller-selected containers.

If two audiences must not see the same documents, run two deployments. Do not attempt to partition
one instance.

## Local use with VS Code and Copilot

Node.js 22 is required.

```bash
npm ci
npm run build
```

Register the stdio server, pointing `DOCS_ROOT` at the directory you want indexed:

```json
{
  "servers": {
    "doc-rag": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/agent-tool-server-doc-rag/dist/mcp/stdio.js"],
      "env": {
        "CORPUS_SOURCE": "filesystem",
        "DOCS_ROOT": "/absolute/path/to/your/docs"
      }
    }
  }
}
```

Local stdio runs with authentication disabled because the client process boundary is the security
boundary. It never listens on a network port.

For HTTP during development:

```bash
cp .env.example .env
npm run dev
```

API-key mode requires a generated hex key. An optional non-secret label such as `prod_` is allowed
so keys are identifiable in logs; anything a human could have typed is rejected at startup:

```bash
API_KEY="$(openssl rand -hex 32)"
AUTH_MODE=api-key API_KEYS="$API_KEY" DOCS_ROOT=./docs npm run dev
curl -H "x-api-key: $API_KEY" http://localhost:8080/tools
```

## Hosted use with Azure Blob Storage

Set the corpus from deployment configuration only:

```bash
CORPUS_SOURCE=azure-blob
AZURE_STORAGE_ACCOUNT_NAME=yourcorpusaccount
AZURE_STORAGE_CONTAINER=corpus
AZURE_STORAGE_PREFIX=docs/
```

The container must be private, and the app's managed identity needs **Storage Blob Data Reader
scoped to that container** — not to the account or subscription. Connection strings, SAS tokens and
account keys are rejected at startup; supplying one is a configuration error, not a fallback.

## Source formats

Markdown, plain text, HTML, JSON, YAML, and common source code. Formats that cannot be segmented
reliably (PDF, Office documents, images, archives) are skipped rather than guessed at.

Ignored by default: `.git`, `node_modules`, caches, build output, hidden entries, and common secret
files such as `.env`, `*.pem`, and `*credentials*`. Symbolic links, traversal, absolute paths and
control characters never enter the index.

## Indexing, refresh, and cold starts

The index builds asynchronously at startup; the process is live immediately but not ready until a
usable index exists. Candidate indexes are validated and swapped in atomically, and a failed refresh
keeps serving the last good index while reporting `degraded`.

Filesystem corpora use debounced watching plus bounded reconciliation; Blob corpora poll a bounded
metadata manifest. `CORPUS_REFRESH_INTERVAL_MS=0` disables background refresh. There is no
model-facing refresh tool — refresh is an operational concern.

Use `minReplicas=1` for predictable readiness. With scale-to-zero, every cold start re-reads and
re-indexes the corpus, so the first request after idle waits for a full build.

## Ranking, scores, and limits

BM25 is the default because it wins the committed evaluation, not by preference. Scores are
normalized to the share of attainable evidence, so one threshold behaves consistently regardless of
corpus size:

| Threshold | BM25 recall@5 | BM25 nDCG@5 | TF-IDF recall@5 | TF-IDF nDCG@5 |
| --------- | ------------- | ----------- | --------------- | ------------- |
| 0.10      | 1.000         | 0.968       | 1.000           | 0.968         |
| **0.20**  | **1.000**     | **0.936**   | 1.000           | 0.936         |
| 0.30      | 1.000         | 0.936       | 0.917           | 0.852         |
| 0.40      | 0.917         | 0.852       | 0.833           | 0.801         |

Neither algorithm produced a false positive on the no-match cases at any threshold. BM25 holds
perfect recall from 0.10 through 0.35, while TF-IDF starts degrading at 0.30, so BM25 is the default
and `SEARCH_MIN_SCORE` defaults to the middle of the stable band. Reproduce with
`npm run eval:retrieval`, and set `SEARCH_ALGORITHM=tfidf` to switch.

**A score is the share of the query's attainable lexical evidence that a chunk carries, from 0 to

1. It is not a probability, not a confidence, and not a correctness signal.** Because scoring is
   normalized per query, scores are not comparable across different queries.

This is lexical retrieval with light inflection folding, so "rotate the key" matches a "Rotating
keys" heading. It matches words, identifiers and their case variants — not meaning. A query using
entirely different vocabulary than the corpus will legitimately return `no_match`. Retrieval quality
degrades on corpora where every document repeats the same terms.

## Provenance and citations

Every result carries a stable chunk ID, a corpus-relative source, the heading hierarchy, and a
`startLine`/`endLine` range. Cite that range. Absolute paths and storage identity are never
returned.

Results are deduplicated, adjacent chunks are merged, and per-source diversity is capped so one
document cannot crowd out the rest.

## Interpreting status

| Status        | Meaning                                                             |
| ------------- | ------------------------------------------------------------------- |
| `ok`          | Usable evidence was found                                           |
| `no_match`    | Nothing passed the relevance threshold; the corpus may not cover it |
| `degraded`    | Results may be stale or the search was cut short by a deadline      |
| `unavailable` | No usable index exists; no evidence can be returned                 |

`no_match` and `unavailable` are different failures. The first means the corpus does not answer the
question; the second means the corpus could not be consulted at all. Never treat either as an
answer.

## Security defaults

- Production refuses `AUTH_MODE=disabled` and rejects a relative or application-directory
  `DOCS_ROOT`.
- API keys must be hex encoding at least 32 random bytes, exactly what `openssl rand -hex 32`
  produces. This is a format contract, not a strength score: the server has no passwords, and a key
  that a human could have typed is rejected at startup. Keys are compared as fixed-width keyed HMAC
  digests, and only non-reversible fingerprints are retained.
- HTML is parsed with a tokenizer rather than regexes, so script, style and attribute content never
  reaches the index.
- Authentication is rate-limited before and after credential verification.
- Blob access is managed identity only, container-scoped and read-only.
- Errors never expose absolute paths, storage identity, corpus content, queries, or stacks.
- Queries and document content are never logged; metrics are safe aggregates only.
- The runtime container runs as the unprivileged `node` user and treats `/app` as code, never a
  corpus.

**Returned content is untrusted.** A corpus document can contain text that looks like instructions.
Treat every result as data. See [SECURITY.md](SECURITY.md) for the threat model.

The in-process limiter suits scale-to-zero instances but is not a globally consistent quota. Put a
distributed gateway in front of the service if callers need a cross-replica quota.

## Configuration

See [`.env.example`](.env.example) for every variable and its default. Requests can never raise a
configured ceiling.

## Troubleshooting

| Symptom                              | Cause                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `/ready` returns 503 forever         | No corpus configured, the root is missing, or the identity lacks the container role       |
| Ready but every search `no_match`    | The corpus is empty, all files were skipped, or the vocabulary genuinely differs          |
| `status: degraded`                   | A refresh failed and the last good index is still serving, or the search hit its deadline |
| `warnings: ingestion_limits_reached` | The corpus exceeded a configured budget and the index is partial                          |
| Documents missing from results       | Unsupported extension, oversized, empty, duplicate, binary, or an ignored path            |
| First request after idle is slow     | Scale-to-zero cold start rebuilding the index; use `minReplicas=1`                        |

`GET /ready` reports index state, counts and skip totals, which is the fastest way to distinguish
these.

## Privacy

Corpus content never leaves the process except as search results to an authenticated caller. There
is no external embedding API, no telemetry of query text, and no content in logs or metrics.

## Deployment

Follow [`docs/deployment.md`](docs/deployment.md). The Azure Container Apps example uses a
user-assigned managed identity, private storage, Key Vault references, and a two-pass bootstrap. It
is an example, not an implied Azure dependency.

## Validation

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run openapi:emit
npm run metadata:validate
npm run eval:retrieval
docker build -t agent-tool-server-doc-rag .
az bicep build --file infra/main.bicep
az bicep lint --file infra/main.bicep
```

CI additionally smoke-tests the container against a mounted read-only corpus, verifies that a
missing corpus stays not-ready, checks non-root execution, compiles every Bicep entry point, audits
production dependencies, scans for secrets, and runs CodeQL.

## Metadata

`server.json` describes only what exists. It advertises no npm package and no remote endpoint,
because neither is published. Add them when they are real; `npm run metadata:validate` rejects
placeholder endpoints and a package identifier that contradicts a private manifest.

## License

MIT
