import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dependencyHeaderInventory} from '../scripts/discrete-build-inputs.mjs';

function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-header-inventory-'));t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^cad-header-inventory-/);fs.rmSync(root,{recursive:true,force:true});});fs.mkdirSync(path.join(root,'nested'));fs.writeFileSync(path.join(root,'z.h'),'xyz');fs.writeFileSync(path.join(root,'nested','a.h'),'1234');return root;}
test('native dependency inventory is sorted and hashes exact bytes',t=>{const root=fixture(t),items=dependencyHeaderInventory(root);assert.deepEqual(items.map(x=>[x.file,x.bytes]),[['nested/a.h',4],['z.h',3]]);assert.equal(items[0].sha256.length,64);assert.deepEqual(dependencyHeaderInventory(root),items);});
test('dependency inventory enforces file, aggregate and per-file byte budgets',t=>{const root=fixture(t);for(const limits of [{maxFiles:1},{maxBytes:6},{maxFileBytes:3}])assert.throws(()=>dependencyHeaderInventory(root,limits),/budget exceeded/);assert.equal(dependencyHeaderInventory(root,{maxFiles:2,maxBytes:7,maxFileBytes:4}).length,2);});
test('dependency inventory bounds directory count and depth',t=>{const root=fixture(t);assert.throws(()=>dependencyHeaderInventory(root,{maxDirectories:1}),/directory inventory budget/);fs.mkdirSync(path.join(root,'nested','deep'));assert.throws(()=>dependencyHeaderInventory(root,{maxDepth:1}),/directory inventory budget/);});
test('dependency inventory rejects linked files and invalid configuration',t=>{const root=fixture(t);fs.linkSync(path.join(root,'z.h'),path.join(root,'alias.h'));assert.throws(()=>dependencyHeaderInventory(root),/non-regular files/);for(const limits of [{maxFiles:0},{maxBytes:NaN},{maxDepth:1.5}])assert.throws(()=>dependencyHeaderInventory(root,limits),TypeError);});
