const observations=new WeakMap();
/** Observe the exact OS process. A kill request or a wait timeout is not exit. */
export function childExit(child){
  if(!child||child.exitCode!=null||child.signalCode!=null)return Promise.resolve();
  if(observations.has(child))return observations.get(child);
  const observed=new Promise(resolve=>{
    const done=()=>{child.off('exit',done);child.off('close',closed);resolve();};
    const closed=()=>{if(child.exitCode!=null||child.signalCode!=null||child.pid==null)done();};
    child.once('exit',done);child.once('close',closed);
  });observations.set(child,observed);return observed;
}
export async function waitChildExit(child,{timeoutMs=5000,code='CHILD_STOP_UNCONFIRMED',message='尚未核验工作进程退出。'}={}){
  let timer;
  try{await Promise.race([childExit(child),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error(message),{code})),timeoutMs);})]);}
  finally{clearTimeout(timer);}
}
