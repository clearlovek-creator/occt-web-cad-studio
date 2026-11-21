/** Positive-volume overlap of LINEAR tetrahedra. Contacts are not overlaps.
 * SAT uses both sets of face normals and every edge/edge cross-product axis.
 * Numerical decisions are filtered; uncertain signs use exact dyadic BigInts.
 * This is not a curved-element, boundary conformity or surface repair proof. */
export const MESH_SPATIAL_LIMITS=Object.freeze({cells:1<<21,bytes:128*1024*1024,buildComparisons:128*1024*1024,nodeVisits:128*1024*1024,pairs:32*1024*1024,predicates:256*1024*1024,exactPredicates:2*1024*1024,samples:8});
const limited=message=>Object.assign(Error('网格空间检查超限：'+message),{code:'MESH_ARTIFACT_LIMIT'});
const faces=[[1,2,3,0],[0,3,2,1],[0,1,3,2],[0,2,1,3]],edges=[[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]];
const minNormal=2**-1022;
const bits=new DataView(new ArrayBuffer(8));
const equal=(a,b)=>a[0]===b[0]&&a[1]===b[1]&&a[2]===b[2];
const sameEdge=(a,b,c,d)=>equal(a,c)&&equal(b,d)||equal(a,d)&&equal(b,c);
function dyadic(value){
  bits.setFloat64(0,value,false);const n=bits.getBigUint64(0,false),e=Number(n>>52n&2047n),fraction=n&((1n<<52n)-1n);
  return {m:(n>>63n?-1n:1n)*(e?fraction+(1n<<52n):fraction),e:e?e-1075:-1074};
}
function determinant(u,v,w){return u[0]*(v[1]*w[2]-v[2]*w[1])-u[1]*(v[0]*w[2]-v[2]*w[0])+u[2]*(v[0]*w[1]-v[1]*w[0]);}
const integerPoint=p=>Number.isSafeInteger(p[0])&&Number.isSafeInteger(p[1])&&Number.isSafeInteger(p[2]);
const normalNumber=n=>n===0||Number.isFinite(n)&&Math.abs(n)>=minNormal;
const normalTerm=(zero,first,last)=>zero||Number.isFinite(first)&&Math.abs(first)>=minNormal&&Number.isFinite(last)&&Math.abs(last)>=minNormal;
/** Sign of (b-a) cross (d-c) dot (q-p), for finite binary64 inputs.
 * The 64-epsilon filter is deliberately wider than the < 16u error for
 * three rounded subtractions/products and summing six normal products.
 * Subnormal/overflow intermediates never use that relative-error filter. */
