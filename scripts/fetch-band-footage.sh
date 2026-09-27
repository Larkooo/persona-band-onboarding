#!/usr/bin/env bash
# Downloads Persona's band film from yourpersona.com and cuts the web versions this demo plays.
# The footage belongs to Persona and is not committed to this repo.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public/band
tmp="$(mktemp -t band).mp4"
curl -fsSL -o "$tmp" https://yourpersona.com/band/films/hero/hero-1080.mp4
# Dense keyframes (-g 8) so the player can jump between segments without stutter.
ffmpeg -v error -y -i "$tmp" -t 14.2 -an -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 21 -preset slow -g 8 -keyint_min 8 -sc_threshold 0 -movflags +faststart public/band/hero.mp4
ffmpeg -v error -y -i "$tmp" -t 14.2 -an -vf scale=1280:-2 -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 23 -preset slow -g 8 -keyint_min 8 -sc_threshold 0 -movflags +faststart public/band/hero-720.mp4
rm -f "$tmp"
echo "Wrote public/band/hero.mp4 and public/band/hero-720.mp4"
