"use client";

import { useState } from "react";
import { instanceTargets,schemaCommand as run, usePropertySchema, type PropertyField, type PropertyInstance, type PropertyTarget, type PropertyType, type PropertyMigration } from "./model/property-schema";
import {MAX_PROPERTY_TARGETS,propertyTargetKey} from '../shared/property-targets.mjs';
import { normalizePropertyFields, parsePropertyValue } from "./model/property-field-values";

function FieldEditor({ fields, onChange, lockedKeys = [] }: { fields: PropertyField[]; onChange: (fields: PropertyField[]) => void; lockedKeys?: string[] }) {
  const update = (index: number, patch: Partial<PropertyField>) => onChange(fields.map((field, itemIndex) => itemIndex === index ? { ...field, ...patch } : field));
  return <div className="schema-field-editor" aria-label="自定义属性字段列表">
    <div className="schema-field-heading"><span>字段定义</span><button type="button" onClick={() => { let number = fields.length + 1; while (fields.some((field) => field.key === `field${number}`)) number++; onChange([...fields, { key: `field${number}`, label: "新属性", type: "double", required: false }]); }}>＋ 添加属性</button></div>
    {fields.map((field, index) => <fieldset className="schema-field-row" key={index} disabled={lockedKeys.includes(field.key)}><legend className="schema-field-legend">字段 {index + 1}{lockedKeys.includes(field.key) ? " · 已有实例，定义只读" : ""}</legend>
      <input aria-label={`字段 ${index + 1} Key`} value={field.key} onChange={(event) => update(index, { key: event.target.value })} placeholder="key" />
      <input aria-label={`字段 ${index + 1} 名称`} value={field.label} onChange={(event) => update(index, { label: event.target.value })} placeholder="显示名称" />
      <select aria-label={`字段 ${index + 1} 类型`} value={field.type} onChange={(event) => update(index, { type: event.target.value as PropertyField["type"], default:undefined, options:event.target.value === "enum" ? ["选项1", "选项2"] : undefined })}><option value="double">Double</option><option value="int">Int</option><option value="bool">Bool</option><option value="expression">表达式</option><option value="enum">枚举</option><option value="vector3">三维向量</option></select>
      <label className="schema-required"><input type="checkbox" checked={field.required === true} onChange={(event) => update(index, { required: event.target.checked })} />必填</label>
      <button type="button" aria-label={`删除字段 ${field.key}`} onClick={() => onChange(fields.filter((_, itemIndex) => itemIndex !== index))}>×</button>
      {field.type === "enum" && <input className="schema-enum-options" aria-label={`字段 ${index + 1} 枚举选项`} placeholder="选项，以逗号分隔" value={(field.options || []).join(",")} onChange={(event) => update(index, { options: event.target.value.split(",").map((entry) => entry.trim()) })} />}
      <div className="schema-field-default"><label className="schema-required"><input type="checkbox" aria-label={`字段 ${index+1} 使用默认值`} checked={field.default!==undefined} onChange={event=>update(index,{default:event.target.checked ? field.type==="bool"?false:field.type==="enum"?field.options?.[0] || "":"" : undefined})} />使用默认值</label>
        {field.default!==undefined && (field.type==="bool" ? <select aria-label={`字段 ${index+1} 默认值`} value={String(field.default)} onChange={event=>update(index,{default:event.target.value==="true"})}><option value="false">false</option><option value="true">true</option></select> : field.type==="enum" ? <select aria-label={`字段 ${index+1} 默认值`} value={String(field.default)} onChange={event=>update(index,{default:event.target.value})}>{field.options?.map((option,optionIndex)=><option key={optionIndex} value={option}>{option || "（空选项）"}</option>)}</select> : <input aria-label={`字段 ${index+1} 默认值`} value={Array.isArray(field.default)?field.default.join(", "):String(field.default)} placeholder={field.type==="vector3"?"0, 0, 1":field.type==="expression"?"变量或表达式":"默认数值"} onChange={event=>update(index,{default:event.target.value})} />)}
      </div>
    </fieldset>)}
    {!fields.length && <p className="panel-copy">添加字段后，实例只能修改这些字段的值，不能改变 key。</p>}
  </div>;
}

