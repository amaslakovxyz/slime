default:
    @just --list

# Run all pre-commit hooks against the whole tree.
check:
    pre-commit run --all-files

# Install git hooks into this clone.
hooks:
    pre-commit install

# --- Stack recipes ---
# Add install / dev / test recipes here once the project stack is chosen.
# e.g.
#   install:
#       uv sync
#   test:
#       uv run pytest -q
