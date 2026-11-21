// Isolated test fixture only: terminate after a real native file operation but
// before the transaction can publish its terminal journal record.
import path from 'node:path';
import {SourceFileSwap} from '../../gateway/source-file-swap.mjs';
import {SourceRestoreTransactions} from '../../gateway/source-restore-transactions.mjs';
const [dataDir,operationId,action]=process.argv.slice(2);
if(!dataDir||!operationId||!['commit','rollback'].includes(action))process.exit(64);
const swap=new SourceFileSwap({dataDir,executablePath:path.resolve(import.meta.dirname,'../../geometry-worker/build/cad_source_file_swap.exe')});
const original=swap.swap.bind(swap);
swap.swap=async input=>{const result=await original(input);if(!result.ok)throw Error('Native fixture swap failed');process.exit(88);};
let transactions;
const proof={validate:async()=>transactions.read(operationId).proof};
transactions=new SourceRestoreTransactions({dataDir,proof,swap});
await transactions[action](operationId);
process.exit(65);
