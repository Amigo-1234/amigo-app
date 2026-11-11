# Animatic v1: proposed sequence (for approval before rendering)

Direction (4 Nov 2026): keep all existing footage and Ada's approved frames; fix continuity in the edit (mask, crop, reframe, composited stills) rather than re-record; keep the countdown-to-LIVE transition; play down the leaderboard; keep storyboard, narration, timings, music direction and the 1:45 runtime. No app, database, storage or infrastructure changes.

**Format:** 960×540, 24 fps, H.264, with a burned-in timecode and scene label. Live-action shots are **placeholder slates** (dark frame, scene number, shot description, cast, location). App moments are the real recordings in a plain phone outline on a dark canvas (no status bar; the final mockup adds it). **Scratch narration:** macOS "Daniel" voice, timing only. **Temp audio:** a soft synth pad plus a 104 BPM click from 0:26, and the app's own alert chimes (message G5→D6, social B5) at the storyboard's cue points. Built locally with ffmpeg and Chromium; nothing leaves this Mac.

## How each continuity issue is handled (least disruptive)

| # | Issue | Fix in the edit | New material needed |
| --- | --- | --- | --- |
| C1 | Ada's Atelier shows "AA" initials and text-only posts in feeds, but a logo and photo posts in scene 10 | **S6:** keep the real splash (0.0–1.2 s), then crossfade to a composited Home-feed still made the same way as the approved scene 10 frames (logo in the avatar slots, the same Pexels photos in her posts). **S7/S8 glimpses:** patch the approved logo over the "AA" avatar where it shows (fixed positions) | One composited Home-feed still (same method, assets and credits as scene 10) |
| C2 | Night-time times: chat "0:40 / 0:45 · Read"; World "Wed, 4 Nov, 0:56 – 1:56" | Fill each small time label with the background colour (`#0c0c0e`); the text sits on plain background, so it disappears cleanly. "Read" and "Sent" stay | None. **No re-record needed** |
| C3a | S7 group photo became a text post | Keep the text post. It reads naturally ("Rooftop, suya and my people…"); the rooftop live action shows the friends, Kemi typing the caption | None |
| C3b | S9 Bisi's photo became a text message | Keep the text ("Found a Nigerian shop… PLANTAIN. I almost cried 😭"); Bisi's live action reacts to it | None |
| C3c | S12 photo entry and the 12→13 match cut | Show the entry as a **composited still**: the real entry card with a golden-hour Lagos photo inserted between its text and its like row. Skip the typing footage (it shows no photo being attached). In the animatic the photo is a placeholder stock image with no people; in the final it becomes a still from the scene 13 rooftop shoot, so the match cut is honest | One composited entry still; placeholder Lagos photo (free licence, no faces) |
| C4 | Thin leaderboard | Leaderboard is not used. Scene 12 ends on live reaction banners and the room chat | None |
| C5 | No "World is live" notice | The countdown → LIVE flip carries the shared moment (kept as is) | None |
| C6 | Kudos in scene 11 | Only Kudos-free ranges are used (below); nothing needs masking in v1 | None |

## Sequence (1:45)

