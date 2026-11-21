import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';

/** Owned real Windows handle: allow reads/writes, deliberately deny replacement. */
export async function denyWindowsFileReplacement(file) {
    return holdWindowsFile(file,false);
}
export async function denyWindowsFileRead(file){return holdWindowsFile(file,true);}
async function holdWindowsFile(file,exclusive) {
    assert.equal(process.platform, 'win32');
    const share=exclusive?'None':'ReadWrite';
    const script = "$ErrorActionPreference='Stop'; $stream=[System.IO.File]::Open($env:CAD_TASK_LOCK_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::"+share+"); try { [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $stream.Dispose() }";
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, CAD_TASK_LOCK_FILE: path.toNamespacedPath(path.resolve(file))}});
    let closed = false, code = null;
    const done = new Promise(resolve => child.once('close', value => { closed = true; code = value; resolve(); }));
    let diagnostics='';child.stderr.on('data',part=>diagnostics=(diagnostics+part).slice(-8192));
    async function release() {
        if (!closed) child.stdin.end('\n');
        let timer;
        try {
            await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('Owned sharing fixture exit unconfirmed; retain its data'), {retainData: true})), 10000); })]);
        } finally { clearTimeout(timer); }
        assert.equal(closed, true);
        assert.equal(code, 0);
    }
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('Owned Windows sharing fixture did not become ready')), 10000);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.stdout.on('data', bytes => { if (String(bytes).includes('READY')) { clearTimeout(timer); resolve(); } });
            child.once('close', () => { clearTimeout(timer); reject(Error('Owned sharing fixture closed before readiness: '+diagnostics)); });
        });
    } catch (error) { try{await release();}catch(cleanupError){Object.defineProperty(error,'cleanupError',{value:cleanupError});if(cleanupError.retainData)error.retainData=true;}throw error; }
    return {release};
}
