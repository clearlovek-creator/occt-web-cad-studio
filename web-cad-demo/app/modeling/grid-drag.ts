import type { PrimitiveKind, SurfaceKind } from "../workbench/ribbon-catalog";
export type GridDragKind = PrimitiveKind | "disk" | "rectangle" | `surface-${SurfaceKind}`;

export type GeometrySnapKind = "endpoint" | "midpoint";
export type GridPoint = { x: number; y: number; snap?: GeometrySnapKind };
export type GridDragStage = "idle" | "base" | "height";

/** Shared progress vocabulary for the viewport; planar/radial tools finish in two steps. */
export function gridDragSteps(kind: GridDragKind): { stage: GridDragStage; label: string }[] {
  const rectangular = ["box", "wedge", "pyramid", "rectangle", "surface-rectangle"].includes(kind);
  return [
    { stage: "idle", label: rectangular ? "起点" : "中心" },
    { stage: "base", label: kind === "rectangle" || kind === "surface-rectangle" ? "平面范围" : rectangular ? "底面" : "半径" },
    ...(needsDragHeight(kind) ? [{ stage: "height" as const, label: kind === "torus" ? "管半径" : "高度" }] : []),
  ];
}

/** A double click at the footprint must not accidentally commit a 1 mm solid. */
export function hasDragHeightMovement(dx: number, dy: number): boolean {
  return Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) >= 4;
}

/** A landing click may cross a snapped grid cell without intending to draw. */
export function hasDragFootprintMovement(dx: number, dy: number): boolean {
  return hasDragHeightMovement(dx, dy);
}

/** Only motion along the positive construction axis arms height confirmation.
 * Sideways motion (or moving below the base) must not commit the clamped
 * minimum height. Near top view, the visible height gesture is screen-up.
 */
export function hasDragHeightAdjustment(dx: number, dy: number, axisX: number, axisY: number): boolean {
  if (![dx, dy, axisX, axisY].every(Number.isFinite)) return false;
  const length = Math.hypot(axisX, axisY);
  const projectedPixels = length > .15 ? (dx * axisX + dy * axisY) / length : -dy;
  return projectedPixels >= 4;
}

export function shouldSwitchModelingMethod(event: {
  code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean;
  repeat: boolean; isComposing: boolean; editable: boolean; inPrimitiveEditor: boolean;
}): boolean {
  return event.code === "KeyM" && event.altKey && !event.ctrlKey && !event.metaKey
    && !event.repeat && !event.isComposing && (!event.editable || event.inPrimitiveEditor);
}

export function gridDragDimensionLabel(kind: GridDragKind, stage: GridDragStage): string {
  if (stage === "height") return kind === "torus" ? "管半径" : "高度";
  if (["sphere", "surface-sphere", "disk", "surface-disk"].includes(kind)) return "半径";
  if (["rectangle", "surface-rectangle"].includes(kind)) return "平面范围";
  return "底面";
}

export function gridDragDimensionText(kind: GridDragKind, stage: GridDragStage, dimensions: { width: number; depth: number; height: number }): string {
  const format = (value: number) => Number(value.toFixed(6)).toString();
  const { width, depth, height } = dimensions;
  if (["sphere", "surface-sphere", "disk", "surface-disk"].includes(kind)) return `半径 · ${format(width / 2)} mm`;
  if (["rectangle", "surface-rectangle"].includes(kind)) return `平面范围 · ${format(width)} × ${format(depth)} mm`;
  if (kind === "torus" && stage === "height") return `管半径 · ${format(height)} mm · 主半径 ${format(width / 2)} mm`;
  return `${gridDragDimensionLabel(kind, stage)} · ${format(width)} × ${format(depth)} × ${format(height)} mm`;
}

/** The height axis passes through the footprint, not the radius-line midpoint. */
export function gridDragHeightReference(kind: GridDragKind, start: GridPoint, end: GridPoint): GridPoint {
  const rectangular = ["box", "wedge", "pyramid", "rectangle", "surface-rectangle"].includes(kind);
  return rectangular ? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } : { ...start };
}

