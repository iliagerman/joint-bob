#!/bin/sh
# Makes the landing page's copies of the films. Each film comes out twice: 720p for the small
# cards down the page, and 1080p (the size it was rendered at) for the hero, the tour and the
# theater, where it is shown large. A still of each is taken to show before it plays.
# Run after `npm run render:all`; a film that has not been rendered is skipped.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../out"
MEDIA="$HERE/media"
mkdir -p "$MEDIA"
cp "$HERE/../public/icon.svg" "$MEDIA/icon.svg"

# Each film, and the second its still is taken from.
for entry in teaser:15.6 hero:15.1 lid:9.9 team:14.7 schedule:12.9 alerts:9.3 browser:4.0 secrets:2.4 analytics:6.2; do
  film="${entry%%:*}"
  at="${entry##*:}"
  [ -f "$OUT/$film.mp4" ] || { echo "skipped $film: not rendered"; continue; }
  ffmpeg -y -v error -i "$OUT/$film.mp4" -vf "scale=1280:720:flags=lanczos" -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart "$MEDIA/$film.mp4"
  ffmpeg -y -v error -i "$OUT/$film.mp4" -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart "$MEDIA/$film-1080.mp4"
  ffmpeg -y -v error -ss "$at" -i "$OUT/$film.mp4" -frames:v 1 -vf "scale=1280:720:flags=lanczos" -q:v 3 "$MEDIA/$film.jpg"
  ffmpeg -y -v error -ss "$at" -i "$OUT/$film.mp4" -frames:v 1 -q:v 3 "$MEDIA/$film-1080.jpg"
  echo "$film: $(du -h "$MEDIA/$film.mp4" | cut -f1) and $(du -h "$MEDIA/$film-1080.mp4" | cut -f1)"
done