export function exactTripleSign(a,b,c,d,p,q,meter){
  meter?.call();
  if(equal(a,b)||equal(c,d)||equal(p,q))return 0;
  if(sameEdge(a,b,c,d)||sameEdge(a,b,p,q)||sameEdge(c,d,p,q))return 0;
  const u0=b[0]-a[0],u1=b[1]-a[1],u2=b[2]-a[2],v0=d[0]-c[0],v1=d[1]-c[1],v2=d[2]-c[2],w0=q[0]-p[0],w1=q[1]-p[1],w2=q[2]-p[2];
  // Integer operations in this range have exact products and sums (< 2^51).
  if(integerPoint(a)&&integerPoint(b)&&integerPoint(c)&&integerPoint(d)&&integerPoint(p)&&integerPoint(q)&&Math.abs(u0)<=65536&&Math.abs(u1)<=65536&&Math.abs(u2)<=65536&&Math.abs(v0)<=65536&&Math.abs(v1)<=65536&&Math.abs(v2)<=65536&&Math.abs(w0)<=65536&&Math.abs(w1)<=65536&&Math.abs(w2)<=65536){const value=u0*(v1*w2-v2*w1)-u1*(v0*w2-v2*w0)+u2*(v0*w1-v1*w0);return value===0?0:Math.sign(value);}
  const z0=u0===0||v1===0||w2===0,z1=u0===0||v2===0||w1===0,z2=u1===0||v0===0||w2===0,z3=u1===0||v2===0||w0===0,z4=u2===0||v0===0||w1===0,z5=u2===0||v1===0||w0===0;
  // Every determinant term has an exact zero factor: a symbolic zero proof,
  // not a tolerance. Keep its original exact-predicate budget accounting.
  if(z0&&z1&&z2&&z3&&z4&&z5){meter?.exact();return 0;}
  const f0=u0*v1,f1=u0*v2,f2=u1*v0,f3=u1*v2,f4=u2*v0,f5=u2*v1;
  const t0=f0*w2,t1=f1*w1,t2=f2*w2,t3=f3*w0,t4=f4*w1,t5=f5*w0;
  const value=t0-t1-t2+t3+t4-t5,permanent=Math.abs(t0)+Math.abs(t1)+Math.abs(t2)+Math.abs(t3)+Math.abs(t4)+Math.abs(t5);
  // The same 64-epsilon/normal-intermediate guards, without constructing
  // temporary point, slot, factor and product arrays for every predicate.
  if(Number.isFinite(permanent)&&Math.abs(value)>64*Number.EPSILON*permanent&&normalNumber(u0)&&normalNumber(u1)&&normalNumber(u2)&&normalNumber(v0)&&normalNumber(v1)&&normalNumber(v2)&&normalNumber(w0)&&normalNumber(w1)&&normalNumber(w2)&&normalTerm(z0,f0,t0)&&normalTerm(z1,f1,t1)&&normalTerm(z2,f2,t2)&&normalTerm(z3,f3,t3)&&normalTerm(z4,f4,t4)&&normalTerm(z5,f5,t5))return Math.sign(value);
  meter?.exact();
  const all=[a,b,c,d,p,q].map(point=>point.map(dyadic)),exponent=Math.min(...all.flat().filter(n=>n.m!==0n).map(n=>n.e));
  const ints=all.map(point=>point.map(n=>n.m===0n?0n:n.m<<BigInt(n.e-exponent)));
  const difference=(i,j)=>ints[j].map((n,k)=>n-ints[i][k]);
  const exact=determinant(difference(0,1),difference(2,3),difference(4,5));
  return exact<0n?-1:exact>0n?1:0;
}
const orientation=(a,b,c,d,meter)=>exactTripleSign(a,b,a,c,a,d,meter);
export function tetrahedraOverlap(a,b,meter){
  if(orientation(...a,meter)===0||orientation(...b,meter)===0)return false;
  for(const [own,other] of [[a,b],[b,a]])for(const [i,j,k,opposite] of faces){
    const sign=orientation(own[i],own[j],own[k],own[opposite],meter);
    if(other.every(point=>orientation(own[i],own[j],own[k],point,meter)*sign<=0))return false;
  }
  for(const [i,j] of edges)for(const [k,l] of edges){
    const compare=(p,q)=>exactTripleSign(a[i],a[j],b[k],b[l],p,q,meter);
    if(a.slice(1).every(p=>compare(a[0],p)===0))continue; // Zero cross-product axis, since A is full-dimensional.
    let minA=a[0],maxA=a[0],minB=b[0],maxB=b[0];
    for(let n=1;n<4;n++){
      if(compare(a[n],minA)>0)minA=a[n];
      if(compare(maxA,a[n])>0)maxA=a[n];
      if(compare(b[n],minB)>0)minB=b[n];
      if(compare(maxB,b[n])>0)maxB=b[n];
    }
    if(compare(maxA,minB)>=0||compare(maxB,minA)>=0)return false;
  }
  return true;
}

/** One retained packed corner/bounds record per linear cell, no raw cell objects.
 * A median-split BVH is built after the certified cell stream has been consumed.
 * Only bounded display IDs are retained; IDs never participate in geometry tests. */
