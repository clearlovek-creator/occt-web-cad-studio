import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {PROJECT_MIME} from './project-package.mjs';
export async function streamProjectBackup(response,download,headers={}){
  const backup=download.result.projectBackup;
  try{response.writeHead(200,{...headers,'Content-Type':PROJECT_MIME,'Content-Length':backup.bytes,'Content-Disposition':`attachment; filename="project.cadproj"; filename*=UTF-8''${encodeURIComponent(backup.fileName)}`,'ETag':`"${backup.sha256}"`,'X-Content-SHA256':backup.sha256,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});await pipeline(Readable.from(download.chunks()),response);}
  finally{download.close();}
}
