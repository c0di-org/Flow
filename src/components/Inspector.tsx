import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  BringToFront,
  Copy,
  Grid2X2,
  Lock,
  SendToBack,
  Trash2,
  Unlock,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { boardStore, useBoard } from '../board/store';
import type { BoardElement } from '../board/types';

const toHex = (value: number) => `#${value.toString(16).padStart(6, '0').slice(-6)}`;
const fromHex = (value: string) => Number.parseInt(value.replace('#', ''), 16);

function IconButton({ title, children, onClick }: { title: string; children: ReactNode; onClick: () => void }) {
  return <button className="inspector-icon-button" title={title} aria-label={title} onClick={onClick}>{children}</button>;
}

export function Inspector() {
  const state = useBoard();
  if (!state.selectedIds.length) return null;
  const selected = state.document.elements.filter((element) => state.selectedIds.includes(element.id));
  if (!selected.length) return null;
  const primary = selected[0];
  const allLocked = selected.every((element) => element.locked);
  const photos = selected.filter((element) => element.kind === 'photo');
  const opacity = Math.round((primary.opacity ?? 1) * 100);

  const update = (patch: Partial<BoardElement>) => boardStore.updateSelected(patch);

  return (
    <aside className="inspector" aria-label="Selection inspector">
      <div className="inspector-header">
        <div>
          <strong>{selected.length === 1 ? primary.kind[0].toUpperCase() + primary.kind.slice(1) : `${selected.length} items`}</strong>
          <small>{primary.locked ? 'Locked' : 'Selected'}</small>
        </div>
        <div className="inspector-actions">
          {primary.kind !== 'connector' && <IconButton title="Duplicate" onClick={() => boardStore.duplicateSelected()}><Copy size={16} /></IconButton>}
          <IconButton title={allLocked ? 'Unlock' : 'Lock'} onClick={() => update({ locked: !allLocked } as Partial<BoardElement>)}>{allLocked ? <Unlock size={16} /> : <Lock size={16} />}</IconButton>
          <IconButton title="Delete" onClick={() => boardStore.deleteSelected()}><Trash2 size={16} /></IconButton>
        </div>
      </div>

      {selected.length === 1 && (primary.kind === 'rect' || primary.kind === 'ellipse' || primary.kind === 'sticky') && (
        <div className="inspector-section inspector-row">
          <label>Fill<input type="color" value={toHex(primary.fill)} onChange={(event) => update({ fill: fromHex(event.target.value) } as Partial<BoardElement>)} /></label>
          <label>Stroke<input type="color" value={toHex(primary.stroke)} onChange={(event) => update({ stroke: fromHex(event.target.value) } as Partial<BoardElement>)} /></label>
          <label className="numeric-label">Text<input type="number" min="10" max="96" value={primary.fontSize} onChange={(event) => update({ fontSize: Number(event.target.value) } as Partial<BoardElement>)} /></label>
        </div>
      )}

      {selected.length === 1 && primary.kind === 'text' && (
        <div className="inspector-section inspector-row">
          <label>Color<input type="color" value={toHex(primary.color)} onChange={(event) => update({ color: fromHex(event.target.value) } as Partial<BoardElement>)} /></label>
          <label className="numeric-label">Size<input type="number" min="10" max="144" value={primary.fontSize} onChange={(event) => update({ fontSize: Number(event.target.value) } as Partial<BoardElement>)} /></label>
        </div>
      )}

      {selected.length === 1 && primary.kind === 'drawing' && (
        <div className="inspector-section inspector-row">
          <label>Ink<input type="color" value={toHex(primary.color)} onChange={(event) => update({ color: fromHex(event.target.value) } as Partial<BoardElement>)} /></label>
          <label className="numeric-label">Width<input type="number" min="1" max="28" value={primary.widthPx} onChange={(event) => update({ widthPx: Number(event.target.value) } as Partial<BoardElement>)} /></label>
        </div>
      )}

      {selected.length === 1 && primary.kind === 'connector' && (
        <div className="inspector-section connector-editor">
          <div className="inspector-row">
            <label>Line<input type="color" value={toHex(primary.color)} onChange={(event) => update({ color: fromHex(event.target.value) } as Partial<BoardElement>)} /></label>
            <label className="numeric-label">Width<input type="number" min="1" max="12" value={primary.widthPx} onChange={(event) => update({ widthPx: Number(event.target.value) } as Partial<BoardElement>)} /></label>
          </div>
          <label className="text-field-label">Label<input type="text" maxLength={60} value={primary.label} placeholder="Optional connector label" onChange={(event) => update({ label: event.target.value } as Partial<BoardElement>)} /></label>
        </div>
      )}

      <div className="inspector-section opacity-row">
        <label htmlFor="opacity">Opacity</label>
        <input id="opacity" type="range" min="10" max="100" value={opacity} onChange={(event) => update({ opacity: Number(event.target.value) / 100 } as Partial<BoardElement>)} />
        <span>{opacity}%</span>
      </div>

      {selected.filter((element) => element.kind !== 'connector').length > 1 && (
        <div className="inspector-section icon-group" aria-label="Align selection">
          <IconButton title="Align left" onClick={() => boardStore.alignSelected('left')}><AlignStartVertical size={16} /></IconButton>
          <IconButton title="Align center" onClick={() => boardStore.alignSelected('center')}><AlignCenterVertical size={16} /></IconButton>
          <IconButton title="Align right" onClick={() => boardStore.alignSelected('right')}><AlignEndVertical size={16} /></IconButton>
          <IconButton title="Align top" onClick={() => boardStore.alignSelected('top')}><AlignStartHorizontal size={16} /></IconButton>
          <IconButton title="Align middle" onClick={() => boardStore.alignSelected('middle')}><AlignCenterHorizontal size={16} /></IconButton>
          <IconButton title="Align bottom" onClick={() => boardStore.alignSelected('bottom')}><AlignEndHorizontal size={16} /></IconButton>
        </div>
      )}

      {primary.kind !== 'connector' && (
        <div className="inspector-section icon-group">
          <IconButton title="Bring to front" onClick={() => boardStore.bringToFront()}><BringToFront size={16} /></IconButton>
          <IconButton title="Send to back" onClick={() => boardStore.sendToBack()}><SendToBack size={16} /></IconButton>
          {photos.length > 1 && <IconButton title="Arrange photos" onClick={() => boardStore.arrangeSelectedPhotos()}><Grid2X2 size={16} /></IconButton>}
        </div>
      )}
    </aside>
  );
}
