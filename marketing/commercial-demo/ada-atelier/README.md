# Ada's Atelier: composited phone screens (commercial scene 10)

**These frames are a composite, not a live app state.** The app, database, photo storage and infrastructure were not changed.

How they were made: the real Amigo World app (commit `bac33c5`) was run locally against the `recording-1103` test database and opened at iPhone 15 Pro size in dark mode, signed in as Kemi viewing `/b/adas_atelier`. Into that rendered page, a capture script placed:
- the cover photo in the page's real cover slot (`.biz-cover`);
- the logo in the real logo slots (`.biz-logo`) and as the business's post avatar (the same swap the app makes when a logo exists);
- product photos in the real post photo grid (`post-media` / `media-tile`), with the caption style the app uses for posts that have photos.

The capture browser's clock was set to Wed 4 Nov 2026, 11:00 Lagos time (timers kept running), so the page reads "Open now". Follower count (0), likes (13), views and post wording are the real values from the recording database.

Why a composite: business logos, covers and post photos can only be files in the app's photo storage, which the recording environment can't use without new infrastructure. Business photos are a real feature, so the frames show something viewers can do; only the specific photos weren't uploaded.

## Files

| File | Shows |
| --- | --- |
| `composite-frame-1.png` | Top of the business page: cover, logo, open hours, description |
| `composite-frame-2.png` | "Behind the scenes" post with 2 photos |
| `composite-frame-3.png` | "Wedding season" post with 1 photo |
| `composite-frame-4.png` | "Fresh indigo adire" post with 2 photos (page bottom, clear of the navigation bar) |
| `preview-sheet.png` | The four frames side by side |
| `reference-before-composite.png` | The same page before compositing |
| `logo-adas-atelier.svg` | Original logo artwork made for the commercial (indigo and gold monogram) |

All frames are 1179 × 1977 px (393 × 659 pt at 3×).

## Image credits (Pexels License: free to use, attribution not required)

Photographer names weren't readable (Pexels blocks automated page reads); each photo's page is listed so credit can be added.

| Used for | Pexels page | Photo ID |
| --- | --- | --- |
| Cover: fabric shop doorway with rolls of printed cloth | [Colorful Fabrics on Display at a Market Stall](https://www.pexels.com/photo/colorful-fabrics-on-display-at-a-market-stall-30698866/) | 30698866 |
| "Behind the scenes" post, photo 1: vintage sewing machine | [Hands Stitching Fabric Using Vintage Sewing Machine](https://www.pexels.com/photo/hands-stitching-fabric-using-vintage-sewing-machine-18181977/) | 18181977 |
| "Behind the scenes" post, photo 2: fabric under the needle | [Fabric on Sewing Machine](https://www.pexels.com/photo/fabric-on-sewing-machine-7998342/) | 7998342 |
| "Wedding season" post: dresses on mannequins | [Dresses on Mannequins](https://www.pexels.com/photo/dresses-on-mannequins-14452230/) | 14452230 |
| "Fresh indigo adire" post, photo 1: indigo resist-dyed cloth | [Woman with painted hands on fabric](https://www.pexels.com/photo/woman-with-painted-hands-on-fabric-6850452/) | 6850452 |
| "Fresh indigo adire" post, photo 2: indigo dyeing | [Person Holding Wooden Clip and Wet Fabric](https://www.pexels.com/photo/person-holding-wooden-clip-and-wet-fabric-6850854/) | 6850854 |

No faces appear in any photo (hands only), so no stock model stands in for Ada. The mannequin dresses are floral prints rather than ankara; swap the photo ID in the capture script if a better match is found.

## Scene 6 continuity still (4 Nov 2026)

`composite-home-feed-femi.png`: Femi's real Home feed on `recording-1103` as it stood before scene 7 (Kemi's later post and Moment left out), with Ada's Atelier shown the way the approved frames show it: the logo in her avatar slots and the same Pexels photos above (6850452, 6850854, 14452230, 18181977, 7998342) in her three posts. Same method as frames 1–4; nothing was uploaded and the app was not changed.
