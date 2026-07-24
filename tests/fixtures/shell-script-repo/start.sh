#!/usr/bin/env bash
# Boot the API for local development.
set -euo pipefail

cd "$(dirname "$0")"
export NODE_ENV=development
source ./.env

echo "Installing dependencies..."
npm ci

echo "Starting the server on port 5000..."
node server.js --port 5000