export function gridDragInstruction(kind: GridDragKind, stage: GridDragStage) {
  const flat = ["disk", "rectangle", "surface-disk", "surface-rectangle"].includes(kind);
  const radial = !["box", "wedge", "pyramid", "rectangle", "surface-rectangle"].includes(kind);
  const total = needsDragHeight(kind) ? 3 : 2;
  if (stage === "idle") return `1/${total} · 点击${radial ? "中心" : "起点"}`;
  if (stage === "base") return `2/${total} · 移动鼠标确定${radial ? "半径" : flat ? "平面范围" : "底面"}，点击${total === 2 ? "完成" : "锁定底面"}`;
  return `3/3 · 沿构造面法向调整${kind === "torus" ? "管半径" : "高度"}，正视时向上移动，再点击完成`;
}

export function needsDragHeight(kind: GridDragKind) { return !["sphere", "surface-sphere", "disk", "rectangle", "surface-disk", "surface-rectangle"].includes(kind); }
export function makeGridDragCommand(kind: GridDragKind, start: GridPoint, end: GridPoint, gridStep = 1, requestedHeight = 20) {
  if (![start.x, start.y, end.x, end.y, gridStep, requestedHeight].every(Number.isFinite) || gridStep <= 0) return null;
  const geometrySnapped = Boolean(start.snap || end.snap);
  const dx = geometrySnapped ? Math.abs(end.x - start.x) : Math.abs(Math.round(end.x / gridStep) - Math.round(start.x / gridStep)) * gridStep;
  const dy = geometrySnapped ? Math.abs(end.y - start.y) : Math.abs(Math.round(end.y / gridStep) - Math.round(start.y / gridStep)) * gridStep;
  const shape = kind.replace("surface-", "");
  const rectangular = ["box", "wedge", "pyramid", "rectangle"].includes(shape);
  const radius = Math.hypot(dx, dy), diameter = radius * 2;
  const minimumFootprint = geometrySnapped ? 1e-7 : gridStep;
  if (rectangular ? dx < minimumFootprint || dy < minimumFootprint : radius < minimumFootprint) return null;
  const height = Math.max(gridStep, requestedHeight);
  const surface = kind.startsWith("surface-") || kind === "disk" || kind === "rectangle";

  const dimensions: Record<string, number> = shape === "box" ? { width: dx, depth: dy, height }
    : shape === "rectangle" ? { width: dx, height: dy }
    : shape === "wedge" ? { width: dx, depth: dy, height, topLength: dx / 2 }
    : shape === "pyramid" ? { baseWidth: dx, baseDepth: dy, topWidth: dx / 2, topDepth: dy / 2, height }
    : shape === "cone" ? { radius1: radius, radius2: 0, height }
    : shape === "tube" ? { outerRadius: radius, innerRadius: radius * 0.6, height }
    : shape === "torus" ? { majorRadius: radius, minorRadius: Math.min(height, radius * 0.45) }
    : shape === "prism" ? { radius, sides: 6, height }
    : shape === "cylinder" ? { radius, height } : { radius };
  // OCCT Box/Wedge use a base corner, while Rectangle/Pyramid constructors
  // use the base center. The same footprint must not move on commit.
  const centeredBase = shape === "rectangle" || shape === "pyramid";
  const parameters = { ...dimensions, x: centeredBase ? (start.x + end.x) / 2 : rectangular ? Math.min(start.x, end.x) : start.x, y: centeredBase ? (start.y + end.y) / 2 : rectangular ? Math.min(start.y, end.y) : start.y, z: 0, coordinateSystemId: "global", reset: false };

  return {
    operation: `${surface ? "surface" : "primitive"}.${shape}`,
    parameters,
    preview: {
      width: rectangular ? dx : diameter,
      depth: rectangular ? dy : diameter,
      x: rectangular ? (start.x + end.x) / 2 : start.x,
      y: rectangular ? (start.y + end.y) / 2 : start.y,
      height: surface && ["disk", "rectangle"].includes(shape) ? 0 : shape === "sphere" ? diameter : shape === "torus" ? Math.min(height, radius * .45) : height,
    },
  };
}

/** Local screen projection of the construction axis; top view falls back to vertical screen motion. */
export function heightFromScreenDrag(dx: number, dy: number, axisX: number, axisY: number, unitsPerPixel: number, gridStep = 1) {
  const length = Math.hypot(axisX, axisY);
  const value = length > 0.15 ? (dx * axisX + dy * axisY) / (length * length) : -dy * unitsPerPixel;
  return Math.max(gridStep, Math.round(value / gridStep) * gridStep);
}
