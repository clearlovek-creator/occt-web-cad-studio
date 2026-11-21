"use client";

import { useMemo, useState } from "react";
import { bodyDisplayName, buildStructuredBodyHistory, featureTypeLabel,featureOutputName,unrepresentedSuppressedFeatures, type FeatureData, type StructuredFeatureNode } from "./model/feature-graph";
import { ContextActions, EyeIcon, MeshIcon } from "./workbench/ContextActions";
import {SuppressedFeatureBranch} from "./workbench/SuppressedFeatureBranch";
import {loftVersionKind} from './modeling/loft-loops';
import { StudioIcon } from "./workbench/StudioIcon";
export type { FeatureData } from "./model/feature-graph";
export type BodyTreeData = { bodyId: string; topologyRevision: number; name?: string; visible?: boolean; color?: string; material?: string; opacity?: number; kind?: "solid" | "sheet" | "wire" | "shape" };
type BodySelectionOptions = { additive?: boolean; range?: boolean };
export {BodyAppearancePanel} from './workbench/BodyAppearancePanel';

export function boxDimensions(feature: FeatureData | undefined) {
  if (feature?.type !== "primitive.box") return null;
  const dimensions = [feature.numberParameters.width, feature.numberParameters.depth, feature.numberParameters.height];
  return dimensions.every(Number.isFinite) ? dimensions : null;
}

