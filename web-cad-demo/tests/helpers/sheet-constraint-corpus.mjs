import {boxSoup} from './discrete-industrial-corpus.mjs';
const cube={min:[0,0,0],max:[2,2,2]};
function sheet(input,corners,{name='sheet-1',reverse=false}={}){
  const base=input.points.length;input.points.push(...corners);
  for(const triangle of [[0,1,2],[0,2,3]]){const row=triangle.map(i=>base+i);if(reverse)[row[1],row[2]]=[row[2],row[1]];input.triangles.push(row);input.sources.push({bodyId:name,faceId:name+'-face'});}return input;
}
const horizontal=(x0,x1,y0,y1,z)=>[[x0,y0,z],[x1,y0,z],[x1,y1,z],[x0,y1,z]];
export function sheetConstraintCases(){
  const box=()=>boxSoup([cube]);
  const cavity=boxSoup([cube,{min:[.5,.5,.5],max:[1.5,1.5,1.5]}]);
  for(let i=12;i<cavity.triangles.length;i++){[cavity.triangles[i][1],cavity.triangles[i][2]]=[cavity.triangles[i][2],cavity.triangles[i][1]];cavity.sources[i]={...cavity.sources[i],bodyId:'body-1',solidId:'solid-1'};}
  const hollow=structuredClone(cavity),cavityBoundary=structuredClone(cavity),badCavity=structuredClone(cavity);
  for(let i=12;i<24;i++)[badCavity.triangles[i][1],badCavity.triangles[i][2]]=[badCavity.triangles[i][2],badCavity.triangles[i][1]];
  const island=boxSoup([cube,{min:[.5,.5,.5],max:[1.5,1.5,1.5]},{min:[.75,.75,.75],max:[1.25,1.25,1.25]}]);
  for(let i=0;i<island.triangles.length;i++){if(i>=12&&i<24)[island.triangles[i][1],island.triangles[i][2]]=[island.triangles[i][2],island.triangles[i][1]];island.sources[i]={...island.sources[i],bodyId:'body-1',solidId:'solid-1'};}
  const open=box();open.triangles.splice(0,2);open.sources.splice(0,2);sheet(open,horizontal(0,2,0,2,0));
  const pure=sheet({units:'mm',points:[],triangles:[],sources:[]},horizontal(0,2,0,2,0));sheet(pure,horizontal(0,2,0,2,1),{name:'sheet-2'});
  const coincident=()=>sheet(box(),horizontal(0,2,0,2,0));
  return [
    {name:'closed-solids-only',input:box(),volume:8,embedded:false,exterior:false,boundarySheet:false},
    {name:'internal-open-plane',input:sheet(box(),horizontal(.25,1.75,.25,1.75,1)),volume:8,embedded:true,exterior:false,boundarySheet:false},
    {name:'external-open-plane',input:sheet(box(),horizontal(.25,1.75,.25,1.75,3)),volume:8,embedded:false,exterior:true,boundarySheet:false},
    {name:'partially-intersecting-open-plane',input:sheet(box(),horizontal(-1,3,.5,1.5,1)),volume:8,embedded:true,exterior:true,boundarySheet:false},
    {name:'boundary-coincident-open-plane',input:coincident(),volume:8,embedded:false,exterior:false,boundarySheet:true},
    {name:'reversed-boundary-Sheet-keeps-solid-orientation',input:sheet(box(),horizontal(0,2,0,2,0),{reverse:true}),volume:8,embedded:false,exterior:false,boundarySheet:true},
    {name:'Sheet-on-two-solid-shared-interface',input:sheet(boxSoup([cube,{min:[2,0,0],max:[4,2,2]}]),[[2,0,0],[2,2,0],[2,2,2],[2,0,2]]),volume:16,embedded:false,exterior:false,boundarySheet:true,shared:true},
    {name:'Sheet-crosses-three-membership-cells',input:sheet(boxSoup([cube,{min:[1,0,0],max:[3,2,2]}]),horizontal(.25,2.75,.25,1.75,1)),volume:12,embedded:true,exterior:false,boundarySheet:false,embeddedCells:3},
    {name:'two-crossing-open-Sheets',input:sheet(sheet(box(),horizontal(.25,1.75,.25,1.75,1)),[[1,.25,.25],[1,1.75,.25],[1,1.75,1.75],[1,.25,1.75]],{name:'sheet-2'}),volume:8,embedded:true,exterior:false,boundarySheet:false},
    {name:'Sheet-in-actual-cavity-is-exterior',input:sheet(cavity,horizontal(.6,1.4,.6,1.4,1)),volume:7,embedded:false,exterior:true,boundarySheet:false},
    {name:'hollow-source-preserves-cavity-without-Sheets',input:hollow,volume:7,embedded:false,exterior:false,boundarySheet:false},
    {name:'Sheet-on-cavity-boundary',input:sheet(cavityBoundary,horizontal(.5,1.5,.5,1.5,.5)),volume:7,embedded:false,exterior:false,boundarySheet:true},
    {name:'nested-island-remains-a-separate-connected-cell',input:sheet(island,horizontal(.8,1.2,.8,1.2,1)),volume:7.125,embedded:true,exterior:false,boundarySheet:false,cells:2},
    {name:'wrong-cavity-orientation-is-not-silently-reinterpreted',input:badCavity,reject:['VOLUME_ORIENTATION_INVALID','VOLUME_SOURCE_SHELL_ORIENTATION']},
    {name:'touching-exterior-Sheet-is-not-an-internal-constraint',input:sheet(box(),horizontal(2,3,0,2,1)),volume:8,embedded:false,exterior:true,boundarySheet:false},
    {name:'Sheet-cannot-close-an-open-Solid',input:open,reject:['VOLUME_OPEN_BOUNDARY','VOLUME_NON_MANIFOLD']},
    {name:'pure-Sheets-are-not-promoted-to-volumes',input:pure,reject:['VOLUME_SOLID_REQUIRED']},
  ];
}
