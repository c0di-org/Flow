import { Check, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { boardStore, useBoard } from '../board/store';

export function BoardSwitcher() {
  const state = useBoard();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div className="board-switcher" ref={root}>
      <button className="topbar-button board-switcher-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="board-name">{state.document.title}</span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="board-popover" role="menu">
          <label className="board-title-editor">
            <span>Current board</span>
            <input
              value={state.document.title}
              onChange={(event) => boardStore.renameBoard(event.target.value)}
              onKeyDown={(event) => event.stopPropagation()}
              maxLength={80}
            />
          </label>
          <div className="popover-heading">Boards</div>
          <div className="board-list">
            {state.boards.map((board) => (
              <button
                className={`board-row ${board.id === state.document.id ? 'current' : ''}`}
                key={board.id}
                onClick={() => {
                  boardStore.openBoard(board.id);
                  setOpen(false);
                }}
              >
                <span className="board-row-check">{board.id === state.document.id && <Check size={15} />}</span>
                <span className="board-row-copy">
                  <strong>{board.title}</strong>
                  <small>{new Date(board.updatedAt).toLocaleDateString()}</small>
                </span>
                {state.boards.length > 1 && (
                  <span
                    className="board-delete"
                    role="button"
                    tabIndex={0}
                    title="Delete board"
                    onClick={(event) => {
                      event.stopPropagation();
                      boardStore.deleteBoard(board.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') boardStore.deleteBoard(board.id);
                    }}
                  >
                    <Trash2 size={14} />
                  </span>
                )}
              </button>
            ))}
          </div>
          <button
            className="new-board-button"
            onClick={() => {
              boardStore.createBoard();
              setOpen(false);
            }}
          >
            <Plus size={16} /> New board
          </button>
        </div>
      )}
    </div>
  );
}
