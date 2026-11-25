"use client";

import { useState, type ReactNode } from "react";
import type { CoordinateSystemData, MaterialData, ScalarVariableData } from "../ProjectDataPanel";
import type { ProjectDataMode } from "../AdvancedProjectDataPanel";
import type { FeatureData } from "../model/feature-graph";
import { instanceTargets, schemaCommand, type PropertyInstance, type PropertyTarget, type PropertyType } from "../model/property-schema";
import { ContextActions, type TreeAction } from "./ContextActions";
import { StudioIcon, type StudioIconName } from "./StudioIcon";

function Branch({ label, actions, children, icon, onEdit, searching = false, hidden = false, initiallyExpanded = true }: { label: string; actions: TreeAction[]; children: ReactNode; icon: StudioIconName; onEdit?: () => void; searching?: boolean; hidden?: boolean; initiallyExpanded?: boolean }) {
  const [expansion, setExpanded] = useState<boolean | null>(null);
  const expanded = expansion ?? initiallyExpanded;
  const open = searching || expanded;
  return <li role="treeitem" aria-selected={false} aria-expanded={open} hidden={hidden}><ContextActions label={label} actions={[...actions, { label: open ? "折叠节点" : "展开节点", run: () => setExpanded(!expanded) }]}>
    {onEdit && <button type="button" className="tree-branch-toggle" aria-label={`${open?"折叠":"展开"}${label}`} aria-expanded={open} onClick={()=>setExpanded(!expanded)}>{open?"▾":"▸"}</button>}
    <button className="managed-tree-label" onClick={event=>{if(!onEdit)setExpanded(!expanded);else if(event.detail===0)onEdit();}} onDoubleClick={onEdit} onKeyDown={event=>{if(onEdit && ["ArrowLeft","ArrowRight"].includes(event.key)){event.preventDefault();setExpanded(event.key==="ArrowRight");}}}>
      {!onEdit && <span className="tree-toggle">{children ? (open ? "▾" : "▸") : ""}</span>}<StudioIcon name={icon} size={14} /><strong>{label}</strong>
    </button></ContextActions>{open && children && <ul role="group" className="managed-tree-branch">{children}</ul>}</li>;
}

