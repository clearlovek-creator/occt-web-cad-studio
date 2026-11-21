"use client";

import { useMemo, useState } from "react";
import type { FeatureData } from "./ModelMetadataPanels";

type Primitive = "box" | "cylinder" | "cone" | "sphere" | "torus";
type TransformOperation = "translate" | "rotate" | "mirror" | "scale";

export type DirectModelResult = {
  ok: true;
  revision: number;
  bodyCount: number;
  canUndo?: boolean;
  canRedo?: boolean;
  bodyId: string;
  topologyRevision: number;
  features: FeatureData[];
  positions: number[];
  normals: number[];
  indices: number[];
  triangleFaceIds: string[];
  edges: { edgeId: string; points: number[] }[];
  stats: { faceCount: number; edgeCount: number; triangleCount: number };
};


import type { ModelingCommandInput } from "./modeling/command-contract";
import { executeModelingCommand } from "./modeling/runtime";

async function command(payload: ModelingCommandInput) {
  return await executeModelingCommand<DirectModelResult>(payload);
}

export function DirectModelingPanel({
  model,
  onModel,
  mode = "all",
}: {
  model: { revision: number; bodyId: string } | null;
  onModel: (result: DirectModelResult) => void;
  mode?: "all" | "primitive" | "transform";
}) {
  const [primitive, setPrimitive] = useState<Primitive>("box");
  const [boxWidth, setBoxWidth] = useState(100);
  const [boxDepth, setBoxDepth] = useState(80);
  const [radius1, setRadius1] = useState(12);
  const [radius2, setRadius2] = useState(5);
  const [height, setHeight] = useState(50);
  const [transformOperation, setTransformOperation] = useState<TransformOperation>("translate");
  const [vectorX, setVectorX] = useState(10);
  const [vectorY, setVectorY] = useState(0);
  const [vectorZ, setVectorZ] = useState(0);
  const [originX, setOriginX] = useState(0);
  const [originY, setOriginY] = useState(0);
  const [originZ, setOriginZ] = useState(0);
  const [angleDegrees, setAngleDegrees] = useState(90);
  const [scaleFactor, setScaleFactor] = useState(1.2);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const primitiveParameters = useMemo(() => {
    const result: Record<string, number | boolean> = { reset: false };
    if (primitive === "box") Object.assign(result, { width: boxWidth, depth: boxDepth, height });
    else if (primitive === "cylinder") Object.assign(result, { radius: radius1, height });
    else if (primitive === "cone") Object.assign(result, { radius1, radius2, height });
    else if (primitive === "sphere") Object.assign(result, { radius: radius1 });
    else Object.assign(result, { majorRadius: radius1, minorRadius: radius2 });
    return result;
  }, [boxDepth, boxWidth, height, primitive, radius1, radius2]);

  const transformParameters = useMemo(() => {
    const result: Record<string, number> = {};
    if (transformOperation === "translate") Object.assign(result, { dx: vectorX, dy: vectorY, dz: vectorZ });
    else if (transformOperation === "rotate") Object.assign(result, { originX, originY, originZ, axisX: vectorX, axisY: vectorY, axisZ: vectorZ, angleDegrees });
    else if (transformOperation === "mirror") Object.assign(result, { originX, originY, originZ, normalX: vectorX, normalY: vectorY, normalZ: vectorZ });
    else Object.assign(result, { originX, originY, originZ, factor: scaleFactor });
    return result;
  }, [angleDegrees, originX, originY, originZ, scaleFactor, transformOperation, vectorX, vectorY, vectorZ]);

  const create = async () => {
    setBusy(true); setMessage(null);
    try {
      const result = await command({ operation: `primitive.${primitive}`, parameters: primitiveParameters });
      onModel(result);
      setMessage(`已创建 ${primitive}，文档版本 R${result.revision}`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "基础体创建失败。");
    } finally { setBusy(false); }
  };

  const chooseTransform = (operation: TransformOperation) => {
    setTransformOperation(operation);
    if (operation === "translate") { setVectorX(10); setVectorY(0); setVectorZ(0); }
    else if (operation === "mirror") { setVectorX(1); setVectorY(0); setVectorZ(0); }
    else if (operation === "rotate") { setVectorX(0); setVectorY(0); setVectorZ(1); }
  };

  const executeTransform = async () => {
    if (!model) return;
    setBusy(true); setMessage(null);
    try {
      const result = await command({
        operation: `transform.${transformOperation}`,
        baseRevision: model.revision,
        inputs: { bodyId: model.bodyId },
        parameters: transformParameters,
      });
      onModel(result);
      setMessage(`${transformOperation} 完成，文档版本 R${result.revision}`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "实体变换失败。");
    } finally { setBusy(false); }
  };

  const directionLabel = transformOperation === "translate" ? "平移" : transformOperation === "rotate" ? "旋转轴" : "平面法向";

  return (
    <section className="panel-section direct-modeling" data-testid="direct-modeling-panel">
      <div className="section-heading compact">
        <div><span className="eyebrow">DIRECT MODELING</span><h2>{mode === "primitive" ? "创建基础体" : mode === "transform" ? "实体变换" : "基础体与变换"}</h2></div>
        <span className="feature-badge">3D</span>
      </div>
      {mode !== "transform" && <>
      <select className="operation-select" aria-label="基础体类型" value={primitive} onChange={(event) => setPrimitive(event.target.value as Primitive)}>
        <option value="box">Box 长方体</option>
        <option value="cylinder">Cylinder 圆柱</option>
        <option value="cone">Cone 圆锥</option>
        <option value="sphere">Sphere 球</option>
        <option value="torus">Torus 圆环</option>
      </select>
      <div className="compact-fields">
        {primitive === "box" ? <>
          <label><span>长度 X</span><input aria-label="长度 X" type="number" min="0.1" value={boxWidth} onChange={(event) => setBoxWidth(Number(event.target.value))} /></label>
          <label><span>深度 Y</span><input aria-label="深度 Y" type="number" min="0.1" value={boxDepth} onChange={(event) => setBoxDepth(Number(event.target.value))} /></label>
          <label><span>高度 Z</span><input aria-label="高度 Z" type="number" min="0.1" value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label>
        </> : <>
          <label><span>{primitive === "torus" ? "主半径" : "半径 R1"}</span><input type="number" min="0.1" value={radius1} onChange={(event) => setRadius1(Number(event.target.value))} /></label>
          {(primitive === "cone" || primitive === "torus") && <label><span>{primitive === "torus" ? "管半径" : "半径 R2"}</span><input type="number" min="0" value={radius2} onChange={(event) => setRadius2(Number(event.target.value))} /></label>}
          {(primitive === "cylinder" || primitive === "cone") && <label><span>高度</span><input type="number" min="0.1" value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label>}
        </>}
      </div>
      <button className="primary-action" disabled={busy} onClick={() => void create()}>创建基础体</button>
      </>}
      {mode !== "primitive" && <>
      <p className="subsection-label">变换当前显示实体</p>
      <select className="operation-select" aria-label="变换类型" value={transformOperation} onChange={(event) => chooseTransform(event.target.value as TransformOperation)}>
        <option value="translate">Translate 平移</option>
        <option value="rotate">Rotate 旋转</option>
        <option value="mirror">Mirror 平面镜像</option>
        <option value="scale">Scale 统一缩放</option>
      </select>
      {transformOperation !== "scale" && (
        <>
          <p className="vector-label">{transformOperation === "translate" ? "位移 (mm)" : directionLabel}</p>
          <div className="vector-fields">
            <label><span>X</span><input aria-label={`${directionLabel} X`} type="number" value={vectorX} onChange={(event) => setVectorX(Number(event.target.value))} /></label>
            <label><span>Y</span><input aria-label={`${directionLabel} Y`} type="number" value={vectorY} onChange={(event) => setVectorY(Number(event.target.value))} /></label>
            <label><span>Z</span><input aria-label={`${directionLabel} Z`} type="number" value={vectorZ} onChange={(event) => setVectorZ(Number(event.target.value))} /></label>
          </div>
        </>
      )}
      {transformOperation !== "translate" && (
        <>
          <p className="vector-label">原点 / 中心 (mm)</p>
          <div className="vector-fields">
            <label><span>X</span><input aria-label="变换原点 X" type="number" value={originX} onChange={(event) => setOriginX(Number(event.target.value))} /></label>
            <label><span>Y</span><input aria-label="变换原点 Y" type="number" value={originY} onChange={(event) => setOriginY(Number(event.target.value))} /></label>
            <label><span>Z</span><input aria-label="变换原点 Z" type="number" value={originZ} onChange={(event) => setOriginZ(Number(event.target.value))} /></label>
          </div>
        </>
      )}
      {transformOperation === "rotate" && <label className="single-field transform-scalar"><span>角度</span><div className="number-field"><input aria-label="旋转角度" type="number" value={angleDegrees} onChange={(event) => setAngleDegrees(Number(event.target.value))} /><em>deg</em></div></label>}
      {transformOperation === "scale" && <label className="single-field transform-scalar"><span>缩放因子</span><div className="number-field"><input aria-label="缩放因子" type="number" min="0.001" step="0.1" value={scaleFactor} onChange={(event) => setScaleFactor(Number(event.target.value))} /><em>×</em></div></label>}
      <button className="secondary-action" disabled={busy || !model} onClick={() => void executeTransform()}>执行 {transformOperation}</button>
      </>}
      {message && <p className="exchange-message">{message}</p>}
    </section>
  );
}