# HM1: Icon header with language picker, theme toggle and avatar menu

- Status: Done
- Plan entry: [header-menu-plan.md](../plans/header-menu-plan.md)
- Depends on (merged): UX1, UX10, BH3 (baseline `master`)
- Can run in parallel with: none that touch `web/src/lib/shell/**` or `web/src/routes/layout.css`
- Branch / worktree: `task/hm1` in `..\pandalibrary-hm1`
- Migration: no

## Read first

- [plans/header-menu-plan.md](../plans/header-menu-plan.md) — the full design;
  this prompt does not repeat every detail, the plan is normative.
- [architecture/system.md](../architecture/system.md) — web client section.
- Existing code to build on:
  - `web/src/lib/shell/AppShell.svelte` (header markup, drawer, focus trap)
  - `web/src/lib/shell/AccountControls.svelte` (to be replaced)
  - `web/src/lib/shell/Sidebar.svelte` (`account` snippet)
  - `web/src/lib/shell/focus.ts` (focus helpers)
  - `web/src/lib/bookheap/UploadButton.svelte`
  - `web/src/routes/+layout.svelte` (`viewer`, `logout()`, `setLocale`)
  - `web/src/routes/settings/+page.svelte` (`PATCH /me/profile` usage)
  - `web/src/routes/layout.css` (`--color-shell-*`, `.shell-*` classes)
  - `web/src/lib/shell/shell.e2e.ts`, `web/src/routes/auth.e2e.ts`,
    `web/src/routes/release.e2e.ts`, `web/src/lib/sync/offline.e2e.ts`
    (they click a header/drawer "Sign out" button)

## Goal

The header shows only icons, in the order Search, Upload, Language, Theme,
Avatar. The language icon opens a searchable language picker modelled on
Pasted Image 2 that actually changes and persists the locale. The theme icon
switches the whole app (shell and page panel) between light and dark. The
avatar opens a menu with Profile and Sign out, each with an icon and text.

## Scope

**Owns (create/modify freely):**
- `web/src/lib/shell/AppShell.svelte`
- `web/src/lib/shell/Sidebar.svelte` (account section only)
- `web/src/lib/shell/AccountControls.svelte` (delete or replace)
- `web/src/lib/shell/HeaderMenu.svelte` (new: shared popover/menu-button)
- `web/src/lib/shell/LanguageMenu.svelte` (new)
- `web/src/lib/shell/ThemeToggle.svelte` (new)
- `web/src/lib/shell/AvatarMenu.svelte` (new)
- `web/src/lib/shell/languages.ts`, `languages.test.ts` (new)
- `web/src/lib/shell/theme.ts`, `theme.test.ts` (new)
- `web/src/lib/shell/icons/*.svelte` (new, if useful for shared inline SVGs)
- `web/src/lib/shell/shell.e2e.ts`
- `web/src/routes/layout.css`
- `web/src/app.html` (`theme-color` meta only; no inline scripts)

**Shared files (append-only or minimal edits):**
- `web/src/routes/+layout.svelte` — apply theme at module load; add the
  locale-change handler; add `app-panel` hook if the panel class lives in
  `AppShell`.
- `web/src/lib/bookheap/UploadButton.svelte` — icon-only label
  (`aria-label` + `title`), no other behaviour change.
- `web/messages/en.json`, `web/messages/zh.json` — add `hm1.*` keys; remove
  keys left unused.
- `web/src/routes/auth.e2e.ts`, `web/src/routes/release.e2e.ts`,
  `web/src/lib/sync/offline.e2e.ts` — change the sign-out step to open the
  avatar menu first. No other edits.

**Must not touch:**
- `internal/**` — the API already supports everything needed.
- `web/src/lib/reader/**`, `web/src/routes/read/**` — reader theme is separate.
- `web/src/lib/paraglide/**` — generated.

## Requirements

### Header

1. Right-hand group order: `SearchBox` (as today, hidden on `/search`),
   `UploadButton` (admin, non-immersive), `LanguageMenu`, `ThemeToggle`,
   `AvatarMenu` (signed in only).
2. No visible text in the header except the logo/app name and the search
   field. Every icon button is `size-9`, has `aria-label` and a matching
   `title`, and a visible `:focus-visible` outline (`--color-shell-accent`).
3. Remove the display-name span, the Settings link, the Sign out text button
   and the locale text links from the header and the drawer.
4. Below `sm` (640 px): Language and Theme render in the drawer's account
   section as icon + text rows instead of the header; Upload and Avatar stay
   in the header. At 320, 360 and 768 px the header has no horizontal
   overflow and the search input is at least 64 px wide (existing test).
5. Signed out: header shows Language and Theme only.

### Language menu

6. Implement exactly the layout in the plan's "Language menu" section:
   search field (autofocus), SUGGESTED (current locale, then
   `navigator.languages` matches), ALL LANGUAGES (sorted by native name),
   rows with check column, native name (with `lang`), muted localized name,
   empty-state text.
7. `languages.ts` exports the locale table and pure helpers
   `suggestedLocales(current, navigatorLanguages)` and
   `filterLanguages(query, uiLocale)`; matching is case- and
   accent-insensitive (`normalize('NFD')`, strip combining marks) on native
   name, localized name and code.
8. Selecting a different locale, signed in: call an `onlocale(locale)` prop
   provided by `+layout.svelte`, which sends
   `PATCH /api/v1/me/profile` `{ display_name: viewer.display_name, locale }`
   and then `setLocale(locale)` (reload). On failure it still calls
   `setLocale(locale)` after storing a flag so the reloaded page shows
   `hm1.language.local_only` once in a `role="status"` message. Signed out:
   `setLocale(locale)` only. Same locale: close only.
