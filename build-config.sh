#!/bin/sh
# Cloudflare Pages build script — generates flare/config.js from environment variables.
# Set PB_URL, WEATHER_API_KEY, and PB_API_TOKEN as encrypted env vars in the
# Cloudflare Pages dashboard (Settings → Environment variables).
cat > flare/config.js <<EOF
var PB_URL          = '${PB_URL}';
var WEATHER_API_KEY = '${WEATHER_API_KEY}';
var PB_API_TOKEN    = '${PB_API_TOKEN}';
EOF
echo "config.js generated."
