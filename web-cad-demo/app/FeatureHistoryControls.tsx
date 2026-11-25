"use client";

import { useMemo, useState } from "react";
import type { DirectModelResult } from "./DirectModelingPanel";
import { bodyDisplayName, traceBodyFeatures } from "./model/feature-graph";
import type { FeatureData } from "./ModelMetadataPanels";
import type { ModelingCommandInput } from "./modeling/command-contract";
import {useEditorCommands} from "./modeling/CommandEditScope";
import {FeatureReferenceRepair, failedSelectionTarget} from "./FeatureReferenceRepair";
import {editableNumberEntries} from "./modeling/feature-parameters";
import type {FeatureRepairProposal} from "./modeling/feature-input";
import {LoftModelingPanel,type LoftBodySummary} from "./LoftModelingPanel";
import {SweepModelingPanel} from "./SweepModelingPanel";
import { MissingVariableEditor } from "./workbench/MissingVariableEditor";

type BooleanOperation =
  | "boolean.fuse"
  | "boolean.cut"
  | "boolean.common"
  | "boolean.section"
  | "boolean.split"
  | "boolean.partition"
  | "boolean.fragments"
  | "boolean.imprint";

type BooleanDraft = {
  featureId: string;
  operation: BooleanOperation;
  targets: string[];
  tools: string[];
  refine: boolean;
};

type ScalarVariable = {
  name: string;
  type: "length" | "angle" | "dimensionless" | "integer";
  expression: string;
  value: number;
};

const BOOLEAN_OPERATIONS: { value: BooleanOperation; label: string }[] = [
  { value: "boolean.fuse", label: "Fuse（并集）" },
  { value: "boolean.cut", label: "Cut（差集）" },
  { value: "boolean.common", label: "Common（交集）" },
  { value: "boolean.section", label: "Section（截线）" },
  { value: "boolean.split", label: "Split（分割）" },
  { value: "boolean.partition", label: "Partition（分区）" },
  { value: "boolean.fragments", label: "Fragments（碎片化）" },
  { value: "boolean.imprint", label: "Imprint（压印）" },
];

