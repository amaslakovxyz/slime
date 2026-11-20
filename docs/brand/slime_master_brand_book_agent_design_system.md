# SLIME — Master Brand Book & Agent Design System Spec
**Version:** 3.0 (Wetware Lab Edition)<br>
**Status:** Locked Specification<br>
**Target Audience:** AI Agents, UI Engineers, Brand Designers, Technical Writers

---

## 1. Executive Brand Essence & Core Philosophy

**Slime** is a zero-endpoint, AI-native dynamic runtime. It swallows legacy databases (Postgres, ClickHouse, MySQL) and REST schemas, synthesizing isolated Wasm/V8 logic on the fly with automated Row-Level Security (RLS) and sub-millisecond execution.

### Brand Archetype: *High-Fashion Wetware Bioluminescence*
* **NOT 1980s Arcade Synthwave:** Slime avoids cheap cyan/magenta retrowave clichés.
* **Bio-Tech Precision:** Slime looks and feels like deep-sea bioluminescence, lab-grown wetware, translucent plasma gel, and hyper-dense crystal geometry.
* **Core Motto:** *"Feed the Slime. Swallows legacy APIs. Powers vibecoded UIs."*

---

## 2. Color System Architecture (v3.0 Wetware Lab)

All design implementations MUST use the following hex tokens and color roles. Never substitute generic black (`#000000`) or Tailwind slate (`#0F172A`).

```
┌────────────────────────────────────────────────────────────────────────┐
│                        CANVAS: Abyssal Plum (#0B070C)                   │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    SURFACE: Velvet Obsidian (#161019)            │  │
│  │  ┌────────────────────────────────────────────────────────────┐  │  │
│  │  │   Tier 0: GAS           Tier 1: LIQUID       Tier 2: CRYSTAL│  │  │
│  │  │   Cryo Mint (#38F8B8)   Laser Plasma (#FF1476) Diamond Quartz│  │  │
│  │  │                         Berry Shadow (#8F0043) (#F2EAFF)   │  │  │
│  │  └────────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

### Color Token Reference Table

| Token Name | Hex Code | Role & Subsurface Mechanics | Usage Rules |
| :--- | :--- | :--- | :--- |
| **Abyssal Plum** | `#0B070C` | Dark Canvas background | Warm plum undertone makes pink plasma glow 3x brighter. |
| **Velvet Obsidian** | `#161019` | Card / Surface container | Primary container background. Replaces standard blue-slate. |
| **Membrane Border** | `#2D1F33` | Surface borders & rules | Cell-wall boundaries (`1px solid`). |
| **Membrane Bright** | `#442D4D` | Active / Hover borders | Hover state for interactive cards and buttons. |
| **Laser Plasma** | `#FF1476` | Primary Accent / CTAs | Main brand color. Authoritative, high-energy crimson-magenta. |
| **Bruised Berry** | `#8F0043` | 3D Goo Shadow | Gradient stop 2 for buttons, 3D metaballs, and cards. |
| **Specular Jelly** | `#FF85C0` | Translucent Rim Highlight | Gradient stop 0 for glossy highlights & top rims. |
| **Cryo Mint** | `#38F8B8` | Tier 0 Gas / Telemetry | Bio-lab mint green accent. Creates bio-organic tension with pink. |
| **Diamond Quartz** | `#F2EAFF` | Tier 2 Crystal Foreground | Crisp white-violet for sub-millisecond AOT badges & headers. |
| **Iridescent Ice** | `#C4B5FD` | Tier 2 Crystal Secondary | Lavender glow accent for compiled binary paths. |
| **Wireframe Grey** | `#6E5C77` | Legacy API cages | Muted text & dashed lines representing old SQL/REST code. |
| **Text Pure** | `#F8F6FC` | Primary Typography | Clean off-white for titles and primary labels. |
| **Text Muted** | `#A396AC` | Secondary Typography | Subtle mauve-grey for body text and metadata. |

