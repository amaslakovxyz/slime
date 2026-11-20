default:
    @just --list

# Run all pre-commit hooks against the whole tree.
check:
    pre-commit run --all-files

# Install git hooks into this clone.
hooks:
    pre-commit install

# Serve the landing page locally at http://localhost:8000.
landing:
    python3 -m http.server 8000 --directory landing

# Build the Slime runtime Lambda bundle (sandbox/dist/lambda).
runtime-build:
    cd sandbox && npm run build:lambda

# Plan an infra/aws stack with the slime deployer role (e.g. `just tf-plan platform`).
tf-plan stack: (runtime-build)
    AWS_PROFILE=slime terraform -chdir=infra/aws/{{stack}} init -input=false >/dev/null
    AWS_PROFILE=slime terraform -chdir=infra/aws/{{stack}} plan
