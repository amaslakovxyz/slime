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

# --- Stack recipes ---
# Add install / dev / test recipes here once the project stack is chosen.
# e.g.
#   install:
#       uv sync
#   test:
#       uv run pytest -q
