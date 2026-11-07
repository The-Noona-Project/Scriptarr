#!/bin/sh
set -eu

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT HUP INT TERM

ffmpeg -hide_banner -encoders 2>/dev/null | grep -q 'libaom-av1'
ffmpeg -hide_banner -muxers 2>/dev/null | grep -q 'avif'

for fixture in jpg:257:513 png:257:513 png:257:2049; do
  extension="${fixture%%:*}"
  dimensions="${fixture#*:}"
  width="${dimensions%%:*}"
  height="${dimensions#*:}"
  input="$workdir/page.$extension"
  output="$workdir/page.avif"
  timeout 30 ffmpeg -hide_banner -loglevel error -nostdin -y -f lavfi \
    -i "testsrc=size=${width}x${height}:rate=1" -frames:v 1 -threads 1 "$input"
  timeout 60 ffmpeg -hide_banner -loglevel error -nostdin -y -filter_threads 1 -i "$input" -frames:v 1 \
    -vf 'pad=max(256\,ceil(iw/2)*2):max(256\,ceil(ih/2)*2):0:0:color=white,format=yuv420p' \
    -c:v libaom-av1 -crf 32 -cpu-used 8 -still-picture 1 -row-mt 1 -threads 2 -b:v 0 -f avif "$output"
  timeout 30 ffmpeg -hide_banner -loglevel error -nostdin -i "$output" -frames:v 1 -f null -
  actual="$(timeout 10 ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$output")"
  expected="$(( (width + 1) / 2 * 2 ))x$(( (height + 1) / 2 * 2 ))"
  [ "$actual" = "$expected" ] || { printf 'AVIF dimensions differ: %s versus %s\n' "$actual" "$expected" >&2; exit 1; }
done

printf 'CPU AVIF JPEG/PNG/odd/tall encode and decode checks passed.\n'
