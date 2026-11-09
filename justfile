# Thin aliases only: every recipe calls an npm script, because package.json is
# the source of truth for the task runner. Add new work as an npm script first.
set shell := ["bash", "-euo", "pipefail", "-c"]

# Full isolated gate (lint, typecheck, tests, fixture verify and fixture build).
ci:
    npm run ci:isolated

# Fast checks that do not regenerate dashboard artifacts.
check:
    npm run check

lint:
    npm run lint

typecheck:
    npm run typecheck

test:
    npm test

build:
    npm run build

install:
    npm ci

clean:
    npm run clean

# Collect this machine (tokscale daily). Extra arguments are forwarded.
collect *ARGS:
    npm run collect -- --tokscale --daily {{ARGS}}

# Collect, then explicitly commit and push the bundle.
collect-sync *ARGS:
    npm run collect -- --tokscale --daily --sync-git {{ARGS}}

# Legacy ccusage-only collection (no tokscale daily flags).
collect-ccusage *ARGS:
    npm run collect -- {{ARGS}}

docker-build:
    npm run docker-build

docker-up:
    npm run docker-up

docker-down:
    npm run docker-down

docker-restart:
    npm run docker-restart

docker-logs:
    npm run docker-logs