export function FeatureTree({ features, bodies, activeBodyId, selectedBodyId, selectedBodyIds = [], onSelectBody, onActivateBody, onEditFeature, onFeatureAction, onDeleteBody, deletingBodyId, onUpdateBody, onEditBody, onEditMaterial, onManageProperties, meshBodyVisibility,meshBodyPending, onMeshBodyVisibility,busy, query }: {
  features: FeatureData[]; bodies: BodyTreeData[]; activeBodyId: string | null; selectedBodyId: string | null; selectedBodyIds?: string[];
  onSelectBody: (bodyId: string, options?: BodySelectionOptions) => void | Promise<void>;
  onActivateBody: (bodyId: string) => Promise<void>;
  onEditFeature: (bodyId: string|null, featureId: string) => void;
  onFeatureAction: (featureId: string, action: "suppress" | "restore" | "delete", bodyId?: string) => Promise<void>;
  onDeleteBody: (bodyId: string) => Promise<void>; deletingBodyId: string | null;
  onUpdateBody: (bodyId: string, changes: Record<string, unknown>) => Promise<boolean>;
  onEditBody: (bodyId: string) => void; onEditMaterial: (name: string) => void; onManageProperties: (bodyId: string) => void;
  meshBodyVisibility?: Record<string, boolean>; meshBodyPending?:Record<string,boolean>; onMeshBodyVisibility?: (bodyId: string, visible: boolean) => void;
  busy?:boolean;
  query: string;
}) {
  const [collapsedBodies, setCollapsedBodies] = useState<Set<string>>(new Set());
  const [collapsedMaterials, setCollapsedMaterials] = useState<Set<string>>(new Set());
  const [expandedBooleanInputs, setExpandedBooleanInputs] = useState<Set<string>>(new Set());
  const bodyFilter = query.trim().toLocaleLowerCase();
  const toggle = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) => setter((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const orderedBodies = useMemo(() => [...bodies].sort((a, b) => a.bodyId.localeCompare(b.bodyId, undefined, { numeric: true })), [bodies]);
  const histories = useMemo(() => new Map(orderedBodies.map((body) => [body.bodyId, buildStructuredBodyHistory(features, body.bodyId)])), [features, orderedBodies]);
  const suppressed=useMemo(()=>unrepresentedSuppressedFeatures(features,histories.values()),[features,histories]);
  const filteredSuppressed=useMemo(()=>{const query=bodyFilter.trim().toLocaleLowerCase();return query?suppressed.filter(feature=>`${featureOutputName(feature)} ${featureTypeLabel(feature.type)} ${feature.type} ${feature.id} ${feature.outputBodies.join(" ")}`.toLocaleLowerCase().includes(query)):suppressed;},[suppressed,bodyFilter]);
  const groups = useMemo(() => {
    const byMaterial = new Map<string, BodyTreeData[]>();
    for (const body of orderedBodies) { const material = body.material || ""; if (!byMaterial.has(material)) byMaterial.set(material, []); byMaterial.get(material)!.push(body); }
    if (!byMaterial.has("")) byMaterial.set("", []);
    const query = bodyFilter.trim().toLocaleLowerCase();
    return [...byMaterial.entries()].sort(([a], [b]) => a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)).map(([material, members]) => ({ material, members, filtered: query ? members.filter((body) => {
      const history = histories.get(body.bodyId) || [];
      const names = history.map(({ feature }) => `${feature.id} ${featureTypeLabel(feature.type)} ${featureOutputName(feature)}`);
      return `${material} ${body.name || bodyDisplayName(body.bodyId, features)} ${body.bodyId} ${names.join(" ")}`.toLocaleLowerCase().includes(query);
    }) : members })).filter((group) => group.members.length && group.filtered.length);
  }, [orderedBodies, bodyFilter, features, histories]);
  const renderHistory = (history: StructuredFeatureNode[], ownerBodyId: string, nested = false) => <ol className={`body-feature-list${nested ? " nested-feature-list" : ""}`} role="group">{history.map(({ feature, inputBodies }) => {
    const protectedFeature = nested || /^(primitive|surface)\./.test(feature.type);
    const reason = nested ? "已消费输入仅可编辑源参数，不能独立删除或抑制" : "基础特征请通过 Body 管理";
    return <li key={feature.id} role="treeitem" aria-selected={false} className={inputBodies.length ? "has-input-bodies" : undefined}>
      <ContextActions label={`${featureTypeLabel(feature.type)} ${feature.id}`} actions={[{ label: "编辑特征参数", run: () => onEditFeature(ownerBodyId, feature.id) }, { label: feature.state === "suppressed" ? "恢复特征" : "抑制特征", disabled: protectedFeature, reason, run: () => onFeatureAction(feature.id, feature.state === "suppressed" ? "restore" : "suppress", ownerBodyId) }, { label: "删除特征", danger: true, disabled: protectedFeature, reason, run: () => onFeatureAction(feature.id, "delete", ownerBodyId) }]}>
        <span className="feature-order">{features.indexOf(feature) + 1}</span><button className="feature-tree-label" title={`${feature.type} · ${feature.id} · 双击编辑参数`} onClick={() => void onSelectBody(ownerBodyId)} onDoubleClick={() => onEditFeature(ownerBodyId, feature.id)}><strong>{featureTypeLabel(feature.type)}{feature.type==='detail.loft'?(loftVersionKind(feature)==='legacy'?' · 旧近似':loftVersionKind(feature)==='unsupported'?' · 不支持版本':feature.stringParameters.loftVersion==='3'?' · 多孔':''):''}</strong><small>{feature.id} · R{feature.computedRevision}</small></button><em className={feature.state === "valid" ? "valid" : ""}>{feature.state === "valid" ? "✓" : feature.state}</em>
      </ContextActions>
      {inputBodies.length > 0 && <ul className="boolean-input-list" role="group">{inputBodies.map((inputBody) => { const key = `${feature.id}:${inputBody.bodyId}`; const expanded = expandedBooleanInputs.has(key); return <li className="boolean-input-body" key={key} role="treeitem" aria-selected={false} aria-expanded={expanded}><button className="boolean-input-header" onClick={() => toggle(setExpandedBooleanInputs, key)}><span>{expanded ? "▾" : "▸"}</span><span className="boolean-input-icon">B</span><strong>{inputBody.name || bodyDisplayName(inputBody.bodyId, features)}</strong></button>{expanded && renderHistory(inputBody.features, ownerBodyId, true)}</li>; })}</ul>}
    </li>;
  })}</ol>;
  return <li role="none" className="feature-tree geometry-tree-pane" data-testid="feature-tree">
    {!bodies.length&&!suppressed.length ? <p className="panel-copy">暂无几何，使用上方创建工具添加。</p> : bodies.length>0&&<ul className="body-feature-tree material-feature-tree" role="group" aria-label="几何体与特征">{groups.map(({ material, members, filtered }) => {
      const flat = !material && groups.length === 1;
      const expanded = flat || Boolean(bodyFilter) || !collapsedMaterials.has(material);
      const groupName = material || "未指定材料";
      return <li className={`material-tree-group${flat ? " flat" : ""}`} key={material} role={flat ? "none" : "treeitem"} aria-selected={flat ? undefined : false} aria-expanded={flat ? undefined : expanded} data-material={material || "unassigned"}>
        {!flat && <ContextActions label={groupName} actions={[{ label: "选择组内全部 Body", run: async () => { for (const [index, body] of members.entries()) await onSelectBody(body.bodyId, { additive: index > 0 }); } }, { label: "显示组内几何", run: async () => { for (const body of members) await onUpdateBody(body.bodyId, { visible: true }); } }, { label: "隐藏组内几何", run: async () => { for (const body of members) await onUpdateBody(body.bodyId, { visible: false }); } }, { label: "编辑材料", disabled: !material, reason: !material ? "尚未指定材料" : undefined, run: () => onEditMaterial(material) }]}>
          <button className="managed-tree-label material-group-label" onClick={() => toggle(setCollapsedMaterials, material)}><span className="tree-toggle">{expanded ? "▾" : "▸"}</span><StudioIcon name="layers" size={14} /><strong>{groupName}</strong><small>{members.length}</small></button>
        </ContextActions>}
        {expanded && <ul role="group" className="material-body-list">{filtered.map((body) => {
          const history = histories.get(body.bodyId) || [];
          const bodyExpanded = Boolean(history.length) && (Boolean(bodyFilter) || !collapsedBodies.has(body.bodyId));
          const selected = selectedBodyIds.includes(body.bodyId) || selectedBodyId === body.bodyId;
          const name = body.name || bodyDisplayName(body.bodyId, features);
          const dimensions = boxDimensions(history.at(-1)?.feature);
          const meshVisible = meshBodyVisibility?.[body.bodyId];
          return <li key={body.bodyId} role="treeitem" aria-selected={selected} aria-expanded={bodyExpanded} data-body-id={body.bodyId}>
            <ContextActions label={name} className={`body-tree-node${selected ? " selected" : ""}`} actions={[{ label: "编辑名称 / 材料 / 外观", run: () => onEditBody(body.bodyId) }, { label: "设为当前 Body", disabled: activeBodyId === body.bodyId, reason: "当前建模目标", run: () => onActivateBody(body.bodyId) }, { label: body.visible === false ? "显示几何" : "隐藏几何", run: () => onUpdateBody(body.bodyId, { visible: body.visible === false }) }, { label: meshVisible ? "隐藏网格" : "显示网格", disabled: meshVisible === undefined, reason: "此 Body 尚无网格", run: () => onMeshBodyVisibility?.(body.bodyId, !meshVisible) }, { label: "管理关联属性", run: () => onManageProperties(body.bodyId) }, { label: "删除 Body", danger: true, disabled: Boolean(deletingBodyId), run: () => onDeleteBody(body.bodyId) }]}>
              {history.length ? <button className="tree-expander" aria-label={`${bodyExpanded ? "折叠" : "展开"} ${name}`} onClick={() => toggle(setCollapsedBodies, body.bodyId)}>{bodyExpanded ? "▾" : "▸"}</button> : <span className="tree-expander" />}
              <button className="body-tree-label" title={`${name} · ${body.bodyId}${dimensions ? " · " + dimensions.join(" × ") + " mm" : ""} · 双击修改外观`} onClick={(event) => void onSelectBody(body.bodyId, { additive: event.ctrlKey || event.metaKey, range: event.shiftKey })} onDoubleClick={() => onEditBody(body.bodyId)}><StudioIcon name={body.kind === "sheet" ? "plane" : body.kind === "wire" ? "line" : "box"} size={13} /><span><strong>{name}</strong></span>{activeBodyId === body.bodyId && <span className="studio-active-body" aria-current="true" title="当前建模目标">当前</span>}</button>
              <button className={`body-visibility-button tree-icon-button${body.visible === false ? " is-off" : ""}`} aria-label={`${body.visible === false ? "显示" : "隐藏"} ${name} 几何`} title={body.visible === false ? "显示几何" : "隐藏几何"} aria-pressed={body.visible !== false} onClick={() => void onUpdateBody(body.bodyId, { visible: body.visible === false })}><EyeIcon hidden={body.visible === false} /></button>
              {meshVisible !== undefined && <button className={`body-mesh-visibility-button tree-icon-button${meshVisible ? " is-on" : " is-off"}`} aria-label={`${meshVisible ? "隐藏" : "显示"} ${name} 网格`} aria-busy={Boolean(meshBodyPending?.[body.bodyId])} title={meshBodyPending?.[body.bodyId]?"正在校验，点击取消显示":meshVisible ? "隐藏网格" : "显示网格"} aria-pressed={meshVisible} onClick={() => onMeshBodyVisibility?.(body.bodyId, !meshVisible)}><MeshIcon /></button>}
            </ContextActions>
            {bodyExpanded && renderHistory(history, body.bodyId)}
          </li>;
        })}</ul>}
      </li>;
    })}</ul>}
    <SuppressedFeatureBranch features={filteredSuppressed} total={suppressed.length} busy={busy} onEdit={featureId=>onEditFeature(null,featureId)} onAction={onFeatureAction}/>
  </li>;
}
