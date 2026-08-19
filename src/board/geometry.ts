import type { BoardElement, Camera, Point } from './types';

export function screenToWorld(point: Point, camera: Camera): Point {
  return {
    x: (point.x - camera.x) / camera.zoom,
    y: (point.y - camera.y) / camera.zoom,
  };
}

export function worldToScreen(point: Point, camera: Camera): Point {
  return {
    x: point.x * camera.zoom + camera.x,
    y: point.y * camera.zoom + camera.y,
  };
}

export function elementContains(element: BoardElement, point: Point): boolean {
  if (element.kind === 'connector') return false;
  return (
    point.x >= element.x &&
    point.x <= element.x + element.width &&
    point.y >= element.y &&
    point.y <= element.y + element.height
  );
}

export function visibleInWorldRect(
  element: BoardElement,
  left: number,
  top: number,
  right: number,
  bottom: number,
): boolean {
  if (element.kind === 'connector') return true;
  return !(
    element.x + element.width < left ||
    element.x > right ||
    element.y + element.height < top ||
    element.y > bottom
  );
}

export function connectorEndpoints(a: BoardElement, b: BoardElement): [Point, Point] {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;

  const edge = (e: BoardElement, towardDx: number, towardDy: number): Point => {
    const cx = e.x + e.width / 2;
    const cy = e.y + e.height / 2;
    const sx = Math.abs(towardDx) < 0.001 ? Infinity : (e.width / 2) / Math.abs(towardDx);
    const sy = Math.abs(towardDy) < 0.001 ? Infinity : (e.height / 2) / Math.abs(towardDy);
    const t = Math.min(sx, sy);
    return { x: cx + towardDx * t, y: cy + towardDy * t };
  };

  return [edge(a, dx, dy), edge(b, -dx, -dy)];
}

export function collageLayout(
  count: number,
  origin: Point,
  sourceSizes: Array<{ width: number; height: number }>,
): Array<{ x: number; y: number; width: number; height: number }> {
  const gap = 18;
  const targetWidth = 260;
  const columns = Math.max(2, Math.min(8, Math.ceil(Math.sqrt(count))));
  const columnHeights = new Array(columns).fill(origin.y);

  return sourceSizes.map((size, index) => {
    const column = columnHeights.indexOf(Math.min(...columnHeights));
    const ratio = size.width / Math.max(1, size.height);
    let width = targetWidth;
    let height = targetWidth / ratio;
    // Fit very tall sources into the collage cell without ever distorting them.
    if (height > 390) {
      height = 390;
      width = height * ratio;
    }
    const x = origin.x + column * (targetWidth + gap) + (targetWidth - width) / 2;
    const y = columnHeights[column];
    columnHeights[column] = y + height + gap;
    return { x, y, width, height };
  });
}
