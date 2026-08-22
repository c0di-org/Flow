import { useSyncExternalStore } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { collageLayout } from './geometry';
import type {
  BoardDocument,
  BoardElement,
  BoardSettings,
  BoardSummary,
  Camera,
  DrawingElement,
  PhotoAsset,
  Point,
  Tool,
} from './types';

const LEGACY_KEY = 'flow.board.v1';
const LIBRARY_KEY = 'flow.library.v2';
const BOARD_PREFIX = 'flow.board.v2.';
const SETTINGS_KEY = 'flow.settings.v1';

// Preserve existing local browser data from builds released under the Stream name.
const STREAM_LEGACY_KEY = 'stream.board.v1';
const STREAM_LIBRARY_KEY = 'stream.library.v2';
const STREAM_BOARD_PREFIX = 'stream.board.v2.';
const STREAM_SETTINGS_KEY = 'stream.settings.v1';
const HISTORY_LIMIT = 36;
const GRID = 16;

const now = () => Date.now();
const makeDocument = (title = 'Untitled Board'): BoardDocument => ({
  version: 2,
  id: crypto.randomUUID(),
  title,
  createdAt: now(),
  updatedAt: now(),
  elements: [],
});

const snap = (value: number) => Math.round(value / GRID) * GRID;

function normalizeDocument(raw: Partial<BoardDocument> & { id?: string; title?: string; elements?: unknown[] }): BoardDocument {
  const timestamp = now();
  return {
    version: 2,
    id: raw.id || crypto.randomUUID(),
    title: raw.title || 'Untitled Board',
    createdAt: raw.createdAt || timestamp,
    updatedAt: raw.updatedAt || timestamp,
    elements: (raw.elements || []).map((value) => {
      const element = value as BoardElement & Record<string, unknown>;
      if ((element.kind === 'rect' || element.kind === 'ellipse' || element.kind === 'sticky') && typeof element.fontSize !== 'number') {
        return { ...element, fontSize: element.kind === 'sticky' ? 21 : 19 } as BoardElement;
      }
      if (element.kind === 'connector') {
        return {
          ...element,
          widthPx: typeof element.widthPx === 'number' ? element.widthPx : 3,
          label: typeof element.label === 'string' ? element.label : '',
        } as BoardElement;
      }
      if (element.kind === 'photo') {
        const asset = element.asset as typeof element.asset & { microPath?: string };
        if (!asset.microPath) return { ...element, asset: { ...asset, microPath: asset.thumbnailPath } } as BoardElement;
      }
      return element as BoardElement;
    }),
  };
}

type Snapshot = {
  document: BoardDocument;
  boards: BoardSummary[];
  selectedIds: string[];
  tool: Tool;
  camera: Camera;
  connectorStartId?: string;
  settings: BoardSettings;
};

type Listener = () => void;

class BoardStore {
  private listeners = new Set<Listener>();
  private history: BoardDocument[] = [];
  private future: BoardDocument[] = [];
  private saveTimer?: number;
  private transientBase?: BoardDocument;
  private clipboard: BoardElement[] = [];

  state: Snapshot;

