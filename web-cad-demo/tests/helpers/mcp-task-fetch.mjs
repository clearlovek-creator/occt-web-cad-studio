import {randomUUID} from 'node:crypto';
// Existing catalog/selection tests isolate command payloads. Task transport and
// cancellation have separate strict protocol and real native integration tests.
export function withMcpTaskReservations(fetchImpl) {
  let input,task;
  return async(url,init)=>{
    if(url.endsWith('/modeling-tasks')) {
      input=JSON.parse(init.body).command;
      const now=new Date().toISOString();
      task={version:1,taskId:randomUUID(),documentId:input.documentId,operation:input.operation,requestKey:input.requestId,phase:'reserved',sequence:1,createdAt:now,updatedAt:now,cancelRequested:false,cancellable:true,reportDurable:true};
      return new Response(JSON.stringify({ok:true,documentId:input.documentId,modelingTask:task}),{status:201});
    }
    const response=await fetchImpl(url,init);
    if(url.endsWith('/commands')&&init?.headers?.['X-Cad-Task-Id']) {
      const value=await response.json();
      const revision=value.revision??1,stateToken=value.stateToken??'a'.repeat(64);
      return new Response(JSON.stringify({...value,revision,stateToken,documentId:input.documentId,requestId:input.requestId,modelingTask:{...task,revision,stateToken,phase:value.ok?'succeeded':'failed',sequence:2,cancellable:false}}),{status:response.status});
    }
    return response;
  };
}
