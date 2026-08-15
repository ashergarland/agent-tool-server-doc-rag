# Security

Report vulnerabilities privately through GitHub Security Advisories for this repository. Do not open
a public issue for an undisclosed vulnerability.

## Threat model

This server is a read-only retriever over one bounded corpus. It has no write path, no generation,
and no outbound fetching, which removes entire vulnerability classes by construction.

### Assets

The corpus content, the API keys, the hosting identity's Blob permissions, and the availability of
the index.

### Trust boundaries

1. **Caller to server.** Callers are authenticated but not trusted. Every input is validated and
   bounded at the registry boundary.
2. **Corpus to server.** Corpus content is **untrusted data**. It is indexed and returned, never
   interpreted.
3. **Server to storage.** The server holds container-scoped, read-only Blob permissions and cannot
   widen them at runtime.

### Threats and mitigations

| Threat                                   | Mitigation                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Path traversal or corpus escape          | Canonical root, `realpath`, symlink rejection, traversal and control-character rejection       |
| Secret exfiltration through the corpus   | Hidden files, `.env`, key/certificate and `*credentials*` patterns are never indexed           |
| Credential brute force or timing attack  | Fixed-width keyed HMAC digests, constant-time comparison, pre- and post-auth rate limits       |
| Storage identity disclosure              | Identifiers are corpus-relative; account, container and blob paths never appear in responses   |
| Prompt injection via document content    | Content is returned as evidence; instructions state it is untrusted data, never commands       |
| Resource exhaustion during ingestion     | Depth, entry, document, byte, chunk, term, memory and time budgets, all deployment-configured  |
| Resource exhaustion during search        | Candidate, result and output budgets, deadlines, concurrency caps and a bounded queue          |
| Information disclosure through errors    | One bounded error model; no absolute paths, storage identity, content, queries or stacks       |
| Information disclosure through telemetry | Metrics are safe aggregates; queries and content are never logged                              |
| Stale or silently wrong evidence         | Explicit `degraded` status, index version and timestamp, and truthful skip and limit reporting |
| Serving without a usable corpus          | Readiness requires a validated index; production fails readiness on an empty corpus            |

### Explicit non-goals

Per-caller authorization within one corpus is **not** supported. All authenticated principals on an
instance share its corpus and its authorization. Separate audiences require separate deployments.

The in-process rate limiter is not a globally consistent quota across replicas.

## Deployment requirements

Enable authentication, store credentials in a secret manager, keep the corpus container private,
grant only container-scoped `Storage Blob Data Reader`, disable shared-key access, and review
dependency and container findings before release.
