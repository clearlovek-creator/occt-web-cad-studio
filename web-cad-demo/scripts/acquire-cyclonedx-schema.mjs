import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const index=process.argv.indexOf('--output');if(index<0||!process.argv[index+1])throw Error('An explicit --output directory is required.');const output=path.resolve(process.argv[index+1]);if(fs.existsSync(output))throw Error('Schema input directory exists; nothing overwritten.');
const files=[];for(const file of['bom-1.6.schema.json','spdx.schema.json','jsf-0.82.schema.json']){
  const url='https://cyclonedx.org/schema/'+file,response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Official schema request failed: '+response.status);let size=0;const parts=[];for await(const part of response.body){size+=part.length;if(size>2*1024*1024)throw Error('Schema budget exceeded.');parts.push(part);}const bytes=Buffer.concat(parts);JSON.parse(bytes);files.push({file,url,bytes,sha256:createHash('sha256').update(bytes).digest('hex')});
}
fs.mkdirSync(output,{recursive:true});for(const item of files)fs.writeFileSync(path.join(output,item.file),item.bytes,{flag:'wx'});fs.writeFileSync(path.join(output,'schema-input.json'),JSON.stringify({format:'web-cad-cyclonedx-schema-input',version:1,acquiredAt:new Date().toISOString(),files:files.map(item=>({file:item.file,url:item.url,bytes:item.bytes.length,sha256:item.sha256}))},null,2),{flag:'wx'});console.log(JSON.stringify({ok:true,files:files.map(item=>({file:item.file,sha256:item.sha256})),output}));
