// Synthetic, analytically defined stress cases; not customer/production CAD evidence.
const triangles=[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,4,7],[0,7,3],[1,2,6],[1,6,5],[0,1,5],[0,5,4],[3,7,6],[3,6,2]];
export function boxSoup(boxes,{offset=[0,0,0],rotate=false}={}){
  const input={units:'mm',points:[],triangles:[],sources:[]};
  const transform=([x,y,z])=>{
    // Rational orthogonal matrix: no trigonometric drift in the intended geometry.
    const p=rotate?[(3*x-4*y)/5,(4*x+3*y)/5,z]:[x,y,z];
    return p.map((value,i)=>value+offset[i]);
  };
  for(const [index,{min,max}]of boxes.entries()){
    const base=input.points.length,[x,y,z]=min,[u,v,w]=max;
    input.points.push(...[[x,y,z],[u,y,z],[u,v,z],[x,v,z],[x,y,w],[u,y,w],[u,v,w],[x,v,w]].map(transform));
    input.triangles.push(...triangles.map(row=>row.map(n=>base+n)));
    input.sources.push(...triangles.map((_,i)=>({bodyId:`body-${index+1}`,solidId:`solid-${index+1}`,faceId:`face-${index+1}-${Math.floor(i/2)}`})));
  }
  return input;
}
export function discreteIndustrialCases(){
  const box={min:[0,0,0],max:[2,2,2]},overlap={min:[1,1,.5],max:[3,3,2.5]};
  const cases=[
    {name:'origin-box',boxes:[box],volume:8,meshSize:.8},
    {name:'translated-box-1e6',boxes:[box],offset:[1e6,-1e6,1e6],volume:8,meshSize:.8},
    {name:'rotated-box',boxes:[box],rotate:true,volume:8,meshSize:.8},
    {name:'translated-rotated-box-1e6',boxes:[box],rotate:true,offset:[1e6,-1e6,1e6],volume:8,meshSize:.8},
    {name:'overlap',boxes:[box,overlap],volume:14.5,meshSize:.8},
    {name:'translated-overlap-1e6',boxes:[box,overlap],offset:[1e6,-1e6,1e6],volume:14.5,meshSize:.8},
    {name:'translated-box-netgen',boxes:[box],offset:[1e6,-1e6,1e6],volume:8,meshSize:.8,optimization:{version:1,method:'netgen',iterations:3}},
    {name:'translated-overlap-netgen',boxes:[box,overlap],offset:[1e6,-1e6,1e6],volume:14.5,meshSize:.8,optimization:{version:1,method:'netgen',iterations:3}},
    {name:'thin-layer',boxes:[{min:[0,0,0],max:[2,2,.02]}],volume:.08,meshSize:.8},
    {name:'near-gap',boxes:[box,{min:[2.0001,0,0],max:[4.0001,2,2]}],volume:16,meshSize:.8},
    {name:'narrow-overlap',boxes:[box,{min:[1.9999,0,0],max:[3.9999,2,2]}],volume:15.9996,meshSize:.8},
    {name:'coincident-boxes',boxes:[box,box],volume:8,meshSize:.8},
    {name:'open-boundary',boxes:[box],reject:['VOLUME_OPEN_BOUNDARY','VOLUME_NON_MANIFOLD'],open:true},
  ];
  return cases.map(({boxes,offset,rotate,open,...item})=>{
    const input=boxSoup(boxes,{offset,rotate});
    if(open){input.triangles.pop();input.sources.pop();}
    return {...item,input};
  });
}
