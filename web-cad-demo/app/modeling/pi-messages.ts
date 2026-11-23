export const PI_IMAGE_TYPES = ['image/png','image/jpeg','image/gif','image/webp'] as const;
export type PiImage = { type: 'image'; mimeType: typeof PI_IMAGE_TYPES[number]; data: string };
export type PiMessage = { id: string; role: string; content: string; images?: PiImage[]; nativeKey?: string; toolName?: string; toolCallId?: string; status?: string; argumentsText?: string; resultText?: string };
export function piImageType(mimeType: string): mimeType is PiImage['mimeType'] {
  return PI_IMAGE_TYPES.some(type=>type===mimeType);
}
export function piImageUrl(image: PiImage) { return `data:${image.mimeType};base64,${image.data}`; }
export const PI_DETAIL_PAGE_SIZE=24000;
/** Presentation paging only; never truncate the native conversation or copied text. */
export function piDetailPage(content:string,requestedPage:number){
  const pages=Math.max(1,Math.ceil(content.length/PI_DETAIL_PAGE_SIZE)),index=Number.isSafeInteger(requestedPage)?Math.max(0,Math.min(pages-1,requestedPage)):0;
  let start=index*PI_DETAIL_PAGE_SIZE,end=Math.min(content.length,start+PI_DETAIL_PAGE_SIZE);
  const splitsPair=(offset:number)=>offset>0&&offset<content.length&&content.charCodeAt(offset)>=0xdc00&&content.charCodeAt(offset)<=0xdfff&&content.charCodeAt(offset-1)>=0xd800&&content.charCodeAt(offset-1)<=0xdbff;
  if(splitsPair(start))start--;if(splitsPair(end))end--;
  return {index,pages,text:content.slice(start,end)};
}
/** Queries already return observations; mutations require one viewport reconciliation. */
export function piToolNeedsReconcile(name:string):boolean{return Boolean(name)&&!['query_model','measure_geometry','geometry__measure','geometry__check','geometry__relation','body__presentation','property__list','property__type__list','property__instance__list','property__package__export'].includes(name);}
export function piNativeMessageKey(message: Record<string,unknown>): string | undefined {
  if(typeof message.id==='string'&&message.id)return `${message.role}:${message.id}`;
  return typeof message.timestamp==='number'&&Number.isFinite(message.timestamp)?`${message.role}:${message.timestamp}`:undefined;
}

/** Native full messages replace their own presentation parts; deltas are a legacy fallback. */
export function applyNativePiMessage(messages: PiMessage[], event: Record<string,unknown>): PiMessage[] | null {
  const message=event.message&&typeof event.message==='object'?event.message as Record<string,unknown>:null;
  if(!message)return null;
  if(message.role==='toolResult'&&event.type==='message_end')return flattenMessages([message]).reduce((current,item)=>mergeToolMessage(current,item),messages);
  if(message.role!=='assistant')return null;
  const key=piNativeMessageKey(message);if(!key)return null;
  const status=message.stopReason==='aborted'?'interrupted':message.stopReason==='error'?'error':event.type==='message_end'?'done':'streaming';
  const parts=flattenMessages([message]).map(item=>item.role==='tool'?item:{...item,status});
  const callIds=new Set(parts.filter(item=>item.toolCallId).map(item=>item.toolCallId));
  const belongsToMessage=(item:PiMessage)=>item.nativeKey===key||Boolean(item.toolCallId&&callIds.has(item.toolCallId));
  const existing=messages.findIndex(belongsToMessage);
  const preserved=parts.map(item=>{
    const previous=item.toolCallId?messages.find(value=>value.toolCallId===item.toolCallId):undefined;
    if(!previous)return item;
    // Full assistant snapshots can arrive after execution has started. Their
    // toolCall block is not a new call and must not regress the live status.
    return {...mergeToolMessage([previous],{...item,status:previous.status||item.status,resultText:previous.resultText})[0],nativeKey:key};
  });
  if(existing<0)return [...messages,...preserved];
  const before=messages.slice(0,existing),after=messages.slice(existing).filter(item=>!belongsToMessage(item));
  return [...before,...preserved,...after];
}

