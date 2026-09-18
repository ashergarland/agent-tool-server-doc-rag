# Security

Report vulnerabilities privately through GitHub Security Advisories for this repository. Do not
open a public issue for an undisclosed vulnerability.

## Threat model

Doc RAG is a read-only retriever over one bounded corpus. It has no generation, upload, arbitrary
outbound fetch, or mutation path.

### Assets and trust boundaries

Assets are corpus content and the availability and integrity of the index.

1. **Caller to capability.** The local stdio caller is inside the invoking user's process and
   operating-system trust boundary. Inputs are still schema-validated and bounded by Platform.
2. **Corpus to capability.** Corpus content is untrusted data. It is indexed and returned, never
   interpreted as instructions.
3. **Capability to storage.** Filesystem reads stay beneath one canonical root.

### Threats and mitigations

| Threat                                   | Mitigation                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| Path traversal or corpus escape          | Canonical root, symlink rejection, traversal/control-character rejection                    |
| Secret exfiltration through the corpus   | Hidden, environment, key/certificate, and credential-like files are never indexed           |
| Script or attribute content indexed      | A single-pass HTML tokenizer excludes raw-text elements and attributes                      |
| Prompt injection via document content    | Returned text is explicitly untrusted evidence, never commands                              |
| Resource exhaustion during ingestion     | Bounded depth, entries, documents, bytes, concurrency, chunks, terms, memory, and time      |
| Resource exhaustion during retrieval     | Bounded candidates, output, deadlines, concurrency, and queue depth                         |
| Storage identity disclosure              | Results use corpus-relative identifiers; account/container/absolute paths are never exposed |
| Information disclosure through errors    | Platform projects one bounded transport-safe error shape                                    |
| Information disclosure through telemetry | Queries, content, and corpus paths are never logged; metrics are safe aggregates            |
| Stale or silently wrong evidence         | Explicit degraded status, last-good retention, index version, timestamp, skips, and limits  |
| Process alive without useful retrieval   | Domain readiness requires a validated non-empty index; tool status explains not-ready       |

## Profiles

The public profiles are local package profiles only. There is no hosted service, container image,
remote endpoint, or capability-owned cloud infrastructure.

The filesystem profile inherits the invoking user's permissions and reads only beneath
`DOCS_ROOT`.

## Explicit non-goals

Per-caller authorization within one corpus is not supported. Separate audiences require separate
processes and corpus boundaries.

Doc RAG does not sanitize or optimize documents. Document Optimizer owns document preparation;
callers remain responsible for the trust and quality of corpus contents.