  constructor() {
    this.migrateStreamStorage();
    const { document, boards } = this.loadInitial();
    this.state = {
      document,
      boards,
      selectedIds: [],
      tool: 'select',
      camera: { x: 120, y: 100, zoom: 1 },
      settings: this.loadSettings(),
    };
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.state;

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private migrateStreamStorage() {
    try {
      const streamLibraryRaw = localStorage.getItem(STREAM_LIBRARY_KEY);
      if (!localStorage.getItem(LIBRARY_KEY) && streamLibraryRaw) {
        const library = JSON.parse(streamLibraryRaw) as { boards?: BoardSummary[] };
        for (const board of library.boards || []) {
          const streamBoard = localStorage.getItem(`${STREAM_BOARD_PREFIX}${board.id}`);
          if (streamBoard && !localStorage.getItem(`${BOARD_PREFIX}${board.id}`)) {
            localStorage.setItem(`${BOARD_PREFIX}${board.id}`, streamBoard);
          }
        }
        localStorage.setItem(LIBRARY_KEY, streamLibraryRaw);
      }

      const streamLegacy = localStorage.getItem(STREAM_LEGACY_KEY);
      if (!localStorage.getItem(LEGACY_KEY) && streamLegacy) {
        localStorage.setItem(LEGACY_KEY, streamLegacy);
      }

      const streamSettings = localStorage.getItem(STREAM_SETTINGS_KEY);
      if (!localStorage.getItem(SETTINGS_KEY) && streamSettings) {
        localStorage.setItem(SETTINGS_KEY, streamSettings);
      }
    } catch {
      // A failed rename migration should never prevent Flow from starting.
    }
  }

  private loadSettings(): BoardSettings {
    try {
      return { showGrid: true, snapToGrid: false, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch {
      return { showGrid: true, snapToGrid: false };
    }
  }

  private loadInitial(): { document: BoardDocument; boards: BoardSummary[] } {
    try {
      const legacy = localStorage.getItem(LEGACY_KEY);
      const libraryRaw = localStorage.getItem(LIBRARY_KEY);
      if (!libraryRaw && legacy) {
        const migrated = normalizeDocument(JSON.parse(legacy));
        localStorage.setItem(`${BOARD_PREFIX}${migrated.id}`, JSON.stringify(migrated));
        const boards = [{ id: migrated.id, title: migrated.title, updatedAt: migrated.updatedAt }];
        localStorage.setItem(LIBRARY_KEY, JSON.stringify({ currentId: migrated.id, boards }));
        localStorage.removeItem(LEGACY_KEY);
        return { document: migrated, boards };
      }

      if (libraryRaw) {
        const library = JSON.parse(libraryRaw) as { currentId?: string; boards?: BoardSummary[] };
        const boards = library.boards || [];
        const currentId = library.currentId || boards[0]?.id;
        if (currentId) {
          const raw = localStorage.getItem(`${BOARD_PREFIX}${currentId}`);
          if (raw) return { document: normalizeDocument(JSON.parse(raw)), boards };
        }
      }
    } catch {
      // Start clean if browser storage is corrupt.
    }
    const document = makeDocument('My Board');
    const boards = [{ id: document.id, title: document.title, updatedAt: document.updatedAt }];
    localStorage.setItem(`${BOARD_PREFIX}${document.id}`, JSON.stringify(document));
    localStorage.setItem(LIBRARY_KEY, JSON.stringify({ currentId: document.id, boards }));
    return { document, boards };
  }

  private touchLibrary(document = this.state.document) {
    const entry: BoardSummary = { id: document.id, title: document.title, updatedAt: document.updatedAt };
    const boards = [entry, ...this.state.boards.filter((item) => item.id !== document.id)].sort((a, b) => b.updatedAt - a.updatedAt);
    this.state = { ...this.state, boards };
  }

  private persistNow() {
    const document = this.state.document;
    localStorage.setItem(`${BOARD_PREFIX}${document.id}`, JSON.stringify(document));
    localStorage.setItem(LIBRARY_KEY, JSON.stringify({ currentId: document.id, boards: this.state.boards }));
    if (isTauri()) void invoke('save_board', { board: document }).catch(() => undefined);
  }

  private scheduleSave() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.persistNow(), 180);
  }

  flush() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.persistNow();
  }

  private mutate(mutator: (elements: BoardElement[]) => BoardElement[]) {
    this.history.push(structuredClone(this.state.document));
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.future = [];
    const document = {
      ...this.state.document,
      updatedAt: now(),
      elements: mutator(this.state.document.elements),
    };
    this.state = { ...this.state, document };
    this.touchLibrary(document);
    this.scheduleSave();
    this.emit();
  }

