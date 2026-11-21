/** Read-only preflight. The gateway repeats it under its workspace barriers. */
export async function assertPiWorkspaceIdle(apiRoot:string,fetchImpl:typeof fetch,documentId:string){
  const response=await fetchImpl(`${apiRoot}/pi/documents/${encodeURIComponent(documentId)}/activity`,{signal:AbortSignal.timeout(7000),cache:'no-store'});
  const body=await response.text();
  if(body.length>65536)throw new Error('Pi 工程状态超出核对预算，未开始工程切换。');
  let value;try{value=JSON.parse(body);}catch{throw new Error('Pi 工程状态暂不可读，未开始工程切换。');}
  const activity=value?.activity;
  if(!response.ok||value?.ok!==true||value.protocolVersion!==1||value.documentId!==documentId||activity?.version!==1||activity.documentId!==documentId||!['idle','busy','unknown'].includes(activity.status)||typeof activity.guarded!=='boolean'||typeof activity.checkedAt!=='string'||!Number.isFinite(Date.parse(activity.checkedAt))||!Array.isArray(activity.sessions)||activity.sessions.length>32)throw new Error('Pi 工程状态未确认，未开始工程切换。');
  const identities=new Set<string>();
  for(const row of activity.sessions){
    if(!row||typeof row.sessionId!=='string'||!row.sessionId||row.sessionId.length>160||identities.has(row.sessionId)||!['idle','busy','unknown'].includes(row.status))throw new Error('Pi 会话状态不符合协议，未开始工程切换。');
    identities.add(row.sessionId);
    if(row.status==='idle'&&(typeof row.streamId!=='string'||!row.streamId||row.isStreaming!==false||row.isCompacting!==false||row.pendingMessageCount!==0))throw new Error('Pi 会话空闲状态未确认，未开始工程切换。');
  }
  if(activity.guarded||activity.status!=='idle'||activity.sessions.some((row:{status:string})=>row.status!=='idle'))throw new Error('AI 助手仍在运行或状态尚未确认，请先等待或核对相关会话，再切换工程。');
}
