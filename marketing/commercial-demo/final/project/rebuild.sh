#!/bin/sh
# Rebuilds the whole commercial from source footage and any drop-in assets (live action, rooftop still, VO, music).
# Needs: node (with the repo's playwright), ffmpeg. Takes about 2 minutes.
set -e
cd "$(dirname "$0")"
node timeline.mjs   # frame-accurate timeline (2520 frames)
node gfx.mjs        # phone mockup, status bar, hold cards, end card, composited stills
BUILD_MODE=${BUILD_MODE:-review} node build.mjs  # every shot -> ../shots, joined picture
node audio.mjs      # VO / MUSIC / SFX stems + mixes -> ../stems
node deliver.mjs    # FCPXML, filming checklist, master -> ../exports
