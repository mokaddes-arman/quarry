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
| `quarry-mark.svg` | App icon and favicon source. A cut stone on a Deep Navy tile; its off-center point doubles as a speech-bubble tail. |
| `quarry-mark-mono.svg` | Single-color outline (`currentColor`) for print, stamps and one-color contexts. |
| `quarry-lockup.svg` | Mark plus wordmark for README, docs and email headers. |

- In the app, the mark is the React component `web/src/components/Logo.jsx`. Keep its paths in sync with `quarry-mark.svg`.
- Raster icons in `web/public/` are generated. After changing the mark, run `npm run icons`.
- Keep clear space around the mark of at least ¼ of its width. Don't recolor, rotate, outline or add effects.

## Color

Four colors make up the palette. There is no teal.

| Name | Hex | Role |
|---|---|---|
| **Deep Navy** | **`#172A3A`** | Primary: buttons, links, logo tile, body text, dark-mode surface |
| **Warm Ivory** | **`#F5F3ED`** | App background in light mode, sign-in page, logo stone |
| **Muted Brass** | **`#C49A5A`** | Accent: citation markers, logo crown, dark-mode primary actions |
| **Slate** | **`#718096`** | Secondary text, icons, disabled states |

### Primary: Deep Navy (`brand-*` in Tailwind)
| Token | Hex | Use |
|---|---|---|
| brand-50 | `#EEF1F4` | Selected-row tint |
| brand-100 | `#DCE2E8` | Badges, subtle fills |
| brand-200 | `#B9C5D0` | Borders on tinted panels |
| brand-300 | `#93A4B5` | Links in dark mode |
| brand-400 | `#718096` | Disabled primary (Slate) |
| brand-500 | `#3F5468` | Focus rings |
| **brand-600** | **`#172A3A`** | **Primary (Deep Navy)** |
| brand-700 | `#0E1C28` | Hover |
| brand-800 … 950 | `#0B1620` … `#050B10` | Deep tints for dark mode |

In dark mode, `brand-500/600/700` switch to brass (`#C49A5A` / `#D4B381`), with navy text on brass buttons, because a navy button disappears on a navy background.

### Accent: Muted Brass (`brass-*`)
| Token | Hex | Use |
|---|---|---|
| brass-300 | `#E2CCA6` | Badge fill, dark-mode badge text |
| brass-400 | `#D4B381` | Logo highlight, dark-mode hover |
| **brass-500** | **`#C49A5A`** | **Citation markers, logo crown** |
| brass-600 | `#A88043` | |
| brass-700 | `#7D5F31` | Brass text on light backgrounds |

### Neutrals (`slate-*`, redefined)
Tailwind's `slate` scale is replaced in `web/src/index.css`. It runs from Warm Ivory at `slate-50` through Slate at `slate-500` to Deep Navy at `slate-900`, so every existing neutral class follows the palette.

| Token | Hex | | Token | Hex |
|---|---|---|---|---|
| slate-50 | `#F5F3ED` (Warm Ivory) | | slate-600 | `#56657A` |
| slate-100 | `#EDEAE2` | | slate-700 | `#3E4E61` |
| slate-200 | `#E0DCD2` | | slate-800 | `#283B4C` |
| slate-300 | `#CACBC9` | | slate-900 | `#172A3A` (Deep Navy) |
| slate-400 | `#9AA4B1` | | slate-950 | `#0F1E2B` |
| slate-500 | `#718096` (Slate) | | | |

The logo's shaded facet uses `#D9D3C5`, a darker ivory used only in the mark.

### Rules
- White on Deep Navy is about 14:1, and navy on brass is about 5.7:1. Both pass WCAG AA.
- Brass-500 is a fill color. For brass text on light backgrounds use brass-700.
- Slate `#718096` on white is about 4:1. Use it for secondary text and icons, not long body copy.
- Brass marks **sources and citations** in light mode. Don't spend it on generic light-mode buttons.
