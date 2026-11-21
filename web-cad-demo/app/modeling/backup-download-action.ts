/** This starts a browser download; it cannot prove a local filesystem save. */
export function startBackupDownload(file:Blob,fallbackName='工程.cadproj'){
  const suppliedName=(file as Blob&{name?:unknown}).name,fileName=typeof suppliedName==='string'?suppliedName:fallbackName;
  const url=URL.createObjectURL(file),anchor=document.createElement('a');anchor.href=url;anchor.download=fileName;document.body.appendChild(anchor);
  try{anchor.click();}finally{anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
}
