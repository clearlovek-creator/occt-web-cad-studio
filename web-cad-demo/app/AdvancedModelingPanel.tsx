"use client";

import { useEffect, useMemo, useState } from "react";
import type { CoordinateSystemData, MaterialData, ScalarVariableData } from "./ProjectDataPanel";
import type { DirectModelResult } from "./DirectModelingPanel";
import type { PrimitiveKind, SurfaceKind, TransformKind } from "./workbench/ribbon-catalog";
import {useEditorCommands} from "./modeling/CommandEditScope";

type Primitive = "box" | "cylinder" | "cone" | "sphere" | "torus" | "wedge" | "prism" | "pyramid" | "tube";
type Surface = "rectangle" | "disk" | "cylinder" | "cone" | "sphere";
type Transform = "translate" | "rotate" | "mirror" | "scale" | "scale_non_uniform" | "coordinate" | "align" | "copy";
type Field = { key: string; label: string; defaultValue: string; unit?: string };

const primitiveFields: Record<Primitive, Field[]> = {
  box: [{ key: "width", label: "长度 X", defaultValue: "100", unit: "mm" }, { key: "depth", label: "深度 Y", defaultValue: "80", unit: "mm" }, { key: "height", label: "高度 Z", defaultValue: "50", unit: "mm" }],
  cylinder: [{ key: "radius", label: "半径", defaultValue: "20", unit: "mm" }, { key: "height", label: "高度", defaultValue: "50", unit: "mm" }],
  cone: [{ key: "radius1", label: "底部半径", defaultValue: "25", unit: "mm" }, { key: "radius2", label: "顶部半径", defaultValue: "10", unit: "mm" }, { key: "height", label: "高度", defaultValue: "50", unit: "mm" }],
  sphere: [{ key: "radius", label: "半径", defaultValue: "25", unit: "mm" }],
  torus: [{ key: "majorRadius", label: "主半径", defaultValue: "30", unit: "mm" }, { key: "minorRadius", label: "管半径", defaultValue: "8", unit: "mm" }],
  wedge: [{ key: "width", label: "长度", defaultValue: "60", unit: "mm" }, { key: "depth", label: "深度", defaultValue: "40", unit: "mm" }, { key: "height", label: "高度", defaultValue: "35", unit: "mm" }, { key: "topLength", label: "顶部长度", defaultValue: "25", unit: "mm" }],
  prism: [{ key: "radius", label: "外接圆半径", defaultValue: "25", unit: "mm" }, { key: "sides", label: "边数", defaultValue: "6" }, { key: "height", label: "高度", defaultValue: "50", unit: "mm" }],
  pyramid: [{ key: "baseWidth", label: "底部宽度", defaultValue: "50", unit: "mm" }, { key: "baseDepth", label: "底部深度", defaultValue: "40", unit: "mm" }, { key: "topWidth", label: "顶部宽度", defaultValue: "20", unit: "mm" }, { key: "topDepth", label: "顶部深度", defaultValue: "15", unit: "mm" }, { key: "height", label: "高度", defaultValue: "50", unit: "mm" }],
  tube: [{ key: "outerRadius", label: "外半径", defaultValue: "25", unit: "mm" }, { key: "innerRadius", label: "内半径", defaultValue: "15", unit: "mm" }, { key: "height", label: "高度", defaultValue: "50", unit: "mm" }],
};

const surfaceFields: Record<Surface, Field[]> = {
  rectangle: [{ key: "width", label: "宽度 X", defaultValue: "100", unit: "mm" }, { key: "height", label: "高度 Y", defaultValue: "80", unit: "mm" }],
  disk: [{ key: "radius", label: "半径", defaultValue: "30", unit: "mm" }],
  cylinder: [{ key: "radius", label: "半径", defaultValue: "25", unit: "mm" }, { key: "height", label: "高度", defaultValue: "60", unit: "mm" }],
  cone: [{ key: "radius1", label: "底部半径", defaultValue: "30", unit: "mm" }, { key: "radius2", label: "顶部半径", defaultValue: "10", unit: "mm" }, { key: "height", label: "高度", defaultValue: "60", unit: "mm" }],
  sphere: [{ key: "radius", label: "半径", defaultValue: "30", unit: "mm" }],
};

