#!/bin/sh
# Makes the landing page's copies of the films. Each film comes out twice: 720p for the small
# cards down the page, and 1080p for the hero and the theater, where it is shown large.
# A film rendered larger (the drawn ones are 3840 x 2160) is scaled down to those sizes. A still of each is taken to show before it plays.
# Run after `npm run render:all`; a film that has not been rendered is skipped. Name films
# (`media.sh monday pools`) to make only theirs.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../out"
MEDIA="$HERE/media"
mkdir -p "$MEDIA"
cp "$HERE/../public/icon.svg" "$MEDIA/icon.svg"

# Each film, and the second its still is taken from.
FILMS="monday:55.0 control:26.0 lid:30.2 team:32.0 pools:44.1 budgets:29.5 guardian:28.7 story:34.6 dashboards:23.7 assistant:24.3 schedule:36.4 alerts:26.7 phone:31.1 browser:17.5 secrets:13.3 analytics:14.7"
# The drawn films: flat colour on paper grain. Tuned for animation, they keep their look at less
# than half the size the default settings give them.
DRAWN="monday"
for entry in $FILMS; do
  film="${entry%%:*}"
  at="${entry##*:}"
  [ $# -eq 0 ] || case " $* " in *" $film "*) ;; *) continue ;; esac
  [ -f "$OUT/$film.mp4" ] || { echo "skipped $film: not rendered"; continue; }
  case " $DRAWN " in *" $film "*) tune="-tune animation"; small=26; large=24 ;; *) tune=""; small=23; large=20 ;; esac
  # shellcheck disable=SC2086
  ffmpeg -y -v error -i "$OUT/$film.mp4" -vf "scale=1280:720:flags=lanczos" -c:v libx264 -preset slow -crf $small $tune -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart "$MEDIA/$film.mp4"
  # shellcheck disable=SC2086
  ffmpeg -y -v error -i "$OUT/$film.mp4" -vf "scale=1920:1080:flags=lanczos" -c:v libx264 -preset slow -crf $large $tune -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart "$MEDIA/$film-1080.mp4"
  ffmpeg -y -v error -ss "$at" -i "$OUT/$film.mp4" -frames:v 1 -vf "scale=1280:720:flags=lanczos" -q:v 3 "$MEDIA/$film.jpg"
  ffmpeg -y -v error -ss "$at" -i "$OUT/$film.mp4" -frames:v 1 -vf "scale=1920:1080:flags=lanczos" -q:v 3 "$MEDIA/$film-1080.jpg"
  echo "$film: $(du -h "$MEDIA/$film.mp4" | cut -f1) and $(du -h "$MEDIA/$film-1080.mp4" | cut -f1)"
done

# Copies of films that are no longer made are removed, so publishing does not upload them.
for file in "$MEDIA"/*.mp4 "$MEDIA"/*.jpg; do
  name="$(basename "$file")"
  name="${name%.*}"
  name="${name%-1080}"
  case " $FILMS " in *" $name:"*) ;; *) rm "$file"; echo "removed $(basename "$file")" ;; esac
done
