"use client";

import { useMemo, useState } from "react";
import type { CoordinateSystemData, MaterialData, ScalarVariableData } from "./ProjectDataPanel";

type CoordinateKind = "cartesian" | "threePoint" | "face";
type MaterialPropertyType = "bool" | "int" | "double" | "expression";
type MaterialPropertyDraft = { key: string; type: MaterialPropertyType; value: string; dimension: "length" | "angle" | "dimensionless" | "integer" };

function materialPropertyDrafts(material?: MaterialData): MaterialPropertyDraft[] {
  return Object.entries(material?.customProperties || {}).map(([key, property]) => ({ key, type: property.type, value: property.type === "expression" ? property.expression || "" : String(property.value ?? ""), dimension: property.dimension || "dimensionless" }));
}
export type ProjectDataMode = "variables" | "coordinates" | "materials";
type ProjectResult = {
  ok: true;
  revision: number;
  variables: ScalarVariableData[];
  coordinateSystems: CoordinateSystemData[];
  materials: MaterialData[];
  positions?: number[];
};
import type { ModelingCommandInput } from "./modeling/command-contract";
import {useEditorCommands} from "./modeling/CommandEditScope";
import {FeatureReferenceRepair,failedSelectionTarget} from "./FeatureReferenceRepair";
import type {FeatureRepairProposal} from "./modeling/feature-input";



function normalizeVariableExpression(type: ScalarVariableData["type"], expression: string) {
  const value = expression.trim();
  if ((type === "length" || type === "angle") && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))
    return value + (type === "length" ? " mm" : " deg");
  return value;
}

function vector(value: string) {
  const parts=value.split(",");
  const result = parts.map((item) => Number(item.trim()));
  if (result.length !== 3 || parts.some(item=>!item.trim()) || result.some((item) => !Number.isFinite(item))) {
    throw new Error("向量必须包含三个逗号分隔的数值。");
  }
  return result;
}

