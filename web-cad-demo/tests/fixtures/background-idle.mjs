// Test-owned short-lived background process. No ports, CAD, providers or secrets.
import fs from 'node:fs';
const [readyFile,nonce,duration]=process.argv.slice(2);
if(!readyFile||!nonce||Number(duration)!==6000)throw Error('Invalid background lifecycle fixture');
fs.writeFileSync(readyFile,JSON.stringify({pid:process.pid,nonce,arguments:process.argv.slice(5)}),{flag:'wx'});
console.log('fixture ready');
setTimeout(()=>{console.log('fixture complete');},Number(duration));
