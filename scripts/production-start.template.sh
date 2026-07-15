#!/bin/sh
# Production permission template. Copy this file, replace the deployment values,
# and pass one explicit comma-separated network allowlist. Never derive this list
# from DATABASE_URL or SUMMARIZER_BASE_URL: permissions must be reviewed separately.
#
# Usage:
#   ./scripts/production-start.template.sh \
#     "<database-host>,<telegram-dc-hosts>,<summarizer-host>,<listener>"
# SERVER_HOSTNAME must match the listener host in this allowlist. It defaults to
# 127.0.0.1 for reverse-proxied deployments.

set -eu

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <database-host>,<telegram-dc-hosts>,<summarizer-host>,<listener>" >&2
  exit 2
fi

exec deno run \
  --unstable-cron \
  --env-file=.env.production.local \
  --allow-net="$1" \
  --allow-env=DATABASE_URL,PGTARGETSESSIONATTRS,NODE_ENV,PORT,SERVER_HOSTNAME,CREDENTIAL_MASTER_KEY,TELEGRAM_API_ID,TELEGRAM_API_HASH,TELEGRAM_SESSION,GEMINI_API_KEY,LOCAL_API,SUMMARIZER_MODEL,SUMMARIZER_BASE_URL,ALLOWED_ORIGINS,TRUSTED_PROXY_COUNT,MAX_REQUEST_BODY_BYTES,DB_POOL_MAX,DB_IDLE_TIMEOUT_SECONDS,DB_CONNECT_TIMEOUT_SECONDS,DB_SSL_MODE,ALLOW_REMOTE_SUMMARIZATION,CONNECTOR_TIMEOUT_MS,SUMMARIZER_TEXT_BYTES_PER_CHUNK,SUMMARIZER_MAX_ITEMS_PER_CHUNK,SUMMARIZER_MAX_IMAGE_BYTES,SUMMARIZER_TIMEOUT_MS,SUMMARIZATION_CONCURRENCY,MEDIA_TTL_MS,MEDIA_QUOTA_BYTES,DIGEST_RUN_STALE_AFTER_MS,SCHEDULER_LEASE_MS \
  --allow-read=./src,./apps,./drizzle,./node_modules,./deno.json,./package.json,./tsconfig.json,./.env.production.local \
  --allow-write=./telegram_media,./media,./.debug_logs \
  --allow-ffi=./node_modules \
  src/server/main.ts