  async hydrateNative() {
    if (!isTauri()) return;
    try {
      const nativeBoards = await invoke<BoardSummary[]>('list_boards');
      if (!nativeBoards.length) {
        this.persistNow();
        return;
      }
      const localById = new Map(this.state.boards.map((board) => [board.id, board]));
      const nativeById = new Map(nativeBoards.map((board) => [board.id, board]));

      // Reconcile every board, not just the open one. This prevents an older
      // localStorage copy from overwriting a newer native board when it is opened later.
      for (const summary of nativeBoards) {
        const localSummary = localById.get(summary.id);
        const localRaw = localStorage.getItem(`${BOARD_PREFIX}${summary.id}`);
        if (!localRaw || !localSummary || summary.updatedAt > localSummary.updatedAt) {
          try {
            const document = normalizeDocument(await invoke<BoardDocument>('load_board', { boardId: summary.id }));
            localStorage.setItem(`${BOARD_PREFIX}${document.id}`, JSON.stringify(document));
          } catch {
            // Ignore one damaged native board and continue loading the library.
          }
        } else if (localSummary.updatedAt > summary.updatedAt) {
          try {
            await invoke('save_board', { board: normalizeDocument(JSON.parse(localRaw)) });
          } catch {
            // Native mirroring is best effort; localStorage remains usable.
          }
        }
      }

      // Mirror local-only boards into native app data as well.
      for (const summary of this.state.boards) {
        if (nativeById.has(summary.id)) continue;
        const localRaw = localStorage.getItem(`${BOARD_PREFIX}${summary.id}`);
        if (!localRaw) continue;
        try {
          await invoke('save_board', { board: normalizeDocument(JSON.parse(localRaw)) });
        } catch {
          // Keep going if one board cannot be mirrored.
        }
      }
      const currentNative = nativeBoards.find((board) => board.id === this.state.document.id);
      let document = this.state.document;
      const ephemeralBlank = !currentNative && document.elements.length === 0 && this.state.boards.length === 1;
      if (ephemeralBlank) {
        localStorage.removeItem(`${BOARD_PREFIX}${document.id}`);
        document = normalizeDocument(await invoke<BoardDocument>('load_board', { boardId: nativeBoards[0].id }));
        localStorage.setItem(`${BOARD_PREFIX}${document.id}`, JSON.stringify(document));
      } else if (currentNative && currentNative.updatedAt > document.updatedAt) {
        document = normalizeDocument(await invoke<BoardDocument>('load_board', { boardId: document.id }));
        localStorage.setItem(`${BOARD_PREFIX}${document.id}`, JSON.stringify(document));
      }
      const byId = new Map<string, BoardSummary>();
      const localBoards = ephemeralBlank ? this.state.boards.filter((board) => board.id !== this.state.document.id) : this.state.boards;
      for (const board of [...localBoards, ...nativeBoards]) {
        const existing = byId.get(board.id);
        if (!existing || board.updatedAt > existing.updatedAt) byId.set(board.id, board);
      }
      const boards = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      this.state = { ...this.state, document, boards };
      this.persistNow();
      // Cleanup only after every local-newer board has been mirrored. Running this
      // before reconciliation can delete photo files referenced by localStorage
      // when the native JSON mirror is stale after an interrupted save.
      await invoke('save_board', { board: document }).catch(() => undefined);
      await invoke<number>('cleanup_orphan_assets').catch(() => 0);
      this.emit();
    } catch {
      // Local storage remains the fallback if native persistence is unavailable.
    }
  }

  setTool(tool: Tool) {
    this.state = { ...this.state, tool, connectorStartId: undefined };
    this.emit();
  }

  setCamera(camera: Camera) {
    this.state = { ...this.state, camera };
    this.emit();
  }

