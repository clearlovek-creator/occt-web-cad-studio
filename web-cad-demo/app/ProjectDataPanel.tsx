"use client";

import { useMemo, useState } from "react";

export type ScalarVariableData = {
  name: string;
  type: "length" | "angle" | "dimensionless" | "integer";
  expression: string;
  value: number;
};

export type CoordinateSystemData = {
  id: string;
  name: string;
  origin: number[];
  xAxis: number[];
  yAxis: number[];
  kind?: "cartesian" | "threePoint" | "face";
  referenceBodyId?: string;
  referenceTopologyId?: string;
  associationMode?: "snapshot" | "associative";
  referenceFeatureId?: string;
  referenceState?: "snapshot" | "resolved" | "unresolved";
  referenceDiagnostic?: string;
  resolvedFaceIndex?: number;
  builtIn: boolean;
};

export type MaterialPropertyData = {
  type: "bool" | "int" | "double" | "expression";
  value?: boolean | number;
  expression?: string;
  dimension?: "length" | "angle" | "dimensionless" | "integer";
  resolvedValue?: number;
};

export type MaterialData = {
  name: string;
  category: "vacuum" | "dielectric" | "conductor";
  relativePermittivity: number;
  conductivity: number;
  color: string;
  builtIn: boolean;
  customProperties?: Record<string, MaterialPropertyData>;
};

type ProjectResult = {
  ok: true;
  revision: number;
  variables: ScalarVariableData[];
  coordinateSystems: CoordinateSystemData[];
};

import type { ModelingCommandInput } from "./modeling/command-contract";
import { executeModelingCommand } from "./modeling/runtime";

async function command(payload: ModelingCommandInput) {
  return await executeModelingCommand<ProjectResult & { error?: string }>(payload);
}

function vector(text: string) {
  const values = text.split(",").map((item) => Number(item.trim()));
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value)))
    throw new Error("向量必须填写为三个逗号分隔的数值，例如 0, 0, 0。");
  return values;
}

