# Amigo World launch commercial: final production (1:45)

Built 4 Nov 2026 to the approved animatic v1 (`../animatic/`). Sequence, timings, trims, transitions and continuity fixes are unchanged. Master is 1920×1080, 24 fps, 2,520 frames, -14 LUFS / -1 dBTP.

| Path | What |
| --- | --- |
| `exports/AmigoWorld_Launch_1m45_1080p24_WIP-internal-not-for-release.mp4` | Internal work-in-progress cut (H.264 + AAC 320k); see `exports/STATUS.txt`. Becomes `…_RELEASE.mp4` only when no placeholders remain |
| `stems/VO.wav`, `MUSIC.wav`, `SFX.wav` | Stems, 48 kHz 24-bit, aligned to 00:00 |
| `stems/MIX_full.wav`, `MIX_music-and-effects.wav` | Full mix (-14 LUFS) and M&E (-16 LUFS) |
| `project/AmigoWorld_Launch_1m45_v1.fcpxml` | Editable timeline: 34 shot clips on the spine + 3 stem lanes (Final Cut / Resolve) |
| `project/*.mjs`, `project/rebuild.sh` | Source project: timeline data, graphics, shot renderer, audio, delivery. `rebuild.sh` regenerates everything |
| `shots/` | Every rendered shot (1080p24) |
| `assets/drop-in/` | Put supplied assets here, then run `project/rebuild.sh` |
| `FILMING-CHECKLIST.md` | Remaining shots with action, framing and phone screen |

## Current state (4 Nov 2026): picture APPROVED

`exports/AmigoWorld_Launch_1m45_FINAL_REVIEW.mp4` is the full 1:45, **approved by the owner on 4 Nov 2026** (picture, edit, narration and mix). It has no placeholder cards, production text or file paths; `exports/qc-report.txt` has the automated QC.

- **Live-action slots (15):** covered by licensed Pexels stock (places, hands and silhouettes only, never presented as our cast) or an original graphic (scene 6). Credits are in `assets/stock/STOCK-CREDITS.json`. Filmed clips in `assets/drop-in/live-action/` replace them automatically.
- **Scene 12 entry photo:** frame 0 of the scene 13 Lagos aerial, so the match cut is exact. A supplied `assets/drop-in/rooftop-still.jpg` replaces it.
- **Narration (changed 4 Nov 2026 to an American voice):** Azure AI Speech, `en-US-AndrewMultilingualNeural`, "empathetic" style (degree 1.2), rate −6%, pitch −4%. Rendered on the paid Standard S0 resource (eastus); `voiceover/azure-andrew-warm/PROVENANCE.json`, and `assets/drop-in/vo/NARRATION.json` fingerprints the live files for QC. The approved Abeo lines are kept in `voiceover/azure-abeo/approved-lines/` (plus an automatic backup folder) and are not deleted. Disclose the synthetic voice in the video description or credits.
- **Music:** still the temporary synth bed. **This is the one release blocker.** Drop a licensed or commissioned 1:45 track at `assets/drop-in/music/music.wav` and run `project/rebuild.sh`; the gate then names the export `AmigoWorld_Launch_1m45_RELEASE.mp4`.

**Release gate:** the export name comes from what each shot actually used (`shots/_sources.json`), never from a rename. A review or release build refuses to render a placeholder card at all. Every review or release export must pass `project/qc.mjs`, otherwise it's renamed `…_QC-FAILED.mp4`. The QC checks:
- on-device OCR of 4 frames per second for production text;
- black frames and white flashes;
- every cut;
- 2,520 frames / 105.000 s;
- A/V alignment;
- narration source and timecodes;
- loudness and peak.

To rebuild: `BUILD_MODE=review project/rebuild.sh`.

## What's finished

- **App screens:** the real recordings in an iPhone-style mockup with a 9:41 status bar (band colour taken from each screen). Continuity is fixed as approved:
  - Ada's logo is patched over her "AA" initials.
  - Night-time labels are masked.
  - The scene 6 and scene 10 composited stills are in place. Ada's 393×659 pt frames are joined with her own next frame to fill the screen without stretching.
- **Scene 12 reaction banners:** shown as a close-up of the phone's top.
- **Scene 1:** a real Lagos aerial at dusk, graded to blue hour, with a slow push-in.
- **Scene 4:** split screen; Bisi's side is a stock rainy-window plate with no person in shot. Kemi's side is still to film.
- **Sound design:** made here, no third-party audio:
  - city air and rain;
  - phone turn and send swishes;
  - app chimes on cue;
  - a low hit on LIVE after the one-bar drop;
  - a whoosh into the end card.
- **End card:** the original wording: "Your world, together." · Reserve your username · reserve.amigoworld.com.ng · Free · 18+.

## Credits (stock; free licences, no attribution required, credited anyway)

- Scene 1: "Aerial view of Lagos cityscape at sunset" by Vitalis Nwenyi, Pexels (video 28920105), Pexels License.
- Scene 4: "Blurred city lights seen through raindrops on a window at night" by emre varışlı, Pexels (video 35621441), Pexels License.
- Scene 12 placeholder photo: Lagos Island at sunset by Emmanuel Ikwuegbu (@emmages), Unsplash License. Replace before release.
- Ada's Atelier photos: see `../ada-atelier/README.md` (Pexels).