const transformFields: Record<Transform, Field[]> = {
  translate: [{ key: "dx", label: "位移 X", defaultValue: "10", unit: "mm" }, { key: "dy", label: "位移 Y", defaultValue: "0", unit: "mm" }, { key: "dz", label: "位移 Z", defaultValue: "0", unit: "mm" }],
  rotate: [{ key: "originX", label: "中心 X", defaultValue: "0", unit: "mm" }, { key: "originY", label: "中心 Y", defaultValue: "0", unit: "mm" }, { key: "originZ", label: "中心 Z", defaultValue: "0", unit: "mm" }, { key: "axisX", label: "轴向 X", defaultValue: "0" }, { key: "axisY", label: "轴向 Y", defaultValue: "0" }, { key: "axisZ", label: "轴向 Z", defaultValue: "1" }, { key: "angleDegrees", label: "角度", defaultValue: "90", unit: "deg" }],
  mirror: [{ key: "originX", label: "基点 X", defaultValue: "0", unit: "mm" }, { key: "originY", label: "基点 Y", defaultValue: "0", unit: "mm" }, { key: "originZ", label: "基点 Z", defaultValue: "0", unit: "mm" }, { key: "normalX", label: "方向 X", defaultValue: "1" }, { key: "normalY", label: "方向 Y", defaultValue: "0" }, { key: "normalZ", label: "方向 Z", defaultValue: "0" }],
  scale: [{ key: "originX", label: "中心 X", defaultValue: "0", unit: "mm" }, { key: "originY", label: "中心 Y", defaultValue: "0", unit: "mm" }, { key: "originZ", label: "中心 Z", defaultValue: "0", unit: "mm" }, { key: "factor", label: "缩放系数", defaultValue: "1.2" }],
  scale_non_uniform: [{ key: "originX", label: "中心 X", defaultValue: "0", unit: "mm" }, { key: "originY", label: "中心 Y", defaultValue: "0", unit: "mm" }, { key: "originZ", label: "中心 Z", defaultValue: "0", unit: "mm" }, { key: "factorX", label: "X 系数", defaultValue: "1.2" }, { key: "factorY", label: "Y 系数", defaultValue: "1" }, { key: "factorZ", label: "Z 系数", defaultValue: "1" }],
  coordinate: [],
  align: [{ key: "targetX", label: "目标 X", defaultValue: "0", unit: "mm" }, { key: "targetY", label: "目标 Y", defaultValue: "0", unit: "mm" }, { key: "targetZ", label: "目标 Z", defaultValue: "0", unit: "mm" }],
  copy: [{ key: "dx", label: "副本位移 X", defaultValue: "10", unit: "mm" }, { key: "dy", label: "副本位移 Y", defaultValue: "0", unit: "mm" }, { key: "dz", label: "副本位移 Z", defaultValue: "0", unit: "mm" }],
};

import type { ModelingCommandInput } from "./modeling/command-contract";


function defaults(fields: Field[]) {
  return Object.fromEntries(fields.map((field) => [field.key, field.defaultValue]));
}

