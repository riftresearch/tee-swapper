# Docker registry and image configuration
registry := "riftresearch"
image := "cbbtc-swapper-server"
version := `jq -r .version package.json`
full_image := registry + "/" + image + ":" + version
latest_image := registry + "/" + image + ":latest"

# Default recipe - show available commands
default:
    @just --list

# Build the Docker image for linux/amd64
build:
    docker build --platform linux/amd64 -t {{full_image}} -t {{latest_image}} .

# Release: check version doesn't exist, build, and push
release: _check-version-not-exists build _push
    @echo "Released {{full_image}}"

# Internal: check that this version doesn't already exist in registry
_check-version-not-exists:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Checking if {{full_image}} already exists..."
    if docker manifest inspect {{full_image}} > /dev/null 2>&1; then
        echo "ERROR: {{full_image}} already exists in registry!"
        echo "Update version in package.json before releasing."
        exit 1
    fi
    echo "✓ Version {{version}} is available"

# Internal: push both versioned and latest tags
_push:
    docker push {{full_image}}
    docker push {{latest_image}}

# Docker compose shorthand for compose.phala.yml
# Usage: just s up -d, just s down -v, just s logs -f, etc.
s *args:
    docker compose -f etc/compose.phala.yml --env-file .env.prod {{args}}
