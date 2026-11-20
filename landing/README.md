# Slime landing page

A static marketing page for Slime: one `index.html` (HTML, CSS and a little
vanilla JS), no build step, dark-only per the brand book. The layout follows
heroui.com (floating pill header that condenses on scroll, centred hero,
two-tone section heads, media cards, stats row); colours, fonts and copy are
Slime's own.

- `assets/state-*.webp`: the Gas / Liquid / Crystal card images, rendered
  with three.js by [`tools/render-states/`](tools/render-states/). To
  regenerate: `node landing/tools/render-states/capture.mjs landing/assets`
  (needs Google Chrome; macOS path in the script).

## Preview locally

```bash
just landing          # serves landing/ at http://localhost:8000
```

Or open `index.html` directly in a browser.

## Deploy

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) publishes this
folder to GitHub Pages on every push to `main` that touches `landing/`. It can
also be run by hand from the Actions tab.

One-time setup by a repo admin: **Settings → Pages → Build and deployment →
Source: GitHub Actions**.

The same folder is also served from AWS Lambda; see
[`infra/aws/landing/`](../infra/aws/landing/README.md).

## Where things come from

- Colors, fonts and component styles:
  [docs/brand/slime_master_brand_book_agent_design_system.md](../docs/brand/slime_master_brand_book_agent_design_system.md)
  (tokens are copied into `:root` at the top of `index.html`).
- Use cases and punchlines:
  [docs/brand/slime_marketing_positioning_tone_of_voice_use_cases.md](../docs/brand/slime_marketing_positioning_tone_of_voice_use_cases.md).

## Notes

- The hero slime is three.js (pinned `three@0.170.0` from jsDelivr via an
  import map): marching-cubes metaballs in a glossy `MeshPhysicalMaterial`.
  It is drawn on a fixed, full-viewport canvas behind the page (`z-index: 0`)
  and positioned over `.stage` each frame, so it can grow past the hero and
  the screen while content stays on top. Clicking a menu line fires a
  `slime:feed` event; the 3D module flies a droplet from the menu into the
  slime and it grows ~8% per feed. On the 10th feed (`BURST_AT`) it swells
  and bursts: shards fly at the camera and leave SVG stains on a fixed overlay
  above the page. "Clean up the mess" wipes them, resets the menu counters
  and re-forms the slime. If WebGL or the CDN is unavailable, a CSS blob stays
  in its place and the menu still works (no burst).

- The "How it works" demo is a scripted animation, not a live call to the
  server. Its timings (about 2.8 s for a new request, 14 ms cached) are kept in
  the range the sandbox prototype shows, so the page matches the live demo.
- Crystal is shown as "coming next" because it isn't built yet.
