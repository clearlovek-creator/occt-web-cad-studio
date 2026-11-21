import test from "node:test";
import assert from "node:assert/strict";
import { projectStateToken, mutationFingerprint } from "../gateway/project-state.mjs";

test("edit tokens survive serialization and checkpoint maintenance but not Undo/Redo ABA",()=>{
  const initial=projectStateToken("doc",{});
  assert.equal(projectStateToken("doc",{current:"initial.xbf",events:[]}),initial);
  const history={current:"state-a",events:[{eventId:"created"}]},a=projectStateToken("doc",history);
  assert.equal(projectStateToken("doc",JSON.parse(JSON.stringify(history))),a);
  assert.equal(projectStateToken("doc",{...history,idempotency:[{}]}),a);
  assert.notEqual(projectStateToken("other",history),a);
  assert.notEqual(projectStateToken("doc",{...history,events:[...history.events,{eventId:"undo"},{eventId:"redo"}]}),a);
});

test("idempotency identifies semantic edits, not transport IDs or stale preconditions",()=>{
  const fields={documentId:"doc",requestId:"a",baseRevision:4,baseStateToken:"old",parameters:{value:{x:3,y:4}},inputs:{instanceId:"i"}};
  const original=JSON.stringify(fields),hash=mutationFingerprint("property.instance.update",fields);
  assert.equal(mutationFingerprint("property.instance.update",{...fields,requestId:"retry",clientRequestId:"key",baseRevision:5,baseStateToken:"new",parameters:{value:{y:4,x:3}}}),hash);
  assert.notEqual(mutationFingerprint("property.instance.update",{...fields,parameters:{value:{x:9,y:4}}}),hash);
  assert.equal(JSON.stringify(fields),original);
});
