import {
  Application,
  Container,
  FederatedPointerEvent,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  TextStyle,
} from 'pixi.js';
import { assetUrl } from './importer';
import { connectorEndpoints, screenToWorld, visibleInWorldRect, worldToScreen } from './geometry';
import { boardStore } from './store';
import type { BoardElement, Camera, PhotoElement, Point } from './types';
import { PhotoTexturePool } from './PhotoTexturePool';

type RenderRecord = {
  root: Container;
  textureUrl?: string;
  lod?: 'micro' | 'thumb' | 'preview';
  elementRef?: BoardElement;
  selected?: boolean;
  selectionZoom?: number;
};

type DragState =
  | { mode: 'pan'; last: Point; moved: boolean }
  | { mode: 'move'; last: Point; moved: boolean }
  | { mode: 'marquee'; start: Point; current: Point }
  | { mode: 'draw'; points: Point[] }
  | { mode: 'resize'; id: string; start: Point; base: { width: number; height: number }; aspect: number }
  | { mode: 'rotate'; id: string; center: Point; startAngle: number; baseRotation: number };

type PinchState = { distance: number; zoom: number; worldCenter: Point };

export class CanvasEngine {
  private app = new Application();
  private gridLayer = new Graphics();
  private world = new Container();
  private overlay = new Graphics();
  private inkPreview = new Graphics();
  private records = new Map<string, RenderRecord>();
  private texturePool = new PhotoTexturePool();
  private unsubscribe?: () => void;
  private resizeObserver?: ResizeObserver;
  private drag?: DragState;
  private lastElementsRef?: BoardElement[];
  private lastSelectionKey = '';
  private touchPointers = new Map<number, Point>();
  private pinch?: PinchState;
  private editor?: HTMLTextAreaElement;

  constructor(private readonly host: HTMLElement) {}

  private isAndroid() {
    return /android/i.test(navigator.userAgent);
  }

  private desiredResolution() {
    const width = Math.max(1, this.host.clientWidth || window.innerWidth);
    const height = Math.max(1, this.host.clientHeight || window.innerHeight);
    const logicalPixels = width * height;
    // Keep the backing framebuffer bounded. A 2x canvas is 4x the pixel count,
    // which is surprisingly expensive in DeX/full-screen tablet windows.
    const pixelBudget = this.isAndroid() ? 4_500_000 : 9_000_000;
    const budgetResolution = Math.sqrt(pixelBudget / logicalPixels);
    const platformCap = this.isAndroid() ? 1.5 : 2;
    return Math.max(1, Math.min(platformCap, window.devicePixelRatio || 1, budgetResolution));
  }

  async mount() {
    await this.app.init({
      resizeTo: this.host,
      antialias: !this.isAndroid(),
      autoDensity: true,
      resolution: this.desiredResolution(),
      background: '#f6f7f8',
      preference: 'webgl',
      powerPreference: 'high-performance',
    });
    this.host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.gridLayer, this.world, this.overlay);
    this.world.addChild(this.inkPreview);
    this.world.sortableChildren = true;
    this.inkPreview.zIndex = Number.MAX_SAFE_INTEGER;
    this.app.stage.eventMode = 'static';

