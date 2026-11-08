# Header Menu (HM): icon-only header, language picker, theme toggle, avatar menu

Status: Done. Requested 2026-11-08. One task, [HM1](../prompts/HM1-header-menu.md).
Local specification only; nothing is published to GitHub.

## Request (as given, split into requirements)

| # | Requirement | Reference |
|---|---|---|
| R1 | Header menu items are **icons, no visible text** | Pasted Image 1 (today: text links) |
| R2 | Order, left to right: **Search bar, Upload, Language, Light/Dark mode, Avatar** | — |
| R3 | The **English / Chinese** text links are replaced by one **language icon** that opens a dropdown of languages | Pasted Image 2 |
| R4 | A **Light/Dark mode** toggle icon | — |
| R5 | An **avatar** icon opens a dropdown with **Profile** and **Sign out** | — |
| R6 | Every dropdown item has an **icon and text** | — |
| R7 | Sign out uses an icon | — |

## Assessment of the current code

- `web/src/lib/shell/AppShell.svelte` renders the header: menu toggle, logo,
  `SearchBox` (hidden on `/search`), `UploadButton` (admins, not on immersive
  routes), then `AccountControls variant="header"` inside a `hidden lg:block`
  wrapper. Below `lg` the same controls render in the sidebar drawer
  (`variant="drawer"`, via the `Sidebar` `account` snippet).
- `web/src/lib/shell/AccountControls.svelte` shows the display name (xl+),
  a **Settings** text link, a **Sign out** text button and one link per
  locale built with `localizeHref(pathname, { locale })`.
  **Bug:** the Paraglide strategy is `cookie, globalVariable, baseLocale`
  (no `url`), so `localizeHref` returns the same path and these links do not
  change the language. The locale is actually applied by
  `routes/+layout.svelte` from `viewer.locale` (`setLocale(..., { reload: false })`)
  and persisted by `PATCH /api/v1/me/profile` from the Settings page.
- The **Admin** link in Pasted Image 1 is from an older build; Admin now lives
  in the sidebar (`lib/nav.ts`) and stays there.
- `UploadButton.svelte` already is an icon + `sr-only sm:not-sr-only` label.
- `/settings` holds the profile form (display name, language) and app
  passwords. There is no separate profile page.
- **No app-wide theme exists.** The shell (header, sidebar) is dark
  (`--color-shell-*` in `routes/layout.css`); page content is light inside the
  `main` panel (`bg-slate-50 text-slate-950`) and pages use hard-coded Tailwind
  `slate-*`/`white` utilities. The reader has its own light/sepia/dark setting
  for book content (`lib/reader/settings.ts`), unrelated to this work.
- No icon library is installed; icons are inline 20x20 SVGs
  (`stroke="currentColor"`, `stroke-width="1.75"`). Keep that convention.
- Locales: `en`, `zh` only (`project.inlang/settings.json`). The server accepts
  only these in `auth.Service.UpdateProfile`, and `PATCH /me/profile` requires
  both `display_name` and `locale`.
- The SPA is served with a nonce-based CSP (`internal/httpapi/spa.go`); do not
  add new inline `<script>` tags to `app.html`.

## Target design

### Header layout (signed in)

```
[≡] [P PandaLibrary]           [ Search … ][Search] [⇪] [文A] [☾/☀] [(JD)]
                                 search     upload  lang  theme  avatar
```

- Right group order: **Search, Upload, Language, Theme, Avatar** (R2).
  Upload remains admin-only and hidden on immersive routes, as today.
- Language, Theme and Avatar are 36x36 px (`size-9`) round icon buttons with
  the existing `shell-icon-button` hover/focus look. Upload becomes icon-only
  at every width (its label moves to `aria-label` and a `title` tooltip) so
  all header items match (R1).
- Each icon button has an accessible name (`aria-label`) and a `title`
  tooltip with the same text. No visible text in the header.
- The avatar shows the user's initials (first letter of up to two words of
  `display_name || username`, upper-cased) on an emerald-tinted circle; it is
  not an uploaded image (no avatar storage exists).
- Signed out (`/login`, `/setup`): only **Language** and **Theme** show; no
  avatar.
- Responsive: the icon set is small enough to stay in the header at all
  widths. Below `sm` (640 px) Language and Theme move out of the header into
  the drawer's account section (icon + text rows) so search keeps at least
  64 px at 320 px wide; Avatar and Upload stay in the header. The old
  text controls in the drawer (`Settings`, `Sign out`, locale links) are
  removed; Profile and Sign out are reached through the avatar at every
  width.

### Language menu (R3, Pasted Image 2)

A popover anchored under the language button, right-aligned to it,
~20 rem wide, max height ~24 rem with an internal scroll area.

1. **Search field** at the top, autofocused on open, placeholder
   "Search languages", with a magnifier icon. Filters both sections by
   native name, localized name or code (case- and accent-insensitive).
2. **SUGGESTED** section heading (small caps style like `.shell-heading`):
   the current locale first, then supported locales matching
   `navigator.languages` (by primary subtag), de-duplicated.
3. **ALL LANGUAGES** section: every supported locale, sorted by native name.
   A locale may appear in both sections, as in the reference image.
4. Each row: a **check icon** column (visible only for the current locale),
   the **native name** (`English`, `简体中文`) with `lang` set to that locale,
   and the **localized name** right-aligned and muted (`English`,
   `Simplified Chinese` in English UI; `英语`, `简体中文` in Chinese UI).
5. Empty search result shows "No languages found".

Selecting a language:

