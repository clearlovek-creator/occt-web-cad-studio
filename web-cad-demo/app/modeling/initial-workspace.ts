type WorkspaceStorage={getItem:(key:string)=>string|null};
/** Read identity before any model/agent effect, without writing or contacting a service. */
export function initialWorkspaceId(storage?:{sessionStorage:WorkspaceStorage;localStorage:WorkspaceStorage}):string{
  const browser=storage??(typeof window==='undefined'?undefined:window);
  if(!browser)return 'default';
  for(const kind of ['sessionStorage','localStorage'] as const){
    try{const id=browser[kind].getItem('occt.activeDocumentId');if(id&&/^[A-Za-z0-9_-]{1,64}$/.test(id))return id;}catch{/* Storage can be denied independently. */}
  }
  return 'default';
}
