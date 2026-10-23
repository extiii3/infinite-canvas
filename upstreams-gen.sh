#!/bin/sh
# Generates one nginx location per OpenAI-compatible upstream from env vars:
#   UPSTREAM_<NAME>_URL=https://api.openai.com/v1
#   UPSTREAM_<NAME>_KEY=sk-...
# -> /upstream/<name>/... is proxied to <URL>/... with "Authorization: Bearer <KEY>" injected server-side.
# The browser never sees the key. Runs from the nginx entrypoint (after 15-local-resolvers.envsh).
set -eu

OUT=/etc/nginx/upstreams
mkdir -p "$OUT"
rm -f "$OUT"/*.conf

SECRET="${ORIGIN_SECRET:-}"
case "$SECRET" in
    "" | *[!A-Za-z0-9._~+/=-]*) echo "upstreams: ORIGIN_SECRET missing or has unsupported characters; no upstreams generated" >&2; exit 0 ;;
esac
RESOLVER="${NGINX_LOCAL_RESOLVERS:-1.1.1.1}"

for ID in $(env | sed -n 's/^UPSTREAM_\([A-Z0-9_]*\)_URL=.*/\1/p'); do
    eval "URL=\${UPSTREAM_${ID}_URL:-}"
    eval "KEY=\${UPSTREAM_${ID}_KEY:-}"
    NAME=$(printf '%s' "$ID" | tr 'A-Z_' 'a-z-')

    case "$URL" in https://*) ;; *) echo "upstreams: $ID skipped (URL must start with https://)" >&2; continue ;; esac
    case "$KEY" in "" | *[!A-Za-z0-9._~+/=:-]*) echo "upstreams: $ID skipped (KEY missing or has unsupported characters)" >&2; continue ;; esac

    REST=${URL#https://}
    HOSTPORT=${REST%%/*}
    if [ "$REST" = "$HOSTPORT" ]; then BASEPATH=""; else BASEPATH="/${REST#*/}"; fi
    BASEPATH=${BASEPATH%/}
    HOST=${HOSTPORT%%:*}
    case "$HOSTPORT" in "" | *[!A-Za-z0-9.:-]*) echo "upstreams: $ID skipped (bad host)" >&2; continue ;; esac
    case "$BASEPATH" in *[!A-Za-z0-9._~/-]*) echo "upstreams: $ID skipped (bad path)" >&2; continue ;; esac

    cat > "$OUT/$NAME.conf" <<EOF
location /upstream/$NAME/ {
    if (\$http_x_origin_auth != "$SECRET") { return 403; }
    resolver $RESOLVER ipv6=off valid=300s;
    set \$upstream_host "$HOSTPORT";
    rewrite ^/upstream/$NAME/(.*)\$ $BASEPATH/\$1 break;
    proxy_pass https://\$upstream_host;
    proxy_http_version 1.1;
    proxy_ssl_server_name on;
    proxy_ssl_name $HOST;
    proxy_set_header Host $HOSTPORT;
    proxy_set_header Authorization "Bearer $KEY";
    proxy_set_header Connection "";
    # Strip everything identifying the browser, Cloudflare, or the origin secret.
    proxy_set_header Cookie "";
    proxy_set_header Origin "";
    proxy_set_header Referer "";
    proxy_set_header X-Origin-Auth "";
    proxy_set_header X-Forwarded-For "";
    proxy_set_header X-Forwarded-Proto "";
    proxy_set_header X-Real-IP "";
    proxy_set_header True-Client-IP "";
    proxy_set_header CDN-Loop "";
    proxy_set_header CF-Connecting-IP "";
    proxy_set_header CF-IPCountry "";
    proxy_set_header CF-Ray "";
    proxy_set_header CF-Visitor "";
    proxy_set_header Cf-Access-Jwt-Assertion "";
    proxy_set_header Cf-Access-Authenticated-User-Email "";
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 900s;
    proxy_send_timeout 900s;
}
EOF
    echo "upstreams: /upstream/$NAME/ -> https://$HOSTPORT$BASEPATH/"
done
