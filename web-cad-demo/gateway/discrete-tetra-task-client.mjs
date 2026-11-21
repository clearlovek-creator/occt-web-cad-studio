/** One task owns both exact single-job clients. Closing between stages fences
 * the next stage instead of creating a replacement process after cancellation. */
export class DiscreteTetraTaskClient{
  constructor({partitionClient,tetraClient,checkpointClient}){Object.assign(this,{partitionClient,tetraClient,checkpointClient,closed:false});}
  get children(){return new Set([...(this.partitionClient.children||[]),...(this.tetraClient.children||[]),...(this.checkpointClient?.children||[])]);}
  partition(input,options){if(this.closed)throw Object.assign(Error('离散体网格任务已停止。'),{code:'MESH_SERVICE_CLOSED'});return this.partitionClient.partition(input,options);}
  partitionConstrained(input,options){if(this.closed)throw Object.assign(Error('离散体网格任务已停止。'),{code:'MESH_SERVICE_CLOSED'});return this.partitionClient.partitionConstrained(input,options);}
  tetrahedralize(input,options){if(this.closed)throw Object.assign(Error('离散体网格任务已停止，未开始下一阶段。'),{code:'MESH_SERVICE_CLOSED'});return this.tetraClient.tetrahedralize(input,options);}
  tetrahedralizePatched(input,options){if(this.closed)throw Object.assign(Error('离散体网格任务已停止，未开始下一阶段。'),{code:'MESH_SERVICE_CLOSED'});return this.tetraClient.tetrahedralizePatched(input,options);}
  createCheckpoint(input,options){if(this.closed)throw Object.assign(Error('离散体网格任务已停止，未开始生成。'),{code:'MESH_SERVICE_CLOSED'});return this.checkpointClient.createCheckpoint(input,options);}
  optimizeCheckpoint(input,options){if(this.closed)throw Object.assign(Error('离散体网格任务已停止，未开始优化。'),{code:'MESH_SERVICE_CLOSED'});return this.checkpointClient.optimizeCheckpoint(input,options);}
  createPatchedCheckpoint(input,options){if(this.closed)throw Object.assign(Error('离散体网格任务已停止，未开始生成。'),{code:'MESH_SERVICE_CLOSED'});return this.checkpointClient.createPatchedCheckpoint(input,options);}
  optimizePatchedCheckpoint(input,options){if(this.closed)throw Object.assign(Error('离散体网格任务已停止，未开始优化。'),{code:'MESH_SERVICE_CLOSED'});return this.checkpointClient.optimizePatchedCheckpoint(input,options);}
  resourceStatus(){return {basis:'owned-partition-tetra-clients-v1',closed:this.closed,liveProcesses:this.children.size,partition:this.partitionClient.resourceStatus?.(),tetra:this.tetraClient.resourceStatus?.(),...(this.checkpointClient?{checkpoint:this.checkpointClient.resourceStatus?.()}: {})};}
  async closeAndWait(){this.closed=true;const results=await Promise.allSettled([this.partitionClient.closeAndWait(),this.tetraClient.closeAndWait(),this.checkpointClient?.closeAndWait()]);for(const result of results)if(result.status==='rejected')throw result.reason;}
  dispose(){return this.closeAndWait();}
}
