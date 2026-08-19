import { Check, Grid3X3, Image, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CanvasView } from './board/CanvasView';
import { boardStore, useBoard } from './board/store';
import { BoardSwitcher } from './components/BoardSwitcher';
import { Inspector } from './components/Inspector';
import { Toolbar } from './components/Toolbar';
import { fitBoard, ZoomControls } from './components/ZoomControls';

const toolKeys: Record<string, Parameters<typeof boardStore.setTool>[0]> = {
  v: 'select', h: 'hand', p: 'pen', r: 'rect', o: 'ellipse', n: 'sticky', t: 'text', c: 'connector',
};

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
}

export default function App() {
  const state = useBoard();
  const [status, setStatus] = useState<string | null>(null);
  const onImportStatus = useCallback((text: string | null) => setStatus(text), []);
  const previousTool = useRef<typeof state.tool | null>(null);
  const photoCount = state.document.elements.filter((element) => element.kind === 'photo').length;
  const objectCount = state.document.elements.filter((element) => element.kind !== 'connector').length;

  useEffect(() => {
    void boardStore.hydrateNative();
    const flush = () => boardStore.flush();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  useEffect(() => {
    if (!status || status.startsWith('Importing')) return;
    const timer = window.setTimeout(() => setStatus(null), 3800);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if ((event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        boardStore.deleteSelected();
      } else if (modifier && key === 'z') {
        event.preventDefault();
        event.shiftKey ? boardStore.redo() : boardStore.undo();
      } else if (modifier && key === 'y') {
        event.preventDefault();
        boardStore.redo();
      } else if (modifier && key === 'd') {
        event.preventDefault();
        boardStore.duplicateSelected();
      } else if (modifier && key === 'c') {
        event.preventDefault();
        boardStore.copySelected();
      } else if (modifier && key === 'v') {
        event.preventDefault();
        boardStore.paste();
      } else if (modifier && key === '0') {
        event.preventDefault();
        fitBoard(false);
      } else if (event.key === 'Escape') {
        boardStore.setTool('select');
        boardStore.select([]);
      } else if (event.code === 'Space' && !event.repeat) {
        event.preventDefault();
        previousTool.current = boardStore.state.tool;
        boardStore.setTool('hand');
      } else if (toolKeys[key] && !modifier) {
        boardStore.setTool(toolKeys[key]);
      } else if (event.key.startsWith('Arrow') && state.selectedIds.length) {
        event.preventDefault();
        const amount = event.shiftKey ? 10 : 1;
        if (event.key === 'ArrowLeft') boardStore.nudgeSelected(-amount, 0);
        if (event.key === 'ArrowRight') boardStore.nudgeSelected(amount, 0);
        if (event.key === 'ArrowUp') boardStore.nudgeSelected(0, -amount);
        if (event.key === 'ArrowDown') boardStore.nudgeSelected(0, amount);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space' && previousTool.current) {
        boardStore.setTool(previousTool.current);
        previousTool.current = null;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [state.selectedIds.length]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand-mark" aria-label="Flow"><Sparkles size={17} strokeWidth={1.8} /></div>
          <BoardSwitcher />
          <span className="saved-state"><Check size={12} /> Autosaved</span>
        </div>
        <div className="topbar-right">
          <span className="metric"><Image size={13} /> {photoCount}</span>
          <span className="metric object-metric"><Grid3X3 size={13} /> {objectCount}</span>
          <label className="snap-toggle" title="Snap objects to a 16px grid">
            <input type="checkbox" checked={state.settings.snapToGrid} onChange={(event) => boardStore.setSetting('snapToGrid', event.target.checked)} />
            Snap
          </label>
        </div>
      </header>

      <CanvasView onImportStatus={onImportStatus} />
      <Toolbar onImportStatus={onImportStatus} />
      <Inspector />
      <ZoomControls />

      {objectCount === 0 && (
        <div className="empty-state" aria-hidden="true">
          <div className="empty-orb"><Image size={24} /></div>
          <strong>Make some space for your ideas</strong>
          <span>Drop in photos, sketch with S Pen, or build a flow.</span>
          <small>Pinch to zoom · two-finger pan · double-tap text to edit</small>
        </div>
      )}
      {status && <div className="status-pill">{status}</div>}
    </main>
  );
}
