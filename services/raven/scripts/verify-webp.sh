#!/bin/sh
set -eu
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT HUP INT TERM
ffmpeg -hide_banner -encoders 2>/dev/null | grep -q 'libwebp'
vips --version > /dev/null
for loader in pngload jpegload gifload webpload heifload; do vips -l foreign | grep -q "$loader"; done
for spec in 257:513 33:16400 16400:17; do
  width="${spec%%:*}"; height="${spec#*:}"
  timeout 60 ffmpeg -hide_banner -loglevel error -nostdin -y -f lavfi -i "testsrc=size=${width}x${height}:rate=1" -frames:v 1 -threads 1 "$workdir/source.png"
  tilewidth="$width"; [ "$tilewidth" -le 16383 ] || tilewidth=16383
  tileheight="$height"; [ "$tileheight" -le 16383 ] || tileheight=16383
  [ "$(vipsheader -f width "$workdir/source.png")" = "$width" ]
  [ "$(vipsheader -f height "$workdir/source.png")" = "$height" ]
  timeout 120 vips --vips-concurrency=2 --vips-cache-max=0 --vips-cache-max-memory=67108864 --vips-disc-threshold=67108864 \
    crop "$workdir/source.png[access=sequential]" "$workdir/region.png" 0 0 "$tilewidth" "$tileheight"
  timeout 120 ffmpeg -hide_banner -loglevel error -nostdin -y -filter_threads 1 -threads 2 -i "$workdir/region.png" -frames:v 1 \
    -vf "format=rgba" -c:v libwebp -quality 85 -compression_level 4 -lossless 0 -threads 2 -f webp "$workdir/page.webp"
  timeout 60 ffmpeg -hide_banner -loglevel error -nostdin -threads 2 -i "$workdir/page.webp" -frames:v 1 -f null -
  actual="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$workdir/page.webp")"
  [ "$actual" = "${tilewidth}x${tileheight}" ] || { printf 'WebP dimensions differ.\n' >&2; exit 1; }
  thumbwidth="$width"; thumbheight="$height"
  if [ "$width" -gt 512 ] || [ "$height" -gt 768 ]; then
    if [ "$((width * 768))" -gt "$((height * 512))" ]; then thumbwidth=512; thumbheight="$((height * 512 / width))";
    else thumbheight=768; thumbwidth="$((width * 768 / height))"; fi
  fi
  [ "$thumbwidth" -ge 1 ] || thumbwidth=1
  [ "$thumbheight" -ge 1 ] || thumbheight=1
  timeout 120 vips --vips-concurrency=2 --vips-cache-max=0 --vips-cache-max-memory=67108864 --vips-disc-threshold=67108864 \
    thumbnail "$workdir/source.png" "$workdir/thumbnail.png" "$thumbwidth" --height "$thumbheight" --size force
  [ "$(vipsheader -f width "$workdir/thumbnail.png")" = "$thumbwidth" ]
  [ "$(vipsheader -f height "$workdir/thumbnail.png")" = "$thumbheight" ]
done
printf 'Native region/whole-thumbnail and WebP quality85/method4 odd/tall/wide encode/decode checks passed.\n'
