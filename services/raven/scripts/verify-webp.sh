#!/bin/sh
set -eu
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT HUP INT TERM
ffmpeg -hide_banner -encoders 2>/dev/null | grep -q 'libwebp'
for spec in 257:513 33:16400 16400:17; do
  width="${spec%%:*}"; height="${spec#*:}"
  timeout 60 ffmpeg -hide_banner -loglevel error -nostdin -y -f lavfi -i "testsrc=size=${width}x${height}:rate=1" -frames:v 1 -threads 1 "$workdir/source.png"
  tilewidth="$width"; [ "$tilewidth" -le 16383 ] || tilewidth=16383
  tileheight="$height"; [ "$tileheight" -le 16383 ] || tileheight=16383
  timeout 120 ffmpeg -hide_banner -loglevel error -nostdin -y -filter_threads 1 -threads 2 -i "$workdir/source.png" -frames:v 1 \
    -vf "format=rgba,crop=${tilewidth}:${tileheight}:0:0:exact=1" -c:v libwebp -quality 85 -compression_level 4 -lossless 0 -threads 2 -f webp "$workdir/page.webp"
  timeout 60 ffmpeg -hide_banner -loglevel error -nostdin -threads 2 -i "$workdir/page.webp" -frames:v 1 -f null -
  actual="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$workdir/page.webp")"
  [ "$actual" = "${tilewidth}x${tileheight}" ] || { printf 'WebP dimensions differ.\n' >&2; exit 1; }
done
printf 'WebP quality85/method4 odd/tall/wide encode/decode checks passed.\n'
