# Troubleshooting

## Readiness stays at 503

A readiness probe keeps failing when the corpus directory is missing, empty in production, or when
the managed identity lacks the container role assignment.

## Searches return no_match

The lexical threshold rejected every candidate. Retry with a distinctive identifier, an exact error
string, or a heading from the document you expect.

## Results look stale

A degraded status means the last refresh failed and the previous index is still serving evidence.