export class LinearTetraSpatial {
  constructor(expected,positionAt,options={}){
    this.limits={...MESH_SPATIAL_LIMITS,...options};
    for(const [key,value] of Object.entries(this.limits))if(!Object.hasOwn(MESH_SPATIAL_LIMITS,key)||!Number.isSafeInteger(value)||value<1||value>MESH_SPATIAL_LIMITS[key])throw limited('预算配置无效。');
    if(!Number.isSafeInteger(expected)||expected<0||expected>this.limits.cells)throw limited('单元数量超过容量。');
    this.blocks=[];this.order=new Uint32Array(0);
    this.nodeBounds=new Float64Array(0);this.starts=new Uint32Array(0);this.counts=new Uint32Array(0);
    Object.assign(this,{expected,positionAt,observed:0,capacity:0,geometryBytes:0,idBytes:0,treeBytes:0,accountedBytes:0,peakAccountedBytes:0,size:0,skippedHighOrderCount:0,invalidGeometryCount:0,overlapPairCount:0,samples:[],buildComparisons:0,nodeVisits:0,candidatePairs:0,predicates:0,exactPredicates:0,finished:false,report:null});
    this.meter={call:()=>{if(++this.predicates>this.limits.predicates)throw limited('几何谓词总次数超过预算。');},exact:()=>{if(++this.exactPredicates>this.limits.exactPredicates)throw limited('精确谓词次数超过预算，未将未检查单元判为通过。');}};
  }
  reserve(needed,extraIdBytes){
    if(this.accountedBytes+extraIdBytes>this.limits.bytes)throw limited('单元编号保留超过索引预算。');
    if(needed<=this.capacity)return;
    const blockCapacity=Math.min(1024,this.expected-this.capacity),geometryBytes=blockCapacity*77;
    // Append fixed blocks instead of copying a growing array. Existing blocks,
    // the new block and retained IDs are charged together before allocation.
    const peak=this.accountedBytes+geometryBytes+extraIdBytes;
    if(peak>this.limits.bytes)throw limited('空间索引扩容峰值超过预算，原索引与材料保留。');
    let next;
    try{
      next={corners:new Uint32Array(blockCapacity*4),boxes:new Float64Array(blockCapacity*6),volumeTags:new Uint32Array(blockCapacity),flags:new Uint8Array(blockCapacity),ids:new Array(blockCapacity)};
    }catch{throw limited('无法扩容打包空间索引，原索引与材料保留。');}
    this.blocks.push(next);this.capacity+=blockCapacity;this.geometryBytes+=geometryBytes;this.accountedBytes=this.geometryBytes+this.idBytes+this.treeBytes;this.peakAccountedBytes=Math.max(this.peakAccountedBytes,peak);
  }
  allocateTree(){
    let leaves=1;while(leaves<Math.ceil(this.size/8))leaves*=2;
    const nodes=2*leaves-1,treeBytes=nodes*56+this.size*4,peak=this.accountedBytes+treeBytes;
    if(peak>this.limits.bytes)throw limited('空间树与保留单元的合计内存超过预算。');
    let nodeBounds,starts,counts,order;
    try{nodeBounds=new Float64Array(nodes*6);starts=new Uint32Array(nodes);counts=new Uint32Array(nodes);order=new Uint32Array(this.size);for(let i=0;i<this.size;i++)order[i]=i;}catch{throw limited('无法分配空间树，原始材料保留。');}
    Object.assign(this,{nodeBounds,starts,counts,order,treeBytes,accountedBytes:peak});this.peakAccountedBytes=Math.max(this.peakAccountedBytes,peak);
  }
  points(row,target=Array.from({length:4},()=>[0,0,0])){
    const block=this.blocks[row>>>10],offset=(row&1023)*4;
    for(let i=0;i<4;i++)for(let axis=0;axis<3;axis++)target[i][axis]=this.positionAt(block.corners[offset+i]*3+axis);
    return target;
  }
  add(cell,ownersVerified=false){
    if(this.finished)throw limited('空间检查已封存或中断，不能追加单元。');
    if(this.observed>=this.expected){this.finished=true;throw limited('流式单元数量超出声明。');}
    this.observed++;
    try{
    if(cell.order!==1||cell.elementType!==4){this.skippedHighOrderCount++;return;}
    if(this.size>=this.expected)throw limited('流式单元数量超出声明。');
    const points=cell.corners?.map(n=>[0,1,2].map(axis=>this.positionAt(n*3+axis)));
    if(!points||points.length!==4||!points.flat().every(Number.isFinite)||cell.corners.some(n=>!Number.isSafeInteger(n)||n<0||n>0xffffffff)||orientation(...points,this.meter)===0){this.invalidGeometryCount++;return;}
    const row=this.size,id=String(cell.elementId),display=id.slice(0,80),extraIdBytes=display.length*2;
    this.reserve(row+1,extraIdBytes);this.size++;this.idBytes+=extraIdBytes;this.accountedBytes+=extraIdBytes;this.peakAccountedBytes=Math.max(this.peakAccountedBytes,this.accountedBytes);
    const block=this.blocks[row>>>10],slot=row&1023;
    block.ids[slot]=id.length>80?Buffer.from(display,'utf8').toString('utf8'):id;block.flags[slot]=(id.length>80?1:0)|(ownersVerified===true?2:0);
    block.volumeTags[slot]=Number.isInteger(cell.volumeTag)&&cell.volumeTag>0&&cell.volumeTag<=0xffffffff?cell.volumeTag:0;
    block.corners.set(cell.corners,slot*4);
    for(let axis=0;axis<3;axis++){block.boxes[slot*6+axis]=Math.min(...points.map(p=>p[axis]));block.boxes[slot*6+axis+3]=Math.max(...points.map(p=>p[axis]));}
    }catch(error){this.finished=true;throw error;}
  }
  compare(a,b,axis){
    if(++this.buildComparisons>this.limits.buildComparisons)throw limited('空间树构建超过预算。');
    const aa=this.blocks[a>>>10].boxes,bb=this.blocks[b>>>10].boxes,ap=(a&1023)*6+axis,bp=(b&1023)*6+axis;
    const x=aa[ap]/2+aa[ap+3]/2,y=bb[bp]/2+bb[bp+3]/2;
    return x<y?-1:x>y?1:a-b;
  }
  partition(start,end,k,axis){
    let lo=start,hi=end-1;
    while(lo<hi){
      const pivot=this.order[(lo+hi)>>>1];let i=lo,j=hi;
      while(i<=j){while(this.compare(this.order[i],pivot,axis)<0)i++;while(this.compare(this.order[j],pivot,axis)>0)j--;if(i<=j){const value=this.order[i];this.order[i++]=this.order[j];this.order[j--]=value;}}
      if(k<=j)hi=j;else if(k>=i)lo=i;else return;
    }
  }
  build(node,start,end){
    this.starts[node]=start;this.counts[node]=end-start;
    const box=node*6;for(let axis=0;axis<3;axis++){let min=Infinity,max=-Infinity;for(let n=start;n<end;n++){const row=this.order[n],bounds=this.blocks[row>>>10].boxes,b=(row&1023)*6;min=Math.min(min,bounds[b+axis]);max=Math.max(max,bounds[b+axis+3]);}this.nodeBounds[box+axis]=min;this.nodeBounds[box+axis+3]=max;}
    if(end-start<=8)return;
    let axis=0;for(let n=1;n<3;n++)if(this.nodeBounds[box+n+3]-this.nodeBounds[box+n]>this.nodeBounds[box+axis+3]-this.nodeBounds[box+axis])axis=n;
    const mid=(start+end)>>>1;this.partition(start,end,mid,axis);this.build(node*2+1,start,mid);this.build(node*2+2,mid,end);
  }
  intersects(a,aOffset,b,bOffset){for(let axis=0;axis<3;axis++)if(a[aOffset+axis]>=b[bOffset+axis+3]||b[bOffset+axis]>=a[aOffset+axis+3])return false;return true;}
  finish(){
    if(this.report)return this.report;
    if(this.finished)throw limited('空间检查已中断，不能返回部分检查结果。');
    this.finished=true;
    if(this.observed!==this.expected)throw limited('单元流未完整消费，不能返回部分检查结果。');
    if(this.size){
      this.allocateTree();
      this.build(0,0,this.size);
      const stack=new Uint32Array(64),a=Array.from({length:4},()=>[0,0,0]),b=Array.from({length:4},()=>[0,0,0]);
      for(let row=0;row<this.size;row++){
        this.points(row,a);const own=this.blocks[row>>>10],ownSlot=row&1023;let depth=1;stack[0]=0;
        while(depth){
          const node=stack[--depth];if(++this.nodeVisits>this.limits.nodeVisits)throw limited('空间树遍历超过预算。');
          if(!this.intersects(own.boxes,ownSlot*6,this.nodeBounds,node*6))continue;
          const start=this.starts[node],count=this.counts[node];
          if(count>8){if(depth+2>stack.length)throw limited('空间树深度超过预算。');stack[depth++]=node*2+1;stack[depth++]=node*2+2;continue;}
          for(let i=start;i<start+count;i++){
            const other=this.order[i];if(other<=row)continue;const peer=this.blocks[other>>>10],peerSlot=other&1023;if(!this.intersects(own.boxes,ownSlot*6,peer.boxes,peerSlot*6))continue;
            if(++this.candidatePairs>this.limits.pairs)throw limited('候选单元对超过预算。');
            this.points(other,b);if(!tetrahedraOverlap(a,b,this.meter))continue;
            this.overlapPairCount++;
            if(this.samples.length<this.limits.samples)this.samples.push({elementIds:[own.ids[ownSlot],peer.ids[peerSlot]],elementIdsTruncated:[Boolean(own.flags[ownSlot]&1),Boolean(peer.flags[peerSlot]&1)],ownersVerified:[Boolean(own.flags[ownSlot]&2),Boolean(peer.flags[peerSlot]&2)],volumeTags:[own.volumeTags[ownSlot],peer.volumeTags[peerSlot]],corners:[a.flat(),b.flat()]});
          }
        }
      }
    }
    return this.report={version:1,basis:'linear-tetra-positive-volume-sat-v1',status:this.skippedHighOrderCount||this.invalidGeometryCount?'partial':'complete',checkedTetraCount:this.size,skippedHighOrderCount:this.skippedHighOrderCount,invalidGeometryCount:this.invalidGeometryCount,overlapPairCount:this.overlapPairCount,samples:this.samples,resources:{accountedBytes:this.accountedBytes,peakAccountedBytes:this.peakAccountedBytes,buildComparisons:this.buildComparisons,nodeVisits:this.nodeVisits,candidatePairs:this.candidatePairs,predicates:this.predicates,exactPredicates:this.exactPredicates}};
  }
}