function ids(value?: string) {
  return (value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function booleanDraftFrom(feature: FeatureData): BooleanDraft {
  return {
    featureId: feature.id,
    operation: feature.type as BooleanOperation,
    targets: ids(feature.stringParameters.targetBodies || feature.stringParameters.targetBody),
    tools: ids(feature.stringParameters.toolBodies || feature.stringParameters.toolBody),
    refine: feature.stringParameters.refine !== "false",
  };
}

function parameterExpression(feature: FeatureData, key: string, value: number) {
  return feature.stringParameters["expr." + key] ?? String(value);
}

function variableTypeForParameter(key: string): ScalarVariable["type"] {
  if (key === "angleDegrees") return "angle";
  if (["sides","count","countX","countY"].includes(key)) return "integer";
  if (key === "factor" || key === "factorX" || key === "factorY" || key === "factorZ"
    || key.startsWith("axis") || key.startsWith("normal") || key.startsWith("neutralNormal") || key.startsWith("direction")) return "dimensionless";
  return "length";
}

function defaultVariableExpression(type: ScalarVariable["type"]) {
  if (type === "length") return "10 mm";
  if (type === "angle") return "10 deg";
  return "1";
}

function normalizeVariableExpression(type: ScalarVariable["type"], expression: string) {
  const value = expression.trim();
  if ((type === "length" || type === "angle") && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    return value + " " + (type === "length" ? "mm" : "deg");
  }
  return value;
}


export function FeatureHistoryControls({
  model,
  bodyId,
  initialFeatureId,
  initialRepair,
  onRepairFinished,
  onModel,
  onConfirmDelete,
}: {
  model: {
    revision: number;
    features: FeatureData[];
    canUndo?: boolean;
    canRedo?: boolean;
    variables?: ScalarVariable[];
    bodyMetadata?:LoftBodySummary[];
  } | null;
  bodyId: string | null;
  initialFeatureId?: string | null;
  initialRepair?: FeatureRepairProposal | null;
  onRepairFinished?: () => void;
  onModel: (result: DirectModelResult) => void;
  onConfirmDelete: (featureId: string, bodyId: string | null, run: () => Promise<void>) => void;
}) {
  const {execute,executeBatch}=useEditorCommands();
  const command=(payload:ModelingCommandInput)=>execute<DirectModelResult>(payload);
  const [selectedId, setSelectedId] = useState("");
  const requestedFeature=selectedId || initialFeatureId;
  const editable = useMemo(
    () => {
      const candidates=bodyId ? traceBodyFeatures(model?.features || [], bodyId) : [];
      // A body-creating feature can temporarily have no live output while
      // suppressed. Keep the explicitly opened feature, never a neighbour.
      const pinned=model?.features.find(feature=>feature.id===requestedFeature);
      if(pinned && !candidates.some(feature=>feature.id===pinned.id))candidates.push(pinned);
      return candidates.filter(
      (feature) => feature.type.startsWith("primitive.")
        || feature.type.startsWith("surface.")
        || feature.type.startsWith("transform.")
        || feature.type.startsWith("boolean.")
        || feature.type === "detail.fillet"
        || feature.type === "detail.chamfer"
        || feature.type === "detail.shell"
        || feature.type === "detail.thicken"
        || feature.type === "detail.offset"
        || feature.type === "detail.draft"
        || feature.type === "detail.revolve"
        || feature.type === "detail.sweep"
        || feature.type === "detail.pipe"
        || feature.type === "detail.loft"
        || feature.type.startsWith("pattern."),
      );
    },
    [bodyId, model?.features, requestedFeature],
  );
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [booleanDraft, setBooleanDraft] = useState<BooleanDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [activeParameterKey, setActiveParameterKey] = useState<string | null>(null);
  const [missingVariable, setMissingVariable] = useState<string | null>(null);
  const [variableType, setVariableType] = useState<ScalarVariable["type"]>("length");
  const [variableExpression, setVariableExpression] = useState("10 mm");
  const [pendingRequest, setPendingRequest] = useState<ModelingCommandInput | null>(null);
  const [repairProposal, setRepairProposal] = useState<FeatureRepairProposal|null>(initialRepair || null);
  const selected = requestedFeature ? editable.find((feature) => feature.id === requestedFeature) : editable[0];
  const selectedBooleanDraft = selected?.type.startsWith("boolean.")
    ? (booleanDraft?.featureId === selected.id ? booleanDraft : booleanDraftFrom(selected))
    : null;
  const selectedBooleanInputIds = selectedBooleanDraft
    ? [...selectedBooleanDraft.targets, ...selectedBooleanDraft.tools]
    : [];

  const selectFeature = (featureId: string) => {
    setRepairProposal(null);
    setSelectedId(featureId);
    const feature = editable.find((item) => item.id === featureId);
    setDraft(feature
      ? Object.fromEntries(editableNumberEntries(feature).map(([key, value]) => [key, parameterExpression(feature, key, value)]))
      : {});
    setBooleanDraft(feature?.type.startsWith("boolean.") ? booleanDraftFrom(feature) : null);
    setMessage(null);
  };

  const assignBooleanRole = (inputBodyId: string, role: "target" | "tool") => {
    if (!selectedBooleanDraft) return;
    const targets = selectedBooleanDraft.targets.filter((id) => id !== inputBodyId);
    const tools = selectedBooleanDraft.tools.filter((id) => id !== inputBodyId);
    if (role === "target") targets.push(inputBodyId);
    else tools.push(inputBodyId);
    setBooleanDraft({ ...selectedBooleanDraft, targets, tools });
  };

  const featureRequest = ():ModelingCommandInput|null => {
    if (!model || !selected) return null;
    const parameters: Record<string, unknown> = selectedBooleanDraft
      ? {
        operationType: selectedBooleanDraft.operation,
        targetBodies: selectedBooleanDraft.targets.join(","),
        toolBodies: selectedBooleanDraft.tools.join(","),
        refine: selectedBooleanDraft.refine,
      }
      : Object.fromEntries(editableNumberEntries(selected).map(([key, value]) => [
        key,
        draft[key] ?? parameterExpression(selected, key, value),
      ]));
    return {
      operation: "feature.update",
      baseRevision: model.revision,
      inputs: { featureId: selected.id },
      parameters,
    };
  };
  const updateFeature = async () => {
    const request=featureRequest();
    if(!request || !selected)return;
    const parameters=request.parameters!;
    setBusy(true);
    setMessage(null);
    try {
      const result = await command(request);
      setDraft({});
      setBooleanDraft(null);
      setPendingRequest(null);
      onModel(result);
      setMessage("已重算 " + selected.id + "，文档版本 R" + result.revision);
    } catch (reason) {
      const failed=failedSelectionTarget(reason);
      if(failed)setRepairProposal({request,...failed});
      const text = reason instanceof Error ? reason.message : "特征重算失败。";
      const match = text.match(/Undefined scalar variable:\s*([A-Za-z_][A-Za-z0-9_]*)/i);
      if (match) {
        const failedParameter = Object.entries(parameters).find(([, value]) =>
          typeof value === "string" && new RegExp("(^|\\W)" + match[1] + "(\\W|$)").test(value)
        )?.[0] || activeParameterKey || "width";
        const nextType = variableTypeForParameter(failedParameter);
        setMissingVariable(match[1]);
        setVariableType(nextType);
        setVariableExpression(defaultVariableExpression(nextType));
        setPendingRequest(request);
      }
      setMessage(text);
    } finally {
      setBusy(false);
    }
  };

  const createMissingVariable = async () => {
    if (!model || !missingVariable || !pendingRequest) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await executeBatch<DirectModelResult>([{
        operation: "variable.set",
        parameters: {
          name: missingVariable,
          type: variableType,
          expression: normalizeVariableExpression(variableType, variableExpression),
        },
      },{...pendingRequest,baseRevision:undefined,baseStateToken:undefined}]);
      setMissingVariable(null);
      setPendingRequest(null);
      setDraft({});
      onModel(result);
      setMessage("已创建变量并重算 Feature，文档版本 R" + result.revision);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "变量创建失败。");
    } finally {
      setBusy(false);
    }
  };

  const insertVariable = (name: string) => {
    if (!selected) return;
    const targetKey = activeParameterKey || editableNumberEntries(selected)[0]?.[0];
    if (!targetKey) return;
    setActiveParameterKey(targetKey);
    setDraft((current) => ({ ...current, [targetKey]: name }));
  };

  const moveHistory = async (direction: "undo" | "redo") => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await command({ operation: `document.${direction}` });
      setDraft({});
      setBooleanDraft(null);
      onModel(result);
      setMessage(`${direction === "undo" ? "撤销" : "重做"}完成，恢复到 R${result.revision}`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "历史操作失败。");
    } finally {
      setBusy(false);
    }
  };

  const lifecycleSupported = Boolean(selected && (
    (selected.type.startsWith("transform.") && selected.type !== "transform.copy")
    || selected.type === "detail.fillet"
    || selected.type === "detail.chamfer"
    || selected.type === "detail.shell"
    || selected.type === "detail.thicken"
    || selected.type === "detail.offset"
    || selected.type === "detail.draft"
    || selected.type === "detail.revolve"
    || selected.type === "detail.sweep"
    || selected.type === "detail.pipe"
    || selected.type === "detail.loft"
    || selected.type.startsWith("pattern.")
    || selected.type.startsWith("boolean.")
  ));

  const changeFeatureLifecycle = async (action: "suppress" | "restore" | "delete") => {
    if (!model || !selected || !lifecycleSupported) return;
    const request:ModelingCommandInput={operation: "feature." + action,baseRevision:model.revision,inputs:{featureId:selected.id}};
    setBusy(true);
    setMessage(null);
    try {
      const result = await command(request);
      if (action === "delete") setSelectedId("");
      setDraft({});
      setBooleanDraft(null);
      onModel(result);
      const actionLabel = action === "suppress" ? "抑制" : action === "restore" ? "恢复" : "删除";
      setMessage("已" + actionLabel + " " + selected.id + "，文档版本 R" + result.revision);
    } catch (reason) {
      const failed=failedSelectionTarget(reason);if(failed)setRepairProposal({request,...failed});
      setMessage(reason instanceof Error ? reason.message : "Feature 生命周期操作失败。");
    } finally {
      setBusy(false);
    }
  };

  const booleanRolesValid = !selectedBooleanDraft
    || (selectedBooleanDraft.targets.length > 0 && selectedBooleanDraft.tools.length > 0);

  return (
    <section className="panel-section feature-editor" data-testid="feature-history-controls">
      <div className="section-heading compact" hidden={Boolean(repairProposal)}>
        <div><span className="eyebrow">PARAMETRIC · {bodyId || "NO BODY"}</span><h2>Body 参数与历史</h2></div>
        <span className="feature-badge">R{model?.revision ?? 0}</span>
      </div>
      <div className="history-actions" hidden={Boolean(repairProposal)}>
        <button disabled={busy || Boolean(repairProposal) || !model?.canUndo} onClick={() => void moveHistory("undo")}>← 撤销</button>
        <button disabled={busy || Boolean(repairProposal) || !model?.canRedo} onClick={() => void moveHistory("redo")}>→ 重做</button>
      </div>
      {repairProposal ? <FeatureReferenceRepair proposal={repairProposal} onCancel={()=>{setRepairProposal(null);onRepairFinished?.();setMessage("已取消临时修复，参数草稿保留；工程未修改。");}} onCommitted={result=>{setRepairProposal(null);onRepairFinished?.();setDraft({});setBooleanDraft(null);setPendingRequest(null);onModel(result);setMessage("参数与引用已一起提交，文档版本 R"+result.revision);}}/> : selected ? (
        <fieldset className="command-edit-fields" disabled={busy}>
          <select className="operation-select" aria-label="可编辑特征" value={selected.id} onChange={(event) => selectFeature(event.target.value)}>
            {editable.map((feature) => <option key={feature.id} value={feature.id}>{feature.id} · {feature.type}</option>)}
          </select>
          {selectedBooleanDraft ? (
            <div className="boolean-feature-editor">
              <label className="boolean-operation-field">
                <span>操作</span>
                <select className="operation-select" aria-label="Boolean 特征操作" value={selectedBooleanDraft.operation} onChange={(event) => setBooleanDraft({ ...selectedBooleanDraft, operation: event.target.value as BooleanOperation })}>
                  {BOOLEAN_OPERATIONS.map((operation) => <option key={operation.value} value={operation.value}>{operation.label}</option>)}
                </select>
              </label>
              <div className="body-role-grid boolean-edit-roles">
                <div>
                  <strong>Target</strong>
                  {selectedBooleanInputIds.map((inputBodyId) => (
                    <label className="body-role" key={`target-${inputBodyId}`}>
                      <input type="radio" name={`role-${inputBodyId}`} aria-label={`${bodyDisplayName(inputBodyId, model?.features || [])} 设为 Target`} checked={selectedBooleanDraft.targets.includes(inputBodyId)} onChange={() => assignBooleanRole(inputBodyId, "target")} />
                      <span>{bodyDisplayName(inputBodyId, model?.features || [])}<small>{inputBodyId}</small></span>
                    </label>
                  ))}
                </div>
                <div>
                  <strong>Tool</strong>
                  {selectedBooleanInputIds.map((inputBodyId) => (
                    <label className="body-role" key={`tool-${inputBodyId}`}>
                      <input type="radio" name={`role-${inputBodyId}`} aria-label={`${bodyDisplayName(inputBodyId, model?.features || [])} 设为 Tool`} checked={selectedBooleanDraft.tools.includes(inputBodyId)} onChange={() => assignBooleanRole(inputBodyId, "tool")} />
                      <span>{bodyDisplayName(inputBodyId, model?.features || [])}<small>{inputBodyId}</small></span>
                    </label>
                  ))}
                </div>
              </div>
              {!booleanRolesValid && <p className="property-error">Target 和 Tool 都至少需要一个输入 Body。</p>}
              <div className="boolean-options boolean-edit-options">
                <label className="check-field"><input type="checkbox" checked={selectedBooleanDraft.refine} onChange={(event) => setBooleanDraft({ ...selectedBooleanDraft, refine: event.target.checked })} />Refine 结果</label>
                <label className="check-field read-only-option"><input type="checkbox" disabled checked={selected.stringParameters.keepTarget === "true"} readOnly />保留 Target（只读）</label>
                <label className="check-field read-only-option"><input type="checkbox" disabled checked={selected.stringParameters.keepTool === "true"} readOnly />保留 Tool（只读）</label>
                <label className="check-field read-only-option"><input type="checkbox" disabled checked={selected.stringParameters.splitResults === "true"} readOnly />拆分结果（只读）</label>
              </div>
              <p className="panel-copy recompute-scope">保留输入体和拆分结果会改变 Body 数量，当前编辑模式中保持只读；可重新创建 Boolean 特征来更改。</p>
            </div>
          ) : selected.type==="detail.loft" ? <LoftModelingPanel key={selected.id} model={model} feature={selected} onModel={onModel}/> : (selected.type==="detail.sweep"||selected.type==="detail.pipe")&&selected.stringParameters.sweepVersion==="2" ? <SweepModelingPanel key={selected.id} kind={selected.type==="detail.pipe"?"pipe":"sweep"} model={model} feature={selected} onModel={onModel} onBusyChange={setBusy}/> : (
            <>
              {(selected.type==="pattern.rectangular" || selected.type==="pattern.mirror") && <p className="panel-copy" aria-label="阵列实例总数">当前实例总数：{selected.numberParameters.count ?? (selected.type==="pattern.mirror" ? 2 : selected.numberParameters.countX*selected.numberParameters.countY)}（{selected.type==="pattern.mirror" ? "镜像固定为原体和一个副本" : "由行数、列数决定"}，只读）</p>}
              <div className="feature-parameter-grid expression-parameter-grid">
                {editableNumberEntries(selected).map(([key, value]) => {
                  const savedExpression = parameterExpression(selected, key, value);
                  const expression = draft[key] ?? savedExpression;
                  const result = String(value);
                  const showResult = expression === savedExpression && savedExpression !== result;
                  return (
                    <label key={key}>
                      <span>{key}</span>
                      <div className="feature-expression-input">
                        <input
                          aria-label={"特征参数 " + key}
                          value={expression}
                          onFocus={() => setActiveParameterKey(key)}
                          onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
                          placeholder="数值、单位或变量表达式"
                        />
                        {showResult && <em title={"已提交的计算值：" + result}>= {result}</em>}
                      </div>
                    </label>
                  );
                })}
              </div>
              <div className="feature-variable-reference">
                <span>工程变量</span>
                {(model?.variables || []).length > 0
                  ? (model?.variables || []).map((variable) => (
                    <button key={variable.name} type="button" title={variable.type + " · " + variable.expression + " = " + variable.value} onClick={() => insertVariable(variable.name)}>
                      {variable.name}<small>= {variable.value}</small>
                    </button>
                  ))
                  : <small>当前工程没有变量</small>}
              </div>
            </>
          )}
          {selected.type!=="detail.loft" && selected.stringParameters.sweepVersion!=="2" && <button className="primary-action" disabled={busy || !booleanRolesValid} onClick={() => void updateFeature()}>修改参数并重算</button>}
          {["detail.fillet","detail.chamfer","detail.shell","detail.thicken","detail.draft","detail.revolve","detail.sweep","detail.pipe"].includes(selected.type) && selected.stringParameters.sweepVersion!=="2" && <button type="button" className="secondary-action" disabled={busy} onClick={()=>{const request=featureRequest();if(request)setRepairProposal({request,targetFeatureId:selected.id});}}>查看 / 更换输入引用</button>}
          <div className="feature-lifecycle-actions">
            <button
              className="secondary-action"
              disabled={busy || !lifecycleSupported}
              title={lifecycleSupported ? "临时跳过此 Feature 并重算下游" : "此类特征暂不支持独立生命周期操作"}
              onClick={() => void changeFeatureLifecycle(selected.state === "suppressed" ? "restore" : "suppress")}
            >{selected.state === "suppressed" ? "恢复 Feature" : "抑制 Feature"}</button>
            <button className="feature-delete-button" disabled={busy || !lifecycleSupported} title={lifecycleSupported ? "删除并重连下游 Feature" : "此类特征暂不支持独立生命周期操作"} onClick={() => onConfirmDelete(selected.id, bodyId, () => changeFeatureLifecycle("delete"))}>删除 Feature</button>
          </div>
          {!lifecycleSupported && <p className="panel-copy feature-lifecycle-hint">基础特征通过 Body 管理；可重放的变换、细节特征、生成几何、阵列和 Boolean 支持独立生命周期操作。</p>}
          {!selectedBooleanDraft && <p className="panel-copy recompute-scope">参数支持数值、单位和标量变量表达式；面/边引用按真实拓扑来源追踪，缺失或歧义需显式修复。</p>}
        </fieldset>
      ) : <section aria-label="重新选择特征"><p className="panel-copy">{requestedFeature?`原特征 ${requestedFeature} 已不存在，不会自动改为编辑其他特征。请明确重新选择。`:"当前 Body 没有可编辑的实体特征。"}</p>{editable.length>0 && <select className="operation-select" aria-label="可编辑特征" value="" onChange={event=>selectFeature(event.target.value)}><option value="">选择要编辑的特征</option>{editable.map(feature=><option key={feature.id} value={feature.id}>{feature.id} · {feature.type}</option>)}</select>}</section>}
      {message && !repairProposal && !missingVariable && <p className="exchange-message">{message}</p>}
      {missingVariable && (
        <MissingVariableEditor name={missingVariable} type={variableType} expression={variableExpression} busy={busy} message={message}
          onType={type => { setVariableType(type); setMessage(null); }}
          onExpression={expression => { setVariableExpression(expression); setMessage(null); }}
          onCancel={() => { setMissingVariable(null); setPendingRequest(null); setMessage(null); }}
          onSubmit={() => void createMissingVariable()} />
      )}
    </section>
  );
}
