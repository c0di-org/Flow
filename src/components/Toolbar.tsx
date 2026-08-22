import {
  Circle,
  Hand,
  ImagePlus,
  MousePointer2,
  PenLine,
  Square,
  StickyNote,
  Type,
  Workflow,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type { Tool } from '../board/types';
import { boardStore, useBoard } from '../board/store';
import { choosePhotos, importPhotoFiles, importPhotoPaths, pickPhotoFiles } from '../board/importer';
import { isTauri } from '@tauri-apps/api/core';
import { screenToWorld } from '../board/geometry';

const tools: Array<{ tool: Tool; label: string; key: string; icon: ComponentType<{ size?: number; strokeWidth?: number }> }> = [
  { tool: 'select', label: 'Select', key: 'V', icon: MousePointer2 },
  { tool: 'hand', label: 'Pan', key: 'H', icon: Hand },
  { tool: 'pen', label: 'Pen', key: 'P', icon: PenLine },
  { tool: 'rect', label: 'Box', key: 'R', icon: Square },
  { tool: 'ellipse', label: 'Ellipse', key: 'O', icon: Circle },
  { tool: 'sticky', label: 'Note', key: 'N', icon: StickyNote },
  { tool: 'text', label: 'Text', key: 'T', icon: Type },
  { tool: 'connector', label: 'Connect', key: 'C', icon: Workflow },
];

export function Toolbar({ onImportStatus }: { onImportStatus: (text: string | null) => void }) {
  const state = useBoard();

  const addPhotos = async () => {
    const selection = isTauri() ? await choosePhotos() : await pickPhotoFiles();
    if (!selection.length) return;
    const canvasTop = 56;
    const center = screenToWorld({ x: window.innerWidth / 2, y: (window.innerHeight - canvasTop) / 2 }, boardStore.state.camera);
    onImportStatus(`Importing ${selection.length} photo${selection.length === 1 ? '' : 's'}…`);
    const report = ({ total, completed, failed }: { total: number; completed: number; failed: number }) => {
      onImportStatus(completed >= total ? (failed ? `Imported ${total - failed} · ${failed} skipped` : null) : `Importing ${completed}/${total}…`);
    };
    try {
      if (isTauri()) {
        await importPhotoPaths(selection as string[], center, report, (_path, message) => console.warn(message));
      } else {
        await importPhotoFiles(selection as File[], center, report, (_name, message) => console.warn(message));
      }
    } catch (error) {
      console.error(error);
      onImportStatus('Photo import failed');
    }
  };

  return (
    <nav className="toolbar" aria-label="Canvas tools">
      <button className="tool tool-primary" title="Add photos" aria-label="Add photos" onClick={() => void addPhotos()}>
        <ImagePlus size={21} strokeWidth={1.9} />
        <small>Photos</small>
      </button>
      <div className="separator" />
      {tools.map(({ tool, label, key, icon: Icon }) => (
        <button
          key={tool}
          className={`tool ${state.tool === tool ? 'active' : ''}`}
          title={`${label} · ${key}`}
          aria-label={label}
          aria-pressed={state.tool === tool}
          onClick={() => boardStore.setTool(tool)}
        >
          <Icon size={20} strokeWidth={1.8} />
          <small>{label}</small>
        </button>
      ))}
    </nav>
  );
}
