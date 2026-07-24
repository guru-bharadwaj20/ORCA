#!/bin/sh
# Produce a production bundle and a container image.
set -e

npm run build

docker build \
  -t widget-api:latest \
  .
