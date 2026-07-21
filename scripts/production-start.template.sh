#!/bin/sh
# Production permission template. Copy this file and replace the deployment
# values. Substack custom publication domains require unrestricted network
# permission. Public archive requests pin a validated global-unicast address to
# the TCP connection while retaining the publication hostname for TLS SNI and
# certificate verification.
#
# Usage:
#   ./scripts/production-start.template.sh

set -eu

if [ "$#" -ne 0 ]; then
  echo "usage: $0" >&2
  exit 2
fi

exec deno run \
  --unstable-cron \
  --env-file=.env.production.local \
  --allow-net \
  --allow-env=DATABASE_URL,PGTARGETSESSIONATTRS,NODE_ENV,PORT,SERVER_HOSTNAME,CREDENTIAL_MASTER_KEY,TELEGRAM_API_ID,TELEGRAM_API_HASH,TELEGRAM_SESSION,GEMINI_API_KEY,LOCAL_API,SUMMARIZER_MODEL,SUMMARIZER_BASE_URL,ALLOWED_ORIGINS,TRUSTED_PROXY_COUNT,MAX_REQUEST_BODY_BYTES,DB_POOL_MAX,DB_IDLE_TIMEOUT_SECONDS,DB_CONNECT_TIMEOUT_SECONDS,DB_SSL_MODE,ALLOW_REMOTE_SUMMARIZATION,CONNECTOR_TIMEOUT_MS,SUMMARIZER_TEXT_BYTES_PER_CHUNK,SUMMARIZER_MAX_ITEMS_PER_CHUNK,SUMMARIZER_MAX_IMAGE_BYTES,SUMMARIZER_TIMEOUT_MS,SUMMARIZATION_CONCURRENCY,MEDIA_TTL_MS,MEDIA_QUOTA_BYTES,DIGEST_RUN_STALE_AFTER_MS,SCHEDULER_LEASE_MS \
  --allow-read=./src,./apps,./drizzle,./node_modules,./deno.json,./package.json,./tsconfig.json,./.env.production.local,./telegram_media,./substack_media,./youtube_media,./reddit_media,./x_media,./rss_media,./media \
  --allow-write=./telegram_media,./substack_media,./youtube_media,./reddit_media,./x_media,./rss_media,./media,./.debug_logs \
  --allow-ffi=./node_modules \
  src/server/main.ts
