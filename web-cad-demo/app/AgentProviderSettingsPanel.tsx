"use client";

import { useEffect, useState } from "react";
import { modelingController } from "./modeling/runtime";
import { useModelingController } from "./modeling/modeling-controller";
import type { AgentProviderSummary } from "./modeling/modeling-controller";
import { WorkbenchDialog } from "./workbench/WorkbenchDialog";

type Form = Omit<AgentProviderSummary, 'apiKeyConfigured'> & { apiKey: string };
export type PiModelConfiguration = { id: string; provider: string; baseUrl?: string; api?: string; input?: string[] };
type Props = { activeModel?: PiModelConfiguration; disabled?: boolean; onApply?: (providerId: string) => Promise<void> };
const emptyForm: Form = { id: "", name: "", baseUrl: "", apiKey: "", model: "", protocol: "auto", priority: 0, enabled: true, supportsImages: false };

export function AgentProviderSettingsPanel({activeModel, disabled, onApply}: Props) {
  const state = useModelingController(modelingController);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Form | null>(null);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<AgentProviderSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const selected = state.agentProviders.find(item => item.id === (providerId ?? activeModel?.provider));
  const modelForm: Form = activeModel && providerId === null ? {
    ...emptyForm, name: activeModel.provider, baseUrl: activeModel.baseUrl ?? '', model: activeModel.id,
    protocol: activeModel.api === 'openai-responses' ? 'responses' : activeModel.api === 'openai-completions' ? 'chat-completions' : 'auto',
    supportsImages: activeModel.input?.includes('image') ?? false,
  } : emptyForm;
  const form = draft ?? (selected ? { ...selected, apiKey: '' } : modelForm);
  const busy = state.agentProviderBusy || applying || disabled;

  useEffect(() => { void modelingController.loadAgentProviders().catch(() => undefined); }, []);

  const update = <K extends keyof Form>(key: K, value: Form[K]) => setDraft(current => ({ ...(current ?? form), [key]: value }));
  const save = async () => {
    setError(null); setMessage(null);
    setApplying(true);
    try {
      const saved = await modelingController.saveAgentProvider(form);
      setProviderId(saved.id); setDraft(null);
      if(onApply){
        try { await onApply(saved.id); }
        catch(reason){ throw new Error(`配置已保存，应用失败。${reason instanceof Error?reason.message:''}`); }
      }
      setMessage(onApply ? '配置已保存并应用到当前会话。' : '配置已保存。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Provider 保存失败。"); }
    finally { setApplying(false); }
  };
  const test = async () => {
    setError(null); setMessage(null);
    try { await modelingController.testAgentProvider(form.id); setMessage("连接测试成功。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "连接测试失败。"); }
  };
  const remove = async () => {
    if (!deleteCandidate || busy || selected?.id !== deleteCandidate.id) return;
    setError(null); setMessage(null);
    setDeleteError(null); setApplying(true);
    try {
      await modelingController.deleteAgentProvider(deleteCandidate.id);
      setDeleteCandidate(null); setProviderId(''); setDraft(null); setMessage("模型服务配置已删除。");
    }
    catch (reason) { setDeleteError(reason instanceof Error ? reason.message : "模型服务配置删除失败。"); }
    finally { setApplying(false); }
  };

  return <section className="panel-section" data-testid="agent-provider-settings">
    <div className="section-heading compact"><h2>大模型设置</h2></div>
    {onApply && <p className="panel-copy" aria-label="当前使用的模型">{activeModel?`${activeModel.provider} / ${activeModel.id}${activeModel.input?.includes('image')?' · 支持图片':''}`:'当前会话尚未选择模型。'}</p>}
    <fieldset className="command-edit-fields" disabled={Boolean(busy)}>
    <label className="single-field"><span>配置</span><select className="operation-select" value={selected?.id ?? ''} onChange={(event) => {setProviderId(event.target.value);setDraft(null);setMessage(null);setError(null);}}><option value="">新建配置</option>{state.agentProviders.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></label>
    <label className="single-field"><span>ID</span><input value={form.id} readOnly={Boolean(selected)} placeholder="留空自动生成" onChange={(event) => update("id", event.target.value)} /></label>
    <label className="single-field"><span>名称</span><input value={form.name} onChange={(event) => update("name", event.target.value)} /></label>
    <label className="single-field"><span>Base URL</span><input value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.openai.com" /></label>
    <label className="single-field"><span>API Key</span><input type="password" value={form.apiKey} onChange={(event) => update("apiKey", event.target.value)} placeholder={selected?.apiKeyConfigured ? "已配置，留空保持不变" : "sk-..."} autoComplete="new-password" /></label>
    <label className="single-field"><span>模型</span><input value={form.model} onChange={(event) => update("model", event.target.value)} placeholder="gpt-5.2" /></label>
    <label className="single-field"><span>协议</span><select className="operation-select" value={form.protocol} onChange={(event) => update("protocol", event.target.value as Form['protocol'])}><option value="auto">自动（Pi 使用 Chat Completions）</option><option value="responses">Responses API</option><option value="chat-completions">Chat Completions</option></select></label>
    <label className="single-field"><span>路由优先级</span><input type="number" min="0" max="100" value={form.priority ?? 0} onChange={(event) => update("priority", Number(event.target.value))} /></label>
    <label className="inline-check"><input type="checkbox" checked={form.supportsImages === true} onChange={event=>update('supportsImages',event.target.checked)} />模型支持图片输入</label>
    <div className="exchange-actions"><button className="secondary-action" onClick={() => void save()} disabled={!form.model.trim()||!form.baseUrl.trim()}>{onApply?'保存并应用':'保存'}</button><button className="secondary-action" onClick={() => void test()} disabled={!selected || Boolean(draft)}>测试连接</button></div>
    {selected && !onApply && <button type="button" className="secondary-action" onClick={() => { setDeleteError(null); setDeleteCandidate(selected); }}>删除当前配置</button>}
    </fieldset>
    {(message || error || state.agentProviderError) && <p role={error || state.agentProviderError ? "alert" : "status"} className={error || state.agentProviderError ? "property-error" : "exchange-message"}>{error || state.agentProviderError || message}</p>}
    {deleteCandidate && <WorkbenchDialog title="删除模型服务配置" busy={Boolean(busy)} onCancel={() => setDeleteCandidate(null)} actions={<>
      <button type="button" data-initial-focus onClick={() => setDeleteCandidate(null)}>取消</button>
      <button type="button" className="feature-delete-confirm" disabled={selected?.id !== deleteCandidate.id} onClick={() => void remove()}>确认删除配置</button>
    </>}>
      <p><strong>{deleteCandidate.name || deleteCandidate.id}</strong> · {deleteCandidate.model}</p>
      <p>将删除此平台保存的服务配置，不会删除工程或历史对话。</p>
      {draft && <p>当前配置中未保存的修改也会丢失。</p>}
      {deleteError && <p role="alert" className="property-error">{deleteError}</p>}
    </WorkbenchDialog>}
  </section>;
}