export function ProjectDataPanel({
  revision,
  variables,
  coordinateSystems,
  initialTab = "variables",
  onRevision,
}: {
  revision: number;
  variables: ScalarVariableData[];
  coordinateSystems: CoordinateSystemData[];
  initialTab?: "variables" | "coordinates";
  onRevision: (result: ProjectResult) => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [name, setName] = useState("width");
  const [type, setType] = useState<ScalarVariableData["type"]>("length");
  const [expression, setExpression] = useState("100 mm");
  const [coordinateId, setCoordinateId] = useState("local1");
  const [coordinateName, setCoordinateName] = useState("Local1");
  const [origin, setOrigin] = useState("0, 0, 0");
  const [xAxis, setXAxis] = useState("1, 0, 0");
  const [yAxis, setYAxis] = useState("0, 1, 0");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const unit = useMemo(() => type === "length" ? "mm" : type === "angle" ? "deg" : "", [type]);

  const saveVariable = async () => {
    setBusy(true); setMessage(null);
    try {
      const result = await command({ operation: "variable.set", baseRevision: revision, parameters: { name, type, expression } });
      onRevision(result); setMessage(`变量 ${name} 已保存。`);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "变量保存失败。"); }
    finally { setBusy(false); }
  };

  const deleteVariable = async (variableName: string) => {
    setBusy(true); setMessage(null);
    try {
      const result = await command({ operation: "variable.delete", baseRevision: revision, inputs: { name: variableName } });
      onRevision(result); setMessage(`变量 ${variableName} 已删除。`);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "变量删除失败。"); }
    finally { setBusy(false); }
  };

  const editVariable = (variable: ScalarVariableData) => {
    setName(variable.name); setType(variable.type); setExpression(variable.expression);
  };

  const saveCoordinate = async () => {
    setBusy(true); setMessage(null);
    try {
      const result = await command({
        operation: "coordinate.set",
        baseRevision: revision,
        parameters: { id: coordinateId, name: coordinateName, origin: vector(origin), xAxis: vector(xAxis), yAxis: vector(yAxis) },
      });
      onRevision(result); setMessage(`坐标系 ${coordinateName} 已保存。`);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "坐标系保存失败。"); }
    finally { setBusy(false); }
  };

  const deleteCoordinate = async (id: string) => {
    setBusy(true); setMessage(null);
    try {
      const result = await command({ operation: "coordinate.delete", baseRevision: revision, inputs: { id } });
      onRevision(result); setMessage(`坐标系 ${id} 已删除。`);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "坐标系删除失败。"); }
    finally { setBusy(false); }
  };

  const editCoordinate = (coordinate: CoordinateSystemData) => {
    setCoordinateId(coordinate.id); setCoordinateName(coordinate.name);
    setOrigin(coordinate.origin.join(", ")); setXAxis(coordinate.xAxis.join(", ")); setYAxis(coordinate.yAxis.join(", "));
  };

  return (
    <section className="panel-section project-data-panel" data-testid="project-data-panel">
      <div className="section-heading compact">
        <div><span className="eyebrow">PROJECT DATA</span><h2>变量与坐标系</h2></div>
        <span className="feature-badge">B</span>
      </div>
      <div className="project-data-tabs">
        <button className={tab === "variables" ? "active" : ""} onClick={() => setTab("variables")}>变量</button>
        <button className={tab === "coordinates" ? "active" : ""} onClick={() => setTab("coordinates")}>坐标系</button>
      </div>
      {tab === "variables" ? <>
        <div className="compact-fields">
          <label><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label><span>类型</span><select value={type} onChange={(event) => setType(event.target.value as ScalarVariableData["type"])}><option value="length">Length</option><option value="angle">Angle</option><option value="dimensionless">无量纲 (Dimensionless)</option><option value="integer">Integer</option></select></label>
          <label><span>表达式</span><input value={expression} onChange={(event) => setExpression(event.target.value)} placeholder={unit ? `例如 100 ${unit}` : "例如 2 * count"} /></label>
        </div>
        <button className="primary-action" disabled={busy || !name || !expression} onClick={() => void saveVariable()}>保存变量</button>
        <div className="project-data-list">{variables.map((variable) => <div key={variable.name}><button onDoubleClick={() => editVariable(variable)}><strong>{variable.name}</strong><small>{variable.type} · {variable.expression} = {variable.value}</small></button><button className="list-delete" disabled={busy} onClick={() => void deleteVariable(variable.name)}>×</button></div>)}</div>
      </> : <>
        <div className="compact-fields">
          <label><span>ID</span><input value={coordinateId} onChange={(event) => setCoordinateId(event.target.value)} /></label>
          <label><span>名称</span><input value={coordinateName} onChange={(event) => setCoordinateName(event.target.value)} /></label>
          <label><span>原点</span><input value={origin} onChange={(event) => setOrigin(event.target.value)} /></label>
          <label><span>X 轴</span><input value={xAxis} onChange={(event) => setXAxis(event.target.value)} /></label>
          <label><span>Y 轴</span><input value={yAxis} onChange={(event) => setYAxis(event.target.value)} /></label>
        </div>
        <button className="primary-action" disabled={busy || !coordinateId || !coordinateName} onClick={() => void saveCoordinate()}>保存坐标系</button>
        <div className="project-data-list">{coordinateSystems.map((coordinate) => <div key={coordinate.id}><button onDoubleClick={() => !coordinate.builtIn && editCoordinate(coordinate)}><strong>{coordinate.name}</strong><small>{coordinate.id} · O({coordinate.origin.join(", ")})</small></button>{!coordinate.builtIn && <button className="list-delete" disabled={busy} onClick={() => void deleteCoordinate(coordinate.id)}>×</button>}</div>)}</div>
      </>}
      {message && <p className="exchange-message">{message}</p>}
    </section>
  );
}