  setSetting<K extends keyof BoardSettings>(key: K, value: BoardSettings[K]) {
    const settings = { ...this.state.settings, [key]: value };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    this.state = { ...this.state, settings };
    this.emit();
  }

  select(ids: string[]) {
    this.state = { ...this.state, selectedIds: ids };
    this.emit();
  }

  toggleSelect(id: string) {
    const exists = this.state.selectedIds.includes(id);
    this.select(exists ? this.state.selectedIds.filter((item) => item !== id) : [...this.state.selectedIds, id]);
  }

  selectInRect(left: number, top: number, right: number, bottom: number) {
    const ids = this.state.document.elements
      .filter((element) => element.kind !== 'connector' && !element.locked)
      .filter((element) => element.x >= left && element.y >= top && element.x + element.width <= right && element.y + element.height <= bottom)
      .map((element) => element.id);
    this.select(ids);
  }

  renameBoard(title: string) {
    const clean = title.trim().slice(0, 80) || 'Untitled Board';
    const document = { ...this.state.document, title: clean, updatedAt: now() };
    this.state = { ...this.state, document };
    this.touchLibrary(document);
    this.scheduleSave();
    this.emit();
  }

  createBoard() {
    this.persistNow();
    const document = makeDocument(`Board ${this.state.boards.length + 1}`);
    const boards = [{ id: document.id, title: document.title, updatedAt: document.updatedAt }, ...this.state.boards];
    this.history = [];
    this.future = [];
    this.clipboard = [];
    this.state = {
      ...this.state,
      document,
      boards,
      selectedIds: [],
      tool: 'select',
      connectorStartId: undefined,
      camera: { x: 120, y: 100, zoom: 1 },
    };
    this.persistNow();
    this.emit();
  }

  openBoard(id: string) {
    if (id === this.state.document.id) return;
    this.persistNow();
    try {
      const raw = localStorage.getItem(`${BOARD_PREFIX}${id}`);
      if (!raw) return;
      const document = normalizeDocument(JSON.parse(raw));
      this.history = [];
      this.future = [];
      this.clipboard = [];
      this.state = {
        ...this.state,
        document,
        selectedIds: [],
        connectorStartId: undefined,
        camera: { x: 120, y: 100, zoom: 1 },
      };
      this.persistNow();
      this.emit();
    } catch {
      // Keep the current board if the requested board is unreadable.
    }
  }

  deleteBoard(id: string) {
    if (this.state.boards.length <= 1) return;
    localStorage.removeItem(`${BOARD_PREFIX}${id}`);
    if (isTauri()) void invoke('delete_board', { boardId: id }).catch(() => undefined);
    const boards = this.state.boards.filter((board) => board.id !== id);
    if (id === this.state.document.id) {
      const nextId = boards[0].id;
      const raw = localStorage.getItem(`${BOARD_PREFIX}${nextId}`);
      if (!raw) return;
      const document = normalizeDocument(JSON.parse(raw));
      this.history = [];
      this.future = [];
      this.clipboard = [];
      this.state = {
        ...this.state,
        boards,
        document,
        selectedIds: [],
        connectorStartId: undefined,
        camera: { x: 120, y: 100, zoom: 1 },
      };
      this.persistNow();
      this.emit();
    } else {
      this.state = { ...this.state, boards };
      this.persistNow();
      this.emit();
    }
  }

  addShape(kind: 'rect' | 'ellipse' | 'sticky' | 'text', at: Point) {
    const id = crypto.randomUUID();
    const x = this.state.settings.snapToGrid ? snap(at.x) : at.x;
    const y = this.state.settings.snapToGrid ? snap(at.y) : at.y;
    const common = { id, x, y, rotation: 0, z: now(), opacity: 1 };
    const element: BoardElement =
      kind === 'text'
        ? { ...common, kind, width: 280, height: 78, text: 'Type something', color: 0x202124, fontSize: 32 }
        : {
            ...common,
            kind,
            width: kind === 'sticky' ? 240 : 230,
            height: kind === 'sticky' ? 240 : 138,
            text: kind === 'sticky' ? 'New note' : kind === 'rect' ? 'Process' : 'Idea',
            fill: kind === 'sticky' ? 0xffef9f : 0xffffff,
            stroke: kind === 'sticky' ? 0xe4c963 : 0x667085,
            fontSize: kind === 'sticky' ? 21 : 19,
          };
    this.mutate((elements) => [...elements, element]);
    this.select([id]);
    this.setTool('select');
  }

