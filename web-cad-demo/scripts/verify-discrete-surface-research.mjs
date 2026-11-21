/* Isolated native algorithm research. Never connects to the daily project. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const exe=path.resolve(root,process.argv[3]||'.artifacts/discrete-surface-build/cad_discrete_surface_research.exe');
assert.ok(exe.startsWith(path.join(root,'.artifacts')+path.sep));
const output=path.resolve(root,process.argv[2]||'.artifacts/discrete-surface-research-first');
assert.ok(output.startsWith(path.join(root,'.artifacts')+path.sep));
assert.ok(!fs.existsSync(output),'Preserve earlier verification evidence; choose a new output directory.');
fs.mkdirSync(output,{recursive:true});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>Math.sqrt(dot(a,a));
const area=t=>norm(cross(sub(t[1],t[0]),sub(t[2],t[0])))/2;
const close=(a,b,eps=1e-7)=>norm(sub(a,b))<=eps;
function barycentric(p,t){
  const u=sub(t[1],t[0]),v=sub(t[2],t[0]),w=sub(p,t[0]),n=cross(u,v);
  const normal=norm(n);if(normal===0||Math.abs(dot(w,n))/normal>1e-7)return null;
  const uu=dot(u,u),uv=dot(u,v),vv=dot(v,v),uw=dot(u,w),vw=dot(v,w),d=uu*vv-uv*uv;
  const a=(vv*uw-uv*vw)/d,b=(uu*vw-uv*uw)/d;return [1-a-b,a,b];
}
function inside(p,t,strict=false){const b=barycentric(p,t);return b&&b.every(n=>strict?n>1e-8:n>=-1e-7);}
function soup(tris,owner=i=>({bodyId:`body-${i}`,faceId:`face-${i}`})){
  return {units:'mm',points:tris.flat(),triangles:tris.map((_,i)=>[3*i,3*i+1,3*i+2]),sources:tris.map((_,i)=>owner(i))};
}
function box(min,max,body){
  const [x,y,z]=min,[X,Y,Z]=max,p=[[x,y,z],[X,y,z],[X,Y,z],[x,Y,z],[x,y,Z],[X,y,Z],[X,Y,Z],[x,Y,Z]];
  const quads=[[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
  return quads.flatMap((q,f)=>[[q[0],q[1],q[2]],[q[0],q[2],q[3]]].map(t=>({t:t.map(i=>p[i]),owner:{bodyId:body,faceId:`${body}-face-${f}`,solidId:body}})));
}
const horizontal=[[-2,-2,0],[2,-2,0],[0,2,0]],vertical=[[0,-1,-1],[0,-1,1],[0,1,0]];
const crossing=soup([horizontal,vertical]);
const slanted=[horizontal,[[-.2,-1,-1],[.3,-1,1],[.6,1,.4]]];
const coplanar=soup([[[0,0,0],[3,0,0],[0,3,0]],[[1,0,0],[4,0,0],[1,3,0]]]);
const boxes=[...box([0,0,0],[2,2,2],'A'),...box([1,.5,.5],[3,2.5,2.5],'B')];
const cases=[
  {name:'single-clean-triangle',request:soup([horizontal]),count:1},
  {name:'two-separated-triangles',request:soup([horizontal,horizontal.map(p=>[p[0],p[1],p[2]+3])]),count:2},
  {name:'crossing-triangles',request:crossing,split:true,seam:true},
  {name:'three-plane-junction',request:soup([horizontal,vertical,[[-1,0,-1],[1,0,-1],[0,0,1]]]),split:true},
  {name:'coplanar-partial-overlap',request:coplanar,split:true,sharedArea:2},
  {name:'duplicate-different-owners',request:soup([horizontal,[...horizontal].reverse()]),count:1,sharedArea:8},
  {name:'shared-edge-clean',request:soup([[[0,0,0],[1,0,0],[0,1,0]],[[1,0,0],[1,1,0],[0,1,0]]]),count:2},
  {name:'vertex-contact',request:soup([[[0,0,0],[1,0,0],[0,1,0]],[[0,0,0],[0,-1,0],[0,0,1]]]),count:2},
  {name:'degenerate-removed',request:soup([horizontal,[[0,0,0],[1,0,0],[2,0,0]]]),count:1,removed:[1]},
  {name:'overlapping-box-surfaces',request:soup(boxes.map(x=>x.t),i=>boxes[i].owner),split:true},
  {name:'translated-crossing',request:soup([horizontal,vertical].map(t=>t.map(p=>p.map(v=>v+1000)))),split:true},
  {name:'decimal-crossing',request:soup([horizontal,vertical].map(t=>t.map(p=>p.map(v=>v/3+.123)))),split:true},
  {name:'slanted-crossing',request:soup(slanted),split:true},
  {name:'strict-drift-rejected',request:{...soup(slanted.map(t=>t.map(p=>p.map(v=>v+1e6)))),options:{tolerance:1e-12}},reject:'GEOMETRY_DRIFT'},
  {name:'all-degenerate-rejected',request:soup([[[0,0,0],[1,0,0],[2,0,0]]]),reject:'NO_SURFACE'},
  {name:'missing-units-rejected',request:{...crossing,units:undefined},reject:'INVALID_INPUT'},
  {name:'missing-owner-rejected',request:{...crossing,sources:[]},reject:'SOURCE_MAP_INVALID'},
  {name:'unknown-owner-key-rejected',request:{...crossing,sources:[{...crossing.sources[0],path:'x'},crossing.sources[1]]},reject:'SOURCE_MAP_INVALID'},
  {name:'invalid-index-rejected',request:{...crossing,triangles:[[0,1,999],crossing.triangles[1]]},reject:'INVALID_INPUT'},
  {name:'fractional-index-rejected',request:{...crossing,triangles:[[0,1,1.5],crossing.triangles[1]]},reject:'INVALID_INPUT'},
  {name:'snap-grid-limit-rejected',request:{...crossing,options:{snapGridSize:52}},reject:'INVALID_INPUT'},
  {name:'iteration-limit-rejected',request:{...crossing,options:{iterations:11}},reject:'INVALID_INPUT'},
  {name:'tolerance-limit-rejected',request:{...crossing,options:{tolerance:1}},reject:'INVALID_INPUT'},
  {name:'fractional-grid-rejected',request:{...crossing,options:{snapGridSize:40.5}},reject:'INVALID_INPUT'},
  {name:'non-numeric-coordinate-rejected',request:{...crossing,points:[['x',0,0],...crossing.points.slice(1)]},reject:'INVALID_INPUT'},
  {name:'coordinate-limit-rejected',request:{...crossing,points:[[1e13,0,0],...crossing.points.slice(1)]},reject:'INVALID_INPUT'},
  {name:'unknown-option-rejected',request:{...crossing,options:{silent:true}},reject:'INVALID_INPUT'},
];
async function run(request,name){
  fs.writeFileSync(path.join(output,name+'.input.json'),JSON.stringify(request));
  const start=performance.now(),child=spawn(exe,[],{cwd:root,windowsHide:true,env:{...process.env,GEOMETRY_WORKER_MEMORY_LIMIT_BYTES:String(2*1024**3),PATH:`C:/msys64/ucrt64/bin;${process.env.PATH}`},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',failure=null;
  const timer=setTimeout(()=>{failure='native timeout';child.kill();},30000);
  child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>64*1024*1024){failure='stdout limit';child.kill();}});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-65536);});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request)+'\n');
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));
  fs.writeFileSync(path.join(output,name+'.stdout.json'),stdout);fs.writeFileSync(path.join(output,name+'.stderr.txt'),stderr);
  assert.equal(failure,null,failure||'');const value=JSON.parse(stdout);
  return {code,value,elapsedMs:Math.round(performance.now()-start)};
}
function verify(c,value){
  const r=c.request,ts=value.triangles.map(t=>t.map(i=>value.points[i]));
  assert.equal(value.ok,true);assert.equal(value.units,'mm');assert.equal(value.cgalVersion,'6.1.2');
  assert.equal(value.report.tetrahedralReady,false);assert.equal(value.report.volumeDomainReconstruction,'not-performed');
  assert.deepEqual(value.sources,r.sources);assert.equal(value.sourceTriangleIds.length,ts.length);
  const input=r.triangles.map(t=>t.map(i=>r.points[i])),coverage=input.map(()=>0),keys=new Set();
  let sharedArea=0;
  for(let i=0;i<ts.length;i++){
    const indices=value.triangles[i];assert.ok(indices.length===3&&indices.every(k=>Number.isSafeInteger(k)&&k>=0&&k<value.points.length));
    const key=[...indices].sort((a,b)=>a-b).join(',');assert.ok(!keys.has(key),'Duplicate global triangle');keys.add(key);
    const triangle=ts[i],a=area(triangle);assert.ok(a>0);triangle.flat().forEach(n=>assert.ok(Number.isFinite(n)));
    const owners=value.sourceTriangleIds[i];assert.ok(owners.length>0);assert.equal(new Set(owners).size,owners.length);
    for(const source of owners){assert.ok(Number.isSafeInteger(source)&&source>=0&&source<input.length);triangle.forEach(p=>assert.ok(inside(p,input[source]),'Vertex outside its claimed input triangle'));coverage[source]+=a;}
    const center=[0,1,2].map(k=>triangle.reduce((n,p)=>n+p[k],0)/3);
    for(let j=0;j<input.length;j++)if(inside(center,input[j],true))assert.ok(owners.includes(j),'Coplanar support lost an owner');
    if(owners.length>1)sharedArea+=a;
  }
  coverage.forEach((a,i)=>assert.ok(Math.abs(a-area(input[i]))<=2e-6*Math.max(area(input[i]),1e-10),'Original source area was not preserved'));
  if(c.count)assert.equal(ts.length,c.count);if(c.split)assert.ok(ts.length>input.length,'Crossings were not split');
  if(c.sharedArea!==undefined)assert.ok(Math.abs(sharedArea-c.sharedArea)<1e-6,'Overlap owner area mismatch');
  assert.deepEqual(value.report.removedDegenerateInputTriangles,c.removed||[]);
  // Independent floating-point segment/triangle checks for these small fixtures.
  // Every noncoplanar edge hit must be an existing vertex of both triangles.
  for(let i=0;i<ts.length;i++)for(let j=i+1;j<ts.length;j++)for(const [a,b] of [[i,j],[j,i]]){
    const t=ts[a],u=ts[b],n=cross(sub(u[1],u[0]),sub(u[2],u[0]));
    for(let k=0;k<3;k++){
      const p=t[k],q=t[(k+1)%3],d=sub(q,p),den=dot(d,n);
      if(Math.abs(den)<1e-10*norm(d)*norm(n))continue;
      const s=dot(sub(u[0],p),n)/den;if(s< -1e-8||s>1+1e-8)continue;
      const hit=p.map((v,l)=>v+s*d[l]);if(!inside(hit,u))continue;
      assert.ok(t.some(v=>close(v,hit))&&u.some(v=>close(v,hit)),'Nonconforming surface intersection remains');
    }
  }
  if(c.seam){
    const edges=new Map();value.triangles.forEach((t,i)=>{for(let k=0;k<3;k++){const e=[t[k],t[(k+1)%3]].sort((a,b)=>a-b),key=e.join(',');if(!edges.has(key))edges.set(key,{e,owners:new Set()});value.sourceTriangleIds[i].forEach(s=>edges.get(key).owners.add(s));}});
    let length=0;for(const {e,owners} of edges.values())if(owners.has(0)&&owners.has(1))length+=norm(sub(value.points[e[0]],value.points[e[1]]));
    assert.ok(Math.abs(length-2)<1e-6,'Crossing does not share the expected global indexed seam');
  }
  return {triangles:ts.length,points:value.points.length,sourceReferences:value.sourceTriangleIds.flat().length,sharedArea};
}
const records=[];
const sources=['experiments/discrete-surface/main.cxx','experiments/discrete-surface/CMakeLists.txt','discrete-surface-worker/src/SurfaceRefinement.cxx','discrete-surface-worker/src/SurfaceRefinement.hxx','discrete-surface-worker/cmake/boost-headers/BoostConfig.cmake','discrete-surface-worker/cmake/boost-headers/BoostConfigVersion.cmake','discrete-surface-worker/cmake/boost-headers/ReadHeaderVersion.cmake','geometry-worker/src/protocol/Json.cxx','geometry-worker/src/protocol/Json.hxx','geometry-worker/src/runtime/NativeResourceGuard.cxx','geometry-worker/src/runtime/NativeResourceGuard.hxx','scripts/verify-discrete-surface-research.mjs'];
const sourceProof=sources.map(file=>({file,sha256:hash(fs.readFileSync(path.join(root,file)))})),executableSha=hash(fs.readFileSync(exe));
for(const c of cases){
  try{
    const result=await run(c.request,c.name);let details;
    if(c.reject){assert.notEqual(result.code,0);assert.equal(result.value.ok,false);assert.equal(result.value.code,c.reject);assert.equal(result.value.triangles,undefined);details={rejection:result.value.code};}
    else{assert.equal(result.code,0);details=verify(c,result.value);}
    records.push({name:c.name,ok:true,elapsedMs:result.elapsedMs,...details});console.log('PASS '+c.name);
  }catch(error){records.push({name:c.name,ok:false,error:error.stack});console.error('FAIL '+c.name+': '+error.message);}
}
try{
  const a=await run(crossing,'repeat-crossing-a'),b=await run(crossing,'repeat-crossing-b');
  assert.equal(a.code,0);assert.equal(b.code,0);assert.deepEqual(a.value,b.value);
  records.push({name:'deterministic-repeat',ok:true,outputSha256:hash(JSON.stringify(a.value))});
}catch(error){records.push({name:'deterministic-repeat',ok:false,error:error.stack});}
for(const item of sourceProof)assert.equal(hash(fs.readFileSync(path.join(root,item.file))),item.sha256,'Source changed during algorithm regression.');
assert.equal(hash(fs.readFileSync(exe)),executableSha,'Regression executable changed during verification.');
const receipt={format:'discrete-surface-research-verification',version:1,createdAt:new Date().toISOString(),ok:records.every(r=>r.ok),scope:'shared-product-core-regression-not-project-task-or-distribution-integration',executable:{path:path.relative(root,exe).replaceAll('\\','/'),sha256:executableSha},sources:sourceProof,counts:{total:records.length,passed:records.filter(r=>r.ok).length,failed:records.filter(r=>!r.ok).length},records,limits:['Small controlled fixtures, not arbitrary industrial dirty geometry qualification.','Caller-supplied Body/Face labels are not certified CAD identities.','No closed volume domain reconstruction or tetrahedral meshing.','No default worker linkage, deployment, installer or license qualification.']};
fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(receipt,null,2),{flag:'wx'});
console.log(JSON.stringify({ok:receipt.ok,counts:receipt.counts,output}));if(!receipt.ok)process.exitCode=1;