/** Also explain exit events from an older gateway without losing its diagnostic code. */
export function piRuntimeError(event: Record<string, unknown>): string {
  const detail = typeof event.error === "string" ? event.error : "";
  if (event.type === "runtime_exit" || /Pi RPC process exited/.test(detail)) {
    const diagnostic = detail || `code=${event.code ?? "-"}, signal=${event.signal ?? "-"}`;
    return `Pi 会话进程被终止，可重新连接恢复历史。不会重发上一条建模命令；若建模被中断，请先查询当前工程。\n${diagnostic}`;
  }
  return detail || "Pi 服务连接中断，请重新连接已有会话。";
}

/** Enter commits an IME candidate before it can submit a Chinese modeling request. */
export function shouldSubmitPiMessage(event: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

/** Keep the reader in control while native Pi events continue to stream. */
export function isNearPiConversationEnd(scroll: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean {
  return [scroll.scrollTop, scroll.scrollHeight, scroll.clientHeight].every(Number.isFinite)
    && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 32;
}

export function piThinkingSummary(item: PiMessage): string {
  const excerpt = item.content.slice(0,1024).replace(/\s+/g, " ").trim();
  const status = item.status === "interrupted" ? "已中断" : item.status==='error'?'出错':item.status === "streaming" ? "进行中" : "查看详情";
  return `思考过程 · ${status}${excerpt ? ` · ${excerpt.slice(0, 72)}${excerpt.length > 72 ? "…" : ""}` : ""}`;
}

/** Keep one expandable presentation per native call; never rewrite Pi's conversation. */
export function mergeToolMessage(messages: PiMessage[], incoming: PiMessage): PiMessage[] {
  const index = incoming.toolCallId ? messages.findIndex(item => item.role === "tool" && item.toolCallId === incoming.toolCallId) : -1;
  const previous = index >= 0 ? messages[index] : undefined;
  const item = { ...previous, ...incoming, id: previous?.id || incoming.id,
    argumentsText: incoming.argumentsText ?? previous?.argumentsText,
    resultText: incoming.resultText ?? previous?.resultText };
  item.content = [item.argumentsText !== undefined ? `参数\n${item.argumentsText}` : "", item.resultText !== undefined ? `结果\n${item.resultText}` : ""].filter(Boolean).join("\n\n") || incoming.content;
  if (index < 0) return [...messages, item];
  return messages.map((message, position) => position === index ? item : message);
}

/** Native Pi progress is an accumulated snapshot, not a text delta. */
export function applyPiToolEvent(messages: PiMessage[], event: Record<string, unknown>): PiMessage[] {
  if (!["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(String(event.type))) return messages;
  const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
  if (!toolCallId) return messages;
  const previous = messages.find(item => item.role === "tool" && item.toolCallId === toolCallId);
  // A late progress callback must not turn a completed/error/interrupted call back into a running one.
  if (event.type !== "tool_execution_end" && previous && ["done", "error", "interrupted"].includes(previous.status || "")) return messages;
  const completed = event.type === "tool_execution_end";
  const raw = completed ? event.result : event.partialResult;
  const result = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
  const resultText = raw === undefined ? undefined : contentText(result?.content) || JSON.stringify(raw, null, 2);
  const argumentsText = event.args === undefined ? undefined : JSON.stringify(event.args, null, 2);
  return mergeToolMessage(messages, {
    id: `tool-${toolCallId}`, role: "tool", toolCallId,
    toolName: typeof event.toolName === "string" ? event.toolName : typeof event.name === "string" ? event.name : previous?.toolName,
    content: resultText || argumentsText || "", argumentsText, resultText,
    status: completed ? event.isError || result?.isError ? "error" : "done" : "running",
  });
}

export function piToolSummary(item: PiMessage): string {
  let status = item.status === "running" ? "执行中" : item.status === "interrupted" ? "已中断，结果待核对" : item.status === "error" ? "失败" : item.status === "call" ? "未收到结果" : "完成";
  let detail = "";
  try {
    const text=item.resultText||'null';
    const result = text.length<=65536?JSON.parse(text):null;
    if (result && typeof result === "object") {
      const task=result.modelingTask;
      const bound=task?.version===1&&typeof task.taskId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(task.taskId)&&typeof task.documentId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(task.documentId)&&task.operation===item.toolName?.replaceAll('__','.')&&typeof result.requestId==='string'&&task.requestKey===result.requestId;
      if(!['running','call','interrupted'].includes(item.status||'')&&result.ok===false){
        if(bound&&task.phase==='cancelled'&&task.cancelRequested===true){
          if(result.outcome==='restored'&&task.restored===true)status='已取消，原工程已恢复';
          else if(result.outcome==='not-started'&&task.execution==='not-started')status='已取消，未执行';
        }else if(result.outcome==='unknown')status='结果待核对';
      }
      const id = result.bodyId || result.featureId;
      detail = typeof id === "string" ? id : Number.isInteger(result.bodyCount) ? `${result.bodyCount} 个 Body` : "";
    }
  } catch { /* Free-form native tool output stays available in the expanded details. */ }
  return `${item.toolName || "CAD 工具"} · ${status}${detail ? ` · ${detail.slice(0, 80)}` : ""}`;
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => part && part.type === "text" && typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n");
}

/** Presentation only: the original Pi conversation and tool messages stay untouched. */
export function flattenMessages(value: unknown): PiMessage[] {
  if (!Array.isArray(value)) return [];
  const flattened = value.flatMap((message, index) => {
    const item = message && typeof message === "object" ? message as Record<string, unknown> : {};
    const key=piNativeMessageKey(item);
    const id = String(key || `${item.role}-${index}`);
    if (item.role === "toolResult") { const resultText = contentText(item.content) || JSON.stringify(item.content ?? ""); return [{ id:item.toolCallId?`tool-${item.toolCallId}`:id, role: "tool", toolCallId: String(item.toolCallId || ""), toolName: String(item.toolName || "CAD MCP"), status: item.isError ? "error" : "done", content: resultText, resultText }]; }
    if (item.role === 'user') {
      const images = Array.isArray(item.content) ? item.content.filter((part): part is PiImage => part?.type==='image'&&piImageType(part.mimeType)&&typeof part.data==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(part.data)) : [];
      const original = contentText(item.content);
      const marker = '\n\n用户请求：';
      const content = original.startsWith('当前工程 documentId=') && original.includes(marker) ? original.slice(original.indexOf(marker) + marker.length) : original;
      return [{ id, role: 'user', content, images }];
    }
    if (!Array.isArray(item.content)) return [{ id, role: String(item.role || "assistant"), content: contentText(item.content) }];
    return item.content.flatMap((part, partIndex): PiMessage[] => {
      if (!part || typeof part !== "object") return [];
      const key = `${id}-${partIndex}`;
      const status=item.stopReason==='aborted'?'interrupted':item.stopReason==='error'?'error':undefined;
      if (part.type === "thinking" && typeof part.thinking === "string") return [{ id: key, nativeKey:piNativeMessageKey(item),role: "thinking", content: part.thinking,status }];
      if (part.type === "toolCall") { const argumentsText = JSON.stringify(part.arguments ?? {}, null, 2); return [{ id: typeof part.id==='string'&&part.id?`tool-${part.id}`:key, nativeKey:piNativeMessageKey(item),role: "tool", toolCallId: part.id, toolName: String(part.name || "CAD MCP"), status: "call", content: argumentsText, argumentsText }]; }
      return part.type === "text" && typeof part.text === "string" && part.text ? [{ id: key, nativeKey:piNativeMessageKey(item),role: String(item.role || "assistant"), content: part.text,status }] : [];
    });
  }).filter(item => item.content || item.images?.length);
  return flattened.reduce<PiMessage[]>((messages, item) => item.role === "tool" ? mergeToolMessage(messages, item) : [...messages, item], []);
}