  addDrawing(points: Point[], color = 0x242424, widthPx = 3) {
    if (points.length < 2) return;
    const minX = Math.min(...points.map((p) => p.x));
    const minY = Math.min(...points.map((p) => p.y));
    const maxX = Math.max(...points.map((p) => p.x));
    const maxY = Math.max(...points.map((p) => p.y));
    const element: DrawingElement = {
      id: crypto.randomUUID(),
      kind: 'drawing',
      x: minX,
      y: minY,
      width: Math.max(2, maxX - minX),
      height: Math.max(2, maxY - minY),
      rotation: 0,
      z: now(),
      color,
      widthPx,
      points: points.map((point) => ({ x: point.x - minX, y: point.y - minY })),
    };
    this.mutate((elements) => [...elements, element]);
    this.select([element.id]);
  }

  addPhotos(assets: PhotoAsset[], origin: Point) {
    const layout = collageLayout(
      assets.length,
      origin,
      assets.map((asset) => ({ width: asset.pixelWidth, height: asset.pixelHeight })),
    );
    const timestamp = now();
    const additions: BoardElement[] = assets.map((asset, index) => ({
      id: crypto.randomUUID(),
      kind: 'photo',
      asset,
      ...layout[index],
      rotation: 0,
      z: timestamp + index,
      opacity: 1,
    }));
    this.mutate((elements) => [...elements, ...additions]);
    this.select(additions.map((item) => item.id));
  }

  beginTransient() {
    if (!this.transientBase) this.transientBase = structuredClone(this.state.document);
  }

  moveSelectedTransient(dx: number, dy: number) {
    if (!this.state.selectedIds.length) return;
    const ids = new Set(this.state.selectedIds);
    this.state = {
      ...this.state,
      document: {
        ...this.state.document,
        elements: this.state.document.elements.map((element) => {
          if (!ids.has(element.id) || element.locked) return element;
          return { ...element, x: element.x + dx, y: element.y + dy };
        }),
      },
    };
    this.emit();
  }

  updateElementTransient(id: string, patch: Partial<BoardElement>) {
    this.state = {
      ...this.state,
      document: {
        ...this.state.document,
        elements: this.state.document.elements.map((element) => (element.id === id && !element.locked ? ({ ...element, ...patch } as BoardElement) : element)),
      },
    };
    this.emit();
  }

  checkpoint() {
    if (!this.transientBase) return;
    this.history.push(this.transientBase);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.future = [];
    this.transientBase = undefined;
    const selected = new Set(this.state.selectedIds);
    const elements = this.state.settings.snapToGrid
      ? this.state.document.elements.map((element) => selected.has(element.id) && element.kind !== 'connector' && !element.locked ? { ...element, x: snap(element.x), y: snap(element.y) } : element)
      : this.state.document.elements;
    const document = { ...this.state.document, elements, updatedAt: now() };
    this.state = { ...this.state, document };
    this.touchLibrary(document);
    this.scheduleSave();
    this.emit();
  }

  updateSelected(patch: Partial<BoardElement>) {
    const ids = new Set(this.state.selectedIds);
    if (!ids.size) return;
    this.mutate((elements) => elements.map((element) => (ids.has(element.id) && !element.locked ? ({ ...element, ...patch } as BoardElement) : element)));
  }

