import { useEffect, useRef } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { isTauri } from '@tauri-apps/api/core';
import { CanvasEngine } from './CanvasEngine';
import { importPhotoFiles, importPhotoPaths } from './importer';
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

  // The Tauri drag-drop event never fires in a browser, so the web build binds
  // the DOM equivalent and feeds the dropped File objects to the web importer.
  useEffect(() => {
    const host = hostRef.current;
    if (isTauri() || !host) return;
    const allowDrop = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (event: DragEvent) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (!files.length) return;
      event.preventDefault();
      const world = screenToWorld({ x: event.clientX, y: event.clientY - 56 }, boardStore.state.camera);
      onImportStatus(`Importing ${files.length} photo${files.length === 1 ? '' : 's'}…`);
      void importPhotoFiles(
        files,
        world,
        ({ total, completed, failed }) => {
          onImportStatus(completed >= total ? (failed ? `Imported ${total - failed} · ${failed} skipped` : null) : `Importing ${completed}/${total}…`);
        },
        (_name, message) => console.warn(message),
      ).catch((error) => {
        console.error(error);
        onImportStatus('Photo import failed');
      });
    };
    // Without this, a photo dropped just off the canvas makes the browser
    // navigate away from the board and open the file instead.
    const swallowStrayDrop = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    host.addEventListener('dragover', allowDrop);
    host.addEventListener('drop', onDrop);
    window.addEventListener('dragover', swallowStrayDrop);
    window.addEventListener('drop', swallowStrayDrop);
    return () => {
      host.removeEventListener('dragover', allowDrop);
      host.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', swallowStrayDrop);
      window.removeEventListener('drop', swallowStrayDrop);
    };
  }, [onImportStatus]);

  return <div ref={hostRef} className="canvas-host" />;
}
