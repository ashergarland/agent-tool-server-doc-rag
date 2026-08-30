# Pinned by digest so a given commit always builds the same image. `node:24-alpine` is a moving
# tag: Node patch releases and Alpine rebuilds change it underneath us, so the tag alone makes the
# shipped artifact unreproducible and unauditable. Dependabot proposes digest bumps as reviewable
# pull requests, which is what keeps CVE patches flowing; see .github/dependabot.yml.
#
# Node 24 is the Active LTS line. Major bumps are deliberate, not automatic: Node 26 does not reach
# LTS until 2026-10-28, and shipping a Current release would put production on a runtime that still
# takes breaking changes.
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS build
WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
  && npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS runtime
ARG GIT_SHA=unknown
ARG SERVICE_VERSION=0.0.0-dev
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    GIT_SHA=${GIT_SHA} \
    SERVICE_VERSION=${SERVICE_VERSION} \
    CORPUS_SOURCE=none
WORKDIR /app

COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/dist ./dist
COPY --chown=node:node package.json ./

# The corpus is always mounted or configured separately. /app holds application code and is never
# treated as a corpus, and the image ships without one so an unconfigured deployment stays not-ready.
RUN mkdir -p /corpus && chown node:node /corpus
VOLUME ["/corpus"]

USER node
EXPOSE 8080
# Liveness only. Readiness additionally requires a usable configured index at /ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]
