# Reservation site (reserve.amigoworld.com.ng)

Closed at launch (24 Nov 2026): every address redirects (temporary, 307) to https://amigoworld.com.ng,
except `/privacy`, which people who reserved a name were given. Reserved names stay held in the
database for their owners to claim by signing up with the same email. To reopen the site, remove
`redirects` from `vercel.json`.

Vercel only rebuilds this project when the latest commit changes something under `reserve/`.