export function PropertyTypeManagerPanel({ initialTypeId }: { initialTypeId?: string | null }) {
  const { types, instances, stateToken, refresh, error: loadError } = usePropertySchema();
  const [selectedTypeId, setSelectedTypeId] = useState(initialTypeId || "");
  type TypeDraft = Pick<PropertyType, "key" | "name" | "description" | "targetScope" | "association" | "fields" | "targetMode" | "splitPolicy"> & { recordId: string; baseStateToken?:string };
  const [draft, setDraft] = useState<TypeDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [migration, setMigration] = useState<{key:string;value:PropertyMigration}|null>(null);
  const selectedType = types.find((item) => item.typeId === selectedTypeId);
  const current: TypeDraft = draft?.recordId === selectedTypeId ? draft : { key: selectedType?.key || "", name: selectedType?.name || "", description: selectedType?.description || "", targetScope: selectedType?.targetScope || "project", association: selectedType?.association || "none",targetMode:selectedType?.targetMode||'single',splitPolicy:selectedType?.splitPolicy||'review', fields: selectedType?.fields || [], recordId: selectedTypeId, baseStateToken:stateToken };
  const { key: typeKey, name: typeName, description, targetScope, association, fields } = current;
  const update = (patch: Partial<TypeDraft>) => setDraft((previous) => ({ ...(previous?.recordId === selectedTypeId ? previous : current), ...patch }));
  const setTypeKey = (key: string) => update({ key });
  const setTypeName = (name: string) => update({ name });
  const setDescription = (description: string) => update({ description });
  const setTargetScope = (scope: PropertyType["targetScope"]) => {
    update({ targetScope: scope, association: scope === "project" ? "none" : "optional", splitPolicy: scope === "face" || scope === "edge" ? "all-descendants" : "review" });
  };
  const setAssociation = (association: PropertyType["association"]) => update({ association });
  const setFields = (fields: PropertyField[]) => update({ fields });
  const selectType = (typeId: string) => { setSelectedTypeId(typeId); setDraft(null); setMigration(null); setError(null); setMessage(""); };
  const stale=Boolean(current.baseStateToken && stateToken && current.baseStateToken!==stateToken);
  const missing=Boolean(stateToken && selectedTypeId && !selectedType);
  const instanceCount=instances.filter(instance=>instance.typeId===selectedTypeId).length;
  const migrationKey=JSON.stringify(current);
  const needsMigration=Boolean(instanceCount && selectedType && JSON.stringify(fields)!==JSON.stringify(selectedType.fields));
  const previewMigration=async()=>{if(!selectedTypeId)return;setBusy(true);setError(null);try{const result=await run("property.type.preview",{typeId:selectedTypeId},{name:typeName,description,fields:normalizePropertyFields(fields,instanceCount?selectedType?.fields.map(field=>field.key):[])},current.baseStateToken);if(result.migration)setMigration({key:migrationKey,value:result.migration});}catch(reason){setError(reason instanceof Error?reason.message:"迁移预览失败");}finally{setBusy(false);}};
  const reload=async()=>{setBusy(true);const loaded=await refresh();if(loaded){setDraft(null);setMigration(null);setError(null);setMessage("已重新载入最新类型，未保存的草稿已放弃。");}setBusy(false);};
  const save = async () => { setBusy(true); setError(null); try {
    if(!current.baseStateToken || missing)throw new Error("类型尚未载入或已被删除，请重新载入。");
    if(needsMigration && migration?.key!==migrationKey)throw new Error("请先预览字段迁移，再保存类型。");
    const normalized=normalizePropertyFields(fields,instanceCount?selectedType?.fields.map(field=>field.key):[]);
    const result = selectedTypeId ? await run("property.type.update", { typeId: selectedTypeId }, { name: typeName, description, fields:normalized },current.baseStateToken) : await run("property.type.create", {}, { key: typeKey, name: typeName, description, targetScope, association,fields:normalized,...(current.targetMode==='multiple'&&targetScope!=='project'&&association!=='none'?{targetMode:'multiple',splitPolicy:['face','edge'].includes(targetScope)?current.splitPolicy:'review'}:{}) },current.baseStateToken);
    if (result.type) setSelectedTypeId(result.type.typeId); await refresh();setDraft(null);setMigration(null);setMessage("属性类型已保存，工程树已同步。");
  } catch (reason) { setError(reason instanceof Error ? reason.message : "属性类型保存失败"); } finally { setBusy(false); } };
  const exportTypes = async () => { setBusy(true); setError(null); try { const result = await run("property.package.export"); const url = URL.createObjectURL(new Blob([JSON.stringify(result.package, null, 2)], { type: "application/json" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "cad-property-types.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (reason) { setError(String(reason)); } finally { setBusy(false); } };
  const importTypes = async (file: File) => { setBusy(true); setError(null); try { if(!stateToken)throw new Error("请等待属性载入。");await run("property.package.import", {}, { package: JSON.parse(await file.text()), conflict: "skip" },stateToken);await refresh();setMessage("属性类型文件已恢复，同名类型保留现有定义。"); } catch (reason) { setError(String(reason)); } finally { setBusy(false); } };
  return <section className="panel-section property-type-manager" data-testid="property-type-manager">
    <div className="section-heading compact"><div><h2>{selectedTypeId ? `编辑类型 · ${selectedType?.name || typeName || selectedTypeId}` : "新建属性类型"}</h2><small>每种类型可创建多个独立实例，统一挂在工程树的类型节点下。</small></div></div>
    <div className="schema-toolbar"><button disabled={busy} onClick={() => void exportTypes()}>导出类型文件</button><label className="file-action">导入类型文件<input disabled={busy} type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importTypes(file); event.currentTarget.value = ""; }} /></label></div>
    {initialTypeId === undefined && <label className="single-field"><span>属性类型</span><select aria-label="选择属性类型" value={selectedTypeId} onChange={(event) => selectType(event.target.value)}><option value="">＋ 新建类型</option>{types.map((type) => <option key={type.typeId} value={type.typeId}>{type.name} · {type.key}</option>)}</select></label>}
    {(stale || missing) && <div className="schema-conflict" role="alert">{missing?"此类型已被删除，不能将旧草稿另存为新类型。":"工程已有新修改，当前草稿不会覆盖最新数据。"}</div>}
    <div className="schema-toolbar"><button type="button" disabled={busy || !stateToken} onClick={()=>void reload()}>重新载入最新类型（放弃草稿）</button></div>
    <form className="schema-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <fieldset className="schema-edit-fields" disabled={!stateToken || busy} aria-label="类型编辑字段">
      <div className="compact-fields"><label><span>唯一 Key</span><input aria-label="属性类型 Key" required disabled={Boolean(selectedTypeId) || busy} value={typeKey} onChange={(event) => setTypeKey(event.target.value)} /></label><label><span>名称</span><input aria-label="属性类型名称" required value={typeName} onChange={(event) => setTypeName(event.target.value)} /></label></div>
      <label className="single-field"><span>说明</span><input aria-label="属性类型说明" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <div className="compact-fields"><label><span>关联范围</span><select aria-label="属性关联范围" disabled={Boolean(selectedType)} value={targetScope} onChange={event => setTargetScope(event.target.value as PropertyType["targetScope"])}><option value="project">工程（无几何关联）</option><option value="body">体 Body</option><option value="face">面 Face</option><option value="edge">边 Edge</option></select></label><label><span>关联要求</span><select aria-label="属性关联方式" disabled={Boolean(selectedType) || targetScope === "project"} value={association} onChange={(event) => setAssociation(event.target.value as PropertyType["association"])}><option value="none">不关联</option><option value="optional">可选关联</option><option value="required">必须关联</option></select></label></div>
      {targetScope!=='project'&&association!=='none'&&<><label className="single-field"><span>关联数量</span><select aria-label="属性关联数量" disabled={Boolean(selectedType)} value={current.targetMode||'single'} onChange={event=>update({targetMode:event.target.value as PropertyType['targetMode']})}><option value="single">单个几何对象（兼容原行为）</option><option value="multiple">关联集合（一个实例关联多个对象）</option></select></label>{current.targetMode==='multiple'&&<><label className="single-field"><span>分裂继承</span><select aria-label="属性分裂继承策略" disabled={Boolean(selectedType)||targetScope==='body'} value={targetScope==='body'?'review':current.splitPolicy||'review'} onChange={event=>update({splitPolicy:event.target.value as PropertyType['splitPolicy']})}><option value="review">人工复核</option>{targetScope!=='body'&&<option value="all-descendants">跟随全部已验证后代</option>}</select></label><p className="panel-copy">仅沿真实拓扑血缘继承；身份缺失、删除或不确定对应仍需复核。类型创建后关联数量与策略固定；集合工程/类型文件使用版本 2。</p></>}</>}
      <FieldEditor fields={fields} onChange={setFields} lockedKeys={instanceCount?selectedType?.fields.map(field=>field.key):[]} />
      <p className="panel-copy">已有实例的类型只能新增字段，不能改动或移除已有字段。</p>
      {Boolean(selectedTypeId) && <button type="button" className="secondary-action" disabled={busy || stale || missing || !stateToken} onClick={()=>void previewMigration()}>预览字段迁移</button>}
      {migration?.key===migrationKey && <section className="schema-migration" aria-label="字段迁移预览"><strong>{migration.value.instanceCount} 个实例 · {migration.value.addedFields.length} 个新增字段</strong><p>只补入新增字段的默认值；已有字段值和几何关联保持不变。保存后可撤销。</p>{migration.value.addedFields.map(field=><div key={field.key}><code>{field.key}</code><span>{field.default===undefined?"未设置（可选字段）":JSON.stringify(field.default)}</span></div>)}{migration.value.examples.length>0 && <details><summary>查看前 {migration.value.examples.length} 个实例</summary>{migration.value.examples.map(example=><p key={example.instanceId}>{example.name} · {JSON.stringify(example.addedValues)}</p>)}</details>}</section>}
      <button className="primary-action" disabled={busy || !stateToken || stale || missing || (needsMigration && migration?.key!==migrationKey)}>{busy ? "正在保存…" : selectedTypeId ? "保存类型" : "创建类型"}</button>
      </fieldset>
    </form>
    {(loadError || (!stale && !missing && error)) && <p className="property-error" role="alert">{loadError || error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}

function initialValues(type?: PropertyType, instance?: PropertyInstance): Record<string, unknown> {
  return Object.fromEntries((type?.fields || []).map((field) => [field.key, instance?.value[field.key] ?? field.default ?? (field.type === "bool" ? false : field.type === "enum" ? field.options?.[0] || "" : "")]));
}

export function PropertySchemaPanel({ selectedTarget, onSelectTarget,onSelectTargets, onOpenTypeManager, initialTypeId, initialInstanceId }: { selectedTarget: PropertyTarget; onSelectTarget: (target: PropertyTarget) => void;onSelectTargets?:(targets:NonNullable<PropertyTarget>[])=>void; onOpenTypeManager?: () => void; initialTypeId?: string | null; initialInstanceId?: string | null }) {
  const { types, instances, stateToken, refresh, error: loadError } = usePropertySchema();
  const [editingId, setEditingId] = useState(initialInstanceId || "");
  const [typeId, setTypeId] = useState(initialTypeId || "");
  type InstanceDraft = { recordId: string; name: string; values: Record<string, unknown>; target: PropertyTarget;targets?:NonNullable<PropertyTarget>[]; targetEdited?: boolean; baseStateToken?:string; typeSnapshot?:PropertyType };
  const [draft, setDraft] = useState<InstanceDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const instance = instances.find((item) => item.instanceId === editingId);
  const liveType = types.find((item) => item.typeId === (instance?.typeId || typeId));
  const type = draft?.recordId === `instance:${editingId}` ? draft.typeSnapshot || liveType : liveType;
  const draftId = editingId ? `instance:${editingId}` : `new:${type?.typeId || ""}`;
  const current: InstanceDraft = draft?.recordId === draftId ? draft : { recordId: draftId, name: instance?.name || "", values: initialValues(type, instance), target: instance?.target || null,targets:instanceTargets(instance), baseStateToken:stateToken, typeSnapshot:type };
  const { name, values, target } = current;
  const update = (patch: Partial<InstanceDraft>) => setDraft((previous) => ({ ...(previous?.recordId === draftId ? previous : current), ...patch }));
  const setName = (name: string) => update({ name });
  const setValues = (values: Record<string, unknown>) => update({ values });
  const setTarget = (target: PropertyTarget) => update({ target, targetEdited:true });
  const targets=current.targets||[],multiple=type?.targetMode==='multiple';
  const setTargets=(targets:NonNullable<PropertyTarget>[])=>{if(targets.length>MAX_PROPERTY_TARGETS){setError(`关联集合最多 ${MAX_PROPERTY_TARGETS} 项，请拆分实例。`);return;}update({targets,targetEdited:true});};
  const addTargets=(added:NonNullable<PropertyTarget>[])=>{
    // A viewport pick may not contain the canonical UUID yet. Do not duplicate
    // an already stored member simply because one representation includes it.
    const location=(item:NonNullable<PropertyTarget>)=>`${item.kind}|${item.bodyId}|${item.topologyId||''}`;
    const next=new Map(targets.map(target=>[location(target),target]));
    for(const target of added)if(!next.has(location(target)))next.set(location(target),target);
    setTargets([...next.values()]);
  };
  const stale=Boolean(current.baseStateToken && stateToken && current.baseStateToken!==stateToken);
  const missing=Boolean(stateToken && editingId && !instance);
  const reload=async()=>{setBusy(true);const loaded=await refresh();if(loaded){setDraft(null);setError(null);setMessage("已重新载入最新实例，未保存的草稿已放弃。");}setBusy(false);};
  const save = async () => { if (!type) return; setBusy(true); setError(null); try {
    if(!current.baseStateToken || missing)throw new Error("实例尚未载入或已被删除，请重新载入。");
    const value: Record<string, unknown> = {};
    for (const field of type.fields) {
      const parsed=parsePropertyValue(field,values[field.key]);
      if(parsed!==undefined)value[field.key]=parsed;
    }
    const result = await run(editingId ? "property.instance.update" : "property.instance.create", editingId ? { instanceId: editingId } : {}, { typeId: type.typeId, name: name.trim() || `${type.name} ${instances.filter((item) => item.typeId === type.typeId).length + 1}`, value, ...(!editingId || current.targetEdited ? multiple?{targets}:{target} : {}) },current.baseStateToken);
    if (result.instance) setEditingId(result.instance.instanceId); await refresh();setDraft(null); setMessage("实例已保存，工程树已同步。");
  } catch (reason) { setError(reason instanceof Error ? reason.message : "属性实例保存失败"); } finally { setBusy(false); } };
  return <section className="panel-section property-schema-panel" data-testid="property-schema-panel">
    <div className="section-heading compact"><div><h2>{editingId ? `编辑实例 · ${instance?.name || name || editingId}` : "新增属性实例"}</h2><small>字段 key 由属性类型定义，实例仅修改 value。</small></div></div>
    {!types.length && <p className="panel-copy">暂无属性类型，请先定义字段与关联范围。</p>}
    <button className="secondary-action" onClick={onOpenTypeManager}>管理属性类型</button>
    {(stale || missing) && <div className="schema-conflict" role="alert">{missing?"此实例已被删除，不能将旧草稿另存为新实例。":"工程已有新修改，草稿已保留，不会覆盖最新数据。"}</div>}
    <div className="schema-toolbar"><button type="button" disabled={busy || !stateToken} onClick={()=>void reload()}>重新载入最新实例（放弃草稿）</button></div>
    <form className="schema-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <fieldset className="schema-edit-fields" disabled={!stateToken || busy} aria-label="实例编辑字段">
      <label className="single-field"><span>属性类型</span><select aria-label="属性类型" required disabled={Boolean(editingId) || Boolean(initialTypeId)} value={type?.typeId || ""} onChange={(event) => { setTypeId(event.target.value); setEditingId(""); }}><option value="">选择类型</option>{types.map((item) => <option key={item.typeId} value={item.typeId}>{item.name} · {item.key}</option>)}</select></label>
      <label className="single-field"><span>实例名称</span><input aria-label="属性实例名称" value={name} onChange={(event) => setName(event.target.value)} placeholder={type ? `${type.name} ${instances.filter((item) => item.typeId === type.typeId).length + 1}` : "实例名称"} /></label>
      <div className="schema-value-fields">{type?.fields.map((field) => <label className="schema-value-field" key={field.key}><span><strong>{field.label}{field.required ? " *" : ""}</strong><code>{field.key} · {field.type}</code></span>
        {field.type === "bool" ? <input aria-label={field.label} type="checkbox" checked={values[field.key] === true} onChange={(event) => setValues({ ...values, [field.key]: event.target.checked })} /> : field.type === "enum" ? <select aria-label={field.label} value={String(values[field.key] ?? "")} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}>{!field.required && <option value="">未设置</option>}{field.options?.map((option) => <option key={option}>{option}</option>)}</select> : <input aria-label={field.label} type="text" inputMode={field.type === "double" || field.type === "int" ? "decimal" : undefined} required={field.required} placeholder={field.type === "vector3" ? "0, 0, 0" : field.type === "expression" ? "变量或表达式" : "数值"} value={Array.isArray(values[field.key]) ? (values[field.key] as unknown[]).join(", ") : String(values[field.key] ?? "")} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })} />}
      </label>)}</div>
      {type && type.association !== "none" && type?.targetScope !== "project" && (multiple?<fieldset className="schema-association" aria-label="属性关联集合"><legend>关联集合 · {type.targetScope} · {targets.length} 项</legend><p className="panel-copy">分裂策略：{type.splitPolicy==='all-descendants'?'跟随全部已验证后代':'人工复核'}。可保持窗口打开，在视口逐个选择并加入集合；最多 {MAX_PROPERTY_TARGETS} 项。</p><div className="schema-toolbar"><button type="button" disabled={stale||!selectedTarget||selectedTarget.kind!==type.targetScope} onClick={()=>{if(selectedTarget)addTargets([selectedTarget]);}}>添加当前选择</button><button type="button" disabled={stale||!targets.length||Boolean(instance&&instance.state!=='active'&&!current.targetEdited)} onClick={()=>onSelectTargets?.(targets)}>定位整个集合</button><button type="button" disabled={!targets.length} onClick={()=>setTargets([])}>清空集合</button></div><ul className="property-target-list" aria-label="关联成员">{targets.slice(0,100).map((item,index)=><li key={`${propertyTargetKey(item)}:${index}`}><div><strong>{index+1} · {item.bodyId}</strong><span>{item.topologyId||item.kind}</span>{!current.targetEdited&&instance?.association?.members?.[index]?.state!=='active'&&instance?.association?.members?.[index]&&<small>{instance.association.members[index].reason||'关联待复核'}</small>}</div><button type="button" aria-label={`移除关联成员 ${index+1}`} onClick={()=>setTargets(targets.filter((_,i)=>i!==index))}>移除</button></li>)}</ul>{targets.length>100&&<p className="panel-copy">显示前 100 项；保存保留全部 {targets.length} 项，不会截断集合。</p>}{!targets.length&&<p className="panel-copy">集合为空{type.association==='required'?'，保存前至少添加一项':'，可保持无几何关联'}。</p>}</fieldset>:<fieldset className="schema-association"><legend>几何关联 · {type?.targetScope}（{type?.association === "required" ? "必须" : "可选"}）</legend><div className="schema-toolbar"><button type="button" disabled={!selectedTarget || selectedTarget.kind !== type?.targetScope} title={selectedTarget?.kind !== type?.targetScope ? `请在视口中选择 ${type?.targetScope}` : "关联当前几何选择"} onClick={() => setTarget(selectedTarget)}>使用当前选择</button><button type="button" disabled={!target || Boolean(instance && instance.state !== "active" && !current.targetEdited)} title={instance?.state !== "active" && !current.targetEdited ? "请先选用一个候选或当前几何" : "定位已验证的关联"} onClick={() => onSelectTarget(target)}>定位并高亮</button>{type?.association === "optional" && <button type="button" onClick={() => setTarget(null)}>取消关联</button>}</div><p className="panel-copy">{target ? `${target.kind} · ${target.bodyId}${target.topologyId ? ` · ${target.topologyId}` : ""}` : "未关联几何，可保持窗口打开并在视口中选择。"}</p></fieldset>)}
      {type?.association === "none" && <p className="panel-copy">工程级实例，不关联几何。</p>}
      {instance && instance.state !== "active" && <section className="property-association-review" aria-label="属性关联待复核" role="status"><strong>{instance.state === "orphaned" ? "关联几何已删除" : "几何关联需要复核"}</strong><p>{instance.stateReason || "属性值已保留，请重新指定几何关联。"}</p><p>修改属性值不会改变原关联；选择新几何并保存后才会重新绑定。</p>{Boolean(instance.association?.candidates.length) && <details><summary>{instance.association!.candidates.length} 个真实血缘候选</summary><div className="association-candidates">{instance.association!.candidates.slice(0,100).map(candidate => <button type="button" key={`${candidate.bodyId}:${candidate.topologyId}`} onClick={() => { if(multiple)addTargets([candidate]);else setTarget(candidate); onSelectTarget(candidate); }}>{candidate.bodyId} · {candidate.topologyId} · {multiple?'定位并加入草稿':'定位并选用'}</button>)}</div>{instance.association!.candidates.length>100 && <p>仅列出前 100 项，其余请在视口中选择。</p>}</details>}</section>}
      {multiple&&instance?.state!=='active'&&Boolean(instance?.association?.candidates.length)&&<button type="button" className="secondary-action" disabled={stale||instance?.association?.candidatesTruncated} onClick={()=>{setTargets(instance!.association!.candidates);onSelectTargets?.(instance!.association!.candidates);}}>用全部已验证候选替换集合（尚未保存）</button>}
      <button className="primary-action" disabled={busy || !type || !stateToken || stale || missing || Boolean(multiple&&type.association==='required'&&!targets.length)}>{busy ? "正在保存…" : editingId ? "保存实例" : "创建实例"}</button>
      </fieldset>
    </form>
    {initialInstanceId === undefined && !initialTypeId && instances.length > 0 && <div className="schema-instance-list"><h3>已有实例</h3>{types.map((item) => <div key={item.typeId}><h4>{item.name}</h4>{instances.filter((record) => record.typeId === item.typeId).map((record) => <button className="schema-instance-card" key={record.instanceId} onClick={() => { setEditingId(record.instanceId); setTypeId(record.typeId); if(record.state==='active'){if(Array.isArray(record.targets))onSelectTargets?.(record.targets);else onSelectTarget(record.target);} }}>{record.name}</button>)}</div>)}</div>}
    {(loadError || (!stale && !missing && error)) && <p className="property-error" role="alert">{loadError || error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}