| Timecode | Scene | Picture | Source and treatment | Scratch VO | Temp audio |
| --- | --- | --- | --- | --- | --- |
| 0:00–0:05 | 1 | Slate: Lagos skyline, blue hour, push-in | — | — | Pad |
| 0:05–0:11 | 2 | Slate: Tobi in his bedroom studio, phone face down | — | 0:05 "The world is full of people…" · 0:08 "with ideas waiting to be heard." | Pad |
| 0:11–0:16 | 3 | Slate: Ada folding coral fabric, seen through the shop window | — | 0:12 "With work worth finding." | Pad |
| 0:16–0:21 | 4 | Slate: Kemi on a Lagos bus / Bisi at a rainy window abroad | — | 0:17 "With friends a world away." | Pad |
| 0:21–0:26 | 5 | Slate: Femi photographing a street corner alone | — | 0:22 "And people still looking for the ones who get them." | Pad |
| 0:26–0:31 | 6 | Slate (0:26–0:28): macro, phone turned over, Amigo icon tapped → phone: splash → Home | S6 0.0–1.2 s, then composited Home still with 2 % push (C1) | 0:27 "Imagine one place where all of it comes together." | Click starts |
| 0:31–0:40 | 7 | Slate (0:31–0:34): friends on the rooftop at golden hour → phone: new post → Moment | S7 post take02 3.0–8.5 s at 1.4× (logo patch on Ada's avatars as the post lands); S7 Moment take02 9.5–11.5 s (viewer) | 0:32 "Share the moments that matter." | Social chime 0:37 |
| 0:40–0:48 | 8 | Slate (0:40–0:42): Femi at a café → phone: search → Seyi → Follow Back | S8 1.0–8.5 s at 1.25× (logo patch on the "Popular this week" avatar until the search results replace it) | 0:40 "Find the people who see the world the way you do." | — |
| 0:48–0:56 | 9 | Slate (0:48–0:49): Bisi at night → phone (Bisi) sends → phone (Kemi): typing, arrives, heart, swipe-reply → slate (0:55–0:56): Kemi laughing, bus passes Ada's shop | S9 Bisi send moment (~1.5 s); S9 Kemi 10.0–19.5 s at 2× with one jump cut; time labels filled (C2) | 0:48 "Talk freely, in messages only you and the people you're talking to can read." | Message chime 0:50.5 |
| 0:56–1:04 | 10 | Slate (0:56–1:00): Ada and a customer holding up a phone → phone: Ada's Atelier | Approved composite frame 1 → slow 8 % push → frame 2 | 0:56 "Show what your business does, so the people nearby can find you." | — |
| 1:04–1:13 | 11 | Slate (1:04–1:05): Tobi posts in studio → phone (Femi): Help out → phone (Ada): confirms → phone (Tobi): notification → request with 2 helpers | S11 Femi 2.5–5.0 s; S11 Ada 5.0–10.5 s at 2.5×; S11 Tobi 1.0–7.0 s at 1.5×. No Kudos frames (C6) | 1:04 "Ask your community for a hand, and give one back." | Social chime on Tobi's notification |
| 1:13–1:24 | 12 | Phone (Femi): countdown "Starts in 4s" → **LIVE**, intercut with two 0.5 s slate cards ("cast look at their phones") → composited entry with photo → reaction banners (reframed to the banner) → room chat | S12 countdown 36.0–41.5 s (schedule line filled, C2); composited entry still (C3c); S12 reactions 7–11 s cropped to the top banner; S12 chat 12–20 s at 2× | 1:13 "And when the moment comes…" · 1:16 "everyone shows up." · 1:19 "Live. Together. In the same World." | Ticks; one bar of silence at 1:16; social chimes on banners |
| 1:24–1:33 | 13 | Match cut from the entry photo → slate: rooftop meet-up at sunset, crane up → Kemi's phone in hand showing Bisi's message → slate | S9 Kemi 20–23 s (time labels filled) | 1:27 "This is Amigo World." | Pad opens out |
| 1:33–1:45 | 14 | End card: coral tile + "Amigo World" → "Your world, together." → coral pill **Reserve your username** · reserve.amigoworld.com.ng · "Free · 18+" | Built from the repo's logo and fonts | 1:36 "Your world, together." · 1:40 "Reserve your username today." | Four-note G-B-D-G motif, 2 s tail |

## Unresolved items (need a decision or come later)

1. **Entry photo (C3c):** the animatic uses a placeholder Lagos golden-hour photo. The final needs a still from the scene 13 rooftop shoot (Femi's own shot), so the match cut and the entry show the same place. Confirm this approach.
2. **Scene 7 and 9 stay text-only** (no composited group photo or plantain photo). The live action for those scenes should show typing and reading, not photographing a group or sending a photo. Confirm.
3. **Scene 6 composite** adds one new composited still (Home feed with Ada's logo and photos), made with the approved method and the same credited photos. Confirm that's acceptable as "least disruptive".
4. **Scene 11 continuity, minor:** Ada's clip starts at "1 of 10 helpers" (Femi helped first), which matches the order shown. No action.
5. **Not fixable in the animatic, by design:** live action (slates only), final voice, music and Tobi's chorus, status bars.
