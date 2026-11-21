/** A kill request is not proof that a test-owned OS process has exited. */
export async function stopTestChild(child,{timeoutMs=5000}={}){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  await new Promise((resolve,reject)=>{
    const onExit=()=>{clearTimeout(timer);resolve();};
    const timer=setTimeout(()=>{child.removeListener('exit',onExit);reject(Error('Test-owned child has not exited; preserve its data directory and inspect the same process handle.'));},timeoutMs);
    child.once('exit',onExit);
    if(!child.killed)child.kill();
  });
}
