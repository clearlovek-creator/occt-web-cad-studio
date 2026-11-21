/* Test-only native reply/exit gates and request admission observations. No production testing endpoint. */
import readline from 'node:readline';
import childProcess from 'node:child_process';
import workerThreads from 'node:worker_threads';
import http from 'node:http';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {selectBackendRelease} from '../../gateway/backend-release.mjs';
import {validateNativeRuntime} from '../../gateway/native-runtime-release.mjs';
import {selectNativeTestRuntime,assertNativeTestRoles} from '../../scripts/test-native-runtime.mjs';
const workspace=path.resolve(import.meta.dirname,'../..');
let meshCompletionExit=false,meshCompletionDenied=false,meshRecoveryArmed=false,releaseMeshRecovery;
let surfaceArmed=false,surfaceExitHeld=false,surfaceChild,heldSurface;
let volumeArmed=false,discreteTetraArmed=false,heldDiscreteTetra,checkpointOptimizerArmed=false,heldCheckpointOptimizer;
let validationGate=null;
const validationControls=new Set();
let projectionArmed=false,derivedPublicationDenied=false;
const projectionControls=new Set();
const recordRename=fs.renameSync;
fs.renameSync=function(source,target){const managed=String(target).startsWith(path.join(path.resolve(process.env.GEOMETRY_DATA_DIR),'mesh-jobs')+path.sep),completion=path.basename(String(target))==='completion.json'&&managed;if(derivedPublicationDenied&&managed&&path.basename(String(target))==='derived-mesh')throw Object.assign(Error('Private derived publication denied'),{code:'EPERM'});if(completion&&meshCompletionDenied){process.stdout.write(JSON.stringify({type:'fixture.mesh-completion-denied'})+'\n');throw Object.assign(Error('Private completion publication denied'),{code:'EPERM'});}const result=recordRename(source,target);if(meshCompletionExit&&completion){process.stdout.write(JSON.stringify({type:'fixture.mesh-completion-published-exit'})+'\n');process.exit(88);}return result;};
const frozenBackend=process.env.CAD_TEST_GATEWAY_RELEASE_ROOT?selectBackendRelease(path.resolve(process.env.CAD_TEST_GATEWAY_RELEASE_ROOT),process.env.CAD_TEST_GATEWAY_RELEASE_ID):null;
if(frozenBackend)assertNativeTestRoles(selectNativeTestRuntime(workspace).manifest,validateNativeRuntime(path.join(frozenBackend.directory,'native'),frozenBackend.native).roles);
const {StepImportStore}=await import(pathToFileURL(path.join(frozenBackend?path.join(frozenBackend.directory,'runtime'):workspace,'gateway/step-import-store.mjs')).href);
const {ModelingTaskService}=await import(pathToFileURL(path.join(frozenBackend?path.join(frozenBackend.directory,'runtime'):workspace,'gateway/modeling-task-service.mjs')).href);
const {ProjectFileService}=await import(pathToFileURL(path.join(frozenBackend?path.join(frozenBackend.directory,'runtime'):workspace,'gateway/project-file-service.mjs')).href);
const {PersistentHistoryStore}=await import(pathToFileURL(path.join(frozenBackend?path.join(frozenBackend.directory,'runtime'):workspace,'gateway/history-store.mjs')).href);
const {ProjectMeshService}=await import(pathToFileURL(path.join(frozenBackend?path.join(frozenBackend.directory,'runtime'):workspace,'gateway/project-mesh-service.mjs')).href);
const {MeshArtifactPool}=await import(pathToFileURL(path.join(frozenBackend?path.join(frozenBackend.directory,'runtime'):workspace,'gateway/mesh-artifact-pool.mjs')).href);
const artifactExecute=MeshArtifactPool.prototype.execute;
MeshArtifactPool.prototype.execute=function(options){const previous=this.timeoutMs;if(validationGate?.timeout&&options.operation==='validate-discrete-native'&&options.result?.phase===validationGate.phase&&options.result?.operation===validationGate.operation)this.timeoutMs=1500;try{return artifactExecute.call(this,options);}finally{this.timeoutMs=previous;}};
const RealWorker=workerThreads.Worker;
workerThreads.Worker=class extends RealWorker{
  constructor(url,options){
    const packet=options?.workerData?.operation==='validate-discrete-native'?options.workerData.result:null;
    const holding=packet&&validationGate&&packet.phase===validationGate.phase&&packet.operation===validationGate.operation,control=holding?new Int32Array(new SharedArrayBuffer(8)):null;
    if(holding){validationGate=null;validationControls.add(control);}
    const projection=options?.workerData?.operation==='derive-tetra-mesh'&&projectionArmed,projectionControl=projection?new Int32Array(new SharedArrayBuffer(8)):null;
    if(projection){projectionArmed=false;projectionControls.add(projectionControl);}
    super(holding?new URL('./held-discrete-validation-thread.mjs',import.meta.url):projection?new URL('./held-discrete-projection-thread.mjs',import.meta.url):url,holding?{...options,workerData:{...options.workerData,validationFixtureTarget:url.href,validationFixtureControl:control.buffer}}:projection?{...options,workerData:{...options.workerData,projectionFixtureTarget:url.href,projectionControl:projectionControl.buffer}}:options);
    if(packet){const threadId=this.threadId;event('discrete-validation-start',{threadId,phase:packet.phase,operation:packet.operation});if(holding)this.once('message',reply=>{if(reply.ok)event('discrete-validation-held',{threadId,phase:packet.phase,operation:packet.operation});});this.once('exit',code=>{if(control)validationControls.delete(control);event('discrete-validation-exit',{threadId,phase:packet.phase,operation:packet.operation,code});});}
    if(projection){const threadId=this.threadId;this.once('message',reply=>{if(reply.ok)event('derived-mesh-held',{threadId});});this.once('exit',code=>{projectionControls.delete(projectionControl);event('derived-mesh-exit',{threadId,code});});}
  }
};
if(ProjectMeshService.prototype.performCompletionRecovery){const recover=ProjectMeshService.prototype.performCompletionRecovery;ProjectMeshService.prototype.performCompletionRecovery=async function(...args){if(meshRecoveryArmed){meshRecoveryArmed=false;event('mesh-recovery-held');await new Promise(resolve=>releaseMeshRecovery=resolve);}return recover.apply(this,args);};}
const backupModule=path.join(frozenBackend?path.join(frozenBackend.directory,'runtime'):workspace,'gateway/project-backup-store.mjs');
const ProjectBackupStore=fs.existsSync(backupModule)?(await import(pathToFileURL(backupModule).href)).ProjectBackupStore:null;
const maintenanceModule=path.join(frozenBackend?path.join(frozenBackend.directory,'runtime'):workspace,'gateway/project-backup-maintenance.mjs');
const ProjectBackupMaintenance=fs.existsSync(maintenanceModule)?(await import(pathToFileURL(maintenanceModule).href)).ProjectBackupMaintenance:null;
let maintenanceIsolationArmed=false,releaseMaintenanceIsolation;
if(ProjectBackupMaintenance){const remaining=ProjectBackupMaintenance.prototype.remaining;ProjectBackupMaintenance.prototype.remaining=async function(...args){const files=await remaining.call(this,...args);if(maintenanceIsolationArmed){maintenanceIsolationArmed=false;event('maintenance-isolated-held',{reviewId:args[0].reviewId});await new Promise(resolve=>releaseMaintenanceIsolation=resolve);}return files;};}
let geometryArmed=false,workspaceViewArmed=false,geometryCorruptAfterReply=false,geometryExitHeld=false,geometryChild,stepArmed=false,stepReportFailure=false,stepCommitReportFailure=false,stepReportExit=false,meshArmed=false,meshExitHeld=false,heldGeometry,meshChild;
let taskCommitArmed=false;
let projectCreateArmed=false;
let projectSaveArmed=false,savePublishHeld=false,releaseSavePublish,saveTerminalExit=false;
if(ProjectBackupStore){const publish=ProjectBackupStore.prototype.publish;ProjectBackupStore.prototype.publish=async function(...args){if(savePublishHeld){savePublishHeld=false;event('save-publish-held');await new Promise(resolve=>releaseSavePublish=resolve);}const result=await publish.call(this,...args);if(saveTerminalExit){event('save-published-exit');process.exit(88);}return result;};}
let projectOpenArmed=false;
let projectOpenPublishedExit=false,projectOpenTerminalExit=false,projectCreatePublishedExit=false;
const projectHistoryCommit=PersistentHistoryStore.prototype.commit;
PersistentHistoryStore.prototype.commit=function(documentId,history,...options){const result=projectHistoryCommit.call(this,documentId,history,...options);if(projectOpenPublishedExit&&history.events?.at(-1)?.operation==='project.open'){event('project-open-published-exit');process.exit(88);}if(projectCreatePublishedExit&&history.events?.at(-1)?.operation==='document.create'){event('project-create-published-exit');process.exit(88);}return result;};
const projectFinishFiles=ProjectFileService.prototype.finishFiles;
ProjectFileService.prototype.finishFiles=function(documentId,journal){if(projectOpenTerminalExit&&journal.phase==='committed'){event('project-open-terminal-exit');process.exit(88);}return projectFinishFiles.call(this,documentId,journal);};
let taskTerminalExit=false,stepTaskTerminalExit=false;
const event=(type,extra={})=>process.stdout.write(JSON.stringify({type:'fixture.'+type,...extra})+'\n');
const taskUpdate=ModelingTaskService.prototype.update;
ModelingTaskService.prototype.update=function(taskId,phase,...args){const operation=this.records.get(taskId)?.operation;if(phase==='succeeded'&&(taskTerminalExit&&['project.batch','project.create'].includes(operation)||stepTaskTerminalExit&&operation==='step.import')){event('task-terminal-exit');process.exit(88);}return taskUpdate.call(this,taskId,phase,...args);};
const persist=StepImportStore.prototype.persist;
StepImportStore.prototype.persist=function(record){
  if(record.phase==='complete'&&stepReportExit){event('step-committed-exit');process.exit(89);}
  if(record.phase==='complete'&&stepReportFailure){stepReportFailure=false;event('step-report-failed');throw Error('test-only report persistence failure');}
  if(record.phase==='committing'&&stepCommitReportFailure){stepCommitReportFailure=false;event('step-commit-report-failed');throw Error('test-only precommit report failure');}
  const result=persist.call(this,record);event('step-phase',{requestId:record.requestId,phase:record.phase});return result;
};
const createServer=http.createServer;
http.createServer=function(listener){return createServer(function(request,response){event('request-admitted',{path:new URL(request.url,'http://test').pathname});return listener(request,response);});};
const spawn=childProcess.spawn;
const resourceDeclarationFixture=process.env.CAD_TEST_RESOURCE_DECLARATION;
const nativeRequestEvents=process.env.CAD_TEST_NATIVE_REQUEST_EVENTS==='1';
childProcess.spawn=function(file,args,options){
  const child=spawn(file,args,options),geometry=String(file).endsWith('occt_geometry_worker.exe'),mesh=String(file).endsWith('gmsh_mesh_worker.exe');
  if(String(file).endsWith('cad_discrete_surface_worker.exe')){
    event('surface-start',{pid:child.pid});const write=child.stdin.write.bind(child.stdin),kill=child.kill.bind(child);
    child.stdin.write=function(bytes,...rest){let request;try{request=JSON.parse(String(bytes));}catch{}if(request?.operation==='surface.refine'&&surfaceArmed){surfaceArmed=false;heldSurface=()=>write(bytes,...rest);event('surface-held',{pid:child.pid});return true;}if(request?.operation==='volume.partition'&&volumeArmed){volumeArmed=false;heldSurface=()=>write(bytes,...rest);event('volume-held',{pid:child.pid});return true;}return write(bytes,...rest);};
    child.kill=function(...signals){if(surfaceExitHeld){surfaceChild={child,kill,signals};event('surface-exit-held',{pid:child.pid});return true;}return kill(...signals);};
    child.once('exit',()=>event('surface-exit',{pid:child.pid}));return child;
  }
  if(!geometry&&!mesh)return child;
  event(geometry?'geometry-start':'mesh-start',{pid:child.pid});
  const requests=new Map(),write=child.stdin.write.bind(child.stdin);
  child.stdin.write=function(bytes,...rest){try{const request=JSON.parse(String(bytes));requests.set(request.requestId,request.operation);if(geometry&&(resourceDeclarationFixture||nativeRequestEvents))event('native-request',{pid:child.pid,operation:request.operation,documentId:request.documentId??null});if(mesh&&nativeRequestEvents)event('mesh-native-request',{pid:child.pid,operation:request.operation});if(mesh&&['mesh.discrete-optimize','mesh.discrete-patched-optimize'].includes(request.operation)&&checkpointOptimizerArmed){checkpointOptimizerArmed=false;heldCheckpointOptimizer={child,release:()=>write(bytes,...rest)};event('checkpoint-optimizer-held',{pid:child.pid});return true;}if(mesh&&request.operation==='mesh.discrete-tetra'&&discreteTetraArmed){discreteTetraArmed=false;heldDiscreteTetra=()=>write(bytes,...rest);event('discrete-tetra-held',{pid:child.pid});return true;}}catch{}return write(bytes,...rest);};
  const emit=child.stdout.emit;let buffer='';
  child.stdout.emit=function(name,chunk,...rest){
    if(name!=='data')return emit.call(this,name,chunk,...rest);
    buffer+=String(chunk);let at;
    while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at+1);buffer=buffer.slice(at+1);let response;try{response=JSON.parse(line);}catch{}
      const operation=requests.get(response?.requestId);
      if(geometry&&resourceDeclarationFixture&&operation==='health.ping'&&response?.ok){if(resourceDeclarationFixture==='missing')delete response.capabilities.processResources;else if(resourceDeclarationFixture==='mismatch')response.capabilities.processResources.jobLimitBytes++;else if(resourceDeclarationFixture==='loft-legacy'){delete response.capabilities.loftThroughHoles;delete response.capabilities.faceBoundaryLoops;}emit.call(child.stdout,'data',JSON.stringify(response)+'\n');}
      else if(geometry&&geometryCorruptAfterReply&&operation==='primitive.box'&&response?.ok){geometryCorruptAfterReply=false;event('geometry-result-then-fault',{pid:child.pid,bodyCount:response.bodyCount});emit.call(child.stdout,'data',line+'{"ok":true,"protocolVersion":1,"requestId":"unowned-late-frame"}\n');}
      else if(geometry&&workspaceViewArmed&&operation==='document.view'&&response?.ok){workspaceViewArmed=false;heldGeometry=()=>emit.call(child.stdout,'data',line);event('workspace-view-held',{pid:child.pid,documentId:response.documentId});}
      else if(geometry&&projectCreateArmed&&operation==='document.create'&&response?.ok){projectCreateArmed=false;heldGeometry=()=>emit.call(child.stdout,'data',line);event('project-create-held',{pid:child.pid,documentId:response.documentId,bodyCount:response.bodyCount});}
      else if(geometry&&taskCommitArmed&&operation==='document.snapshot'&&response?.ok){taskCommitArmed=false;heldGeometry=()=>emit.call(child.stdout,'data',line);event('task-commit-held',{pid:child.pid});}
      else if(geometry&&projectSaveArmed&&operation==='document.snapshot'&&response?.ok){projectSaveArmed=false;heldGeometry=()=>emit.call(child.stdout,'data',line);event('project-save-held',{pid:child.pid});}
      else if(geometry&&geometryArmed&&operation==='primitive.box'&&response?.ok){geometryArmed=false;heldGeometry=()=>emit.call(child.stdout,'data',line);event('geometry-held',{pid:child.pid,bodyCount:response.bodyCount,revision:response.revision});}
      else if(geometry&&stepArmed&&operation==='step.import'&&response?.ok){stepArmed=false;heldGeometry=()=>emit.call(child.stdout,'data',line);event('step-held',{pid:child.pid,bodyCount:response.bodyCount,revision:response.revision});}
      else if(geometry&&projectOpenArmed&&operation==='document.restore'&&response?.ok){projectOpenArmed=false;heldGeometry=()=>emit.call(child.stdout,'data',line);event('project-open-held',{pid:child.pid,revision:response.revision});}
      else if(mesh&&meshArmed&&operation==='mesh.create'&&response?.ok){meshArmed=false;event('mesh-held',{pid:child.pid,nodeCount:response.mesh?.nodeCount});}
      else emit.call(child.stdout,'data',line);
    }return true;
  };
  const kill=child.kill.bind(child);
  child.kill=function(...signals){if(geometry&&geometryExitHeld){geometryChild={child,kill,signals};event('geometry-exit-held',{pid:child.pid,exitCode:child.exitCode,signalCode:child.signalCode});return true;}if(mesh&&meshExitHeld){meshChild={child,kill,signals};event('mesh-exit-held',{pid:child.pid,exitCode:child.exitCode,signalCode:child.signalCode});return true;}return kill(...signals);};
  child.once('exit',()=>event(geometry?'geometry-exit':'mesh-exit',{pid:child.pid}));
  return child;
};
syncBuiltinESMExports();
if(frozenBackend){const entry=path.join(frozenBackend.directory,'runtime/scripts/backend-server.mjs');process.argv=[process.execPath,entry,'--release',frozenBackend.directory,'--workspace',workspace];await import(pathToFileURL(entry).href);}
else await import('../../gateway/server.mjs');
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{
  const command=JSON.parse(line);
  if(command.type==='arm-surface'){surfaceArmed=true;event('surface-armed');}
  if(command.type==='arm-derived-mesh'){projectionArmed=true;event('derived-mesh-armed');}
  if(command.type==='release-derived-mesh'){for(const control of projectionControls){Atomics.store(control,0,1);Atomics.notify(control,0);}projectionControls.clear();}
  if(command.type==='deny-derived-publication'){derivedPublicationDenied=true;event('derived-publication-denied-armed');}
  if(command.type==='allow-derived-publication'){derivedPublicationDenied=false;event('derived-publication-denied-released');}
  if(command.type==='arm-volume'){volumeArmed=true;event('volume-armed');}
  if(command.type==='arm-discrete-tetra'){discreteTetraArmed=true;event('discrete-tetra-armed');}
  if(command.type==='arm-checkpoint-optimizer'){checkpointOptimizerArmed=true;event('checkpoint-optimizer-armed');}
  if(command.type==='crash-checkpoint-optimizer'){heldCheckpointOptimizer?.child.kill();heldCheckpointOptimizer=null;event('checkpoint-optimizer-terminated');}
  if(command.type==='release-checkpoint-optimizer'){heldCheckpointOptimizer?.release();heldCheckpointOptimizer=null;}
  if(command.type==='arm-discrete-validation-input'){validationGate={phase:'input',operation:'volume.partition'};event('discrete-validation-armed',{phase:'input'});}
  if(command.type==='arm-discrete-validation-result'){validationGate={phase:'result',operation:'mesh.discrete-tetra'};event('discrete-validation-armed',{phase:'result'});}
  if(command.type==='arm-discrete-validation-failure'){validationGate={phase:'failure',operation:'mesh.discrete-tetra'};event('discrete-validation-armed',{phase:'failure'});}
  if(command.type==='arm-discrete-validation-timeout'){validationGate={phase:'result',operation:'mesh.discrete-tetra',timeout:true};event('discrete-validation-armed',{phase:'result'});}
  if(command.type==='release-discrete-validation'){for(const control of validationControls){Atomics.store(control,0,1);Atomics.notify(control,0);}validationControls.clear();}
  if(command.type==='release-discrete-tetra'){heldDiscreteTetra?.();heldDiscreteTetra=null;}
  if(command.type==='hold-surface-exit'){surfaceExitHeld=true;event('surface-exit-hold-armed');}
  if(command.type==='release-surface-exit'){surfaceExitHeld=false;if(surfaceChild){surfaceChild.kill(...surfaceChild.signals);surfaceChild=null;}heldSurface=null;}
  if(command.type==='release-surface'){heldSurface?.();heldSurface=null;}
  if(command.type==='shutdown'){input.close();process.stdin.destroy();process.emit('SIGTERM');}
  if(command.type==='exit-mesh-completion'){meshCompletionExit=true;event('mesh-completion-exit-armed');}
  if(command.type==='deny-mesh-completion'){meshCompletionDenied=true;event('mesh-completion-denial-armed');}
  if(command.type==='allow-mesh-completion'){meshCompletionDenied=false;event('mesh-completion-denial-released');}
  if(command.type==='arm-mesh-recovery'){meshRecoveryArmed=true;event('mesh-recovery-armed');}
  if(command.type==='release-mesh-recovery'){releaseMeshRecovery?.();releaseMeshRecovery=null;}
  if(command.type==='arm-geometry'){geometryArmed=true;event('geometry-armed');}
  if(command.type==='arm-task-commit'){taskCommitArmed=true;event('task-commit-armed');}
  if(command.type==='arm-project-create'){projectCreateArmed=true;event('project-create-armed');}
  if(command.type==='arm-workspace-view'){workspaceViewArmed=true;event('workspace-view-armed');}
  if(command.type==='exit-task-terminal'){taskTerminalExit=true;event('task-terminal-exit-armed');}
  if(command.type==='exit-step-task-terminal'){stepTaskTerminalExit=true;event('step-task-terminal-exit-armed');}
  if(command.type==='arm-step'){stepArmed=true;event('step-armed');}
  if(command.type==='arm-project-open'){projectOpenArmed=true;event('project-open-armed');}
  if(command.type==='arm-project-save'){projectSaveArmed=true;event('project-save-armed');}
  if(command.type==='arm-maintenance-isolation'){maintenanceIsolationArmed=true;event('maintenance-isolation-armed');}
  if(command.type==='release-maintenance-isolation'){releaseMaintenanceIsolation?.();releaseMaintenanceIsolation=null;}
  if(command.type==='arm-save-publish'){savePublishHeld=true;event('save-publish-armed');}
  if(command.type==='release-save-publish'){releaseSavePublish?.();releaseSavePublish=null;}
  if(command.type==='exit-save-published'){saveTerminalExit=true;event('save-published-exit-armed');}
  if(command.type==='exit-project-open-published'){projectOpenPublishedExit=true;event('project-open-published-exit-armed');}
  if(command.type==='exit-project-create-published'){projectCreatePublishedExit=true;event('project-create-published-exit-armed');}
  if(command.type==='exit-project-open-terminal'){projectOpenTerminalExit=true;event('project-open-terminal-exit-armed');}
  if(command.type==='fail-step-report'){stepReportFailure=true;event('step-report-armed');}
  if(command.type==='fail-step-commit-report'){stepCommitReportFailure=true;event('step-commit-report-armed');}
  if(command.type==='exit-step-report'){stepReportExit=true;event('step-exit-armed');}
  if(command.type==='release-geometry'){heldGeometry?.();heldGeometry=null;}
  if(command.type==='arm-geometry-exit'){geometryExitHeld=true;event('geometry-exit-armed');}
  if(command.type==='fault-after-geometry-reply'){geometryCorruptAfterReply=true;event('geometry-result-fault-armed');}
  if(command.type==='release-geometry-exit'){geometryExitHeld=false;geometryChild?.kill(...geometryChild.signals);geometryChild=null;}
  if(command.type==='arm-mesh'){meshArmed=true;meshExitHeld=true;event('mesh-armed');}
  if(command.type==='arm-mesh-exit'){meshExitHeld=true;event('mesh-exit-armed');}
  if(command.type==='release-mesh-exit'){meshExitHeld=false;meshChild?.kill(...meshChild.signals);meshChild=null;}
});
