# Flow architecture

## Design goal

The primary constraint is not element count by itself; it is **decoded image residency**. A board containing 300 photo objects is cheap if only small LODs are resident, and extremely expensive if the originals or 1600px previews are all decoded simultaneously.

Flow therefore separates four layers:

1. **Original asset storage** — private app-data files, never rendered directly.
2. **Derivative generation** — Rust produces micro, thumbnail and preview WebPs sequentially.
3. **Board document** — small JSON metadata referencing asset paths.
4. **GPU residency** — Pixi textures are attached only when spatially relevant and released through an LRU pool.

## Photo import sequence

1. The OS picker/drop returns a path or URI.
2. `tauri-plugin-fs` opens it. On Android this includes `content://` URIs.
3. The source is streamed into `AppData/boards/<board-id>/assets/originals` with a 750MB guard.
4. `image` inspects dimensions before full decode and rejects pathological pixel counts.
5. The source is decoded once, orientation is applied, and 1600/420/160 derivatives are generated.
6. Import progress is streamed over a Tauri IPC channel.
7. The frontend adds the entire imported batch as one undoable board action.

## Rendering

Pixi owns board content. React only owns application chrome (toolbar, board switcher, inspector, zoom controls), which means hundreds of photo objects do not create hundreds of DOM subtrees.

Photo LOD is selected from projected width:
- below ~180 screen px → micro
- normal navigation → thumbnail
- above ~520 screen px → preview

Only photos inside the viewport plus a prefetch margin have a texture attached. Texture loads are limited to four concurrent uploads. Camera motion performs cheap visibility checks for photo records, while ordinary object edits use per-element dirty updates so moving one item does not redraw hundreds of unchanged photo frames.

The backing framebuffer is also bounded. Android uses a more conservative device-pixel budget and disables expensive canvas MSAA, preventing a high-DPI DeX window from consuming the photo-memory budget before the board is even populated. Texture residency is rebuilt cleanly after graphics-context restoration.

## Input model

All board coordinates are world coordinates. Camera transform is `{x, y, zoom}`.

- Mouse/trackpad: wheel pan; Ctrl/⌘ + wheel zoom; middle/right/hand drag pans.
- Touch: one-finger empty-canvas drag pans; two-finger gesture continuously updates zoom and center.
- Stylus: pen tool records world-space points.
- Keyboard: tool shortcuts, nudge, history and clipboard commands.

React controls and Pixi canvas both use touch-safe hit targets; no essential action depends on hover.

## Persistence

The current document is saved quickly to local storage for low-latency recovery and mirrored to native app data through recoverable temp/backup replacement. If a save is interrupted between filesystem operations, the previous JSON mirror remains available as a fallback. Startup reconciles local and native copies by modification time. Orphan-photo cleanup runs only after that reconciliation so a newer local recovery copy cannot lose assets merely because its native JSON mirror was interrupted.

Photos are stored per board. Deleting a board removes its native board directory, including its photo assets.

## Scale assumptions

The intended high-confidence target is roughly **200–500 photos on one board**, not thousands. At whole-board zoom, the 160px micro LOD puts 500 square RGBA textures at roughly 49 MiB before implementation overhead; real photos generally consume less because one edge is below 160px. Closer zoom naturally reduces the number of simultaneously visible photos before the renderer switches to larger LODs. Collage placement always preserves each source aspect ratio, including extreme portrait and panorama images.
