# Agent Tool Server Doc RAG

Bounded lexical retrieval over one configured documentation corpus, packaged as a thin
[Agent Tool Platform](https://github.com/ashergarland/agent-tool-platform) capability.

**Doc RAG retrieves evidence; the caller generates the answer.** It returns the smallest relevant
passages with citations instead of loading whole documents into an agent context.

## Deliberate boundaries

This capability has no generation, embeddings, vector database, web search, arbitrary URL fetch,
upload, document-management, or mutation path. It exposes one read-only tool: `search_docs`.

Document Optimizer and Doc RAG remain separate:

- Document Optimizer prepares agent-native documents and representations.
- Doc RAG indexes an already prepared corpus and retrieves relevant portions.

This migration does not absorb document preparation or introduce a new ingestion product.

## D4 architecture

```text
Agent Tool Platform stdio / HTTP / MCP / OpenAPI
                         |
                    search_docs
                         |
           DocumentationSearchService
      thresholds | diversity | budgets | deadlines
                         |
                   IndexManager
       atomic swap | last-good | refresh | readiness
                         |
       ingestion -> chunking -> lexical index
                    BM25 / TF-IDF
                         |
                 filesystem corpus source
```

The capability owns corpus policy, adapters, ingestion, chunking, scoring, retrieval selection,
provenance, index lifecycle, and corpus readiness. Platform owns application assembly, generic
configuration, authentication, HTTP/MCP transports, OpenAPI, error projection, rate limiting,
logging, readiness aggregation, shutdown, conformance, metadata validation, packaging workflows,
security workflows, and release mechanics.

The integration is pinned to:

- D4 template `db42b31a16ba0fa41066edac331b71497b3a9c8c`
- Agent Tool Platform `98ec8162fb11d5c04aee9e6f7b3625a472a0180d`
- `@agent-tool-platform/runtime` and `@agent-tool-platform/testkit` `0.1.2`

## Run the capability

Node.js 22 or newer is required. CI and deployment-contract checks use Node.js 22.

```bash
npm ci
npm run build
```

Point `DOCS_ROOT` at an existing corpus and run the stdio entrypoint:

```bash
CORPUS_SOURCE=filesystem DOCS_ROOT=/absolute/path/to/docs npm run mcp:stdio
```

For VS Code or another MCP client, launch the installed executable and provide the same environment:

```json
{
  "servers": {
    "doc-rag": {
      "type": "stdio",
      "command": "agent-tool-doc-rag",
      "env": {
        "CORPUS_SOURCE": "filesystem",
        "DOCS_ROOT": "/absolute/path/to/docs"
      }
    }
  }
}
```

Stdio is a local process boundary. It opens no network listener and Platform disables network
authentication for this entrypoint.

## Truthful profiles

[`capability-profiles.json`](capability-profiles.json) declares one `local-filesystem-package`
profile. It reads a caller-selected local corpus root through the local stdio process boundary.

There is no hosted profile, container image, or capability-owned cloud infrastructure. A supported
data source is not evidence of a deployed hosted service. Hosted execution can be added only with a
real corpus source, authenticated access, deployment evidence, rollback, and a profile that
truthfully models those requirements.

## Corpus and index lifecycle

One process serves one corpus and one authorization boundary. The index builds asynchronously:

1. bounded metadata enumeration and reads;
2. format-aware, provenance-preserving chunking;
3. immutable lexical-index construction;
4. validation and atomic swap;
5. background filesystem watch or bounded metadata reconciliation when configured.

A failed refresh preserves the last validated index and reports `degraded`. A first build failure
reports not-ready and cannot return evidence.

### Liveness is not retrieval readiness

Platform process lifecycle state and corpus readiness are intentionally distinct. A process may be
alive while the index is building, absent, empty, or failed.

The `corpus-index` readiness contributor reports:

| Index condition                    | Readiness   | Retrieval behavior                                |
| ---------------------------------- | ----------- | ------------------------------------------------- |
| validated non-empty current index  | `ready`     | `status: ok` or `no_match`, depending on evidence |
| last-good index after refresh fail | `degraded`  | `status: degraded` with `stale_index`             |
| build in progress                  | `not_ready` | `status: unavailable` with `index_building`       |
| no configured corpus               | `not_ready` | `status: unavailable` with `index_not_configured` |
| empty index                        | `not_ready` | `status: no_match` with `corpus_empty`            |
| failed first build                 | `not_ready` | `status: unavailable` with a safe corpus warning  |

Not-ready responses are deterministic and model-visible. The capability never returns a
success-shaped empty result merely because its process started.

## Source formats and admission policy

Markdown, plain text, HTML, JSON, YAML, and common source-code formats are supported. PDF, Office
documents, images, archives, binary data, and formats that cannot be segmented reliably are
skipped.

Ignored by policy include hidden entries, `.git`, dependency/build/cache directories, `.env`,
private keys, certificates, and credential-like file names. Filesystem roots are canonicalized;
symbolic links, traversal, absolute result identifiers, control characters, and root escapes never
enter the index.

## Chunking, ranking, and limits

Chunking follows headings, paragraphs, structured-data members, and source declarations while
preserving source-relative line ranges. Over-long text splits on Unicode grapheme boundaries.

BM25 is the default because it wins the committed deterministic evaluation. TF-IDF remains
available. Scores are normalized to a `0..1` share of attainable lexical evidence so one threshold
is useful across corpus sizes.

| Threshold | BM25 recall@5 | BM25 nDCG@5 | TF-IDF recall@5 | TF-IDF nDCG@5 |
| --------- | ------------- | ----------- | --------------- | ------------- |
| 0.10      | 1.000         | 0.968       | 1.000           | 0.968         |
| **0.20**  | **1.000**     | **0.936**   | 1.000           | 0.936         |
| 0.30      | 1.000         | 0.936       | 0.917           | 0.852         |
| 0.40      | 0.917         | 0.852       | 0.833           | 0.801         |

A score is not probability, confidence, or correctness. Queries made only of common terms do not
create evidence, and the service returns `no_match` when nothing clears the configured threshold.

Ingestion bounds depth, directory entries, documents, per-document bytes, total bytes, concurrent
reads, chunks, terms, estimated index memory, and build time. Retrieval bounds candidates, results,
results per source, per-result and total characters, concurrency, queue depth, and execution time.
Requests cannot raise these ceilings.

## Provenance and insufficient context

Every result carries:

- a stable opaque chunk ID;
- a corpus-relative source;
- heading hierarchy and nearest section;
- `startLine` and `endLine`;
- bounded content, score, and truncation state.

Absolute filesystem paths and storage identity are never returned. Cite the source and line range
for every claim.

Statuses have distinct meanings:

| Status        | Meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| `ok`          | Usable evidence was found                                        |
| `no_match`    | The available corpus does not supply sufficient lexical evidence |
| `degraded`    | Evidence may be stale or retrieval hit a deadline                |
| `unavailable` | No usable index could be consulted                               |

Never treat `no_match` or `unavailable` as an answer.

## Benchmark fixture

[`tests/fixtures/benchmark-corpus/operations-runbook.md`](tests/fixtures/benchmark-corpus/operations-runbook.md)
contains the Level 2 runbook evidence for:

- the runtime port/configuration contract;
- TCP readiness semantics;
- why an HTTP `/health` to `/healthz` route rename is not causal for a TCP probe.

[`tests/retrieval/benchmark.test.ts`](tests/retrieval/benchmark.test.ts) proves bounded retrieval with
source and line provenance and separately proves `no_match` when the configured corpus lacks the
required evidence. The conclusions live only in the corpus fixture, not in ranking or retrieval
code.

Run it with:

```bash
npm run test:benchmark
```

## Security and privacy

Corpus content is untrusted data. It is indexed and returned, never executed or interpreted.
Instructions embedded in documents remain inert evidence. Queries and content are not logged, and
capability metrics contain safe aggregates only.

The filesystem profile relies on the invoking user's operating-system permissions. See
[`SECURITY.md`](SECURITY.md).

## Validation

Normal repository checks:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run openapi:emit
npm run metadata:validate
npm run eval:retrieval
npm run test:benchmark
npm run package:smoke
npm audit --omit=dev --audit-level=high
```

Deployment validation uses the exact Platform source revision rather than copying its schema:

```bash
git clone https://github.com/ashergarland/agent-tool-platform.git ../agent-tool-platform
git -C ../agent-tool-platform checkout --detach 98ec8162fb11d5c04aee9e6f7b3625a472a0180d
npm --prefix ../agent-tool-platform ci
npm --prefix ../agent-tool-platform run build

AGENT_TOOL_PLATFORM_CHECKOUT=../agent-tool-platform npm run deployment:validate
AGENT_TOOL_PLATFORM_CHECKOUT=../agent-tool-platform npm run deployment:conformance
```

`npm run package:smoke` builds and packs the real package, installs it into a temporary external
consumer, retrieves cited evidence from a disposable corpus, and verifies deterministic
not-configured behavior from a second packaged process. It publishes nothing and removes its
temporary files.

## Release metadata

Source keeps package and server metadata at `0.0.0-development`. Stable `vX.Y.Z` tags are the
authoritative versions; the pinned shared Platform release workflow stamps metadata only on its
runner. No package, release, deployment, or remote endpoint is created by repository validation.

## License

MIT
