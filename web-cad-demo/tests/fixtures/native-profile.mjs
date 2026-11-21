import assert from 'node:assert/strict';
import path from 'node:path';
const [expected]=process.argv.slice(2);
assert.equal(path.resolve(process.env.PATH.split(path.delimiter)[0]),path.resolve(expected),'CTest must use its own native DLL profile first');
console.log('Native profile order verified');
