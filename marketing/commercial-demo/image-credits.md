# Commercial demo: image credits (verify-1029 test database only)

Profile pictures for the fictional demo accounts on the **verify-1029 test branch**. Every image is free to use under the [Unsplash License](https://unsplash.com/license) (checked 3 Nov 2026; none is Unsplash+). They show objects and places only, never a person's face, so no stock model stands in for a cast member.

The app loads each one straight from Unsplash's CDN (`images.unsplash.com`, the hot-linking Unsplash asks for), sized `w=400&h=400&fit=crop&crop=entropy&q=75&fm=jpg`. Nothing was uploaded to the photo-storage bucket that the Preview shares with Production.

| Account | Image | Photographer | Unsplash page | Image ID |
| --- | --- | --- | --- | --- |
| @tobi_sounds (Tobi, cast) | Headphones on a studio microphone | [Will Francis](https://unsplash.com/@willfrancis) | [page](https://unsplash.com/photos/black-and-silver-headphones-on-black-and-silver-microphone-ZDNyhmgkZlQ) | `photo-1589903308904-1010c2294adc` |
| @ada_nwosu (Ada, cast) | Rolls of wax-print fabric, Adjamé Market, Abidjan | [Eva Blue](https://unsplash.com/@evablue) | [page](https://unsplash.com/photos/assorted-color-textiles-SfPOkp6-2eA) | `photo-1552710307-537199cd41c0` |
| @kemi_okafor (Kemi, cast) | Sunset on the Lagos skyline | [Chibuzo Nwaneri](https://unsplash.com/@dvke_) | [page](https://unsplash.com/photos/the-sun-is-setting-over-the-ocean-with-buildings-in-the-background-gE3ign9Lx1Q) | `photo-1638437155671-167865b8bd49` |
| @bisi_lawal (Bisi, cast) | Rainy window, city lights at night | [Jahanzeb Ahsan](https://unsplash.com/@jahan_photobox) | [page](https://unsplash.com/photos/rainy-window-with-blurred-city-lights-at-night-PQyC6hrKPS4) | `photo-1761378697895-9f3c7b79ec8c` |
| @femi_frames (Femi, cast) | Classic camera on a wooden surface | [Annie Spratt](https://unsplash.com/@anniespratt) | [page](https://unsplash.com/photos/classic-black-camera-on-brown-wooden-surface-biAK9xAjrvM) | `photo-1481933236927-d92e97e3194c` |
| @chidi_eze | LinnDrum drum machine | [Steve Harvey](https://unsplash.com/@trommelkopf) | [page](https://unsplash.com/photos/close-view-of-linn-drum-machine-5zuCqOLaSyw) | `photo-1571512379797-4613cb587cc0` |
| @amara_obi | Watercolour palette (a hand only) | [Fallon Michael](https://unsplash.com/@fallonmichaeltx) | [page](https://unsplash.com/photos/paint-palette-1yZI30karxI) | `photo-1578521157034-273977158e71` |
| @seyi_shoots | Idumota, Lagos Island, from above | [Opeyemi Adisa](https://unsplash.com/@niceyem) | [page](https://unsplash.com/photos/a-busy-city-street-filled-with-lots-of-traffic-cFT_Xq4XyA0) | `photo-1648023199223-25d3622bcb13` |
| @zainab_lens | Camera lens close-up | [Colin Lloyd](https://unsplash.com/@onthesearchforpineapples) | [page](https://unsplash.com/photos/a-close-up-view-of-a-camera-lens-9rTwYexYgJw) | `photo-1637100000835-1f3a7b2001f5` |
| @uche_nnaji | Football on grass | [Lukáš Parničan](https://unsplash.com/@lukasparnican) | [page](https://unsplash.com/photos/a-soccer-ball-rests-on-the-fields-grass-bZIbDiD3dnY) | `photo-1746333253387-5aac26260c96` |
| @funke_adeyemi | Jollof rice with chicken | [Keesha's Kitchen](https://unsplash.com/@keeshasskitchen) | [page](https://unsplash.com/photos/a-plate-of-food-b4Ht8TQ1JGo) | `photo-1664993101841-036f189719b6` |
| @ibrahim_sule | Acoustic guitar close-up | [Taya](https://unsplash.com/@tayaiv) | [page](https://unsplash.com/photos/close-up-photograph-of-black-dreadnought-acoustic-guitar-sBr-g8wJw5k) | `photo-1505859208100-4a17362f784b` |
| @ngozi_ike | Stack of books with coffee | [Abhishek Tiwari](https://unsplash.com/@abhi_2410) | [page](https://unsplash.com/photos/stack-of-books-with-a-cup-of-coffee-RH-WY45Y0l0) | `photo-1770393985997-06479d624614` |

Notes
- The Unsplash License allows free use, including commercial use, without attribution; credit is kept here anyway. It doesn't allow selling the photos unaltered or using them to build a competing photo service.
- These are stand-ins for the test feed. If any profile picture is visible in the final film, decide whether to keep it (credit optional) or replace it with consented photos of the cast.
- Post photos, Moment photos and the business logo/cover were **not** added: the database only accepts keys in the shared photo bucket for those.