  updateElement(id: string, patch: Partial<BoardElement>) {
    this.mutate((elements) => elements.map((element) => (element.id === id ? ({ ...element, ...patch } as BoardElement) : element)));
  }

  setElementText(id: string, text: string) {
    this.mutate((elements) => elements.map((element) => {
      if (element.id !== id) return element;
      if (element.kind === 'text' || element.kind === 'rect' || element.kind === 'ellipse' || element.kind === 'sticky') return { ...element, text };
      return element;
    }));
  }

  deleteSelected() {
    if (!this.state.selectedIds.length) return;
    const ids = new Set(this.state.selectedIds);
    this.mutate((elements) => elements.filter((element) => !ids.has(element.id) && !(element.kind === 'connector' && (ids.has(element.fromId) || ids.has(element.toId)))));
    this.select([]);
  }

  duplicateSelected(offset = 28) {
    const ids = new Set(this.state.selectedIds);
    const selected = this.state.document.elements.filter((element) => ids.has(element.id) && element.kind !== 'connector');
    if (!selected.length) return;
    const idMap = new Map<string, string>();
    const timestamp = now();
    const copies = selected.map((element, index) => {
      const id = crypto.randomUUID();
      idMap.set(element.id, id);
      return { ...structuredClone(element), id, x: element.x + offset, y: element.y + offset, z: timestamp + index, locked: false } as BoardElement;
    });
    const connectors = this.state.document.elements
      .filter((element): element is Extract<BoardElement, { kind: 'connector' }> => element.kind === 'connector' && ids.has(element.fromId) && ids.has(element.toId))
      .map((connector, index) => ({ ...connector, id: crypto.randomUUID(), fromId: idMap.get(connector.fromId)!, toId: idMap.get(connector.toId)!, z: timestamp + selected.length + index }));
    this.mutate((elements) => [...elements, ...copies, ...connectors]);
    this.select(copies.map((copy) => copy.id));
  }

  copySelected() {
    const ids = new Set(this.state.selectedIds);
    this.clipboard = structuredClone(this.state.document.elements.filter((element) => ids.has(element.id) && element.kind !== 'connector'));
  }

  paste() {
    if (!this.clipboard.length) return;
    const timestamp = now();
    const copies = this.clipboard.map((element, index) => ({ ...structuredClone(element), id: crypto.randomUUID(), x: element.x + 34, y: element.y + 34, z: timestamp + index, locked: false }) as BoardElement);
    this.clipboard = structuredClone(copies);
    this.mutate((elements) => [...elements, ...copies]);
    this.select(copies.map((copy) => copy.id));
  }

  bringToFront() {
    const ids = new Set(this.state.selectedIds);
    const maxZ = Math.max(0, ...this.state.document.elements.map((element) => element.z));
    let next = maxZ + 1;
    this.mutate((elements) => elements.map((element) => (ids.has(element.id) ? { ...element, z: next++ } : element)));
  }

  sendToBack() {
    const ids = new Set(this.state.selectedIds);
    const minZ = Math.min(0, ...this.state.document.elements.map((element) => element.z));
    let next = minZ - this.state.selectedIds.length;
    this.mutate((elements) => elements.map((element) => (ids.has(element.id) ? { ...element, z: next++ } : element)));
  }

  alignSelected(mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') {
    const ids = new Set(this.state.selectedIds);
    const selected = this.state.document.elements.filter((element) => ids.has(element.id) && element.kind !== 'connector');
    if (selected.length < 2) return;
    const left = Math.min(...selected.map((e) => e.x));
    const right = Math.max(...selected.map((e) => e.x + e.width));
    const top = Math.min(...selected.map((e) => e.y));
    const bottom = Math.max(...selected.map((e) => e.y + e.height));
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    this.mutate((elements) => elements.map((element) => {
      if (!ids.has(element.id) || element.kind === 'connector' || element.locked) return element;
      if (mode === 'left') return { ...element, x: left };
      if (mode === 'center') return { ...element, x: cx - element.width / 2 };
      if (mode === 'right') return { ...element, x: right - element.width };
      if (mode === 'top') return { ...element, y: top };
      if (mode === 'middle') return { ...element, y: cy - element.height / 2 };
      return { ...element, y: bottom - element.height };
    }));
  }

