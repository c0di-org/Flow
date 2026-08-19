import { useEffect, useRef } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { isTauri } from '@tauri-apps/api/core';
import { CanvasEngine } from './CanvasEngine';
import { importPhotoPaths } from './importer';
import { screenToWorld } from './geometry';
import { boardStore } from './store';

export function CanvasView({ onImportStatus }: { onImportStatus: (text: string | null) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const engine = new CanvasEngine(hostRef.current);
    void engine.mount();
    return () => void engine.destroy();
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent((event) => {
      if (disposed || event.payload.type !== 'drop') return;
      const pos = event.payload.position;
      const world = screenToWorld({ x: pos.x, y: pos.y - 56 }, boardStore.state.camera);
      const paths = event.payload.paths.filter((path) => /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(path) || path.startsWith('content://'));
      if (!paths.length) return;
      onImportStatus(`Importing ${paths.length} photo${paths.length === 1 ? '' : 's'}…`);
      void importPhotoPaths(
        paths,
        world,
        ({ total, completed, failed }) => {
          onImportStatus(completed >= total ? (failed ? `Imported ${total - failed} · ${failed} skipped` : null) : `Importing ${completed}/${total}…`);
        },
        (_path, message) => console.warn(message),
      ).catch((error) => {
        console.error(error);
        onImportStatus('Photo import failed');
      });
    }).then((fn) => { unlisten = fn; });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onImportStatus]);

  return <div ref={hostRef} className="canvas-host" />;
}