function normalizeMissingVariableExpression(type: string, expression: string) {
  const value = expression.trim();
  if ((type === "length" || type === "angle") && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return `${value} ${type === "length" ? "mm" : "deg"}`;
  return value;
}

function suggestedVariableType(request: ModelingCommandInput, name: string) {
  const matching = Object.entries(request.parameters || {}).filter(([, value]) => typeof value === "string" && value.trim() === name);
  if (matching.length !== 1) return null;
  const key = matching[0][0];
  if (key === "angleDegrees") return "angle";
  if (key === "sides") return "integer";
  if (/^(factor|axis|normal)/.test(key)) return "dimensionless";
  return "length";
}

export function AdvancedModelingPanel({ model, onModel, mode = "all", initialPrimitive = "box", initialSurface = "rectangle", initialTransform = "translate", fixedKind = false, initialParameters, onDraftChange, onSwitchToDrag }: {
  model: { revision: number; bodyId: string; bodyName?: string; coordinateSystems?: CoordinateSystemData[] } | null;
  onModel: (result: DirectModelResult) => void;
  onProjectRevision: (result: { revision: number; variables: ScalarVariableData[]; coordinateSystems: CoordinateSystemData[]; materials: MaterialData[]; positions?: number[] }) => void;
  mode?: "all" | "primitive" | "surface" | "transform";
  initialPrimitive?: PrimitiveKind; initialSurface?: SurfaceKind; initialTransform?: TransformKind; fixedKind?: boolean;
  initialParameters?: Record<string, unknown>;
  onDraftChange?: (kind: PrimitiveKind | `surface-${SurfaceKind}`, parameters: Record<string, unknown>) => void;
  onSwitchToDrag?: () => void;
}) {
  const editorCommands=useEditorCommands();
  const command=(payload:ModelingCommandInput)=>editorCommands.execute<DirectModelResult>(payload);
  const [primitive, setPrimitive] = useState<Primitive>(initialPrimitive);
  const [surface, setSurface] = useState<Surface>(initialSurface);
  const [transform, setTransform] = useState<Transform>(initialTransform);
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...defaults(mode === "surface" ? surfaceFields[initialSurface] : mode === "transform" ? transformFields[initialTransform] : primitiveFields[initialPrimitive]), x: "0", y: "0", z: "0", ...Object.fromEntries(Object.entries(initialParameters || {}).filter(([, value]) => typeof value === "number" || typeof value === "string").map(([key, value]) => [key, typeof value === "number" ? Number(value.toPrecision(14)).toString() : String(value)])) }));
  const [coordinateSystemId, setCoordinateSystemId] = useState(String(initialParameters?.coordinateSystemId || "global"));
  const [sourceCoordinateSystemId, setSourceCoordinateSystemId] = useState("global");
  const [targetCoordinateSystemId, setTargetCoordinateSystemId] = useState("global");
  const [mirrorMode, setMirrorMode] = useState("plane");
  const [alignMode, setAlignMode] = useState("center");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [missingVariable, setMissingVariable] = useState<string | null>(null);
  const [variableType, setVariableType] = useState("length");
  const [variableExpression, setVariableExpression] = useState("10 mm");
  const [pendingRequest, setPendingRequest] = useState<ModelingCommandInput | null>(null);
  const coordinates = useMemo(() => model?.coordinateSystems?.length ? model.coordinateSystems : [{ id: "global", name: "Global" } as CoordinateSystemData], [model]);

  useEffect(() => {
    if (mode !== "primitive" && mode !== "surface") return;
    const fields = mode === "surface" ? surfaceFields[surface] : primitiveFields[primitive];
    onDraftChange?.(mode === "surface" ? `surface-${surface}` : primitive, {
      ...Object.fromEntries(fields.map(({ key }) => [key, values[key]])),
      x: values.x, y: values.y, z: values.z, coordinateSystemId, reset: false,
    });
  }, [mode, primitive, surface, values, coordinateSystemId, onDraftChange]);

  const changeKind = (kind: Primitive | Surface | Transform, fields: Field[], setter: (value: never) => void) => {
    setter(kind as never);
    setValues((current) => ({ ...current, ...defaults(fields) }));
  };
  const fieldGrid = (fields: Field[]) => <div className="compact-fields expression-fields">{fields.map((field) => <label key={field.key}><span>{field.label}</span><div className="number-field"><input aria-label={field.label} value={values[field.key] ?? field.defaultValue} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} placeholder="数值或表达式" /><em>{field.unit || "fx"}</em></div></label>)}</div>;

  const execute = async (request: ModelingCommandInput) => {
    setBusy(true); setMessage(null);
    try {
      const result = await command(request);
      onModel(result);
      setMessage(`操作完成，文档版本 R${result.revision}`);
      setPendingRequest(null);
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : "几何操作失败";
      const match = text.match(/Undefined scalar variable:\s*([A-Za-z_][A-Za-z0-9_]*)/i);
      if (match) {
        const suggested = suggestedVariableType(request, match[1]) || "length";
        setMissingVariable(match[1]); setPendingRequest(request); setVariableType(suggested);
        setVariableExpression(suggested === "angle" ? "10 deg" : suggested === "length" ? "10 mm" : "1");
      }
      setMessage(text);
    } finally { setBusy(false); }
  };

  const createPrimitive = () => {
    const parameters = { ...Object.fromEntries(primitiveFields[primitive].map(({ key }) => [key, values[key]])), x: values.x, y: values.y, z: values.z, coordinateSystemId, reset: false };
    void execute({ operation: `primitive.${primitive}`, parameters });
  };
  const createSurface = () => {
    const parameters = { ...Object.fromEntries(surfaceFields[surface].map(({ key }) => [key, values[key]])), x: values.x, y: values.y, z: values.z, coordinateSystemId, reset: false };
    void execute({ operation: `surface.${surface}`, parameters });
  };
  const executeTransform = () => {
    if (!model) return;
    const parameters: Record<string, unknown> = Object.fromEntries(transformFields[transform].map(({ key }) => [key, values[key]]));
    if (transform === "mirror") parameters.mode = mirrorMode;
    if (transform === "align") parameters.mode = alignMode;
    if (transform === "coordinate") Object.assign(parameters, { sourceCoordinateSystemId, targetCoordinateSystemId });
    void execute({ operation: `transform.${transform}`, baseRevision: model.revision, inputs: { bodyId: model.bodyId }, parameters });
  };
  const createMissingVariable = async () => {
    if (!missingVariable || !pendingRequest || !model) return;
    setBusy(true);setMessage(null);
    try {
      const result=await editorCommands.executeBatch<DirectModelResult>([{operation:"variable.set",parameters:{name:missingVariable,type:variableType,expression:normalizeMissingVariableExpression(variableType,variableExpression)}},{...pendingRequest,baseRevision:undefined,baseStateToken:undefined}]);
      setMissingVariable(null);
      setPendingRequest(null);onModel(result);setMessage(`变量与建模已整体完成，文档版本 R${result.revision}`);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "变量与建模操作失败，未提交部分修改。"); } finally{setBusy(false);}
  };

  return <section className="panel-section direct-modeling advanced-modeling" data-testid="advanced-modeling-panel">
    {onSwitchToDrag && <div className="modeling-method-handoff"><span>参数建模 · 支持数值、变量与表达式</span><button type="button" aria-keyshortcuts="Alt+M" disabled={busy} onClick={onSwitchToDrag} title="保留参数草稿，返回视口绘制；Alt+M（输入框内也可使用）">切换拖拽建模</button></div>}
    <div className="section-heading compact"><div><span className="eyebrow">OCCT DIRECT MODELING</span><h2>{mode === "primitive" ? "创建基础体" : mode === "surface" ? "创建基础面" : mode === "transform" ? "几何变换" : "基础体与变换"}</h2></div><span className="feature-badge">3D</span></div>
    {mode !== "transform" && mode !== "surface" && <>
      <select hidden={fixedKind} className="operation-select" aria-label="基础体类型" value={primitive} onChange={(event) => changeKind(event.target.value as Primitive, primitiveFields[event.target.value as Primitive], setPrimitive)}>
        <option value="box">Box 长方体</option><option value="cylinder">Cylinder 圆柱</option><option value="cone">Cone 圆锥</option><option value="sphere">Sphere 球</option><option value="torus">Torus 圆环</option><option value="wedge">Wedge 楔体</option><option value="prism">Prism 棱柱</option><option value="pyramid">Pyramid 棱台</option><option value="tube">Tube 圆管</option>
      </select>
      {fieldGrid(primitiveFields[primitive])}
      <p className="subsection-label">原点与坐标系</p>{fieldGrid([{ key: "x", label: "X", defaultValue: "0", unit: "mm" }, { key: "y", label: "Y", defaultValue: "0", unit: "mm" }, { key: "z", label: "Z", defaultValue: "0", unit: "mm" }])}
      <label className="single-field"><span>参考坐标系</span><select aria-label="参考坐标系" value={coordinateSystemId} onChange={(event) => setCoordinateSystemId(event.target.value)}>{coordinates.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</select></label>
      <button className="primary-action" disabled={busy} onClick={createPrimitive}>{busy ? "正在创建…" : "创建基础体"}</button>
    </>}
    {mode === "surface" && <>
      <select hidden={fixedKind} className="operation-select" aria-label="基础面类型" value={surface} onChange={(event) => changeKind(event.target.value as Surface, surfaceFields[event.target.value as Surface], setSurface)}>
        <option value="rectangle">Rectangle 矩形面</option><option value="disk">Disk 圆面</option><option value="cylinder">Cylinder 圆柱面</option><option value="cone">Cone 圆锥面</option><option value="sphere">Sphere 球面</option>
      </select>
      {fieldGrid(surfaceFields[surface])}
      <p className="subsection-label">原点与坐标系</p>{fieldGrid([{ key: "x", label: "X", defaultValue: "0", unit: "mm" }, { key: "y", label: "Y", defaultValue: "0", unit: "mm" }, { key: "z", label: "Z", defaultValue: "0", unit: "mm" }])}
      <label className="single-field"><span>参考坐标系</span><select aria-label="参考坐标系" value={coordinateSystemId} onChange={(event) => setCoordinateSystemId(event.target.value)}>{coordinates.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</select></label>
      <button className="primary-action" disabled={busy} onClick={createSurface}>{busy ? "正在创建…" : "创建基础面"}</button>
    </>}
    {mode !== "primitive" && mode !== "surface" && <>
      <p className="property-target">操作对象：{model?.bodyName || model?.bodyId || "未选择 Body"}</p>
      <select className="operation-select" aria-label="变换类型" value={transform} onChange={(event) => changeKind(event.target.value as Transform, transformFields[event.target.value as Transform], setTransform)}>
        <option value="translate">Translate 平移</option><option value="rotate">Rotate 旋转</option><option value="mirror">Mirror 镜像</option><option value="scale">Uniform Scale 统一缩放</option><option value="scale_non_uniform">Non-uniform Scale 非统一缩放</option><option value="coordinate">Coordinate Transform 坐标系变换</option><option value="align">Align 对齐</option><option value="copy">Copy 复制 Body</option>
      </select>
      {transform === "mirror" && <label className="single-field"><span>镜像模式</span><select value={mirrorMode} onChange={(event) => setMirrorMode(event.target.value)}><option value="point">点镜像</option><option value="axis">轴镜像</option><option value="plane">平面镜像</option></select></label>}
      {transform === "align" && <label className="single-field"><span>Body 锚点</span><select value={alignMode} onChange={(event) => setAlignMode(event.target.value)}><option value="min">最小角点</option><option value="center">包围盒中心</option><option value="max">最大角点</option></select></label>}
      {transform === "coordinate" ? <div className="boolean-fields"><label><span>源坐标系</span><select value={sourceCoordinateSystemId} onChange={(event) => setSourceCoordinateSystemId(event.target.value)}>{coordinates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span>目标坐标系</span><select value={targetCoordinateSystemId} onChange={(event) => setTargetCoordinateSystemId(event.target.value)}>{coordinates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div> : fieldGrid(transformFields[transform])}
      <button className="secondary-action" disabled={busy || !model?.bodyId} onClick={executeTransform}>{busy ? "正在处理…" : "执行变换"}</button>
    </>}
    <p className="panel-copy">参数支持常数、单位和变量表达式，例如 <code>width + 2 * clearance</code>。</p>
    {message && <p className="exchange-message" role="status">{message}</p>}
    {missingVariable && <div className="inline-dialog" role="dialog" aria-label="创建缺失变量"><h3>未定义变量：{missingVariable}</h3><p>{busy?'变量与几何正在作为同一任务处理；如需停止，请使用下方任务状态区的“取消操作”。':'请核对变量类型和初始值。创建后将自动重试刚才的建模操作；复杂表达式中的变量类型需要手动判断。'}</p><label><span>类型</span><select disabled={busy} value={variableType} onChange={(event) => { const type = event.target.value; setVariableType(type); setVariableExpression((current) => ["10 mm", "10 deg", "1"].includes(current) ? (type === "angle" ? "10 deg" : type === "length" ? "10 mm" : "1") : current); }}><option value="length">长度</option><option value="angle">角度</option><option value="dimensionless">无量纲</option><option value="integer">整数</option></select></label><label><span>表达式</span><input disabled={busy} value={variableExpression} onChange={(event) => setVariableExpression(event.target.value)} /></label><div className="dialog-actions"><button disabled={busy} title={busy?'请使用任务状态区取消整个建模任务。':'仅关闭补充信息，不创建变量。'} onClick={() => { setMissingVariable(null); setPendingRequest(null); }}>取消</button><button className="primary-action" disabled={busy || !model || !variableExpression.trim()} onClick={() => void createMissingVariable()}>创建并重试</button></div></div>}
  </section>;
}
