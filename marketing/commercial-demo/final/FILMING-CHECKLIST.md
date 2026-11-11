# Filming checklist: Amigo World launch commercial (1:45)

Live-action shots with our cast, in story order. In the current cut each slot is covered by licensed stock or a graphic (see assets/stock/STOCK-CREDITS.json); filming them is optional and replaces the fill; drop the clip into `final/assets/drop-in/live-action/` under the file name given and run `final/project/rebuild.sh`. The clip replaces the card automatically, trimmed from its first frame to the length shown, filled to 1920×1080. Shoot 4K 24 fps (or 25) and give 2 s of handles at each end.

Phone screens: use the recording Preview and the cast accounts (see `raw/README.md`): dark mode, Do Not Disturb, status bar 9:41.

| # | Time | Len | Scene | Action | Framing | Phone screen | Cast | Drop-in file |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0:05 | 6.0 s | 2 | Tobi in his bedroom studio, headphones on; his phone lies face down beside the keyboard. | Medium-wide, slow push-in; warm practical light | Phone face down (screen not seen) | Tobi | `S02_tobi-studio.mov` |
| 2 | 0:11 | 5.0 s | 3 | Ada folds coral fabric, seen from the street through her shop window in Yaba. | Exterior through the glass, medium; shop name visible | None | Ada | `S03_ada-shop-window.mov` |
| 3 | 0:16 | 5.0 s | 4 | Kemi on a Lagos bus at dusk, looking out of the window. | LEFT half of a split screen: frame for 960×1080 (centre-weighted), medium close | None (phone in hand, screen not seen) | Kemi | `S04_kemi-bus.mov` |
| 4 | 0:21 | 5.0 s | 5 | Femi photographs a street corner, alone. | Medium, handheld; Femi slightly off-centre | Camera, not phone | Femi | `S05_femi-street.mov` |
| 5 | 0:26 | 2.0 s | 6 | Macro: a hand turns a phone over; the thumb taps the Amigo World icon. | Macro, top-down, shallow focus | iPhone Home Screen with the Amigo World icon (Add to Home Screen from the recording Preview); dark mode, 9:41 | Femi's hand | `S06_macro-icon-tap.mov` |
| 6 | 0:31 | 3.0 s | 7 | Golden hour on a Lagos rooftop: Kemi and friends, suya on the table; Kemi types her caption. | Wide establishing → over-the-shoulder on Kemi's phone | Kemi's New post composer: "Rooftop, suya and my people. Lagos sunsets never miss. 🧡" | Kemi + 3–4 friends | `S07_rooftop-kemi-types.mov` |
| 7 | 0:40 | 2.0 s | 8 | Femi at a café, scrolling on his phone. | Medium close, window light | Femi's Explore page (search field) | Femi | `S08_femi-cafe.mov` |
| 8 | 0:48 | 1.0 s | 9 | Night, abroad: Bisi sends a message. | Close-up, face lit by the phone; rain on the window behind | Bisi's chat with Kemi, sending "Found a Nigerian shop by the station. PLANTAIN. I almost cried 😭" | Bisi | `S09_bisi-sends.mov` |
| 9 | 0:55 | 1.0 s | 9 | Kemi laughs on the bus as it passes Ada's shop. | Through the bus window; Ada's shop sign passes behind Kemi | Kemi's chat with Bisi (not readable) | Kemi (Ada's shop in background) | `S09_kemi-laughs-bus.mov` |
| 10 | 0:56 | 4.0 s | 10 | Ada and a customer hold up a phone at the shop counter. | Medium two-shot across the counter; phone toward camera | Ada's Atelier business page (show composite-frame-1.png full screen on the phone) | Ada + customer | `S10_ada-customer.mov` |
| 11 | 1:04 | 1.0 s | 11 | Tobi posts his request from the studio. | Close on Tobi's hands and screen | Help Hub: "Listen to my new song — does the chorus land?" request | Tobi | `S11_tobi-posts.mov` |
| 12 | 1:14 | 0.5 s | 12 | Kemi, Ada, Tobi and Bisi glance down at their phones (quick cuts). | Four tight singles, 12 frames each are enough | Golden Hour Lagos World countdown | Kemi, Ada, Tobi, Bisi | `S12_glances.mov` |
| 13 | 1:16 | 0.5 s | 12 | Phones light up in four places at once. | Inserts of phone screens in hand, four locations | Golden Hour Lagos World going LIVE | Hands only | `S12_phones-light-up.mov` |
| 14 | 1:24 | 3.5 s | 13 | Match cut from Femi's entry photo: the same rooftop at sunset; crane up over the friends together. | Wide, crane/drone rising; same angle as Femi's photo | None | Whole cast | `S13_rooftop-crane.mov` |
| 15 | 1:30 | 2.5 s | 13 | Wide: the group laughing, Lagos glowing behind them. | Wide, golden-hour backlight | None | Whole cast | `S13_rooftop-wide.mov` |

**Also needed from the shoot**

- **Femi's rooftop photograph** (scene 12 entry; it must match the scene 13 rooftop for the match cut): landscape JPG, at least 1600 px wide, golden hour, no identifiable faces required. Save it as `final/assets/drop-in/rooftop-still.jpg`; it replaces the stock frame in the entry (the scene 13 aerial would then need a matching rooftop shot for the match cut).
- **Optional:** Bisi at her rainy window, to replace the stock window plate on the right of the scene 4 split (currently Pexels footage, no person in shot).

**Audio still to supply**

- **Final narration:** the 17 lines and timecodes in `final/project/audio.mjs` (LINES). Deliver one 1:45 WAV aligned to 00:00 as `final/assets/drop-in/vo/vo-full.wav`.
- **Final music:** licensed or commissioned track, 1:45, aligned to 00:00, as `final/assets/drop-in/music/music.wav`. If it includes Tobi's chorus, written permission for that recording and song is required before release; none is on file.