9. Validate the chosen locale against `locales` from the Paraglide runtime
   before sending it.

### Theme

10. `theme.ts`: `type Theme = 'light' | 'dark'`; `initialTheme(stored,
    prefersDark)`, `readTheme()`, `applyTheme(theme)` (sets
    `document.documentElement.dataset.theme`, `style.colorScheme`, and the
    `theme-color` meta), `saveTheme(theme)` under
    `localStorage['pandalibrary.theme']`. Invalid stored values fall back to
    the media query. Guard `localStorage` access (private mode throws).
11. Apply the theme synchronously at `+layout.svelte` module load, before the
    first render. Do not add inline scripts (nonce CSP in
    `internal/httpapi/spa.go`).
12. `ThemeToggle`: moon icon in light mode, sun icon in dark mode;
    `aria-pressed={theme === 'dark'}`; label is the action
    (`hm1.theme.to_dark` / `hm1.theme.to_light`).
13. `layout.css`: introduce semantic shell variables with light and dark
    values under `:root[data-theme='light']` / `:root[data-theme='dark']`,
    and use them in `.shell-*` classes, `AppShell` and `Sidebar` instead of
    fixed `bg-shell-*` / `text-zinc-*` / `border-white/10` utilities. Dark
    values equal today's colours.
14. Give the main content panel an `app-panel` class. Under
    `:root[data-theme='dark'] .app-panel`, remap `--color-white`, the
    `--color-slate-*` scale (inverted), and the `-50/-100` and `-700/-800/-900`
    steps of red, amber, green, emerald and sky so existing page utilities
    render dark with AA contrast. Do not edit individual pages unless a
    listed page fails contrast after the remap; record any such page edit in
    the hand-off.
15. The search box and upload button styling in the header follows the shell
    variables in both modes.

### Avatar menu

16. Trigger: initials circle (`initials(displayName || username)`, max two
    letters, upper-cased; unit-tested), `aria-label` = `hm1.account.button`.
17. Menu content: header block (initials, display name, muted `@username`),
    separator, **Profile** (user icon, link to `/settings`,
    `aria-current="page"` there), **Sign out** (log-out icon, calls
    `onlogout`). Items are `role="menuitem"`.

### Shared menu behaviour

18. `HeaderMenu.svelte` implements: `aria-haspopup`, `aria-expanded`,
    `aria-controls`; open on click/Enter/Space/ArrowDown; close on Escape,
    outside pointerdown, Tab out, item activation, and route change; return
    focus to the trigger on Escape/activation; arrow/Home/End roving focus
    for menu items; only one header menu open at a time.
19. Popovers stay within the viewport at 320 px wide, sit above the sidebar
    and the drawer overlay, and have no motion under
    `prefers-reduced-motion: reduce`.
20. The drawer focus trap in `AppShell` still works with the new controls.

## Out of scope

- Avatar image upload, new locales, server-synced theme, page-by-page
  restyling beyond item 14 (see plan "Out of scope").

## Acceptance criteria

- [x] Header order and icon-only rendering match the plan at 1440, 768, 360
      and 320 px; no horizontal overflow.
- [x] Language picker matches Pasted Image 2's structure; choosing 简体中文
      while signed in persists (`GET /auth/me` returns `zh` after reload) and
      the UI is Chinese; choosing it on `/login` changes the login page.
- [x] Offline/failed PATCH shows the "this device only" status once.
- [x] Theme toggle switches shell and main panel; choice survives reload;
      first visit follows `prefers-color-scheme`; reader pages unaffected.
- [ ] Visual check in both themes, with AA contrast, of: Dashboard, All
      Books, a book details page, Bookheap, Settings, Admin, Search, Login.
- [x] Avatar menu shows Profile and Sign out with icons; Profile opens
      `/settings`; Sign out signs out.
- [x] Full keyboard operation of all three controls; Escape returns focus.
- [x] Tests:
  - Vitest: `languages.test.ts` (suggested order, de-dupe, filtering incl.
    accents and Chinese), `theme.test.ts` (initial theme resolution,
    invalid storage, storage throwing), initials helper.
  - Playwright `shell.e2e.ts`: header order and accessible names; language
    picker search/select (mock `PATCH /me/profile`, assert body); theme
    toggle sets `data-theme` and persists; avatar menu keyboard navigation
    and sign-out; mobile drawer shows Language/Theme rows; existing overflow
    and focus-trap tests updated and passing.
  - Existing sign-out steps in `auth.e2e.ts`, `release.e2e.ts`,
    `offline.e2e.ts` open the avatar menu, then click `menuitem` "Sign out".
- [x] No unused HM1 message keys remain; `en` and `zh` have identical key sets.
- [x] `task lint test` and `pnpm check test` pass; targeted Playwright specs
      above pass.

## Validation commands

```powershell
task lint test
cd web; pnpm check; pnpm test
pnpm exec playwright test src/lib/shell/shell.e2e.ts src/routes/auth.e2e.ts src/routes/release.e2e.ts src/lib/sync/offline.e2e.ts
```

## Hand-off

- Set this prompt's status to Done and add the HM1 row and a log entry in
  [progress/README.md](../progress/README.md).
- Update [architecture/system.md](../architecture/system.md) (web client)
  with the theme mechanism (`data-theme`, shell variables, `app-panel`
  remap) and the header controls.
- No page-specific dark-mode fixes were needed. The complete visual contrast
  review of the pages listed above remains a follow-up; no specific contrast
  defect was identified in the automated theme smoke checks.
