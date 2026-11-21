import fs from 'node:fs';
import {transactionFixture} from './project-transaction-fixture.mjs';
const [root,stage]=process.argv.slice(2),f=transactionFixture(root);
if(stage==='committed'){
  const remove=fs.rmSync;fs.rmSync=(file,...args)=>{if(file===f.transactions.journalPath('crash')&&fs.existsSync(file)&&JSON.parse(fs.readFileSync(file)).phase==='committed')process.exit(87);return remove(file,...args);};
}
await f.transactions.run('crash',async()=>{
  f.schemas.createType('crash',{key:'AfterCrash',fields:[]});f.setModel({revision:2,name:'AfterCrash'});await f.commit('crash');
  f.history.recordIdempotency('crash',{key:'accepted-with-project',response:{ok:true,revision:2,name:'AfterCrash'}});
  if(stage==='prepared')process.exit(86);
  return {ok:true};
});
