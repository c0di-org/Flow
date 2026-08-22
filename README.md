# Flow

**Flow** is a photo-first infinite canvas built with Tauri 2, React and PixiJS 8. It takes the useful parts of Apple Freeform—spatial thinking, giant visual boards, notes, drawing and flow-charting—and puts photo-collage stability first.

## What is implemented

### Canvas & creation
- Infinite pan/zoom board with trackpad, mouse and two-finger touch gestures
- S Pen / stylus-friendly freehand drawing
- Photos, rectangles, ellipses, sticky notes and free text
- Two-click smart connectors that stay attached as shapes move, with selectable line styling and labels
- Double-click / double-tap text editing
- Marquee and Shift multi-selection
- Drag, keyboard nudge, resize and rotation handles
- Duplicate, copy/paste, lock/unlock, bring-to-front and send-to-back
- Multi-object alignment and photo re-collage
- Optional grid and 16px snapping
- Zoom controls, fit-board and fit-selection
- Undo/redo

### Boards
- Multiple boards with a compact board switcher
- Rename, create, switch and delete boards
- Local instant persistence plus a native JSON mirror under the Tauri app-data directory
- Native recovery/merge on startup if WebView local storage is missing or older
- Per-board photo asset directories

### Photo pipeline
Flow never uploads original-resolution images to the GPU. Every import is copied into private app data and gets three bounded WebP derivatives:

| LOD | Max edge | Purpose |
| --- | ---: | --- |
| Micro | 160px | Whole-board overview / hundreds of visible photos |
| Thumbnail | 420px | Normal collage navigation |
| Preview | 1600px | Close zoom |

The renderer chooses LOD from projected on-screen size, only attaches textures in/near the viewport, caps upload concurrency at four textures, and releases offscreen textures. The estimated GPU texture budget is device-aware: Android/mobile receives a conservative budget, while higher-memory desktops can retain more.

The native importer deliberately decodes **one source image at a time** on a blocking Rust worker. This avoids the large transient RAM spike caused by decoding a big drag/drop batch concurrently. Individual images also have source-byte and decoded-pixel safety limits; the current tablet-safe decode cap is 55 megapixels per source image.

Supported by the built-in decoder: JPEG, PNG, WebP, GIF, BMP and TIFF. HEIC/HEIF is intentionally not bundled yet because a correct desktop + Android + iOS implementation requires shipping and maintaining an additional native HEIF codec stack.

## Samsung DeX / Android large screens

The UI is adaptive rather than a fixed desktop canvas:
- No hover-only controls; all actions are reachable by touch
- Coarse-pointer hit targets become larger automatically
- Toolbar becomes compact and horizontally scrollable in narrow windows
- Inspector becomes a bottom floating sheet in tablet-sized layouts
- Mouse, trackpad, keyboard, touch and stylus can be mixed in the same session
- Two-finger pinch + pan is handled independently from Pixi object dragging
- Tauri window minimums are low enough for DeX freeform resizing
- `scripts/configure-android.mjs` makes the generated Android activity explicitly resizable and marks support for runtime size changes
- Android `content://` photo-picker URIs are read through `tauri-plugin-fs`, not treated as desktop paths

After installing the Android prerequisites:

```bash
npm install
npm run android:init
npm run android:dev
```

For a release AAB:

```bash
npm run android:build
```

See [`docs/DEX_TEST_PLAN.md`](docs/DEX_TEST_PLAN.md) for the device acceptance checklist.

## Desktop development

Requirements: Node.js, Rust and the normal Tauri 2 platform prerequisites.

```bash
npm install
npm run tauri dev
```

Frontend-only browser preview:

```bash
npm run dev
```

Production frontend build:

```bash
npm run build
```

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `V` | Select |
| `H` | Hand / pan |
| `P` | Pen |
| `R` | Rectangle |
| `O` | Ellipse |
| `N` | Sticky note |
| `T` | Text |
| `C` | Connector |
| Hold `Space` | Temporary hand tool |
| `⌘/Ctrl Z` | Undo |
| `⌘/Ctrl Shift Z` / `Ctrl Y` | Redo |
| `⌘/Ctrl D` | Duplicate |
| `⌘/Ctrl C`, `⌘/Ctrl V` | Copy / paste selected board objects |
| `⌘/Ctrl 0` | Fit board |
| Arrow keys | Nudge selection |
| Shift + Arrow | Nudge 10px |
| Delete / Backspace | Delete selection |

## Web build

The same bundle runs in a plain browser at [flow.c0di.com](https://flow.c0di.com). Every native call is guarded by `isTauri()`, and the browser gets its own photo pipeline:

- Photos come in through a file input or a drag-and-drop onto the canvas.
- Derivatives are generated with `createImageBitmap` + canvas at the same 1600/420/160 edges the Rust importer uses.
- Blobs are stored in IndexedDB (`flow.webAssets.v1`) and referenced from the board as `webphoto:<id>:<variant>` keys, so board JSON in localStorage stays small.
- Orphaned blobs are collected on startup, mirroring the native `cleanup_orphan_assets` pass.

Deploy with `npm run build && npx wrangler deploy` (see [`wrangler.jsonc`](wrangler.jsonc)).

## Architecture

- `src/board/CanvasEngine.ts` — Pixi renderer, input, culling/LOD and selection affordances
- `src/board/PhotoTexturePool.ts` — device-aware texture residency and upload queue
- `src/board/store.ts` — document model, board library, commands, history and persistence
- `src-tauri/src/photo_import.rs` — bounded native image ingest / derivative generation
- `src-tauri/src/board_storage.rs` — native board mirror with recoverable temp/backup replacement

More detail is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Validation

CI is configured to install frontend dependencies, run the TypeScript/Vite production build, and run `cargo check` for the Tauri backend on Linux. Android/DeX still needs a real-device pass because GPU/WebView limits are device-dependent; the repository includes a concrete acceptance test rather than claiming a simulator proves memory stability.
