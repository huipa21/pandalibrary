# BC3: Cloth generated cover and cover size tokens

- Status: Done
- Wave: 1. Dependencies merged: baseline (`6a6709b`)
- Can run in parallel with: BC1, BC2
- Branch/worktree: `master` / current worktree (uncommitted; planned `task/bc3` was not created)
- Migration: no

## Read first

- [Book Cover plan](../plans/book-cover-plan.md): decisions 3 and 4, the
  "Theme tokens" and "`BookCover` props" contracts.
- `web/src/lib/bookview/BookCover.svelte`, `cover.ts` + `cover.test.ts`
  (`TONES`, `coverTone`, `truncateTitle`), `covers.e2e.ts` (selectors it
  relies on: `data-generated-cover`, `role="img"`, accessible name),
  `web/src/routes/layout.css` (`@theme`), and every `<BookCover` call site
  (`CoverActions`, `QuickViewContent`, `DetailsTab`, `FilesSummary`,
  `kit-fixture`).
- **Pasted Image 1** (the target). Six covers. Each is a cloth board (navy,
  forest green, ochre, khaki, rust, taupe) with fine noise texture, a slightly
  darker spine strip on the left, an inset double-line frame, and a cream
  rectangular label with a thin inner border holding a serif bold dark title.
  The title size adapts: "Emma" is huge, "Twenty Thousand Leagues Under the
  Seas" wraps to 5 lines. There is an optional small-caps eyebrow ("SHERLOCK
  HOLMES"), an optional italic subtitle under a hairline ("The Modern
  Prometheus"), and at the bottom a `— ◆ —` ornament above the
  letter-spaced uppercase author (gold on dark boards, dark brown on light
  boards). The covers have rounded corners and a soft shadow.

## Goal

Books without a usable cover image look like real cloth-bound books, and
every surface can size covers from one token.

## Scope

**Owns:** `BookCover.svelte`, `cover.ts` + `cover.test.ts`, the `@theme`
tokens and the `.book-grid` component class in `layout.css`, the generated
cover cases in `covers.e2e.ts`, `bc3.*` messages, and the call-site prop
additions (`subtitle`, `series`) in `CoverActions`, `QuickViewContent`,
`DetailsTab`, `FilesSummary` (pass-through only).

**Must not touch:** hover/overlay behaviour in `CoverActions` (BC4), grid
markup in pages (BC6/BC7), Bookheap (BC5).

## Subtasks

### BC3.1 – Measure and add tokens

> Run the app (dev server with the mocked or real API). At a 1440x900
> viewport, measure the rendered cover width of a dashboard row tile (`sm+`)
> and of an All Books grid tile. Set `--spacing-book` in `@theme` to their
> midpoint rounded to 0.25rem (expected ≈ `12rem`) and record both
> measurements in the hand-off. Add `--aspect-book: 2 / 3`. Add the
> `.book-grid` component class (`@layer components`): 2 fluid columns below
> `sm`, then `repeat(auto-fill, var(--spacing-book))`, `justify-content:
> start`, `gap: 1.75rem 1.25rem`. `BookCover` switches from `aspect-[3/4]` to
> `aspect-book`.

### BC3.2 – Cloth palettes and title scale (`cover.ts`)

> Replace `TONES` with 8 `CLOTH` palettes `{ name, board, spine, frame, plate,
> plateRule, ink, author }` as CSS colour strings (not Tailwind classes, so
> gradients/texture can use them): navy `#1f2f5c`, forest `#24462a`, ochre
> `#9a7618`, khaki `#7a6446`, rust `#8b3a17`, taupe `#86704f`, burgundy
> `#5e1f2a`, slate-teal `#24494d`. The plate is cream `#f3eedf` for all, ink
> is a dark tint of the board, and author is gold `#d9b768` on dark boards
> or dark brown `#3b2a17` on light boards (ochre, khaki, taupe). Keep
> `coverTone(seed)`'s hash, returning a `CLOTH` entry (rename to
> `coverCloth`, keep `coverTone` as a deprecated alias only if something
> outside the kit uses it). Add `titleScale(title)`: grapheme count ≤ 6 →
> `'xl'`, ≤ 14 → `'lg'`, ≤ 32 → `'md'`, else `'sm'`. Unit-test determinism,
> the palette spread over IDs 1-1000 (every palette used), and `titleScale`
> boundaries including CJK and emoji.

### BC3.3 – Generated cover markup (`BookCover.svelte`)