export function AdvancedProjectDataPanel({
  mode,
  initialItemId,
  copyFromId,
  editorOnly = false,
  revision,
  variables,
  coordinateSystems,
  materials,
  selectedBodyId,
  selectedTopologyId,
  onRevision,
}: {
  mode: ProjectDataMode;
  initialItemId?: string | null;
  copyFromId?: string | null;
  editorOnly?: boolean;
  revision: number;
  variables: ScalarVariableData[];
  coordinateSystems: CoordinateSystemData[];
  materials: MaterialData[];
  selectedBodyId?: string | null;
  selectedTopologyId?: string | null;
  onRevision: (result: ProjectResult) => void;
}) {
  const editorCommands=useEditorCommands();
  const mutate=(revision:number,payload:ModelingCommandInput)=>editorCommands.execute<ProjectResult>({...payload,baseRevision:revision});
  const sourceId = initialItemId || copyFromId;
  const uniqueName = (base: string, names: string[]) => { let result = `${base}_copy`; let suffix = 2; while (names.includes(result)) result = `${base}_copy${suffix++}`; return result; };
  const initialVariable = mode === "variables" && sourceId ? variables.find((item) => item.name === sourceId) : undefined;
  const initialMaterial = mode === "materials" && sourceId ? materials.find((item) => item.name === sourceId) : undefined;
  const initialCoordinate = mode === "coordinates" && sourceId ? coordinateSystems.find((item) => item.id === sourceId) : undefined;
  const isEditing = Boolean(initialItemId);
  const isReadOnlyBuiltIn = !copyFromId && Boolean(initialMaterial?.builtIn || initialCoordinate?.builtIn);
  const initialCoordinateKind = initialCoordinate?.kind || "cartesian";

  const [name, setName] = useState(copyFromId && initialVariable ? uniqueName(initialVariable.name, variables.map((item) => item.name)) : initialVariable?.name || "width");
  const [type, setType] = useState<ScalarVariableData["type"]>(initialVariable?.type || "length");
  const [expression, setExpression] = useState(initialVariable?.expression || "100 mm");
  const [coordinateId, setCoordinateId] = useState(copyFromId && initialCoordinate ? uniqueName(initialCoordinate.id, coordinateSystems.map((item) => item.id)) : initialCoordinate?.id || "local1");
  const [coordinateName, setCoordinateName] = useState((initialCoordinate?.name || "Local1") + (copyFromId ? " 副本" : ""));
  const [kind, setKind] = useState<CoordinateKind>(initialCoordinateKind);
  const [origin, setOrigin] = useState(initialCoordinate?.origin.join(", ") || "0, 0, 0");
  const [xAxis, setXAxis] = useState(initialCoordinate?.xAxis.join(", ") || "1, 0, 0");
  const [yAxis, setYAxis] = useState(initialCoordinate?.yAxis.join(", ") || "0, 1, 0");
  const [xPoint, setXPoint] = useState(initialCoordinate ? initialCoordinate.origin.map((value, index) => value + (initialCoordinate.xAxis[index] || 0)).join(", ") : "1, 0, 0");
  const [planePoint, setPlanePoint] = useState(initialCoordinate ? initialCoordinate.origin.map((value, index) => value + (initialCoordinate.yAxis[index] || 0)).join(", ") : "0, 1, 0");
  const [coordinateReference,setCoordinateReference]=useState(()=>({bodyId:initialCoordinate?.referenceBodyId || selectedBodyId || "",topologyId:initialCoordinate?.referenceTopologyId || (selectedTopologyId?.startsWith("face-")?selectedTopologyId:"")}));
  const [referenceChanged,setReferenceChanged]=useState(!initialCoordinate && Boolean(selectedTopologyId?.startsWith("face-")));
  const [associationMode,setAssociationMode]=useState<"snapshot"|"associative">(initialCoordinate?.associationMode || (initialCoordinateKind==="face"?"snapshot":"associative"));
  const [coordinateEditingId,setCoordinateEditingId]=useState(copyFromId?"":initialCoordinate?.id || "");
  const loadedCoordinate=coordinateSystems.find(item=>item.id===coordinateId.trim() && item.kind==="face");
  const [materialName, setMaterialName] = useState(copyFromId && initialMaterial ? uniqueName(initialMaterial.name, materials.map((item) => item.name)) : initialMaterial?.name || "MyMaterial");
  const [materialCategory, setMaterialCategory] = useState<MaterialData["category"]>(initialMaterial?.category || "dielectric");
  const [relativePermittivity, setRelativePermittivity] = useState(String(initialMaterial?.relativePermittivity ?? 1));
  const [conductivity, setConductivity] = useState(String(initialMaterial?.conductivity ?? 0));
  const [materialColor, setMaterialColor] = useState(initialMaterial?.color || "#7b91aa");
  const [materialProperties, setMaterialProperties] = useState<MaterialPropertyDraft[]>(() => materialPropertyDrafts(initialMaterial));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [repairProposal,setRepairProposal]=useState<FeatureRepairProposal|null>(null);
  const unit = useMemo(() => type === "length" ? "mm" : type === "angle" ? "deg" : "", [type]);

  const saveVariable = async () => {
    const request:ModelingCommandInput={operation:"variable.set",parameters:{name:name.trim(),type,expression:normalizeVariableExpression(type,expression)}};
    setBusy(true);
    setMessage(null);
    try {
      const result = await mutate(revision, request);
      onRevision(result);
      setMessage(`变量 ${name.trim()} 已保存并重算依赖特征。`);
    } catch (reason) {
      const failed=failedSelectionTarget(reason);if(failed)setRepairProposal({request,...failed});
      setMessage(reason instanceof Error ? reason.message : "变量保存失败。");
    } finally {
      setBusy(false);
    }
  };

  const deleteVariable = async (variableName: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await mutate(revision, {
        operation: "variable.delete",
        inputs: { name: variableName },
      });
      onRevision(result);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "变量删除失败。");
    } finally {
      setBusy(false);
    }
  };

  const saveCoordinate = async () => {
    let request:ModelingCommandInput|null=null;
    setBusy(true);
    setMessage(null);
    try {
      const parameters: Record<string, unknown> = {
        id: coordinateId.trim(),
        name: coordinateName.trim(),
        kind,
        origin: vector(origin),
        xAxis: vector(xAxis),
        yAxis: vector(yAxis),
      };
      if (kind === "threePoint") Object.assign(parameters, { xPoint: vector(xPoint), planePoint: vector(planePoint) });
      if (kind === "face") {
        if(loadedCoordinate && coordinateEditingId===coordinateId.trim() && !referenceChanged)Object.assign(parameters,{preserveReference:true,associationMode});
        else if(copyFromId && initialCoordinate?.kind==="face" && !referenceChanged)Object.assign(parameters,{copyReferenceFrom:copyFromId,associationMode});
        else {
        const referenceBodyId = coordinateReference.bodyId;
        const referenceTopologyId = coordinateReference.topologyId;
        if (!referenceChanged || !referenceBodyId || !referenceTopologyId?.startsWith("face-")) {
          throw new Error("请在视口选择 Face，并点击“使用当前选中面”。");
        }
        Object.assign(parameters, { referenceBodyId, referenceTopologyId,associationMode });
        }
      }
      request={operation:"coordinate.set",parameters};
      const result = await mutate(revision, request);
      onRevision(result);
      const saved=result.coordinateSystems.find(item=>item.id===coordinateId.trim());
      if(saved)editCoordinate(saved);
      setMessage(`坐标系 ${coordinateName.trim()} 已保存并重算依赖特征。`);
    } catch (reason) {
      const failed=failedSelectionTarget(reason);if(failed && request)setRepairProposal({request,...failed});
      setMessage(reason instanceof Error ? reason.message : "坐标系保存失败。");
    } finally {
      setBusy(false);
    }
  };

  const saveMaterial = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const keys = materialProperties.map((property) => property.key.trim());
      if (keys.some((key) => !key) || new Set(keys).size !== keys.length) throw new Error("自定义属性 Key 不能为空或重复。");
      for (const property of materialProperties) {
        if ((property.type === "double" || property.type === "int") && (!property.value.trim() || !Number.isFinite(Number(property.value)) || (property.type === "int" && !Number.isSafeInteger(Number(property.value))))) throw new Error(`属性 ${property.key} 需要有效的${property.type === "int" ? "安全范围整数" : "数值"}。`);
      }
      const steps:ModelingCommandInput[]=[{
        operation: "material.set",
        parameters: {
          name: materialName.trim(),
          category: materialCategory,
          relativePermittivity: Number(relativePermittivity),
          conductivity: Number(conductivity),
          color: materialColor,
        },
      }];
      for (const property of materialProperties) {
        const parameters: Record<string, unknown> = { materialName: materialName.trim(), key: property.key.trim(), type: property.type };
        if (property.type === "expression") Object.assign(parameters, { expression: property.value, dimension: property.dimension });
        else parameters.value = property.type === "bool" ? property.value === "true" : Number(property.value);
        steps.push({ operation: "material.property.set", parameters });
      }
      for (const key of Object.keys(initialMaterial?.customProperties || {})) {
        if (!keys.includes(key)) steps.push({ operation: "material.property.delete", parameters: { materialName: materialName.trim(), key } });
      }
      const result=await editorCommands.executeBatch<ProjectResult>(steps,{baseRevision:revision});onRevision(result);
      setMessage("材料 " + materialName.trim() + " 已保存。");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "材料保存失败。");
    } finally {
      setBusy(false);
    }
  };

  const deleteMaterial = async (nameToDelete: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await mutate(revision, { operation: "material.delete", inputs: { name: nameToDelete } });
      onRevision(result);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "材料删除失败。");
    } finally {
      setBusy(false);
    }
  };

  const editMaterial = (item: MaterialData) => {
    setMaterialName(item.name);
    setMaterialCategory(item.category);
    setRelativePermittivity(String(item.relativePermittivity));
    setConductivity(String(item.conductivity));
    setMaterialColor(item.color);
    setMaterialProperties(materialPropertyDrafts(item));
    setMessage(null);
  };

  const deleteCoordinate = async (id: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await mutate(revision, {
        operation: "coordinate.delete",
        inputs: { id },
      });
      onRevision(result);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "坐标系删除失败。");
    } finally {
      setBusy(false);
    }
  };

  const editCoordinate = (item: CoordinateSystemData) => {
    setCoordinateEditingId(item.id);
    setCoordinateReference({bodyId:item.referenceBodyId || "",topologyId:item.referenceTopologyId || ""});
    setReferenceChanged(false);setAssociationMode(item.associationMode || (item.kind==="face"?"snapshot":"associative"));
    setCoordinateId(item.id);
    setCoordinateName(item.name);
    const coordinateKind = item.kind || "cartesian";
    setKind(coordinateKind);
    setOrigin(item.origin.join(", "));
    if (item.xAxis) setXAxis(item.xAxis.join(", "));
    if (item.yAxis) setYAxis(item.yAxis.join(", "));
    if (coordinateKind === "threePoint") {
      setXPoint(item.origin.map((value, index) => value + (item.xAxis?.[index] || 0)).join(", "));
      setPlanePoint(item.origin.map((value, index) => value + (item.yAxis?.[index] || 0)).join(", "));
    }
    setMessage(null);
  };

  if(repairProposal)return <section className="panel-section project-data-panel" data-testid={`project-data-${mode}`}><FeatureReferenceRepair proposal={repairProposal} onCancel={()=>{setRepairProposal(null);setMessage("已取消修复，工程未改变，原修改草稿保留。");}} onCommitted={result=>{setRepairProposal(null);onRevision(result as unknown as ProjectResult);setMessage("工程数据与引用修复已一起保存，可一次撤销。");}}/></section>;
  return <section className={`panel-section project-data-panel ${isEditing ? "project-data-edit-mode" : "project-data-manage-mode"}`} data-testid={`project-data-${mode}`}>
    <div className="section-heading compact">
      <div><span className="eyebrow">PROJECT DATA</span><h2>{mode === "variables" ? (isEditing ? "编辑变量" : "变量管理") : mode === "materials" ? (isEditing ? "查看/编辑材料" : "材料库管理") : (isEditing ? "编辑坐标系" : "坐标系管理")}</h2></div>
      <span className="feature-badge">R{revision}</span>
    </div>

    {mode === "materials" ? <>
      {isEditing && <p className="project-data-edit-target">当前节点：<strong>{initialItemId}</strong>{isReadOnlyBuiltIn ? " · 内置数据（只读）" : " · 修改模式"}</p>}
      <p className="panel-copy">材料库是工程级数据；内置材料可直接分配，用户材料可以编辑和删除。</p>
      {!editorOnly && <div className="project-data-list">
        {materials.map((item) => <div className="project-data-row" key={item.name} onDoubleClick={() => !item.builtIn && editMaterial(item)}>
          <span><strong>{item.name}</strong><small>{item.category} · εr {item.relativePermittivity} · σ {item.conductivity} S/m</small></span>
          {!item.builtIn && <button disabled={busy} onClick={() => void deleteMaterial(item.name)}>删除</button>}
        </div>)}
      </div>}
      <div className="compact-fields">
        <label><span>名称</span><input disabled={isEditing} value={materialName} onChange={(event) => setMaterialName(event.target.value)} /></label>
        <label><span>类别</span><select disabled={isReadOnlyBuiltIn} value={materialCategory} onChange={(event) => setMaterialCategory(event.target.value as MaterialData["category"])}><option value="vacuum">Vacuum</option><option value="dielectric">Dielectric</option><option value="conductor">Conductor</option></select></label>
        <label><span>颜色</span><input disabled={isReadOnlyBuiltIn} type="color" value={materialColor} onChange={(event) => setMaterialColor(event.target.value)} /></label>
      </div>
      <div className="compact-fields">
        <label><span>相对介电常数 εr</span><input disabled={isReadOnlyBuiltIn} type="number" min="0.000001" step="0.1" value={relativePermittivity} onChange={(event) => setRelativePermittivity(event.target.value)} /></label>
        <label><span>电导率 σ</span><input disabled={isReadOnlyBuiltIn} type="number" min="0" step="1" value={conductivity} onChange={(event) => setConductivity(event.target.value)} /></label>
      </div>
      <div className="property-editor-list" data-testid="material-custom-properties">
        <div className="subsection-label">自定义属性</div>
        {materialProperties.map((item, index) => <div className="property-editor-row" key={index}>
          <input disabled={isReadOnlyBuiltIn} aria-label="属性 Key" placeholder="Key" value={item.key} onChange={(event) => setMaterialProperties((current) => current.map((entry, row) => row === index ? { ...entry, key: event.target.value } : entry))} />
          <select disabled={isReadOnlyBuiltIn} aria-label="属性类型" value={item.type} onChange={(event) => setMaterialProperties((current) => current.map((entry, row) => row === index ? { ...entry, type: event.target.value as MaterialPropertyType } : entry))}>
            <option value="bool">Bool</option><option value="int">Int</option><option value="double">Double</option><option value="expression">Expression</option>
          </select>
          {item.type === "bool" ? <select disabled={isReadOnlyBuiltIn} aria-label="属性值" value={item.value} onChange={(event) => setMaterialProperties((current) => current.map((entry, row) => row === index ? { ...entry, value: event.target.value } : entry))}><option value="true">true</option><option value="false">false</option></select>
            : <input disabled={isReadOnlyBuiltIn} aria-label="属性值" placeholder={item.type === "expression" ? "表达式" : "Value"} value={item.value} onChange={(event) => setMaterialProperties((current) => current.map((entry, row) => row === index ? { ...entry, value: event.target.value } : entry))} />}
          {item.type === "expression" && <select disabled={isReadOnlyBuiltIn} aria-label="表达式量纲" value={item.dimension} onChange={(event) => setMaterialProperties((current) => current.map((entry, row) => row === index ? { ...entry, dimension: event.target.value as MaterialPropertyDraft["dimension"] } : entry))}><option value="dimensionless">Dimensionless</option><option value="length">Length</option><option value="angle">Angle</option><option value="integer">Integer</option></select>}
          <button disabled={busy || isReadOnlyBuiltIn} onClick={() => setMaterialProperties((current) => current.filter((_, row) => row !== index))}>删除</button>
        </div>)}
        <button disabled={busy || isReadOnlyBuiltIn} onClick={() => setMaterialProperties((current) => [...current, { key: "", type: "double", value: "0", dimension: "dimensionless" }])}>添加属性</button>
      </div>      <button className="primary-action" disabled={busy || isReadOnlyBuiltIn || !materialName.trim()} onClick={() => void saveMaterial()}>保存材料</button>
    </> : mode === "variables" ? <>
      {isEditing && <p className="project-data-edit-target">当前节点：<strong>{initialItemId}</strong> · 修改模式</p>}
      <p className="panel-copy">变量名用于参数表达式，仅支持字母、数字和下划线，且不能以数字开头。</p>
      {!editorOnly && <div className="project-data-list">
        {variables.length === 0 && <p className="project-data-empty">暂无变量</p>}
        {variables.map((item) => <div className="project-data-row" key={item.name} onDoubleClick={() => {
          setName(item.name);
          setType(item.type);
          setExpression(item.expression);
        }}>
          <span><strong>{item.name}</strong><small>{item.type} · {item.expression} = {item.value} {item.type === "length" ? "mm" : item.type === "angle" ? "deg" : ""}</small></span>
          <button disabled={busy} onClick={() => void deleteVariable(item.name)}>删除</button>
        </div>)}
      </div>}
      <div className="compact-fields">
        <label><span>名称</span><input disabled={isEditing} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label><span>类型</span><select value={type} onChange={(event) => setType(event.target.value as ScalarVariableData["type"])}><option value="length">Length</option><option value="angle">Angle</option><option value="dimensionless">无量纲 (Dimensionless)</option><option value="integer">Integer</option></select></label>
        <label><span>表达式</span><div className="number-field"><input aria-label="变量表达式" value={expression} onChange={(event) => setExpression(event.target.value)} /><em>{unit || "fx"}</em></div></label>
      </div>
      <button className="primary-action" disabled={busy || !name.trim() || !expression.trim()} onClick={() => void saveVariable()}>保存变量</button>
    </> : <>
      {isEditing && <p className="project-data-edit-target">当前节点：<strong>{initialItemId}</strong>{isReadOnlyBuiltIn ? " · 内置坐标系（只读）" : " · 修改模式"}</p>}
      <p className="panel-copy">坐标系是独立工程数据；双击列表项可载入并修改。</p>
      {!editorOnly && <div className="project-data-list">
        {coordinateSystems.length === 0 && <p className="project-data-empty">暂无坐标系</p>}
        {coordinateSystems.map((item) => <div className="project-data-row" key={item.id} onDoubleClick={() => editCoordinate(item)}>
          <span><strong>{item.name}</strong><small>{item.id} · {item.kind || "cartesian"} · O({item.origin.join(", ")})</small></span>
          {!item.builtIn && <button disabled={busy} onClick={() => void deleteCoordinate(item.id)}>删除</button>}
        </div>)}
      </div>}
      <div className="compact-fields">
        <label><span>ID</span><input disabled={isEditing} value={coordinateId} onChange={(event) => setCoordinateId(event.target.value)} /></label>
        <label><span>名称</span><input disabled={isReadOnlyBuiltIn} value={coordinateName} onChange={(event) => setCoordinateName(event.target.value)} /></label>
        <label><span>类型</span><select aria-label="坐标系类型" disabled={isReadOnlyBuiltIn} value={kind} onChange={(event) => setKind(event.target.value as CoordinateKind)}><option value="cartesian">Local Cartesian</option><option value="threePoint">Three-Point</option><option value="face">Face Reference</option></select></label>
      </div>
      <label className="single-field"><span>原点 O</span><input disabled={isReadOnlyBuiltIn} readOnly={kind === "face"} value={origin} onChange={(event) => setOrigin(event.target.value)} /></label>
      {kind === "cartesian" && <div className="compact-fields"><label><span>X 轴方向</span><input disabled={isReadOnlyBuiltIn} value={xAxis} onChange={(event) => setXAxis(event.target.value)} /></label><label><span>Y 轴方向</span><input disabled={isReadOnlyBuiltIn} value={yAxis} onChange={(event) => setYAxis(event.target.value)} /></label></div>}
      {kind === "threePoint" && <div className="compact-fields"><label><span>X 轴点</span><input disabled={isReadOnlyBuiltIn} value={xPoint} onChange={(event) => setXPoint(event.target.value)} /></label><label><span>XY 平面点</span><input disabled={isReadOnlyBuiltIn} value={planePoint} onChange={(event) => setPlanePoint(event.target.value)} /></label></div>}
      {kind === "face" && <div className="coordinate-face-reference">
        <label className="single-field"><span>面关联方式</span><select aria-label="面关联方式" disabled={busy || isReadOnlyBuiltIn} value={associationMode} onChange={event=>setAssociationMode(event.target.value as "snapshot"|"associative")}><option value="associative">跟随来源面</option><option value="snapshot">固定坐标快照</option></select></label>
        {loadedCoordinate && !referenceChanged && <p className={`coordinate-reference-state${loadedCoordinate.referenceState==="unresolved"?" invalid":""}`} role="status">{loadedCoordinate.associationMode==="associative"?loadedCoordinate.referenceState==="resolved"?`关联有效 · 来源历史 ${loadedCoordinate.referenceFeatureId}`:`引用失效 · ${loadedCoordinate.referenceDiagnostic || "请重新选择来源面"}`:"固定快照 · 不自动跟随几何变化"}</p>}
        <p className="panel-copy">{referenceChanged?"待保存的面":"原始选面记录"}：{coordinateReference.bodyId || "未选 Body"} / {coordinateReference.topologyId || "未选 Face"}</p>
        <button type="button" className="secondary-action" disabled={busy || isReadOnlyBuiltIn || !selectedBodyId || !selectedTopologyId?.startsWith("face-")} onClick={()=>{setCoordinateReference({bodyId:selectedBodyId || "",topologyId:selectedTopologyId || ""});setReferenceChanged(true);setMessage("已采用当前选中面，保存后才更新坐标系及依赖几何。");}}>使用当前选中面</button>
        <div className="compact-fields"><label><span>X 轴方向</span><input readOnly value={xAxis}/></label><label><span>Y 轴方向</span><input readOnly value={yAxis}/></label></div>
        <p className="panel-copy">关联绑定到选面时的历史输出，随上游参数重算；后续 Body 编辑不会改换来源。面消失、分裂或循环依赖会明确拒绝，不按旧编号猜测。原点位于面参数范围中心。</p>
      </div>}
      <div className="coordinate-editor-actions"><button className="primary-action" disabled={busy || isReadOnlyBuiltIn || !coordinateId.trim() || !coordinateName.trim()} onClick={() => void saveCoordinate()}>保存坐标系</button></div>
    </>}
    {message && <p className="exchange-message">{message}</p>}
  </section>;
}
