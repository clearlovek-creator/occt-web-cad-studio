/* Test-only post-publication cleanup denial. No production endpoint or hook. */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {selectBackendRelease} from '../../gateway/backend-release.mjs';
import {validateNativeRuntime} from '../../gateway/native-runtime-release.mjs';
import {selectNativeTestRuntime,assertNativeTestRoles} from '../../scripts/test-native-runtime.mjs';
const workspace=path.resolve(import.meta.dirname,'../..'),release=selectBackendRelease(path.resolve(process.env.CAD_TEST_TASK_RECORD_BACKEND_ROOT));
assertNativeTestRoles(selectNativeTestRuntime(workspace).manifest,validateNativeRuntime(path.join(release.directory,'native'),release.native).roles);
const taskRoot=path.join(path.resolve(process.env.GEOMETRY_DATA_DIR),'modeling-tasks'),rename=fs.renameSync,remove=fs.rmSync;let published;
fs.renameSync=function(source,target){
    let match=false;
    if(String(source).startsWith(taskRoot+path.sep)&&String(source).endsWith('.tmp')){const record=JSON.parse(fs.readFileSync(source,'utf8'));match=record.operation==='feature.update'&&record.phase==='preparing';}
    const result=rename(source,target);
    if(match){published=source;process.stdout.write(JSON.stringify({type:'fixture.task-record-published',phase:'preparing'})+'\n');}
    return result;
};
fs.rmSync=function(file,...args){
    if(file===published&&!fs.existsSync(file)){process.stdout.write(JSON.stringify({type:'fixture.redundant-cleanup-denied'})+'\n');throw Object.assign(Error('Private test-only cleanup sharing denial'),{code:'EPERM'});}
    return remove(file,...args);
};
const entry=path.join(release.directory,'runtime/scripts/backend-server.mjs');process.argv=[process.execPath,entry,'--release',release.directory,'--workspace',workspace];await import(pathToFileURL(entry).href);
