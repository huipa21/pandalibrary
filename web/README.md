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

## Menu icons

Navigation and action menus show leading icons. Library and collection create/edit
forms offer a shared icon picker, and choices are saved with the entity. Entities
without a selected icon receive a pseudo-random icon derived from their type and ID,
so their fallback stays consistent across navigation and reloads.

## Scanned PDF OCR (PV6)

The [OCR module](src/lib/reader/pdf/ocr/index.ts) provides scanned-page
detection, browser-only tesseract.js recognition, selectable text overlays,
localized status/retry UI, and a 5,000-page account-scoped IndexedDB LRU cache.
Results are device-local and cleared by the existing sign-out cache registry.
No PDF pages are sent to an OCR service.

**Live reader integration:** the engine's `addPageEnhancer()` is the page hook. Once a
page's canvas and text layer are drawn, the engine passes the enhancer the page,
character count, image-operator detection and an unrotated overlay that follows the
view rotation. Unloading, re-layout or removing the enhancer aborts the run and
removes the overlay. PV8's [ocr-wiring](src/lib/reader/pdf/marks/ocr-wiring.ts), driven by
[MarksLayer](src/lib/reader/pdf/marks/MarksLayer.svelte) inside `PdfReaderView`, lazily
loads and registers the enhancer once (pdf.js fingerprint, book language), runs it only
in the Select tool, calls `rerunEnhancers()` when the OCR switch flips or Select is
re-entered (switching off removes the OCR layers), publishes the toolbar status chip,
and disposes workers on unmount. The recognized `.pv-ocr-text` layer is a `.textLayer`,
so the selection toolbar and text marks work on it unchanged.
The older `OcrLayer.svelte` component is no longer mounted.

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

### CJK fonts for the OCR browser gate

The fixture prefers `Noto Sans CJK SC`, with Source Han Sans, WenQuanYi Zen Hei,
SimSun, PingFang and YaHei fallbacks, for `扫描样本`. A Linux host without a CJK
font renders tofu boxes, so OCR cannot recognize the sample. Install Noto CJK and
the Latin substitutes on the host before running the gate:

```sh
sudo apt-get update
sudo apt-get install -y fonts-noto-cjk fonts-liberation2
sudo fc-cache -f
fc-match SimSun   # must report Noto Serif CJK SC, not DejaVu Serif
```

Without root, extract the same Debian package into the user font directory and
use the repository's fontconfig aliases:

```sh
apt-get download fonts-noto-cjk
dpkg-deb -x fonts-noto-cjk_*.deb /tmp/noto-cjk
mkdir -p ~/.local/share/fonts/noto-cjk ~/.config/fontconfig/conf.d
cp /tmp/noto-cjk/usr/share/fonts/opentype/noto/*.ttc ~/.local/share/fonts/noto-cjk/
cp deploy/ocr-e2e/fonts.conf ~/.config/fontconfig/conf.d/99-pandalibrary-cjk.conf
fc-cache -f
```

`fonts-noto-cjk` includes regular/bold Sans and Serif faces for Simplified
Chinese, Traditional Chinese, Japanese and Korean. `fonts-noto-cjk-extra` is
only needed for additional weights. The English sample is covered by
`fonts-liberation2` and the Latin glyphs in the Noto CJK faces. Keep the Sans
face first in the fixture: the full Chinese model recognized the Serif/SimSun
shapes as `扫插杵本` in local testing, while the Sans sample passed.

For a reproducible run, build the dedicated Playwright image. It installs the
same fonts, maps common Windows/macOS CJK families with
[`deploy/ocr-e2e/fonts.conf`](../deploy/ocr-e2e/fonts.conf), and fails its build
if `SimSun` does not resolve to Noto Serif CJK SC:

```sh
docker build -f Dockerfile.ocr-e2e -t localhost/pandalibrary-ocr-e2e:latest .
docker run --rm --init --ipc=host localhost/pandalibrary-ocr-e2e:latest
```

For Podman use `podman build` and `podman run` with the same arguments. The
image runs `pnpm build` during the build and then `pnpm test:e2e:ocr`. The
official Playwright base contains Chromium, Firefox and WebKit, so this test
image is several gigabytes; it is not a production artifact.

Do **not** add Chromium or CJK packages to the production `Dockerfile`. Its
final stage is `scratch`, and OCR is browser-side, so fonts installed in the
server image never reach the client's Chromium. Add them only to this test
image (or the CI runner). Server-side rendering, if added later, needs its own
renderer image.

OCR language data is separate from font coverage. The shipped models are
`chi_sim` and `eng`; adding Japanese OCR later requires
`@tesseract.js-data/jpn`, an `OcrLanguage` entry and `ocrLanguagesFor()` mapping
in `src/lib/reader/pdf/ocr/languages.ts`, and the asset list in
`scripts/ocr-assets.ts`. Future scripts need their own font package or webfont;
Noto CJK covers only CJK.
