# Split & Settle

A bill-splitting PWA for Thai restaurant nights — multiple restaurants, one combined bill per person, in baht.

## What it does

Add everyone once, then add each restaurant as the night goes on. Assign each dish to whoever shared it (`÷N` even split). Per restaurant, charges follow the Thai billing order exactly:

1. Food subtotal
2. Service charge — on the food subtotal
3. VAT — on food **+ service** (not food alone)
4. Restaurant total

Service and VAT can each be entered as a percentage (defaults 10% / 7%) or as the exact baht amount printed on the receipt (`% / ฿` toggle), so the app total always matches the real bill. Each person's share of service and VAT is proportional to what they ordered, allocated with a largest-remainder method so shares sum to the restaurant total **exactly** — no rounding drift.

The summary shows one bill per person across all restaurants. "Save tonight's summary as image" exports the whole night as **one** receipt-style PNG — every restaurant's items and totals (dishes shared by a subset carry each sharer's colour-initial tag) plus a settle-up block of transfer amounts rounded to the nearest baht, grouped so people owing the same rounded amount share one line, largest first — and opens the native share sheet where supported (LINE/WhatsApp), falling back to a download. Each person's card keeps a smaller "Save [name]'s bill as image" button for exporting just their own slip (via html2canvas, inlined; render scale adapts so tall slips stay within iOS canvas limits).

## Receipt scanning

"📷 Scan a receipt photo" sends a downscaled photo to the Claude API (`claude-sonnet-4-6`) and auto-fills a new restaurant card with the line items, everyone pre-assigned. Service and VAT are never auto-filled — set those from the printed receipt. Requires a Claude API key, entered under Settings and stored only in your device's localStorage. Scanning is the only feature that needs a connection.

## Files

```
index.html      the whole app (html2canvas inlined)
manifest.json   PWA manifest
sw.js           service worker — cache-first shell, works fully offline
icons/          generated icons (any + maskable + apple-touch)
calc.test.js    proof that shares sum exactly to totals (% and ฿ modes)
vercel.json     headers for sw.js / manifest
```

Everything sits at the repo root — the manifest and service worker use relative paths and break if nested.

## Run locally

```
python3 -m http.server 8000
# open http://localhost:8000
```

Test the maths: `node calc.test.js`

## Deploy (Vercel)

Static site, no build step. Import the repo at vercel.com/new, framework preset **Other**, leave build command and output directory empty, Deploy.

## Install on a phone

- **Android (Chrome):** tap the Install banner, or menu ⋮ → *Add to Home screen*.
- **iPhone (Safari):** Share → *Add to Home Screen*. (iOS doesn't allow install banners.)

Data persists in localStorage; "Start over" clears the night (keeps your API key).
