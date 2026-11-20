# Slime landing page

A static marketing page for Slime: one self-contained `index.html` (HTML, CSS
and a little vanilla JS), no build step. Single-file and dark-only, per the
brand book's rules for generated UI.

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

## Where things come from

- Colors, fonts and component styles:
  [docs/brand/slime_master_brand_book_agent_design_system.md](../docs/brand/slime_master_brand_book_agent_design_system.md)
  (tokens are copied into `:root` at the top of `index.html`).
- Use cases and punchlines:
  [docs/brand/slime_marketing_positioning_tone_of_voice_use_cases.md](../docs/brand/slime_marketing_positioning_tone_of_voice_use_cases.md).

## Notes

- The hero slime is three.js (pinned `three@0.170.0` from jsDelivr via an
  import map): marching-cubes metaballs in a glossy `MeshPhysicalMaterial`.
  Clicking a menu item fires a `slime:feed` event; the 3D module drops a
  droplet into the slime and it grows. If WebGL or the CDN is unavailable, a
  CSS blob stays in its place and the menu still works.

- The "How it works" demo is a scripted animation, not a live call to the
  server. Its timings (about 2.8 s for a new request, 14 ms cached) are kept in
  the range the sandbox prototype shows, so the page matches the live demo.
- Crystal is shown as "coming next" because it isn't built yet.
