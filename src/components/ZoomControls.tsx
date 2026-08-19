import { Focus, Grid3X3, Minus, Plus, Scan } from 'lucide-react';
import { boardStore, useBoard } from '../board/store';

export function fitBoard(selectionOnly = false) {
  const state = boardStore.state;
  const ids = new Set(state.selectedIds);
  const elements = state.document.elements.filter((element) => element.kind !== 'connector' && (!selectionOnly || ids.has(element.id)));
  if (!elements.length) {
    boardStore.setCamera({ x: 120, y: 90, zoom: 1 });
    return;
  }
  const left = Math.min(...elements.map((element) => element.x));
  const top = Math.min(...elements.map((element) => element.y));
  const right = Math.max(...elements.map((element) => element.x + element.width));
  const bottom = Math.max(...elements.map((element) => element.y + element.height));
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const viewportWidth = window.innerWidth;
  const viewportHeight = Math.max(300, window.innerHeight - 56);
  const zoom = Math.max(0.06, Math.min(2.5, Math.min((viewportWidth - 150) / width, (viewportHeight - 170) / height)));
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  boardStore.setCamera({ x: viewportWidth / 2 - cx * zoom, y: viewportHeight / 2 - cy * zoom, zoom });
}

export function ZoomControls() {
  const state = useBoard();
  const zoomAroundCenter = (factor: number) => {
    const camera = boardStore.state.camera;
    const width = window.innerWidth;
    const height = window.innerHeight - 56;
    const center = { x: width / 2, y: height / 2 };
    const world = { x: (center.x - camera.x) / camera.zoom, y: (center.y - camera.y) / camera.zoom };
    const zoom = Math.max(0.06, Math.min(6, camera.zoom * factor));
    boardStore.setCamera({ x: center.x - world.x * zoom, y: center.y - world.y * zoom, zoom });
  };

  return (
    <div className="zoom-controls" aria-label="Canvas view controls">
      <button title="Zoom out" onClick={() => zoomAroundCenter(0.8)}><Minus size={16} /></button>
      <button className="zoom-value" title="Reset zoom" onClick={() => zoomAroundCenter(1 / state.camera.zoom)}>{Math.round(state.camera.zoom * 100)}%</button>
      <button title="Zoom in" onClick={() => zoomAroundCenter(1.25)}><Plus size={16} /></button>
      <span className="zoom-separator" />
      <button title="Fit board" onClick={() => fitBoard(false)}><Scan size={16} /></button>
      <button title="Fit selection" disabled={!state.selectedIds.length} onClick={() => fitBoard(true)}><Focus size={16} /></button>
      <button className={state.settings.showGrid ? 'active' : ''} title="Toggle grid" onClick={() => boardStore.setSetting('showGrid', !state.settings.showGrid)}><Grid3X3 size={16} /></button>
    </div>
  );
}
