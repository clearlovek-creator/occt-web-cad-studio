import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {gatedGeometryGateway} from './helpers/gated-geometry-gateway.mjs';
import {denyWindowsFileReplacement} from './helpers/windows-file-sharing.mjs';

test('HTTP task persistence diagnostics report a real Windows sharing denial without geometry replay or private paths',{skip:process.platform!=='win32',timeout:45000},async()=>{
    const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-task-record-api-'));let gateway,lock,retain=false;
    try{
        gateway=await gatedGeometryGateway(data);
        const before=await gateway.cad('document.view'),input={documentId:'default',requestId:randomUUID(),operation:'primitive.box',parameters:{width:3,depth:4,height:5},baseRevision:before.revision,baseStateToken:before.stateToken};
        const task=await gateway.reserve(input),file=path.join(data,'modeling-tasks',task.taskId+'.json'),bytes=fs.readFileSync(file),offset=gateway.events.length;
        lock=await denyWindowsFileReplacement(file);
        const denied=await gateway.cancel(task);assert.equal(denied.status,503);assert.equal(denied.value.code,'MODELING_TASK_REPORT_UNAVAILABLE');assert.equal(denied.value.retryableByModel,false);
        const diagnostic=denied.value.details.taskPersistence;assert.equal(diagnostic.stage,'replace');assert.ok(['EPERM','EACCES','EBUSY'].includes(diagnostic.ioCode));assert.equal(diagnostic.phase,'cancelled');assert.equal(diagnostic.sequence,2);assert.deepEqual(fs.readFileSync(file),bytes);assert.doesNotMatch(JSON.stringify(denied.value),/cad-task-record-api-|AppData|SECRET/);
        const health=await gateway.get('/health');assert.deepEqual(health.lifecycle.modelingTasks.persistence.lastFailure,diagnostic);assert.equal(health.lifecycle.modelingTasks.persistence.attempts,2);
        assert.equal((await gateway.get('/documents/default/modeling-tasks/'+task.taskId)).modelingTask.phase,'reserved');assert.equal(gateway.events.slice(offset).some(event=>event.type==='fixture.native-request'&&event.operation==='primitive.box'),false);
        assert.equal((await gateway.cad('document.view')).stateToken,before.stateToken);
        await lock.release();lock=null;
        assert.equal((await gateway.cancel(task)).value.modelingTask.phase,'cancelled');assert.equal((await gateway.cad('document.view')).stateToken,before.stateToken);
        assert.equal((await gateway.submit(input,task)).value.code,'MODELING_TASK_ALREADY_SUBMITTED');assert.equal(gateway.events.slice(offset).some(event=>event.type==='fixture.native-request'&&event.operation==='primitive.box'),false);
    }catch(error){if(error.retainData)retain=true;throw error;}
    finally{
        if(lock)try{await lock.release();}catch(error){retain=true;throw error;}
        if(gateway)assert.equal(await gateway.stop(),0);
        assert.equal(retain,false,'Unconfirmed owned child; preserve '+data);assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-task-record-api-/);fs.rmSync(data,{recursive:true,force:true});
    }
});
