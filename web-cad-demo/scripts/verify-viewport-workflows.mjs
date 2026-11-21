import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
export async function verifyViewportWorkflows({origin,artifacts}){
  const root=path.resolve(import.meta.dirname,'..'),results=[];
  for(const [name,file]of [['workbench','verify-workbench.cjs'],['historical-inputs','verify-loft-reference-repair.mjs']]){
    const directory=path.join(artifacts,name);fs.mkdirSync(directory);
    const log=path.join(directory,'workflow.log'),fd=fs.openSync(log,'wx');
    const child=spawn(process.execPath,[path.join(root,'scripts',file)],{cwd:root,windowsHide:true,stdio:['ignore',fd,fd],env:{...process.env,WEB_ORIGIN:origin,WORKBENCH_URL:origin,WORKBENCH_BROWSER_ARTIFACTS:directory}});
    let code;try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}finally{fs.closeSync(fd);}
    const text=fs.readFileSync(log,'utf8'),matches=[...text.matchAll(/"passed":\s*(\d+)/g)];
    if(code===0){assert.ok(matches.length);assert.match(text,/"browserErrors":\s*\[\s*\]/);}
    results.push({name,file,exitCode:code,passed:matches.length?Number(matches.at(-1)[1]):null});console.log(JSON.stringify(results.at(-1)));
  }
  const ok=results.every(r=>r.exitCode===0);
  fs.writeFileSync(path.join(artifacts,'workflows.json'),JSON.stringify({ok,results,paidProviderCalls:0,childrenExited:true},null,2),{flag:'wx'});
  assert.equal(ok,true,'Browser workflows failed; retain all workflow logs: '+artifacts);return results;
}
