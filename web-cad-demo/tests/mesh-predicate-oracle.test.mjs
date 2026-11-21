import test from 'node:test';import assert from 'node:assert/strict';
import {exactTripleSign} from '../gateway/mesh-spatial.mjs';
// Independent all-BigInt binary64 determinant; no production filter or helpers.
function oracle(points){
  const bytes=new DataView(new ArrayBuffer(8)),values=points.flat().map(value=>{bytes.setFloat64(0,value,false);const bits=bytes.getBigUint64(0,false),exponent=Number(bits>>52n&2047n),fraction=bits&((1n<<52n)-1n);return {mantissa:(bits>>63n?-1n:1n)*(exponent?(1n<<52n)+fraction:fraction),exponent:exponent?exponent-1075:-1074};});
  const nonzero=values.filter(value=>value.mantissa!==0n);if(!nonzero.length)return 0;const e=Math.min(...nonzero.map(value=>value.exponent)),ints=values.map(value=>value.mantissa===0n?0n:value.mantissa<<BigInt(value.exponent-e)),vector=(a,b)=>[0,1,2].map(axis=>ints[b*3+axis]-ints[a*3+axis]),u=vector(0,1),v=vector(2,3),w=vector(4,5),d=u[0]*v[1]*w[2]+u[1]*v[2]*w[0]+u[2]*v[0]*w[1]-u[0]*v[2]*w[1]-u[1]*v[0]*w[2]-u[2]*v[1]*w[0];return d>0n?1:d<0n?-1:0;
}
test('scalar filtered determinant agrees with an independent exact binary64 oracle over mixed exponents and near cancellation',()=>{
  let seed=386971;const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  for(let i=0;i<3000;i++){
    const exponent=i%4===0?next()%2001-1000:next()%101-50;
    const points=Array.from({length:6},()=>Array.from({length:3},()=>{const e=i%4===0?next()%2001-1000:exponent;return ((next()%33-16)+(next()%16)/16)*2**e;}));
    if(i%5===0)points[2]=points[0].slice();if(i%7===0)points[4]=points[0].slice();if(i%11===0)points[5]=points[4].slice();
    assert.equal(exactTripleSign(...points),oracle(points),'exact binary64 case '+i);
  }
  for(const scale of [Number.MIN_VALUE,2**-1000,2**-500,1,2**500,1e308]){
    const zero=[[0,0,0],[scale,scale,0],[0,0,0],[scale,-scale,0],[0,0,0],[-scale,scale,0]];assert.equal(exactTripleSign(...zero),oracle(zero));
    const near=[[0,0,0],[1,1,1],[0,0,0],[1,1+2**-52,1],[0,0,0],[1,1,1+2**-52]].map(point=>point.map(value=>value*scale));if(near.flat().every(Number.isFinite))assert.equal(exactTripleSign(...near),oracle(near));
  }
});
test('symbolic zero remains counted against the exact-work budget and never uses an epsilon contact tolerance',()=>{
  const meter={calls:0,exacts:0,call(){this.calls++;},exact(){this.exacts++;}},p=[[.1,.1,.1],[1.1,.1,.1],[.1,.1,.1],[.1,1.1,.1],[.1,.1,.1],[.4,.4,.1]];
  assert.equal(exactTripleSign(...p,meter),0);assert.equal(meter.calls,1);assert.equal(meter.exacts,1);
  const tiny=[[0,0,0],[1,0,0],[0,0,0],[0,1,0],[0,0,0],[0,0,Number.MIN_VALUE]];assert.equal(exactTripleSign(...tiny),1);
});
