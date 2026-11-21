type FrameRequest = (callback: FrameRequestCallback) => number;

/** One owned animation callback at a time. A changing control may request its
 * next damping step; a static scene owns no recurring browser work. */
export function createViewportFrame({draw,requestFrame=requestAnimationFrame,cancelFrame=cancelAnimationFrame}: {
  draw: (time: number) => boolean | void;
  requestFrame?: FrameRequest;
  cancelFrame?: (handle: number) => void;
}) {
  let pending: number | null=null,dirty=false,paused=false,disposed=false,epoch=0;
  const cancel=()=>{epoch++;if(pending!==null)cancelFrame(pending);pending=null;};
  const schedule=()=>{
    if(disposed||paused||!dirty||pending!==null)return;
    const ticket=++epoch;
    pending=requestFrame(time=>{
      if(disposed||paused||ticket!==epoch)return;
      pending=null;dirty=false;
      let changing: boolean | void;
      try{changing=draw(time);}catch(error){dirty=false;cancel();throw error;}
      if(disposed)return;
      if(changing)dirty=true;
      schedule();
    });
  };
  return {
    invalidate(){if(disposed)return;dirty=true;schedule();},
    setPaused(value: boolean){if(disposed||paused===value)return;paused=value;if(paused)cancel();else{dirty=true;schedule();}},
    dispose(){if(disposed)return;disposed=true;dirty=false;cancel();},
    status(){return {pending:pending!==null,dirty,paused,disposed};},
  };
}
