/** Test harness shutdown evidence. A lost HTTP reply is not process-exit proof. */
export async function observeGatewayStop(child,request,{timeoutMs=15000}={}){
  const controller=new AbortController();let timer,onClose;
  const closed=new Promise((resolve,reject)=>{onClose=code=>resolve(code);child.once('close',onClose);timer=setTimeout(()=>reject(Error('Gateway shutdown unconfirmed; preserve data and inspect the same child')),timeoutMs);});
  const acknowledgement=Promise.resolve().then(()=>request(controller.signal)).then(response=>({requestAccepted:response.ok===true,requestStatus:response.status??null}),error=>({requestAccepted:false,requestErrorCode:String(error.cause?.code||error.code||'SHUTDOWN_REPLY_LOST').slice(0,80)}));
  try{const [exitCode,reply]=await Promise.all([closed,acknowledgement]);return {...reply,exitCode,processClosed:true};}
  finally{clearTimeout(timer);child.off('close',onClose);controller.abort();}
}