### CSS Custom Properties Snippet
```css
:root {
  --bg-canvas: #0B070C;
  --bg-surface: #161019;
  --bg-surface-hover: #211825;
  --border-color: #2D1F33;
  --border-bright: #442D4D;

  --plasma-primary: #FF1476;
  --plasma-shadow: #8F0043;
  --plasma-highlight: #FF85C0;

  --gas-accent: #38F8B8;
  --gas-bg: rgba(56, 248, 184, 0.1);
  --gas-border: rgba(56, 248, 184, 0.35);

  --crystal-accent: #F2EAFF;
  --crystal-glow: #C4B5FD;
  --crystal-bg: rgba(196, 181, 253, 0.12);
  --crystal-border: rgba(196, 181, 253, 0.35);

  --wireframe-grey: #6E5C77;
  --text-pure: #F8F6FC;
  --text-muted: #A396AC;
  --glow-primary: rgba(255, 20, 118, 0.35);
}
```

---

## 3. Typography System & Hierarchy

Slime uses a **strict 4-font hierarchy**. Each font has an uncompromisable duty:

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Oi              → Wordmark ("slime") & Punchlines ("Feed Slime") │
│ 2. Titan One       → Section Titles, Bento Card Titles, H1/H2       │
│ 3. Plus Jakarta    → Body text, UI labels, Buttons, Form inputs     │
│ 4. JetBrains Mono  → AST JSON, Latency (ms), SQL queries, Logs      │
└─────────────────────────────────────────────────────────────────────┘
```

1. **`Oi` (Serif Display)**
   * **Use Case:** Wordmark (`slime` lowercase), single-word impact headers, hero taglines.
   * **Style:** Always paired with `.slime-gradient-text` (Gradient from `#FF85C0` $\rightarrow$ `#FF1476` $\rightarrow$ `#8F0043`).
2. **`Titan One` (Cursive/Display)**
   * **Use Case:** Section headers, feature titles, bento grid card headings.
   * **Style:** Bold, soft-cornered typography that gives UI cards physical volume.
3. **`Plus Jakarta Sans` (Geometric Sans)**
   * **Use Case:** All body copy, paragraph text, buttons, navigation items, modal text.
   * **Style:** Font weights 400 (regular), 500 (medium), 700 (bold).
4. **`JetBrains Mono` (Monospace)**
   * **Use Case:** Code blocks, telemetry indicators, execution latencies (`2.14 ms`), state badges (`TIER 0 · GAS`), AST trees.

---

## 4. The 3 Matter-State Execution Paradigm

Every UI component, architecture diagram, or documentation block MUST communicate Slime’s 3 states of matter:

```
VAPOR (Exploratory)  ──────►  PLASMA (Warm Isolate)  ──────►  CRYSTAL (Native Binary)
Tier 0 · Gas                 Tier 1 · Liquid                  Tier 2 · Crystal
150 - 300 ms                 2 - 5 ms                         < 1 ms
#38F8B8 (Cryo Mint)          #FF1476 (Laser Plasma)          #F2EAFF (Diamond Quartz)
```

### 1. Tier 0 · Gas (Ephemeral Vapor)
* **Latency:** `150ms – 300ms`
* **Visual Styling:** Dashed borders (`stroke-dasharray`), translucent Cryo Mint badges (`#38F8B8`), subtle vapor glow.
* **Semantics:** Natural language intent fuzzing, unoptimized zero-endpoint exploration.

### 2. Tier 1 · Liquid (Plasma Cache) — *Default State*
* **Latency:** `2ms – 5ms`
* **Visual Styling:** Glowing Laser Plasma borders (`#FF1476`), 3D metaball fluid gradients, heavy drop shadows (`0 8px 30px rgba(255,20,118,0.35)`).
* **Semantics:** Viscous, self-healing V8 isolate bundles running with high surface tension.

