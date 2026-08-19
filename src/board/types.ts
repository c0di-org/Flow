export type Point = { x: number; y: number };
export type Size = { width: number; height: number };

export type ElementKind = 'photo' | 'rect' | 'ellipse' | 'sticky' | 'text' | 'connector' | 'drawing';

export type BaseElement = {
  id: string;
  kind: ElementKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  z: number;
  locked?: boolean;
  opacity?: number;
};

export type PhotoAsset = {
  id: string;
  name: string;
  originalPath: string;
  previewPath: string;
  thumbnailPath: string;
  microPath: string;
  pixelWidth: number;
  pixelHeight: number;
  bytes: number;
};

export type PhotoElement = BaseElement & {
  kind: 'photo';
  asset: PhotoAsset;
};

export type ShapeElement = BaseElement & {
  kind: 'rect' | 'ellipse' | 'sticky';
  text: string;
  fill: number;
  stroke: number;
  fontSize: number;
};

export type TextElement = BaseElement & {
  kind: 'text';
  text: string;
  color: number;
  fontSize: number;
};

export type ConnectorElement = BaseElement & {
  kind: 'connector';
  fromId: string;
  toId: string;
  color: number;
  widthPx: number;
  label: string;
};

export type DrawingElement = BaseElement & {
  kind: 'drawing';
  points: Point[];
  color: number;
  widthPx: number;
};

export type BoardElement = PhotoElement | ShapeElement | TextElement | ConnectorElement | DrawingElement;

export type BoardDocument = {
  version: 2;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  elements: BoardElement[];
};

export type BoardSummary = {
  id: string;
  title: string;
  updatedAt: number;
};

export type Tool = 'select' | 'hand' | 'pen' | 'rect' | 'ellipse' | 'sticky' | 'text' | 'connector';

export type Camera = {
  x: number;
  y: number;
  zoom: number;
};

export type BoardSettings = {
  showGrid: boolean;
  snapToGrid: boolean;
};
