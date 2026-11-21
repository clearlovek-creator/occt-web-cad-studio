"use client";

import { useEffect, useMemo, useState } from "react";
import { modelingController } from "./modeling/runtime";
import { useModelingController } from "./modeling/modeling-controller";
import type { AgentProviderInput } from "./modeling/modeling-controller";

type Form = { id: string; name: string; baseUrl: string; apiKey: string; model: string; protocol: "auto" | "responses" | "chat-completions"; priority: number; toolCalling: boolean; enabled: boolean };
const emptyForm: Form = { id: "openai-main", name: "OpenAI Compatible", baseUrl: "https://api.openai.com", apiKey: "", model: "gpt-5.2", protocol: "auto", priority: 0, toolCalling: true, enabled: true };

export function AgentProviderSettingsPanel() {
  const state = useModelingController(modelingController);
  const [form, setForm] = useState<Form>(emptyForm);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = useMemo(() => state.agentProviders.find((item) => item.id === form.id), [form.id, state.agentProviders]);

  useEffect(() => { void modelingController.loadAgentProviders().catch(() => undefined); }, []);

  const update = (key: keyof Form, value: string | boolean | number) => setForm((current) => ({ ...current, [key]: value } as Form));
  const selectProvider = (id: string) => { const item = state.agentProviders.find((candidate) => candidate.id === id); if (item) setForm({ id: item.id, name: item.name, baseUrl: item.baseUrl, apiKey: "", model: item.model, protocol: item.protocol, priority: item.priority || 0, toolCalling: item.toolCalling === true, enabled: item.enabled }); else setForm(emptyForm); };
  const save = async () => {
    setError(null); setMessage(null);
    try {
      const input: AgentProviderInput = { ...form, ...(form.apiKey ? { apiKey: form.apiKey } : {}) };
      await modelingController.saveAgentProvider(input);
      setForm((current) => ({ ...current, apiKey: "" }));
      setMessage("Provider 配置已保存，API Key 已加密存储。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Provider 保存失败。"); }
  };
  const test = async () => {
    setError(null); setMessage(null);
    try { await modelingController.testAgentProvider(form.id); setMessage("连接测试成功。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "连接测试失败。"); }
  };
  const remove = async () => {
    setError(null); setMessage(null);
    try { await modelingController.deleteAgentProvider(form.id); setForm(emptyForm); setMessage("Provider 已删除。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Provider 删除失败。"); }
  };

  return <section className="panel-section" data-testid="agent-provider-settings">
    <div className="section-heading compact"><div><span className="eyebrow">AGENT PROVIDER</span><h2>大模型服务设置</h2></div><span className="feature-badge amber">LLM</span></div>
    <p className="panel-copy">支持 OpenAI Responses API 和 Chat Completions 兼容服务。API Key 只提交到 Gateway，界面不会回显完整密钥。</p>
    <label className="single-field"><span>配置</span><select className="operation-select" value={form.id} onChange={(event) => selectProvider(event.target.value)}><option value={emptyForm.id}>新建 Provider</option>{state.agentProviders.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></label>
    <label className="single-field"><span>ID</span><input value={form.id} onChange={(event) => update("id", event.target.value)} /></label>
    <label className="single-field"><span>名称</span><input value={form.name} onChange={(event) => update("name", event.target.value)} /></label>
    <label className="single-field"><span>Base URL</span><input value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.openai.com" /></label>
    <label className="single-field"><span>API Key</span><input type="password" value={form.apiKey} onChange={(event) => update("apiKey", event.target.value)} placeholder={selected?.apiKeyConfigured ? "已配置，留空保持不变" : "sk-..."} autoComplete="new-password" /></label>
    <label className="single-field"><span>模型</span><input value={form.model} onChange={(event) => update("model", event.target.value)} placeholder="gpt-5.2" /></label>
    <label className="single-field"><span>协议</span><select className="operation-select" value={form.protocol} onChange={(event) => update("protocol", event.target.value)}><option value="auto">自动回退</option><option value="responses">Responses API</option><option value="chat-completions">Chat Completions</option></select></label>
    <label className="single-field"><span>路由优先级</span><input type="number" min="0" max="100" value={form.priority} onChange={(event) => update("priority", Number(event.target.value))} /></label>\n <div className="provider-tool-note">CAD Tool Calling：强制启用。Agent 只能通过已声明的 CAD 工具与 Web Studio 交互。</div>
    <div className="exchange-actions"><button className="secondary-action" onClick={() => void save()} disabled={state.agentProviderBusy}>保存</button><button className="secondary-action" onClick={() => void test()} disabled={state.agentProviderBusy || !selected}>测试连接</button></div>
    {selected && <button className="secondary-action" onClick={() => void remove()} disabled={state.agentProviderBusy}>删除当前 Provider</button>}
    {(message || error || state.agentProviderError) && <p className={error || state.agentProviderError ? "property-error" : "exchange-message"}>{error || state.agentProviderError || message}</p>}
  </section>;
}