### 3. Tier 2 · Crystal (Native AOT Binary)
* **Latency:** `< 1ms`
* **Visual Styling:** Hyper-sharp solid borders, Diamond Quartz typography (`#F2EAFF`), cold lavender glow (`#C4B5FD`), crisp geometric facets.
* **Semantics:** Immutable compiled machine code (x86_64 / ARM64 AVX-512) for hot paths (>10k executions/sec).

---

## 5. UI Component Rules & Visual Guidelines

When generating HTML, React components, or CSS for Slime:

* **Border Radii:**
  * Cards & Containers: `rounded-3xl` (`24px`) or `rounded-2xl` (`16px`).
  * Badges & Buttons: `rounded-full` or `rounded-xl` (`12px`).
* **Metaballs & Goo Physics:**
  * Use fluid, organic CSS keyframe animations (`border-radius: 42% 58% 70% 30% / 45% 45% 55% 55%`).
  * Apply multi-stop radial gradients to simulate 3D subsurface light refraction.
* **Buttons:**
  * **Primary (Plasma):** `background: linear-gradient(135deg, #FF1476, #8F0043); box-shadow: 0 4px 20px rgba(255,20,118,0.35); font-family: Plus Jakarta Sans; font-weight: 700;`
  * **Secondary (Ghost Membrane):** `background: #0B070C; border: 1px solid #442D4D; color: #FFFFFF; hover:border-#FF1476;`

---

## 6. Voice, Tone & Lexicon Rules for AI Agents

AI agents writing documentation, marketing copy, or system logs for Slime MUST adhere to these writing instructions:

### Tone Profile
* **Authoritative & Cyber-Biological:** Talk about software as a living, hyper-performant organism.
* **Unapologetically Fast:** Emphasize single-digit millisecond latency and automatic crystallization.
* **Anti-Boilerplate:** Mock static REST endpoints, manual ORM migrations, and slow cold-starts.

### Mandatory Vocabulary
| Concept | Use This Term | DO NOT Use |
| :--- | :--- | :--- |
| Dynamic API route generation | **"Intent Synthesis"** / **"Vapor-to-Crystal pipeline"** | "Auto-generated endpoints" |
| V8 Isolate memory | **"Plasma Isolate"** / **"Viscous Runtime"** | "Serverless function" |
| Query compilation | **"Crystallization"** | "Build step" / "Compilation" |
| Security rules | **"Membrane RLS"** / **"Cellular Authorization"** | "Permissions check" |
| Legacy backends | **"Legacy API Cages"** / **"Static REST"** | "Old database" |

### Copy Examples
* ❌ *Bad:* "Slime connects your database to the frontend with fast serverless APIs."
* ✅ *Good (Slime Voice):* "Slime swallows your legacy database schemas, digesting raw queries into sub-millisecond compiled Plasma isolates."

---

## 7. Directives for AI Agents Generating Code

When an AI agent is asked to write code or UI components for **Slime**, it MUST enforce the following constraints:

1. **Single-File Mandate:** For web applications or component previews, output everything in a self-contained single file containing HTML, CSS, and JS (or single-file React `.jsx`).
2. **Font Loading:** Always include the Google Fonts CDN link loading `Oi`, `Titan One`, `Plus Jakarta Sans`, and `JetBrains Mono`.
3. **Dark Mode Only:** Slime NEVER has a light mode. Canvas is always `#0B070C`.
4. **Color Strictness:** Use `#FF1476` (Laser Plasma) instead of generic `#FF007F` or `#FF1E8A`. Use `#38F8B8` (Cryo Mint) for green/gas accents instead of `#00FF00`.
5. **AST & Telemetry Visibility:** Always include live latency indicators (`X.XX ms`) and state tags (`GAS`, `LIQUID`, `CRYSTAL`) in UI components to reinforce the execution paradigm.

---
**End of Specification — Locked for Production Agent Workflows.**
