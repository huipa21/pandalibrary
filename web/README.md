# PandaLibrary web

This SvelteKit SPA is built into static assets in `build/` and embedded by the Go
application.

From the repository root:

```sh
pnpm --dir web install --frozen-lockfile
pnpm --dir web dev
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
```

The development server proxies `/api`, `/opds`, and `/kosync` to
`http://127.0.0.1:8080`. Set `VITE_API_PROXY_TARGET` to override the backend URL.
For Windows Vite crashes with `0xC0000409`, see the [development troubleshooting
guidance](../README.md#development).
Playwright is configured for later end-to-end tasks; its browser installation is separate
from the default unit-test command.

## Scanned PDF OCR (PV6)

The [OCR module](src/lib/reader/pdf/ocr/index.ts) provides scanned-page
detection, browser-only tesseract.js recognition, selectable text overlays,
localized status/retry UI, and a 5,000-page account-scoped IndexedDB LRU cache.
Results are device-local and cleared by the existing sign-out cache registry.
No PDF pages are sent to an OCR service.

**Live reader integration:** `PdfReader.setPageEnhancer()` is the page hook. Once a
page's canvas and text layer are drawn, the engine passes the enhancer the page,
character count, image-operator detection and an unrotated overlay that follows the
view rotation. Unloading, re-layout or replacing the enhancer aborts the run and
removes the overlay. [OcrLayer](src/lib/reader/pdf/ocr/OcrLayer.svelte) is mounted by
`PdfReaderView`. It lazily loads the enhancer, uses the pdf.js fingerprint and book
language, re-registers when the OCR switch changes, publishes the toolbar status chip,
and disposes workers on unmount. When PV2 replaces the engine, it must keep the same
hook contract.

The [Vite asset plugin](scripts/ocr-assets.ts) emits same-origin, content-hashed
worker/model/core files, excluded from service-worker install precaching and cached
at runtime for offline use. It ships all six tesseract.js 7 core variants, compact
English and full Chinese data. The compact Chinese model failed the required
Chinese sample; Traditional Chinese currently uses the simplified model.
Dependencies are pinned: tesseract.js 7.0.0 (Apache-2.0) and the English/Chinese
data packages 1.0.0 (MIT package metadata). Worker/core license notices accompany
the emitted assets.

Validation from the repository root (Playwright browsers must be installed):

```powershell
pnpm --dir web exec vitest run src\lib\reader\pdf\ocr src\lib\sync
pnpm --dir web check
pnpm --dir web build
pnpm --dir web exec playwright test --config src\lib\reader\pdf\ocr\playwright.config.ts
```

The production build is required for the service-worker/offline browser test.
Measured on Windows: 85 targeted unit tests and five browser tests pass (including
the live `PdfReader` hook test); the
bilingual fixture takes 3.975 s including model loading. OCR contributes no eager
engine payload to the main JavaScript bundle. Its eleven emitted files total
49,013,587 bytes; static stripped Go builds with those assets versus empty overlay
replacements differ by 49,013,760 bytes.
