/** Explicit HTTP fixtures for unit tests; real admission is qualified separately. */
export function idleWorkspaceResponse(url){
  const id=decodeURIComponent(new URL(url,'http://localhost').pathname.split('/').at(-2));
  return new Response(JSON.stringify({ok:true,protocolVersion:1,documentId:id,activity:{version:1,documentId:id,status:'idle',guarded:false,checkedAt:new Date().toISOString(),sessions:[]}}),{headers:{'Content-Type':'application/json'}});
}
export function activatedWorkspaceResponse(value,init){
  const command=JSON.parse(init.body).command;
  return new Response(JSON.stringify({...value,workspaceActivation:command}),{headers:{'Content-Type':'application/json'}});
}
