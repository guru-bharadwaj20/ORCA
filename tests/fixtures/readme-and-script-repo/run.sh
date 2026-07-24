#!/usr/bin/env bash
set -e

# Same thing the README describes, but with the migration step first.
npm install
node scripts/migrate.js
npm start
