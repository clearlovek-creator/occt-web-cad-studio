export type MeasurementTarget = { documentId: string; bodyId: string; selectionType: "body" | "face" | "edge"; selectionId: string };
export type MeasurementResult = {
  documentId?: string; stateToken?: string; revision?: number;
  selectionType: MeasurementTarget["selectionType"]; selectionId: string; bodyId: string;
  volume?: number; area?: number; length?: number; perimeter?: number; centroid?: number[];
  edgeLengthPolicy?: string;
  bounds?: { min: number[]; max: number[] } | null;
  curveType?: string; endpoints?: number[][]; radius?: number; center?: number[];
  obb?: { source?: string; exact?: boolean; minimum?: boolean; center?: number[]; axes?: number[][]; halfSize?: number[] } | null;
};
export type MeasurementSnapshot = { target: MeasurementTarget; stateToken: string; result: MeasurementResult };
export const measurementTargetKey = (target: MeasurementTarget | null) => target ? JSON.stringify([target.documentId, target.bodyId, target.selectionType, target.selectionId]) : "";

export function measurementState(snapshot: MeasurementSnapshot, target: MeasurementTarget | null, stateToken: string | null): "current" | "different-target" | "stale" {
  if (snapshot.target.documentId !== target?.documentId || snapshot.stateToken !== stateToken) return "stale";
  return measurementTargetKey(snapshot.target) === measurementTargetKey(target) ? "current" : "different-target";
}

export function measurementMatches(result: MeasurementResult, target: MeasurementTarget, stateToken: string): boolean {
  return result.documentId === target.documentId && result.stateToken === stateToken && result.bodyId === target.bodyId
    && result.selectionType === target.selectionType && result.selectionId === target.selectionId;
}

/** Do not retain or copy the full document response, unrelated project data or display buffers. */
export function compactMeasurement(result: MeasurementResult): MeasurementResult {
  const { documentId, stateToken, revision, selectionType, selectionId, bodyId, volume, area, length, perimeter, centroid, bounds, curveType, endpoints, radius, center, obb, edgeLengthPolicy } = result;
  return { documentId, stateToken, revision, selectionType, selectionId, bodyId, volume, area, length, perimeter, centroid, bounds, curveType, endpoints, radius, center, obb, edgeLengthPolicy };
}

export type MeasurementRow = { key: string; label: string; unit?: string; value: unknown; vector?: boolean; text?: boolean };
export function measurementRows(result: MeasurementResult): MeasurementRow[] {
  const rows: MeasurementRow[] = result.selectionType === "body"
    ? [{ key: "volume", label: "体积", unit: "mm³", value: result.volume }, { key: "area", label: "表面积", unit: "mm²", value: result.area }, { key: "length", label: result.edgeLengthPolicy === "unique-topological-edges" ? "拓扑边总长" : "边长累计（旧口径）", unit: "mm", value: result.length }]
    : result.selectionType === "face"
      ? [{ key: "area", label: "面积", unit: "mm²", value: result.area }, { key: "perimeter", label: "周长", unit: "mm", value: result.perimeter }]
      : [{ key: "length", label: "长度", unit: "mm", value: result.length }, { key: "curveType", label: "曲线类型", value: result.curveType, text: true }];
  if (result.radius != null) rows.push({ key: "radius", label: "半径", unit: "mm", value: result.radius });
  if (result.centroid) rows.push({ key: "centroid", label: "重心", unit: "mm", value: result.centroid, vector: true });
  if (result.center) rows.push({ key: "center", label: "圆心", unit: "mm", value: result.center, vector: true });
  if (result.endpoints) result.endpoints.slice(0, 2).forEach((point, index) => rows.push({ key: `endpoint-${index}`, label: `端点 ${index + 1}`, unit: "mm", value: point, vector: true }));
  if (result.bounds) rows.push({ key: "bounds-min", label: "包围盒最小值", unit: "mm", value: result.bounds.min, vector: true }, { key: "bounds-max", label: "包围盒最大值", unit: "mm", value: result.bounds.max, vector: true });
  return rows;
}
