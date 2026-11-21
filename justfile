default:
    @just --list

# Run all pre-commit hooks against the whole tree.
check:
    pre-commit run --all-files

# Install git hooks into this clone.
hooks:
    pre-commit install

# Serve the landing page locally at http://localhost:8090.
landing port="8090":
    python3 -m http.server {{port}} --bind 127.0.0.1 --directory platform/landing

# Type-check, test, build and pack-check @slime-cloud/core, as CI does.
core:
    npm ci
    npm run typecheck -w @slime-cloud/core
    npm test -w @slime-cloud/core
    npm run build -w @slime-cloud/core
    npm run check:pack -w @slime-cloud/core

# Build the Slime Cloud runtime Lambda bundle (platform/runtime/dist/lambda).
runtime-build:
    bash platform/infra/platform/build.sh

# Plan a platform/infra stack with the slime deployer role (e.g. `just tf-plan platform`).
tf-plan stack: (runtime-build)
    AWS_PROFILE=slime terraform -chdir=platform/infra/{{stack}} init -input=false >/dev/null
    AWS_PROFILE=slime terraform -chdir=platform/infra/{{stack}} plan
