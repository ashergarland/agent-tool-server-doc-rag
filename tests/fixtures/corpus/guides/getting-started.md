# Getting started

This guide explains how to install the retrieval server and point it at a corpus.

## Install the server

Run `npm ci` to install dependencies and `npm run build` to compile the TypeScript sources into
`dist`. Node.js 22 is required.

## Configure the corpus root

Set `DOCS_ROOT` to the directory that holds your documentation. The server enumerates that root,
chunks every supported document, and builds a lexical index before it reports readiness.

```bash
DOCS_ROOT=/srv/corpus npm start
```

## Verify readiness

Poll `/ready` until it returns `200`. A `503` means the index is still building or no corpus is
configured.
