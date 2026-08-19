# Samsung DeX / tablet acceptance plan

Run this on at least one recent Samsung tablet/phone with DeX and one non-Samsung Android tablet before calling a release production-ready.

## Windowing

- Launch full screen, split screen and DeX freeform window.
- Resize continuously from ~500px wide to a large external monitor window.
- Rotate the tablet while the board is open.
- Confirm toolbar, inspector and board popover never become unreachable.
- Confirm Android soft keyboard does not permanently cover the text editor.

## Input parity

- Touch: pan empty canvas, pinch zoom, select and drag objects, resize using handles.
- S Pen: draw a long stroke, make small handwriting strokes, then move the resulting drawing.
- Mouse: select, marquee, drag, wheel-pan, Ctrl+wheel zoom.
- Trackpad: two-axis pan and pinch/zoom where the platform emits wheel zoom events.
- Keyboard: all documented shortcuts, arrows, delete and temporary Space hand tool.
- Mix inputs in one session (S Pen → mouse → touch) without reloading.

## Photo stress board

Use a representative camera roll rather than duplicated synthetic files.

1. Import 100 mixed portrait/landscape photos; fit the whole board.
2. Import to 250 total; pan end-to-end and rapidly zoom from overview to a single photo.
3. Import to 500 total; repeat fit-board, pan and zoom.
4. Keep the 500-photo board open for 10 minutes and repeatedly resize the DeX window.
5. Background and foreground the app several times.

Pass criteria:
- No process crash or WebView reload.
- No permanent blank photos after returning to an area.
- UI remains interactive during import progress.
- Overview uses micro LODs without a sudden large GPU-memory jump.
- Close zoom replaces visible images with preview LOD without loading every preview.

## Persistence

- Force-stop the app and reopen it: boards and placements return.
- Create a second board, switch repeatedly, then force-stop/reopen.
- Delete a disposable board and verify it does not reappear.

## Flow / editing

- Create 20+ shapes and connect them.
- Multi-select and align a row/column.
- Rotate and resize shapes and photos.
- Lock an item and verify it cannot be dragged.
- Double-tap text and sticky notes and edit with the software and hardware keyboard.
