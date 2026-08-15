## Summary

<!-- What changed and why? -->

## Validation

- [ ] Formatting, linting, typechecking, tests/coverage, and build pass
- [ ] Container smoke test passes, including readiness against a mounted corpus
- [ ] Bicep builds and lints
- [ ] Metadata and generated OpenAPI are valid and describe only what exists
- [ ] Retrieval evaluation gates pass; ranking changes cite `npm run eval:retrieval` evidence
- [ ] No secrets, corpora, generated indexes, or copied deployment identifiers were added
- [ ] Corpus isolation, read-only behavior, limits, authentication and provenance are not weakened