export function ProjectTree({ projectName, variables, materials, coordinates, types, instances, stateToken, features = [], bodies = [], busy, error, onEditData, onDeleteData, onEditType, onEditInstance, onSelectTarget, onSelectTargets, onError, query, onQuery, onHide, geometry, onOpenMesh, onOpenSimulation }: {
  variables: ScalarVariableData[]; materials: MaterialData[]; coordinates: CoordinateSystemData[]; types: PropertyType[]; instances: PropertyInstance[]; busy: boolean; error?: string | null;
  features?: FeatureData[]; bodies?: { bodyId: string; name: string; material: string }[];
  projectName?: string;
  stateToken?: string;
  onEditData: (mode: ProjectDataMode, id?: string | null, copy?: boolean) => void;
  onDeleteData: (mode: ProjectDataMode, id: string) => Promise<void>;
  onEditType: (typeId?: string | null) => void;
  onEditInstance: (typeId: string, instanceId?: string | null) => void;
  onSelectTarget: (target: PropertyTarget) => void;
  onSelectTargets?: (targets: NonNullable<PropertyTarget>[]) => void;
  onError: (message: string) => void;
  query: string;
  onQuery: (value: string) => void;
  onHide: () => void;
  geometry: ReactNode;
  onOpenMesh: () => void;
  onOpenSimulation: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const search = query.trim().toLocaleLowerCase();
  const matches = (...values: string[]) => values.some(value => value.toLocaleLowerCase().includes(search));
  const open = Boolean(search) || expanded;
  const locateInstance = (instance: PropertyInstance) => {
    if (Array.isArray(instance.targets)) onSelectTargets?.(instanceTargets(instance));
    else onSelectTarget(instance.target);
  };
  const [references, setReferences] = useState<{ name: string; entries: string[] } | null>(null);
  const showReferences = (mode: ProjectDataMode, id: string) => {
    const entries: string[] = [];
    if (mode === "materials") bodies.filter((body) => body.material === id).forEach((body) => entries.push(`Body · ${body.name} (${body.bodyId})`));
    else {
      if(mode==="coordinates"){
        const coordinate=coordinates.find(item=>item.id===id);
        if(coordinate?.associationMode==="associative")entries.push(`面参考来源 · ${coordinate.referenceFeatureId} · ${coordinate.referenceState==="resolved"?"关联有效":"引用失效"}`);
      }
      const mentions = (value: string) => mode === "coordinates" ? value === id : (value.match(/[A-Za-z_][A-Za-z0-9_]*/g) || ([] as string[])).includes(id);
      features.filter((feature) => Object.entries(feature.stringParameters).some(([key, value]) => mode === "coordinates" ? /coordinate/i.test(key) && mentions(value) : key.startsWith("expr.") && mentions(value))).forEach((feature) => entries.push(`特征 · ${feature.id} (${feature.type})`));
      if (mode === "variables") {
        variables.filter((variable) => variable.name !== id && mentions(variable.expression)).forEach((variable) => entries.push(`变量 · ${variable.name}`));
        materials.forEach((material) => Object.entries(material.customProperties || {}).forEach(([key, property]) => { if (property.expression && mentions(property.expression)) entries.push(`材料 · ${material.name}.${key}`); }));
        const referencesVariable = (value: unknown) => (Array.isArray(value) ? value : [value]).some(part => typeof part === "string" && mentions(part));
        types.forEach(type => type.fields.filter(field => ["expression", "vector3"].includes(field.type) && referencesVariable(field.default)).forEach(field => entries.push(`属性类型 · ${type.name}.${field.label} 默认值`)));
        instances.filter(instance => Object.values(instance.value).some(referencesVariable)).forEach(instance => entries.push(`属性实例 · ${instance.name}`));
      }
    }
    setReferences({ name: id, entries });
  };
  const safe = async (action: () => Promise<unknown>) => { try { await action(); } catch (reason) { onError(reason instanceof Error ? reason.message : "工程数据操作失败"); } };
  const dataActions = (mode: ProjectDataMode, id: string, builtIn = false): TreeAction[] => [
    { label: builtIn ? "查看" : "修改", run: () => onEditData(mode, id) },
    { label: "复制", disabled: busy, run: () => onEditData(mode, id, true) },
    { label: "查看引用", run: () => showReferences(mode, id) },
    { label: "删除", danger: true, disabled: busy || builtIn, reason: builtIn ? "内置数据不可删除" : undefined, run: () => onDeleteData(mode, id) },
  ];
  const record = (mode: ProjectDataMode, id: string, name: string, detail: string, builtIn = false, invalid = false) => <li key={id} role="treeitem" aria-selected={false} hidden={!matches(id, name, detail, { variables: "变量", materials: "材料", coordinates: "坐标系" }[mode])}><ContextActions label={name} actions={dataActions(mode, id, builtIn)}><button className={`managed-tree-label managed-record${invalid?" invalid":""}`} title={`${detail} · 双击编辑`} onDoubleClick={() => onEditData(mode, id)} onKeyDown={(event) => { if (event.key === "Enter") onEditData(mode, id); }}><StudioIcon name={{ variables: "variable", materials: "layers", coordinates: "diamond" }[mode] as StudioIconName} size={14} /><span><strong>{name}</strong><small>{detail}</small></span></button></ContextActions></li>;
  return <section className="project-tree-pane studio-pane" data-testid="project-tree" aria-label="工程管理">
    <div className="studio-pane-header"><strong>工程管理</strong><button type="button" title={expanded ? "折叠工程树" : "展开工程树"} aria-label={expanded ? "折叠工程树" : "展开工程树"} onClick={() => { onQuery(""); setExpanded(!expanded); }}><StudioIcon name="collapse" /></button><button type="button" title="隐藏工程管理" aria-label="隐藏工程管理" onClick={onHide}><StudioIcon name="close" /></button></div>
    <label className="studio-tree-search"><StudioIcon name="search" size={14} /><input type="search" aria-label="查找几何体" placeholder="搜索名称或 ID" value={query} onChange={event => onQuery(event.target.value)} /></label>
    <div className="studio-tree-scroll"><ul className="managed-tree" role="tree" aria-label="工程结构"><li role="treeitem" aria-selected={false} aria-expanded={open}>
      <ContextActions label="工程管理" actions={[{ label: "新增变量", run: () => onEditData("variables") }, { label: "新增材料", run: () => onEditData("materials") }, { label: "新增坐标系", run: () => onEditData("coordinates") }, { label: "新增属性类型", run: () => onEditType(null) }, { label: open ? "折叠工程" : "展开工程", run: () => { onQuery(""); setExpanded(!open); } }]}><button className="managed-tree-label" onClick={() => { onQuery(""); setExpanded(!open); }}><span className="tree-toggle">{open ? "▾" : "▸"}</span><StudioIcon name="box" size={14} /><strong title={projectName}>{projectName || "未命名工程"}</strong></button></ContextActions>
      {open && <ul role="group" className="managed-tree-branch studio-project-branches">
        <Branch label="变量" icon="function" searching={Boolean(search)} actions={[{ label: "新增变量", disabled: busy, run: () => onEditData("variables") }]}>{variables.length ? variables.map((item) => record("variables", item.name, item.name, item.expression)) : null}</Branch>
        <Branch label="几何" icon="box" searching={Boolean(search)} actions={[]}>{geometry}</Branch>
        <Branch label="材料" icon="layers" searching={Boolean(search)} initiallyExpanded={materials.some(item => !item.builtIn)} actions={[{ label: "新增材料", disabled: busy, run: () => onEditData("materials") }]}>{materials.length ? materials.map((item) => record("materials", item.name, item.name, `εr ${item.relativePermittivity} · σ ${item.conductivity}`, item.builtIn)) : null}</Branch>
        <Branch label="坐标系" icon="axes" searching={Boolean(search)} actions={[{ label: "新增坐标系", disabled: busy, run: () => onEditData("coordinates") }]}>{coordinates.length ? coordinates.map((item) => record("coordinates", item.id, item.name, `${item.kind==="face"?item.associationMode==="associative"?item.referenceState==="resolved"?"面关联 · ":"引用失效 · ":"固定快照 · ":""}O(${item.origin.join(", ")})`, item.builtIn,item.associationMode==="associative" && item.referenceState!=="resolved")) : null}</Branch>
        <Branch label="属性类型" icon="tag" searching={Boolean(search)} actions={[{ label: "新增属性类型", run: () => onEditType(null) }, { label: "管理 / 导入 / 导出", run: () => onEditType(undefined) }]}>{types.length ? types.map((type) => {
          const records = instances.filter((instance) => instance.typeId === type.typeId);
          const typeMatches = matches(type.name, type.typeId, type.key, "属性类型");
          return <Branch key={type.typeId} label={type.name} icon="tag" searching={Boolean(search)} hidden={!typeMatches && !records.some(instance => matches(instance.name, instance.instanceId))} onEdit={() => onEditType(type.typeId)} actions={[
            { label: "新增实例", run: () => onEditInstance(type.typeId, null) },
            { label: "编辑类型", run: () => onEditType(type.typeId) },
            { label: "复制类型", disabled: busy || !stateToken, run: () => safe(async () => { let key = `${type.key}_copy`; let index = 2; while (types.some((item) => item.key === key)) key = `${type.key}_copy${index++}`; await schemaCommand("property.type.create", {}, { ...type, key, name: `${type.name} 副本` },stateToken); }) },
            { label: "删除类型", danger: true, disabled: busy || !stateToken || records.length > 0, reason: records.length ? "请先删除该类型下的实例" : undefined, run: () => safe(() => schemaCommand("property.type.delete", { typeId: type.typeId },{},stateToken)) },
          ]}>{records.length ? records.map((instance) => <li role="treeitem" aria-selected={false} hidden={!typeMatches && !matches(instance.name, instance.instanceId)} key={instance.instanceId}><ContextActions label={instance.name} actions={[
            { label: "修改实例", run: () => onEditInstance(type.typeId, instance.instanceId) },
            { label: "复制实例", disabled: busy || !stateToken || instance.state !== "active", reason:instance.state !== "active" ? "请先修复几何关联" : undefined, run: () => safe(() => schemaCommand("property.instance.create", {}, { typeId: type.typeId, name: `${instance.name} 副本`, value: instance.value, ...(Array.isArray(instance.targets) ? {targets: instance.targets} : {target: instance.target}) },stateToken)) },
            { label: "定位关联几何", disabled: !instanceTargets(instance).length || instance.state !== "active", reason: instance.state !== "active" ? "几何关联需要复核，请修改实例" : !instanceTargets(instance).length ? "此实例不关联几何" : undefined, run: () => locateInstance(instance) },
            { label: "删除实例", danger: true, disabled: busy || !stateToken, run: () => safe(() => schemaCommand("property.instance.delete", { instanceId: instance.instanceId },{},stateToken)) },
          ]}><button className={`managed-tree-label managed-record${instance.state !== "active" ? " invalid" : ""}`} title={instance.stateReason || "单击定位几何，双击修改实例"} onClick={() => { if (instance.state !== "active") { onSelectTargets?.([]); onEditInstance(type.typeId, instance.instanceId); } else if (instanceTargets(instance).length) locateInstance(instance); }} onDoubleClick={() => onEditInstance(type.typeId, instance.instanceId)} onKeyDown={(event) => { if (event.key === "Enter") onEditInstance(type.typeId, instance.instanceId); }}><span className="managed-record-dot">◇</span><span><strong>{instance.name}</strong><small>{instance.state !== "active" ? `${instance.state === "orphaned" ? "关联已失效" : "关联待复核"} · ` : ""}{Array.isArray(instance.targets) ? `关联集合 · ${instance.targets.length} 项` : instance.target ? `${instance.target.kind} · ${instance.target.topologyId || instance.target.bodyId}` : "工程属性"}</small></span></button></ContextActions></li>) : <li className="managed-tree-empty">右键类型 → 新增实例</li>}</Branch>;
        }) : null}</Branch>
        <li role="treeitem" aria-selected={false} hidden={!matches("网格管理", "网格工作台", "网格剖分")}>
          <div className="managed-tree-row">
            <button type="button" className="managed-tree-label" onClick={onOpenMesh}>
              <span className="tree-toggle" aria-hidden="true" /><StudioIcon name="referenceGrid" size={14} /><strong>网格管理</strong>
            </button>
          </div>
        </li>
        <Branch label="仿真管理" icon="settings" searching={Boolean(search)} initiallyExpanded={false} actions={[{ label: "查看求解器状态", run: onOpenSimulation }]}>
          <li role="treeitem" aria-selected={false} hidden={!matches("仿真", "求解器", "求解器未接入")}><button type="button" className="managed-tree-label managed-record" onClick={onOpenSimulation}><StudioIcon name="settings" size={14} /><span><strong>求解器状态</strong><small>未接入</small></span></button></li>
        </Branch>
      </ul>}
    </li></ul>{references && <section className="tree-references" aria-label="引用信息"><div><strong>{references.name} · 引用</strong><button aria-label="关闭引用信息" onClick={() => setReferences(null)}>×</button></div>{references.entries.length ? <ul>{references.entries.map((entry) => <li key={entry}>{entry}</li>)}</ul> : <p>当前工程数据中没有发现引用。删除时仍由几何服务检查依赖关系。</p>}</section>}{error && <p className="tree-error" role="alert">{error}</p>}
    </div></section>;
}
