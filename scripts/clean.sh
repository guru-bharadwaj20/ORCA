#!/usr/bin/env bash
# Dev helper: remove build output, coverage, and any leftover ORCA workspaces.
# STAGE: dev tooling. Placeholder.
set -euo pipefail

# TODO(scripts): confirm paths before removing.
rm -rf dist coverage .orca tmp
echo "Cleaned dist/, coverage/, .orca/, tmp/."