  arrangeSelectedPhotos() {
    const ids = new Set(this.state.selectedIds);
    const selected = this.state.document.elements.filter((element): element is Extract<BoardElement, { kind: 'photo' }> => ids.has(element.id) && element.kind === 'photo');
    if (selected.length < 2) return;
    const origin = { x: Math.min(...selected.map((e) => e.x)), y: Math.min(...selected.map((e) => e.y)) };
    const layout = collageLayout(selected.length, origin, selected.map((e) => ({ width: e.asset.pixelWidth, height: e.asset.pixelHeight })));
    const positions = new Map(selected.map((element, index) => [element.id, layout[index]]));
    this.mutate((elements) => elements.map((element) => positions.has(element.id) ? { ...element, ...positions.get(element.id)! } : element));
  }

  connectorClick(id: string) {
    if (!this.state.connectorStartId) {
      this.state = { ...this.state, connectorStartId: id, selectedIds: [id] };
      this.emit();
      return;
    }
    if (this.state.connectorStartId === id) return;
    const connector: BoardElement = {
      id: crypto.randomUUID(),
      kind: 'connector',
      fromId: this.state.connectorStartId,
      toId: id,
      color: 0x667085,
      widthPx: 3,
      label: '',
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      rotation: 0,
      z: now(),
    };
    this.mutate((elements) => [...elements, connector]);
    this.state = { ...this.state, connectorStartId: undefined, selectedIds: [] };
    this.emit();
  }

  nudgeSelected(dx: number, dy: number) {
    if (!this.state.selectedIds.length) return;
    const ids = new Set(this.state.selectedIds);
    this.mutate((elements) => elements.map((element) => ids.has(element.id) && element.kind !== 'connector' && !element.locked ? { ...element, x: element.x + dx, y: element.y + dy } : element));
  }

  undo() {
    const previous = this.history.pop();
    if (!previous) return;
    this.future.push(structuredClone(this.state.document));
    this.state = { ...this.state, document: previous, selectedIds: [] };
    this.touchLibrary(previous);
    this.scheduleSave();
    this.emit();
  }

  redo() {
    const next = this.future.pop();
    if (!next) return;
    this.history.push(structuredClone(this.state.document));
    this.state = { ...this.state, document: next, selectedIds: [] };
    this.touchLibrary(next);
    this.scheduleSave();
    this.emit();
  }
}

export const boardStore = new BoardStore();
export const useBoard = () => useSyncExternalStore(boardStore.subscribe, boardStore.getSnapshot, boardStore.getSnapshot);

/**
 * Every photo variant path referenced by any board on this device, including
 * the open document. The web build feeds this to `pruneWebAssets` so blobs
 * belonging to deleted boards do not accumulate in IndexedDB.
 *
 * Returns null if any stored board cannot be read: an incomplete reference set
 * would make live photos look like orphans, so the caller must skip the prune
 * entirely rather than work from partial data.
 */
export function referencedAssetPaths(): Set<string> | null {
  const paths = new Set<string>();
  const collect = (document: BoardDocument) => {
    for (const element of document.elements) {
      if (element.kind !== 'photo') continue;
      paths.add(element.asset.originalPath);
      paths.add(element.asset.previewPath);
      paths.add(element.asset.thumbnailPath);
      paths.add(element.asset.microPath);
    }
  };
  collect(boardStore.state.document);
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key || !key.startsWith(BOARD_PREFIX)) continue;
    try {
      collect(JSON.parse(localStorage.getItem(key) || '') as BoardDocument);
    } catch {
      return null;
    }
  }
  return paths;
}
