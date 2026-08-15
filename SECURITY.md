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
| Script or attribute content indexed      | HTML is parsed with a tokenizer, not regexes, so raw-text elements and attributes never leak   |
| Credential brute force or timing attack  | Fixed-width keyed HMAC digests, constant-time comparison, pre- and post-auth rate limits       |
| Weak operator-chosen API keys            | Short keys, tiny alphabets and repeated patterns are rejected at startup                       |
| Storage identity disclosure              | Identifiers are corpus-relative; account, container and blob paths never appear in responses   |
| Prompt injection via document content    | Content is returned as evidence; instructions state it is untrusted data, never commands       |
| Resource exhaustion during ingestion     | Depth, entry, document, byte, chunk, term, memory and time budgets, all deployment-configured  |
| Resource exhaustion during search        | Candidate, result and output budgets, deadlines, concurrency caps and a bounded queue          |
| Information disclosure through errors    | One bounded error model; no absolute paths, storage identity, content, queries or stacks       |
| Information disclosure through telemetry | Metrics are safe aggregates; queries and content are never logged                              |
| Stale or silently wrong evidence         | Explicit `degraded` status, index version and timestamp, and truthful skip and limit reporting |
| Serving without a usable corpus          | Readiness requires a validated index; production fails readiness on an empty corpus            |

### Credential hashing

API keys are verified with HMAC-SHA256 under a random per-process pepper, compared in constant time.
A deliberately fast keyed hash is the correct choice here, and a slow password KDF would be worse:

- These are high-entropy machine-generated keys, not human passphrases, and the configuration
  rejects short keys, tiny alphabets and repeated patterns. Generate keys with
  `openssl rand -hex 32`; that generation step, not the validator, is what guarantees strength.
- Digests live only in process memory and are never persisted or logged, so there is no stored-hash
  corpus for an attacker to grind offline — the threat that slow KDFs exist to defeat.
- Verification runs on an unauthenticated request path, so a per-request memory-hard KDF would turn
  the credential check into a CPU-exhaustion amplifier on a small container.

CodeQL's `js/insufficient-password-hash` rule assumes a stored low-entropy password hash. That
premise does not hold here, so the rule is excluded in `.github/codeql/codeql-config.yml` with this
rationale recorded rather than silently suppressed.

### Explicit non-goals

Per-caller authorization within one corpus is **not** supported. All authenticated principals on an
instance share its corpus and its authorization. Separate audiences require separate deployments.

The in-process rate limiter is not a globally consistent quota across replicas.

## Deployment requirements

Enable authentication, store credentials in a secret manager, keep the corpus container private,
grant only container-scoped `Storage Blob Data Reader`, disable shared-key access, and review
dependency and container findings before release.