- Signed in: `PATCH /api/v1/me/profile` with
  `{ display_name: viewer.display_name, locale }`, then
  `setLocale(locale)` (default reload) so every message re-renders. If the
  request fails (offline or error), still apply the locale on this device and
  show a status message "Language changed on this device only"; the server
  value wins at the next sign-in.
- Signed out: `setLocale(locale)` only (cookie strategy).
- Selecting the current locale just closes the menu.

Language metadata lives in one table, `web/src/lib/shell/languages.ts`:
`{ code, nativeName }` per locale plus a message key for the localized name.
Adding a locale later means adding a row and messages; the search and
sections already scale to many locales.

### Theme toggle (R4)

- Two modes, `light` and `dark`. Initial value: the stored choice, else
  `prefers-color-scheme`. The choice is stored per device in
  `localStorage['pandalibrary.theme']` (not synced to the server).
- The button shows a **moon** in light mode and a **sun** in dark mode;
  `aria-label`/`title` describe the action ("Switch to dark mode" /
  "Switch to light mode"), and `aria-pressed` reflects dark mode.
- Applied as `data-theme="light|dark"` on `<html>`, plus `color-scheme`, set
  synchronously when the root layout module loads (before first render; no
  inline script because of the CSP). Update `<meta name="theme-color">` to
  the header colour.
- **Dark** = today's look for the shell, and the main panel and its pages
  rendered dark. **Light** = a light shell (white/zinc-50 header and
  sidebar, zinc-900 text, emerald accent kept) and today's light panel.
- Implementation approach (keeps the change contained):
  - Move shell colours to semantic CSS variables in `layout.css`
    (`--shell-bg`, `--shell-surface`, `--shell-border`, `--shell-text`,
    `--shell-muted`, `--shell-hover`) with light and dark values under
    `:root[data-theme=…]`, and use them in the `.shell-*` classes and
    `AppShell`/`Sidebar` markup instead of fixed `bg-shell-900`,
    `text-zinc-*` utilities.
  - For page content, scope a palette remap to the main panel in dark mode:
    under `:root[data-theme='dark'] .app-panel` redefine Tailwind v4's
    `--color-white` and `--color-slate-50 … --color-slate-950` (inverted
    scale), and the light tints `--color-{red,amber,green,emerald,sky}-50/100`
    to dark tints, so existing utilities render dark without editing every
    page. Text colours `-700/-800/-900` of those families get lighter values
    for contrast. Book covers keep their own colours.
  - Immersive reader routes are unaffected; the reader's own theme setting
    still controls book content.
- WCAG AA contrast (4.5:1 text, 3:1 UI) must hold in both modes for the
  shell and for the pages listed in HM1's visual check.

### Avatar menu (R5-R7)

A menu (`role="menu"`) anchored under the avatar, right-aligned, ~14 rem wide:

1. Header block (not a menu item): initials circle, display name, and
   `@username` muted.
2. Separator.
3. **Profile** — user icon + "Profile"; navigates to `/settings` (the page
   that holds the profile form). Marked current when on `/settings`.
4. **Sign out** — log-out icon + "Sign out"; calls the existing `onlogout`.

### Shared popover behaviour

Both dropdowns use one small component (`HeaderMenu.svelte`) and follow the
WAI-ARIA menu-button pattern:

- Trigger has `aria-haspopup` (`menu` for avatar, `dialog` for the language
  picker because it contains a search field) and `aria-expanded`.
- Opens on click, Enter, Space or ArrowDown; Escape or outside click closes
  and returns focus to the trigger; Tab out closes it.
- Avatar menu: ArrowUp/ArrowDown/Home/End move between items. Language
  picker: ArrowDown from the search field moves into the options; options
  are `role="option"` in a `role="listbox"` with `aria-selected` on the
  current locale.
- Only one header popover open at a time. Rendered with `position: absolute`
  inside the header (z-index above the sidebar), flipping to stay inside the
  viewport on narrow screens.
- Respects `prefers-reduced-motion` (no scale/fade animation).

## Messages (en / zh)

New keys under `hm1.*`; remove keys that become unused
(`common.language_chinese`, `common.language_english`,
`catalog.language.navigation`, `auth.navigation.settings` if no longer
referenced). Examples:

| Key | en | zh |
|---|---|---|
| `hm1.language.button` | Language | 语言 |
| `hm1.language.search` | Search languages | 搜索语言 |
| `hm1.language.suggested` | Suggested | 推荐 |
| `hm1.language.all` | All languages | 所有语言 |
| `hm1.language.none` | No languages found | 未找到语言 |
| `hm1.language.name.en` | English | 英语 |
| `hm1.language.name.zh` | Simplified Chinese | 简体中文 |
| `hm1.language.local_only` | Language changed on this device only | 仅在此设备上更改了语言 |
| `hm1.theme.to_dark` | Switch to dark mode | 切换到深色模式 |
| `hm1.theme.to_light` | Switch to light mode | 切换到浅色模式 |
| `hm1.account.button` | Account menu | 账户菜单 |
| `hm1.account.profile` | Profile | 个人资料 |
| `auth.logout.submit` (existing) | Sign out | 退出登录 |

## Decisions

- **Profile → `/settings`.** It already holds the profile form; no new page.
- **Theme is per device** (localStorage), not a synced user setting.
- **Dark mode via palette remap** in the main panel rather than editing every
  page; pages can migrate to semantic tokens later.
- **No icon dependency**; inline SVGs consistent with existing icons.
- **Admin stays in the sidebar**, not the header.

## Out of scope

- Uploaded avatar images.
- Adding locales beyond `en`/`zh`.
- Syncing the theme across devices.
- Restyling individual pages beyond what the palette remap gives.
