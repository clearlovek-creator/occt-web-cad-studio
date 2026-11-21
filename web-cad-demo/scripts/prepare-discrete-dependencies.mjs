/* Isolated algorithm research dependencies. Does not install system packages or
 * add CGAL to any default project build/runtime/release. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
const workspace=path.resolve(import.meta.dirname,'..'),root=path.join(workspace,'.artifacts/discrete-dependencies');
const inputs=[
  {name:'CGAL-6.1.2-library.tar.xz',url:'https://github.com/CGAL/cgal/releases/download/v6.1.2/CGAL-6.1.2-library.tar.xz',sha256:'a4d7d36ee49f813609f195638bf9ab2d1d55157e8d1256fb2408459a09a87b59',bytes:5256776,prefix:'CGAL-6.1.2',license:'Package-specific GPL-3.0-or-later / LGPL-3.0-or-later / commercial; autorefinement is GPL-3.0-or-later OR LicenseRef-Commercial'},
  {name:'boost_1_88_0.tar.gz',url:'https://archives.boost.io/release/1.88.0/source/boost_1_88_0.tar.gz',sha256:'3621533e820dcab1e8012afd583c0c73cf0f77694952b81352bf38c1488f9cb4',maxBytes:180*1024*1024,prefix:'boost_1_88_0',members:['boost_1_88_0/boost','boost_1_88_0/LICENSE_1_0.txt'],license:'Boost Software License 1.0'},
];
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function run(binary,args,{capture=false}={}){
  const child=spawn(binary,args,{cwd:workspace,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',error='';
  child.stdout.on('data',b=>{if(capture){output+=b;if(output.length>16*1024*1024)child.kill();}else process.stdout.write(b);});child.stderr.on('data',b=>{error=(error+b).slice(-8192);});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,error);return output;
}
fs.mkdirSync(root,{recursive:true});assert.ok(fs.lstatSync(root).isDirectory()&&!fs.lstatSync(root).isSymbolicLink());
// Windows desktop applications may use a system proxy not inherited by curl.
// Read only its server address; never change the system configuration or copy
// proxy credentials into receipts/logs.
let proxy='';
if(process.platform==='win32'&&!process.env.HTTPS_PROXY&&!process.env.https_proxy&&!process.env.ALL_PROXY&&!process.env.all_proxy){
  const value=(await run('powershell.exe',['-NoProfile','-Command',"$u=[uri]'https://github.com';$p=[System.Net.WebRequest]::DefaultWebProxy.GetProxy($u);if($p -ne $u){$p.GetComponents([System.UriComponents]::SchemeAndServer,[System.UriFormat]::UriEscaped)}"],{capture:true})).trim();
  if(value){const endpoint=new URL(value);assert.ok(['http:','https:'].includes(endpoint.protocol)&&!endpoint.username&&!endpoint.password);proxy=endpoint.href;}
}
const records=[];
for(const input of inputs){
  const archive=path.join(root,input.name);
  if(!fs.existsSync(archive)){
    const pending=archive+'.download';assert.ok(!fs.existsSync(pending),'Retained interrupted download: '+pending);
    console.log('Downloading verified research dependency: '+input.name);
    await run('curl.exe',['--fail','--location','--retry','2','--connect-timeout','15','--max-time','180','--max-filesize',String(input.maxBytes||input.bytes),...(proxy?['--proxy',proxy]:[]),'--output',pending,input.url]);
    const size=fs.statSync(pending).size;assert.ok(size>0&&size<=(input.maxBytes||input.bytes));if(input.bytes)assert.equal(size,input.bytes);
    assert.equal(hash(pending),input.sha256,'Official archive checksum mismatch; retain file and do not extract.');fs.renameSync(pending,archive);
  }
  assert.equal(hash(archive),input.sha256);
  const output=path.join(root,input.prefix),marker=path.join(root,input.prefix+'.receipt.json');
  if(!fs.existsSync(marker)){
    assert.ok(!fs.existsSync(output),'Uncertified extraction exists; preserve it: '+output);
    const names=(await run('C:/Windows/System32/tar.exe',['-tf',archive],{capture:true})).split(/\r?\n/).filter(Boolean);
    assert.ok(names.length>0&&names.length<100000);
    const selected=input.members?names.filter(name=>input.members.some(member=>name===member||name.startsWith(member+'/'))):names;
    assert.ok(selected.length>0);for(const member of input.members||[])assert.ok(selected.some(name=>name===member||name.startsWith(member+'/')),'Missing selected archive subtree');
    for(const name of selected)assert.ok(name.startsWith(input.prefix+'/')&&!name.includes('\\')&&!name.includes(':')&&!name.split('/').includes('..'),'Unsafe selected archive member');
    await run('C:/Windows/System32/tar.exe',['-xf',archive,'-C',root,...(input.members||[])]);
    assert.ok(fs.lstatSync(output).isDirectory()&&!fs.lstatSync(output).isSymbolicLink());
    fs.writeFileSync(marker,JSON.stringify({...input,archiveBytes:fs.statSync(archive).size,memberCount:names.length,extractedAt:new Date().toISOString(),scope:'isolated-research-only-not-default-product'},null,2),{flag:'wx'});
  }
  const record=JSON.parse(fs.readFileSync(marker));assert.equal(record.sha256,input.sha256);records.push(record);
}
console.log(JSON.stringify({ok:true,root,inputs:records.map(({name,sha256,archiveBytes,license})=>({name,sha256,archiveBytes,license})),scope:'No system install; no default product linkage or release qualification.'}));
