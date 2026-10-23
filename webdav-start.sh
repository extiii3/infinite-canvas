#!/bin/sh
# Started by the nginx image entrypoint before nginx. Runs the WebDAV server in the background.
mkdir -p /data
webdav -c /etc/webdav.yml &
