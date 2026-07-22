#!/bin/sh
# Production start template. Bun loads the production environment explicitly;
# replace the deployment values in .env.production.local before use.
#
# Usage:
#   ./scripts/production-start.template.sh

set -eu

if [ "$#" -ne 0 ]; then
  echo "usage: $0" >&2
  exit 2
fi

exec bun --env-file=.env.production.local run start
