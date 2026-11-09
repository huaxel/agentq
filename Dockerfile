# Dashboard viewer container — serves the rendered ROI dashboard over HTTP.
# User config and data are supplied through AGENTQ_HOME, not repository paths.
# Bind-mount a prepared AGENTQ_HOME at runtime; GIT_PULL=1 requires a separate
# full repository mount and suitable credentials.

FROM node:22-alpine

# git for pulling synced bundles; ca-certificates for HTTPS pricing fetch.
RUN apk add --no-cache git ca-certificates wget

WORKDIR /app
COPY . .

# Prune anything the .dockerignore missed
RUN rm -rf test scripts *.md justfile pi-issue.sh *.xlsx osxphotos_crash.log jules_test.txt 2>/dev/null; \
    find . -name \*.test.js -o -name \*.spec.js | xargs rm -f 2>/dev/null; \
    chown -R node:node /app

ENV PORT=8088 HOST=0.0.0.0 REFRESH_MINUTES=30 GIT_PULL=0

# The dashboard only needs to read application code and write mounted output.
# Compose can override this to the host user's UID/GID for bind-mounted files.
USER node
EXPOSE 8088

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8088/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "src/roi-tracker/serve.js"]
