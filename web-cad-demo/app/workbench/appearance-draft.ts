export type AppearanceValues={name:string;color:string;material:string;opacity:number};
export type AppearanceBody=Partial<AppearanceValues>&{bodyId:string;topologyRevision?:number};
export type AppearanceBaseline=AppearanceValues&{bodyId:string};
export type AppearanceDraft={name:string;color:string;material:string;opacityPercent:string};
export type AppearanceErrors=Partial<Record<keyof AppearanceDraft,string>>;

export function appearanceColor(value:string):string|null{
  const text=value.trim();return /^#?[\da-f]{6}$/i.test(text)?'#'+text.replace(/^#/,'').toUpperCase():null;
}
export function opacityPercent(value:number):string{
  return Number.isFinite(value)?String(Number((value*100).toPrecision(15))):'';
}
export function captureAppearance(body:AppearanceBody):AppearanceBaseline{
  return {bodyId:body.bodyId,name:body.name||body.bodyId,color:appearanceColor(body.color||'#7b91aa')||body.color||'#7B91AA',material:body.material||'',opacity:body.opacity??1};
}
export function appearanceDraft(baseline:AppearanceBaseline):AppearanceDraft{
  return {name:baseline.name,color:baseline.color,material:baseline.material,opacityPercent:opacityPercent(baseline.opacity)};
}
export function evaluateAppearance(baseline:AppearanceBaseline,draft:AppearanceDraft){
  const errors:AppearanceErrors={};
  if(!draft.name.trim())errors.name='请输入几何名称。';
  else if(new TextEncoder().encode(draft.name).length>128)errors.name='名称过长，请缩短后保存。';
  const color=appearanceColor(draft.color);if(!color)errors.color='请输入 6 位 HEX 颜色码，例如 #336699。';
  const text=draft.opacityPercent.trim(),percent=/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)?Number(text):NaN;
  if(!Number.isFinite(percent)||percent<5||percent>100)errors.opacityPercent='不透明度须在 5% 至 100% 之间。';
  if(Object.keys(errors).length)return {valid:false,dirty:true,errors,changes:{} as Partial<AppearanceValues>};
  // Formatting the percentage must not round an untouched native double when
  // saving another field. Only actual changes are sent to body.update.
  const opacity=percent===Number(opacityPercent(baseline.opacity))?baseline.opacity:percent/100;
  const changes:Partial<AppearanceValues>={};
  if(draft.name!==baseline.name)changes.name=draft.name;
  if(color!==appearanceColor(baseline.color))changes.color=color!;
  if(draft.material!==baseline.material)changes.material=draft.material;
  if(opacity!==baseline.opacity)changes.opacity=opacity;
  return {valid:true,dirty:Object.keys(changes).length>0,errors,changes};
}
export function opacityKeyPercent(current:string,key:string,fine=false):string|null{
  const value=Number(current),base=Number.isFinite(value)?value:100;
  const delta=fine?1:5;
  const next=key==='Home'?5:key==='End'?100:key==='ArrowRight'||key==='ArrowUp'?base+delta:key==='ArrowLeft'||key==='ArrowDown'?base-delta:key==='PageUp'?base+10:key==='PageDown'?base-10:null;
  return next===null?null:String(Number(Math.min(100,Math.max(5,next)).toPrecision(15)));
}
