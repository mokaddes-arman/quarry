# Quarry — brand guide

## Name
**Quarry.** You dig the answer out of material you already have. It is also a quiet pun on *query*.
Write it as **Quarry** in sentences. The wordmark is lowercase **quarry**.

## Vision
> *Dig the answer out of what you already have.*

Quarry answers questions from your team's own documents and shows the passage each answer came from.
If the answer isn't in your documents, Quarry says so instead of guessing.

**Taglines**
- Short: *Answers from your own documents.*
- Long: *Answers from your documents, with the page they came from.*

## Voice
- Plain, confident and specific, like a careful librarian or engineer.
- Talk about documents, sources, pages and answers.
- Avoid: "AI-powered", "magic", "supercharge", "unlock", "revolutionize", "next-gen".
- No sparkle ✨, brain or robot imagery. No purple or blue gradients.

## Logo
| File | Use |
|---|---|
| `quarry-mark.svg` | App icon and favicon source. A cut stone on a slate-teal tile; its off-center point doubles as a speech-bubble tail. |
| `quarry-mark-mono.svg` | Single-color outline (`currentColor`) for print, stamps and one-color contexts. |
| `quarry-lockup.svg` | Mark plus wordmark for README, docs and email headers. |

- In the app, the mark is the React component `web/src/components/Logo.jsx`. Keep its paths in sync with `quarry-mark.svg`.
- Raster icons in `web/public/` are generated. After changing the mark, run `npm run icons`.
- Keep clear space around the mark of at least ¼ of its width. Don't recolor, rotate, outline or add effects.

## Color

### Primary: slate teal (`brand-*` in Tailwind)
| Token | Hex | Use |
|---|---|---|
| brand-50 | `#F1F6F6` | Selected-row tint |
| brand-100 | `#DCE9EA` | Badges, subtle fills |
| brand-200 | `#BAD3D5` | Borders on tinted panels |
| brand-300 | `#8FB5B8` | Links and accents in dark mode |
| brand-400 | `#5F9095` | Disabled primary |
| brand-500 | `#43747A` | Focus rings |
| **brand-600** | **`#2F5D62`** | **Primary: buttons, links, logo tile** |
| brand-700 | `#274D51` | Hover |
| brand-800 | `#213F43` | |
| brand-900 | `#1C3437` | Dark-mode tinted fills |
| brand-950 | `#16292B` | Deep slate: headings on limestone |

### Accent: ochre (`ochre-*`)
| Token | Hex | Use |
|---|---|---|
| ochre-300 | `#EBC77F` | Logo highlight, badge fill |
| ochre-400 | `#E2B55C` | |
| **ochre-500** | **`#D9A441`** | **Citation markers, logo crown** |
| ochre-600 | `#B9862B` | |
| ochre-700 | `#93681F` | Ochre text on light backgrounds |

### Surfaces and neutrals
- **Limestone `#F5F3EE`:** sign-in background, manifest background, and the logo stone.
- **Stone shade `#CFC8B8`:** the shaded facet of the logo only.
- App neutrals use Tailwind `slate-*`.

### Rules
- White on brand-600 has a contrast of about 7:1, which passes AA and AAA.
- Ochre-500 is a fill color only. Never use it for body text on white; use ochre-700 instead.
- Ochre marks **sources and citations**. Don't spend it on generic buttons.