    this.app.stage.on('pointerdown', this.onPointerDown);
    this.app.stage.on('pointermove', this.onPointerMove);
    this.app.stage.on('pointerup', this.onPointerUp);
    this.app.stage.on('pointerupoutside', this.onPointerUp);
    this.app.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.app.canvas.addEventListener('pointerdown', this.onDomPointerDown, true);
    this.app.canvas.addEventListener('pointermove', this.onDomPointerMove, true);
    this.app.canvas.addEventListener('pointerup', this.onDomPointerUp, true);
    this.app.canvas.addEventListener('pointercancel', this.onDomPointerUp, true);
    this.app.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    this.app.canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    this.app.canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);

    this.unsubscribe = boardStore.subscribe(() => this.render());
    this.resizeObserver = new ResizeObserver(() => {
      const resolution = this.desiredResolution();
      if (Math.abs(this.app.renderer.resolution - resolution) > 0.05) {
        this.app.renderer.resize(Math.max(1, this.host.clientWidth), Math.max(1, this.host.clientHeight), resolution);
      }
      this.render();
    });
    this.resizeObserver.observe(this.host);
    this.render();
  }

  async destroy() {
    this.unsubscribe?.();
    this.resizeObserver?.disconnect();
    this.editor?.remove();
    this.app.canvas.removeEventListener('wheel', this.onWheel);
    this.app.canvas.removeEventListener('pointerdown', this.onDomPointerDown, true);
    this.app.canvas.removeEventListener('pointermove', this.onDomPointerMove, true);
    this.app.canvas.removeEventListener('pointerup', this.onDomPointerUp, true);
    this.app.canvas.removeEventListener('pointercancel', this.onDomPointerUp, true);
    this.app.canvas.removeEventListener('webglcontextlost', this.onContextLost, false);
    this.app.canvas.removeEventListener('webglcontextrestored', this.onContextRestored, false);
    await this.texturePool.clear();
    this.app.destroy(true, { children: true, texture: false, textureSource: false });
  }

  private currentCamera(): Camera {
    return boardStore.state.camera;
  }

  private applyCamera() {
    const camera = this.currentCamera();
    this.world.position.set(camera.x, camera.y);
    this.world.scale.set(camera.zoom);
  }

  private viewportWorldBounds(margin = 520) {
    const camera = this.currentCamera();
    return {
      left: -camera.x / camera.zoom - margin,
      top: -camera.y / camera.zoom - margin,
      right: (this.app.screen.width - camera.x) / camera.zoom + margin,
      bottom: (this.app.screen.height - camera.y) / camera.zoom + margin,
    };
  }

  private drawGrid() {
    this.gridLayer.clear();
    if (!boardStore.state.settings.showGrid) return;
    const { x, y, zoom } = boardStore.state.camera;
    let step = 32;
    while (step * zoom < 22) step *= 2;
    const spacing = step * zoom;
    const offsetX = ((x % spacing) + spacing) % spacing;
    const offsetY = ((y % spacing) + spacing) % spacing;
    for (let sx = offsetX; sx < this.app.screen.width; sx += spacing) {
      this.gridLayer.moveTo(sx, 0).lineTo(sx, this.app.screen.height);
    }
    for (let sy = offsetY; sy < this.app.screen.height; sy += spacing) {
      this.gridLayer.moveTo(0, sy).lineTo(this.app.screen.width, sy);
    }
    this.gridLayer.stroke({ color: 0x9aa4b2, width: 1, alpha: Math.min(0.2, 0.08 + zoom * 0.04) });
  }

  private render() {
    this.app.stage.hitArea = new Rectangle(0, 0, this.app.screen.width, this.app.screen.height);
    this.applyCamera();
    this.drawGrid();
    const state = boardStore.state;
    const elements = state.document.elements;
    const selectionKey = `${state.selectedIds.join('|')}@${state.camera.zoom.toFixed(3)}`;
    const contentChanged = this.lastElementsRef !== elements || this.lastSelectionKey !== selectionKey;

    if (!contentChanged) {
      // Camera movement does not rebuild display objects, but visibility must be
      // refreshed on every camera update so a short/fast pan cannot leave newly
      // exposed photos blank after the gesture stops.
      this.refreshPhotoVisibility(elements);
      return;
    }

    this.lastElementsRef = elements;
    this.lastSelectionKey = selectionKey;
    const ids = new Set(elements.map((e) => e.id));

    for (const [id, record] of this.records) {
      if (!ids.has(id)) this.removeRecord(id, record);
    }

    const byId = new Map(elements.map((element) => [element.id, element]));
    for (const element of elements) {
      if (element.kind === 'connector') this.renderConnector(element, byId);
      else this.renderElement(element);
    }

    this.refreshPhotoVisibility(elements);
  }

  private renderElement(element: Exclude<BoardElement, { kind: 'connector' }>) {
    let record = this.records.get(element.id);
    if (!record) {
      record = { root: new Container() };
      record.root.eventMode = 'static';
      record.root.interactiveChildren = true;
      record.root.cursor = element.locked ? 'default' : 'pointer';
      record.root.on('pointerdown', (event: FederatedPointerEvent) => this.onElementPointerDown(element.id, event));
      record.root.on('pointertap', (event: FederatedPointerEvent) => {
        const detail = (event as FederatedPointerEvent & { detail?: number }).detail || 0;
        if (detail >= 2) this.editText(element.id);
      });
      this.world.addChild(record.root);
      this.records.set(element.id, record);
    }

    const selected = boardStore.state.selectedIds.includes(element.id);
    const zoom = boardStore.state.camera.zoom;
    const visualChanged = record.elementRef !== element;
    const selectionChanged = record.selected !== selected || (selected && record.selectionZoom !== zoom);

    if (visualChanged) {
      record.root.position.set(element.x, element.y);
      record.root.rotation = element.rotation;
      record.root.zIndex = element.z;
      record.root.alpha = element.opacity ?? 1;
      record.root.cursor = element.locked ? 'default' : 'pointer';

      if (element.kind === 'photo') this.drawPhotoFrame(record, element);
      else if (element.kind === 'text') this.drawText(record, element);
      else if (element.kind === 'drawing') this.drawDrawing(record, element);
      else this.drawShape(record, element);
      record.elementRef = element;
    }

    if (selectionChanged || (selected && visualChanged)) {
      this.drawSelection(record.root, element);
      record.selected = selected;
      record.selectionZoom = zoom;
    }
  }

  private drawPhotoFrame(record: RenderRecord, element: PhotoElement) {
    let frame = record.root.getChildByLabel('frame') as Graphics | null;
    if (!frame) {
      frame = new Graphics({ label: 'frame' });
      record.root.addChild(frame);
    }
    frame
      .clear()
      .roundRect(0, 0, element.width, element.height, 10)
      .fill(0xe8ebef)
      .stroke({ color: 0xd6dae0, width: 1 });

    const sprite = record.root.getChildByLabel('photo') as Sprite | null;
    if (sprite) {
      sprite.width = element.width;
      sprite.height = element.height;
    }
  }

  private drawShape(record: RenderRecord, element: Extract<BoardElement, { kind: 'rect' | 'ellipse' | 'sticky' }>) {
    let shape = record.root.getChildByLabel('shape') as Graphics | null;
    if (!shape) {
      shape = new Graphics({ label: 'shape' });
      record.root.addChild(shape);
    }
    shape.clear();
    if (element.kind === 'ellipse') shape.ellipse(element.width / 2, element.height / 2, element.width / 2, element.height / 2);
    else shape.roundRect(0, 0, element.width, element.height, element.kind === 'sticky' ? 7 : 18);
    shape.fill(element.fill).stroke({ color: element.stroke, width: element.kind === 'sticky' ? 1 : 2, alpha: 0.88 });

    let label = record.root.getChildByLabel('label') as Text | null;
    if (!label) {
      label = new Text();
      label.label = 'label';
      label.anchor.set(0.5);
      record.root.addChild(label);
    }
    label.text = element.text;
    label.style = new TextStyle({
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: element.fontSize,
      fill: 0x202124,
      align: 'center',
      wordWrap: true,
      wordWrapWidth: Math.max(40, element.width - 26),
      lineHeight: element.fontSize * 1.25,
    });
    label.position.set(element.width / 2, element.height / 2);
  }

  private drawText(record: RenderRecord, element: Extract<BoardElement, { kind: 'text' }>) {
    let text = record.root.getChildByLabel('text') as Text | null;
    if (!text) {
      text = new Text();
      text.label = 'text';
      record.root.addChild(text);
    }
    text.text = element.text;
    text.style = new TextStyle({
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: element.fontSize,
      fill: element.color,
      wordWrap: true,
      wordWrapWidth: element.width,
      lineHeight: element.fontSize * 1.22,
    });
  }

  private drawDrawing(record: RenderRecord, element: Extract<BoardElement, { kind: 'drawing' }>) {
    let drawing = record.root.getChildByLabel('drawing') as Graphics | null;
    if (!drawing) {
      drawing = new Graphics({ label: 'drawing' });
      record.root.addChild(drawing);
    }
    drawing.clear();
    const [first, ...rest] = element.points;
    if (!first) return;
    drawing.moveTo(first.x, first.y);
    for (const point of rest) drawing.lineTo(point.x, point.y);
    drawing.stroke({ color: element.color, width: element.widthPx, cap: 'round', join: 'round' });
  }

  private drawSelection(root: Container, element: Exclude<BoardElement, { kind: 'connector' }>) {
    let selection = root.getChildByLabel('selection') as Graphics | null;
    if (!selection) {
      selection = new Graphics({ label: 'selection' });
      selection.eventMode = 'none';
      root.addChild(selection);
    }
    selection.clear();

    const selected = boardStore.state.selectedIds.includes(element.id);
    if (!selected) {
      for (const label of ['resize-handle', 'rotate-handle', 'rotate-stem']) root.getChildByLabel(label)?.destroy();
      return;
    }

    const zoom = boardStore.state.camera.zoom;
    selection.rect(-4 / zoom, -4 / zoom, element.width + 8 / zoom, element.height + 8 / zoom).stroke({ color: 0x4f6df5, width: 2 / zoom });
    if (element.locked || boardStore.state.selectedIds.length !== 1 || element.kind === 'drawing') {
      for (const label of ['resize-handle', 'rotate-handle', 'rotate-stem']) root.getChildByLabel(label)?.destroy();
      return;
    }

    let handle = root.getChildByLabel('resize-handle') as Graphics | null;
    if (!handle) {
      handle = new Graphics({ label: 'resize-handle' });
      handle.eventMode = 'static';
      handle.cursor = 'nwse-resize';
      handle.on('pointerdown', (event: FederatedPointerEvent) => {
        event.stopPropagation();
        const current = boardStore.state.document.elements.find((item) => item.id === element.id);
        if (!current || current.kind === 'connector' || current.locked) return;
        boardStore.beginTransient();
        this.drag = {
          mode: 'resize',
          id: current.id,
          start: screenToWorld({ x: event.global.x, y: event.global.y }, boardStore.state.camera),
          base: { width: current.width, height: current.height },
          aspect: current.width / Math.max(1, current.height),
        };
      });
      root.addChild(handle);
    }
    const radius = (window.matchMedia('(pointer: coarse)').matches ? 11 : 7) / zoom;
    handle.clear().circle(0, 0, radius).fill(0xffffff).stroke({ color: 0x4f6df5, width: 2 / zoom });
    handle.position.set(element.width, element.height);

    let stem = root.getChildByLabel('rotate-stem') as Graphics | null;
    if (!stem) {
      stem = new Graphics({ label: 'rotate-stem' });
      stem.eventMode = 'none';
      root.addChild(stem);
    }
    const handleY = -30 / zoom;
    stem.clear().moveTo(element.width / 2, -4 / zoom).lineTo(element.width / 2, handleY).stroke({ color: 0x4f6df5, width: 1.5 / zoom });

    let rotate = root.getChildByLabel('rotate-handle') as Graphics | null;
    if (!rotate) {
      rotate = new Graphics({ label: 'rotate-handle' });
      rotate.eventMode = 'static';
      rotate.cursor = 'grab';
      rotate.on('pointerdown', (event: FederatedPointerEvent) => {
        event.stopPropagation();
        const current = boardStore.state.document.elements.find((item) => item.id === element.id);
        if (!current || current.kind === 'connector' || current.locked) return;
        const center = { x: current.x + current.width / 2, y: current.y + current.height / 2 };
        const point = screenToWorld({ x: event.global.x, y: event.global.y }, boardStore.state.camera);
        boardStore.beginTransient();
        this.drag = {
          mode: 'rotate',
          id: current.id,
          center,
          startAngle: Math.atan2(point.y - center.y, point.x - center.x),
          baseRotation: current.rotation,
        };
      });
      root.addChild(rotate);
    }
    rotate.clear().circle(0, 0, radius).fill(0xffffff).stroke({ color: 0x4f6df5, width: 2 / zoom });
    rotate.position.set(element.width / 2, handleY);
  }

  private renderConnector(connector: Extract<BoardElement, { kind: 'connector' }>, byId: Map<string, BoardElement>) {
    const from = byId.get(connector.fromId);
    const to = byId.get(connector.toId);
    if (!from || !to || from.kind === 'connector' || to.kind === 'connector') {
      const stale = this.records.get(connector.id);
      if (stale) this.removeRecord(connector.id, stale);
      return;
    }

    let record = this.records.get(connector.id);
    if (!record) {
      record = { root: new Container() };
      this.world.addChild(record.root);
      this.records.set(connector.id, record);
    }
    record.root.zIndex = Math.min(from.z, to.z) - 0.5;
    record.root.alpha = connector.opacity ?? 1;

    const [a, b] = connectorEndpoints(from, to);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const arrow = 13;

    let hit = record.root.getChildByLabel('connector-hit') as Graphics | null;
    if (!hit) {
      hit = new Graphics({ label: 'connector-hit' });
      hit.eventMode = 'static';
      hit.cursor = 'pointer';
      hit.on('pointerdown', (event: FederatedPointerEvent) => {
        event.stopPropagation();
        if (event.shiftKey) boardStore.toggleSelect(connector.id);
        else boardStore.select([connector.id]);
      });
      record.root.addChild(hit);
    }
    hit
      .clear()
      .moveTo(a.x, a.y)
      .lineTo(b.x, b.y)
      .stroke({ color: 0xffffff, width: Math.max(connector.widthPx + 14 / boardStore.state.camera.zoom, 12), alpha: 0.001 });

    let line = record.root.getChildByLabel('line') as Graphics | null;
    if (!line) {
      line = new Graphics({ label: 'line' });
      line.eventMode = 'none';
      record.root.addChild(line);
    }
    line
      .clear()
      .moveTo(a.x, a.y)
      .lineTo(b.x, b.y)
      .stroke({ color: connector.color, width: connector.widthPx, cap: 'round' })
      .moveTo(b.x, b.y)
      .lineTo(b.x - arrow * Math.cos(angle - Math.PI / 6), b.y - arrow * Math.sin(angle - Math.PI / 6))
      .moveTo(b.x, b.y)
      .lineTo(b.x - arrow * Math.cos(angle + Math.PI / 6), b.y - arrow * Math.sin(angle + Math.PI / 6))
      .stroke({ color: connector.color, width: connector.widthPx, cap: 'round' });

    let selected = record.root.getChildByLabel('connector-selection') as Graphics | null;
    if (!selected) {
      selected = new Graphics({ label: 'connector-selection' });
      selected.eventMode = 'none';
      record.root.addChild(selected);
    }
    selected.clear();
    if (boardStore.state.selectedIds.includes(connector.id)) {
      selected
        .moveTo(a.x, a.y)
        .lineTo(b.x, b.y)
        .stroke({ color: 0x4f6df5, width: connector.widthPx + 4 / boardStore.state.camera.zoom, alpha: 0.3, cap: 'round' });
    }

    let label = record.root.getChildByLabel('connector-label') as Text | null;
    if (!label) {
      label = new Text();
      label.label = 'connector-label';
      label.anchor.set(0.5);
      label.eventMode = 'none';
      record.root.addChild(label);
    }
    label.text = connector.label;
    label.visible = Boolean(connector.label.trim());
    label.style = new TextStyle({
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: 13 / Math.max(0.65, Math.min(1.35, boardStore.state.camera.zoom)),
      fill: connector.color,
      fontWeight: '600',
      stroke: { color: 0xf6f7f8, width: 5 },
    });
    label.position.set((a.x + b.x) / 2, (a.y + b.y) / 2 - 10 / boardStore.state.camera.zoom);
  }

  private refreshPhotoVisibility(elements: BoardElement[]) {
    const bounds = this.viewportWorldBounds();
    const zoom = boardStore.state.camera.zoom;
    for (const element of elements) {
      if (element.kind !== 'photo') continue;
      const record = this.records.get(element.id);
      if (!record) continue;
      const visible = visibleInWorldRect(element, bounds.left, bounds.top, bounds.right, bounds.bottom);
      if (!visible) {
        this.detachPhotoTexture(record);
        continue;
      }
      const projectedWidth = element.width * zoom;
      const lod: 'micro' | 'thumb' | 'preview' = projectedWidth < 180 ? 'micro' : projectedWidth > 520 ? 'preview' : 'thumb';
      if (record.lod !== lod) void this.attachPhotoTexture(record, element, lod);
      else if (record.textureUrl) this.texturePool.touch(record.textureUrl);
    }
  }

  private async attachPhotoTexture(record: RenderRecord, element: PhotoElement, lod: 'micro' | 'thumb' | 'preview') {
    const path = lod === 'preview' ? element.asset.previewPath : lod === 'micro' ? element.asset.microPath : element.asset.thumbnailPath;
    const url = assetUrl(path);
    if (record.textureUrl === url) return;
    this.detachPhotoTexture(record);
    record.lod = lod;
    const texture = await this.texturePool.acquire(url).catch(() => undefined);
    if (!texture || record.lod !== lod || record.root.destroyed) {
      if (texture) this.texturePool.release(url);
      return;
    }

    let sprite = record.root.getChildByLabel('photo') as Sprite | null;
    if (!sprite) {
      sprite = new Sprite({ label: 'photo' });
      sprite.eventMode = 'none';
      record.root.addChildAt(sprite, 1);
    }
    const current = boardStore.state.document.elements.find((item) => item.id === element.id);
    if (!current || current.kind !== 'photo') {
      this.texturePool.release(url);
      sprite.destroy();
      record.lod = undefined;
      return;
    }
    sprite.texture = texture;
    sprite.width = current.width;
    sprite.height = current.height;
    record.textureUrl = url;
  }

  private detachPhotoTexture(record: RenderRecord) {
    if (record.textureUrl) this.texturePool.release(record.textureUrl);
    record.textureUrl = undefined;
    record.lod = undefined;
    const sprite = record.root.getChildByLabel('photo') as Sprite | null;
    if (sprite) sprite.destroy();
  }

  private removeRecord(id: string, record: RenderRecord) {
    this.detachPhotoTexture(record);
    record.root.destroy({ children: true });
    this.records.delete(id);
  }

  private onElementPointerDown(id: string, event: FederatedPointerEvent) {
    const tool = boardStore.state.tool;
    const point = { x: event.global.x, y: event.global.y };

    if (tool === 'hand' || event.button === 1 || event.button === 2) {
      event.stopPropagation();
      this.drag = { mode: 'pan', last: point, moved: false };
      return;
    }
    if (tool === 'pen') {
      event.stopPropagation();
      this.startDrawing(point);
      return;
    }
    if (tool === 'connector') {
      event.stopPropagation();
      boardStore.connectorClick(id);
      return;
    }
    if (tool === 'rect' || tool === 'ellipse' || tool === 'sticky' || tool === 'text') return;

    event.stopPropagation();
    const element = boardStore.state.document.elements.find((item) => item.id === id);
    if (!element || element.kind === 'connector') return;
    if (event.shiftKey) boardStore.toggleSelect(id);
    else if (!boardStore.state.selectedIds.includes(id)) boardStore.select([id]);
    if (!element.locked && boardStore.state.selectedIds.includes(id)) this.drag = { mode: 'move', last: point, moved: false };
  }

  private onPointerDown = (event: FederatedPointerEvent) => {
    if (this.pinch) return;
    const tool = boardStore.state.tool;
    const point = { x: event.global.x, y: event.global.y };
    if (tool === 'hand' || event.button === 1 || event.button === 2) {
      this.drag = { mode: 'pan', last: point, moved: false };
      return;
    }
    if (tool === 'pen') {
      this.startDrawing(point);
      return;
    }
    const world = screenToWorld(point, boardStore.state.camera);
    if (tool === 'rect' || tool === 'ellipse' || tool === 'sticky' || tool === 'text') {
      boardStore.addShape(tool, world);
      return;
    }
    if (tool === 'connector') {
      boardStore.select([]);
      return;
    }
    boardStore.select([]);
    if (event.pointerType === 'touch') this.drag = { mode: 'pan', last: point, moved: false };
    else this.drag = { mode: 'marquee', start: point, current: point };
  };

  private onPointerMove = (event: FederatedPointerEvent) => {
    if (!this.drag || this.pinch) return;
    const nowPoint = { x: event.global.x, y: event.global.y };
    if (this.drag.mode === 'pan') {
      const dx = nowPoint.x - this.drag.last.x;
      const dy = nowPoint.y - this.drag.last.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.5) this.drag.moved = true;
      const camera = boardStore.state.camera;
      boardStore.setCamera({ ...camera, x: camera.x + dx, y: camera.y + dy });
      this.drag.last = nowPoint;
      return;
    }
    if (this.drag.mode === 'move') {
      const dx = nowPoint.x - this.drag.last.x;
      const dy = nowPoint.y - this.drag.last.y;
      if (!this.drag.moved && Math.abs(dx) + Math.abs(dy) > 0.5) {
        this.drag.moved = true;
        boardStore.beginTransient();
      }
      if (this.drag.moved) {
        const zoom = boardStore.state.camera.zoom;
        boardStore.moveSelectedTransient(dx / zoom, dy / zoom);
      }
      this.drag.last = nowPoint;
      return;
    }
    if (this.drag.mode === 'marquee') {
      this.drag.current = nowPoint;
      this.drawMarquee(this.drag.start, nowPoint);
      return;
    }
    if (this.drag.mode === 'draw') {
      const world = screenToWorld(nowPoint, boardStore.state.camera);
      const previous = this.drag.points[this.drag.points.length - 1];
      if (!previous || Math.hypot(world.x - previous.x, world.y - previous.y) > 1.5 / boardStore.state.camera.zoom) {
        this.drag.points.push(world);
        this.drawInkPreview(this.drag.points);
      }
      return;
    }
    if (this.drag.mode === 'resize') {
      const world = screenToWorld(nowPoint, boardStore.state.camera);
      const dx = world.x - this.drag.start.x;
      const dy = world.y - this.drag.start.y;
      const resizeId = this.drag.id;
      const element = boardStore.state.document.elements.find((item) => item.id === resizeId);
      if (!element || element.kind === 'connector') return;
      let width = Math.max(40, this.drag.base.width + dx);
      let height = Math.max(36, this.drag.base.height + dy);
      if (element.kind === 'photo' || event.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) height = width / this.drag.aspect;
        else width = height * this.drag.aspect;
      }
      boardStore.updateElementTransient(element.id, { width, height } as Partial<BoardElement>);
      return;
    }
    if (this.drag.mode === 'rotate') {
      const world = screenToWorld(nowPoint, boardStore.state.camera);
      const angle = Math.atan2(world.y - this.drag.center.y, world.x - this.drag.center.x);
      let rotation = this.drag.baseRotation + angle - this.drag.startAngle;
      if (event.shiftKey) rotation = Math.round(rotation / (Math.PI / 12)) * (Math.PI / 12);
      boardStore.updateElementTransient(this.drag.id, { rotation } as Partial<BoardElement>);
    }
  };

  private onPointerUp = () => {
    if (!this.drag || this.pinch) return;
    if (this.drag.mode === 'move' && this.drag.moved) boardStore.checkpoint();
    if (this.drag.mode === 'resize' || this.drag.mode === 'rotate') boardStore.checkpoint();
    if (this.drag.mode === 'marquee') {
      const startWorld = screenToWorld(this.drag.start, boardStore.state.camera);
      const endWorld = screenToWorld(this.drag.current, boardStore.state.camera);
      boardStore.selectInRect(
        Math.min(startWorld.x, endWorld.x),
        Math.min(startWorld.y, endWorld.y),
        Math.max(startWorld.x, endWorld.x),
        Math.max(startWorld.y, endWorld.y),
      );
      this.overlay.clear();
    }
    if (this.drag.mode === 'draw') {
      boardStore.addDrawing(this.drag.points);
      this.inkPreview.clear();
    }
    this.drag = undefined;
  };

  private startDrawing(screenPoint: Point) {
    const world = screenToWorld(screenPoint, boardStore.state.camera);
    this.drag = { mode: 'draw', points: [world] };
    this.drawInkPreview([world]);
  }

  private drawInkPreview(points: Point[]) {
    this.inkPreview.clear();
    const [first, ...rest] = points;
    if (!first) return;
    this.inkPreview.moveTo(first.x, first.y);
    for (const point of rest) this.inkPreview.lineTo(point.x, point.y);
    this.inkPreview.stroke({ color: 0x242424, width: 3 / boardStore.state.camera.zoom, cap: 'round', join: 'round' });
  }

  private drawMarquee(a: Point, b: Point) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const width = Math.abs(a.x - b.x);
    const height = Math.abs(a.y - b.y);
    this.overlay.clear().rect(x, y, width, height).fill({ color: 0x4f6df5, alpha: 0.08 }).stroke({ color: 0x4f6df5, width: 1.5, alpha: 0.9 });
  }

  private onContextLost = (event: Event) => {
    event.preventDefault();
    for (const record of this.records.values()) this.detachPhotoTexture(record);
  };

  private onContextRestored = () => {
    void this.texturePool.clear().finally(() => {
      this.refreshPhotoVisibility(boardStore.state.document.elements);
    });
  };

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const camera = boardStore.state.camera;
    if (event.ctrlKey || event.metaKey) {
      const rect = this.app.canvas.getBoundingClientRect();
      const mouse = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const before = screenToWorld(mouse, camera);
      const zoom = Math.max(0.06, Math.min(6, camera.zoom * Math.exp(-event.deltaY * 0.002)));
      boardStore.setCamera({ x: mouse.x - before.x * zoom, y: mouse.y - before.y * zoom, zoom });
    } else {
      boardStore.setCamera({ ...camera, x: camera.x - event.deltaX, y: camera.y - event.deltaY });
    }
  };

  private pointerPoint(event: PointerEvent): Point {
    const rect = this.app.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private onDomPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    this.touchPointers.set(event.pointerId, this.pointerPoint(event));
    if (this.touchPointers.size === 2) {
      if (this.drag?.mode === 'move' && this.drag.moved) boardStore.checkpoint();
      if (this.drag?.mode === 'resize' || this.drag?.mode === 'rotate') boardStore.checkpoint();
      if (this.drag?.mode === 'marquee') this.overlay.clear();
      if (this.drag?.mode === 'draw') this.inkPreview.clear();
      const [a, b] = [...this.touchPointers.values()];
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.pinch = {
        distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        zoom: boardStore.state.camera.zoom,
        worldCenter: screenToWorld(center, boardStore.state.camera),
      };
      this.drag = undefined;
      this.overlay.clear();
    }
  };

  private onDomPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !this.touchPointers.has(event.pointerId)) return;
    this.touchPointers.set(event.pointerId, this.pointerPoint(event));
    if (!this.pinch || this.touchPointers.size < 2) return;
    event.preventDefault();
    const [a, b] = [...this.touchPointers.values()];
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const zoom = Math.max(0.06, Math.min(6, this.pinch.zoom * (distance / this.pinch.distance)));
    boardStore.setCamera({
      x: center.x - this.pinch.worldCenter.x * zoom,
      y: center.y - this.pinch.worldCenter.y * zoom,
      zoom,
    });
  };

  private onDomPointerUp = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    this.touchPointers.delete(event.pointerId);
    if (this.touchPointers.size < 2) this.pinch = undefined;
  };

  private editText(id: string) {
    const element = boardStore.state.document.elements.find((item) => item.id === id);
    if (!element || !('text' in element) || element.locked) return;
    this.editor?.remove();
    const camera = boardStore.state.camera;
    const topLeft = worldToScreen({ x: element.x, y: element.y }, camera);
    const textarea = document.createElement('textarea');
    textarea.className = 'canvas-text-editor';
    textarea.value = element.text;
    textarea.style.left = `${topLeft.x}px`;
    textarea.style.top = `${topLeft.y}px`;
    textarea.style.width = `${Math.max(100, element.width * camera.zoom)}px`;
    textarea.style.height = `${Math.max(52, element.height * camera.zoom)}px`;
    textarea.style.fontSize = `${Math.max(14, ('fontSize' in element ? element.fontSize : 20) * camera.zoom)}px`;
    textarea.style.transform = `rotate(${element.rotation}rad)`;
    textarea.style.transformOrigin = 'top left';
    if (element.kind === 'sticky') textarea.style.background = `#${element.fill.toString(16).padStart(6, '0')}`;
    this.host.appendChild(textarea);
    this.editor = textarea;
    const original = element.text;
    const commit = () => {
      if (this.editor !== textarea) return;
      this.editor = undefined;
      textarea.remove();
      if (textarea.value !== original) boardStore.setElementText(id, textarea.value);
    };
    textarea.addEventListener('blur', commit, { once: true });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        textarea.value = original;
        textarea.blur();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') textarea.blur();
    });
    textarea.focus();
    textarea.select();
  }
}