> New props: `subtitle?`, `series?`, `size` adds `'xs'`. The generated cover
> uses palette colours as CSS custom properties on the root. Layers:
> 1) the board colour + a noise texture as an inline SVG `feTurbulence`
> data-URI with `mix-blend-mode: multiply` at about 0.18 opacity, plus a soft
> vertical light-to-dark gradient;
> 2) a spine band `inset-y-0 left-0 w-[5%]` darker with a 1 px highlight on
> its right edge;
> 3) a frame: two inset borders (`inset: 5%` and `inset: 6.5%`, 1 px, `frame`
> colour at about 45%);
> 4) a plate centred horizontally at about 30% from the top, `width: 78%`,
> cream, with a 1 px inner rule inset 3 px, `box-shadow` 0 1px 2px. Inside:
> the series eyebrow (`size !== 'xs'`, uppercase, `letter-spacing: .12em`,
> ~4.5cqi, ink at 80%) with a tiny rule under it, then the title (`font-serif`
> bold, `text-wrap: balance`, size from `titleScale`: xl 17cqi / lg 12cqi / md
> 9.5cqi / sm 8cqi, line-clamp 5, or 3 for `sm`/`xs`), then the subtitle
> (italic serif ~5cqi, under a short hairline, one line clamp, hidden for
> `xs`/`sm`);
> 5) the footer at `bottom: 11%`: the ornament `— ◆ —` (author colour) and the
> first author, uppercase, `letter-spacing: .14em`, ~5cqi, truncate (hidden
> for `xs`).
> Keep `role="img"`, `aria-label={title}` and `data-generated-cover`. The
> root is `rounded-md` with `shadow-[0_1px_2px_rgb(0_0_0/.12),0_4px_12px_rgb(0_0_0/.10)]`;
> image covers get the same radius/shadow and `object-cover`. Keep the
> `onerror` fallback and the format badge slot.

### BC3.4 – Tests

> Update `covers.e2e.ts`: a long title clamps; a short title gets the `xl`
> scale (assert `data-title-scale="xl"`); series/subtitle render when given;
> the author is present; the image error falls back to the generated cover;
> `aspect-ratio` is 2/3; the 6 Image-1 titles render without overflow at
> `--spacing-book` (screenshot at 1440 attached to the test report, not a
> pixel-diff gate).

## Out of scope

Hover lift, status badge and progress (BC4). Changing page grids (BC6/BC7).

## Acceptance criteria

- [x] The generated covers follow Image 1's described structure in the app
      (screenshots in the hand-off).
- [x] Accessibility contract unchanged; no new dependency or font.
- [x] `--spacing-book`, `--aspect-book` and `.book-grid` exist, with the
      measured values in the hand-off.

## Validation commands (targeted only)

```powershell
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/bookview/cover.test.ts
pnpm --dir web exec playwright test src/lib/bookview/covers.e2e.ts
```

## Hand-off

- Measured at 1440 × 900 with a mocked API and a 16 px root font: dashboard
  cover **158 px** (160 px including its card border), All Books cover
  **257.5 px** (259.5 px including its card border). Their cover-width
  midpoint is 207.75 px; rounded to 0.25rem it is
  **`--spacing-book: 13rem` (208 px)**. `--aspect-book` is `2 / 3`.
  `.book-grid` uses two fluid columns below 40rem, then auto-fills 13rem
  columns, with `1.75rem 1.25rem` gaps and start justification. Adopting
  these tokens in existing page grids and dashboard rows remains BC6/BC7.
- `BookCover` props: `id: number`, `title: string`,
  `subtitle?: string | null`, `series?: string | null`,
  `authors?: readonly string[]`, `coverUrl?: string | null`,
  `files?: readonly BookFile[]`, `size?: 'xs' | 'sm' | 'md' | 'lg'`,
  `badge?: boolean`, `class?: string`, and `loading?: 'lazy' | 'eager'`.
  `xs` hides series, subtitle, and footer; `sm` hides the subtitle.
  The existing narrow Times serif fallback is used for `lg` titles to avoid
  splitting medium-length words; no font is downloaded.
- `coverCloth` preserves the old seed hash; `titleScale` and `truncateTitle`
  count graphemes with `Intl.Segmenter`, retaining the existing code-point
  fallback when it is unavailable. The image-error fallback, accessible
  image name, format badge, and image loading options are preserved.
- The [browser fixture](../../web/src/lib/bookview/covers.e2e.ts) attaches
  **BC3 app at 1440px** and **BC3 cloth covers at 1440px** to the Playwright
  report. The pasted reference image itself was not available in this
  checkout, so visual QA used its written description and six representative
  titles, including the named examples; no pixel-diff gate was used.
- Validation: `pnpm --dir web check` (0 errors, 0 warnings);
  `pnpm --dir web exec vitest run src/lib/bookview/cover.test.ts` (6 passed);
  `pnpm --dir web build` (passed); and the targeted `covers.e2e.ts` suite
  (10 passed). The browser run used an isolated copy of the production build
  and a session-local Playwright config because the shared preview port was
  concurrently in use.
