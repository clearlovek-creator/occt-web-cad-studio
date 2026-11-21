/** Test observation only. Timeout never kills or certifies exit of the child. */
export function waitGatewayReady(child, {timeoutMs = 15000, diagnosticBytes = 16384} = {}) {
  return new Promise((resolve, reject) => {
    let output = '', diagnostic = '', timer;
    const clean = () => {
      clearTimeout(timer); child.stdout.off('data', onOutput); child.stderr.off('data', onDiagnostic);
      child.off('error', onError); child.off('exit', onExit);
    };
    const fail = (code, message) => { clean(); reject(Object.assign(Error(message + (diagnostic ? '\n' + diagnostic : '')), {code, pid: child.pid})); };
    const onDiagnostic = chunk => { diagnostic = (diagnostic + String(chunk)).slice(-diagnosticBytes); };
    const onOutput = chunk => {
      output += String(chunk);
      if (output.includes('Geometry gateway ready')) { clean(); resolve(); return; }
      output = output.slice(-diagnosticBytes);
    };
    const onError = error => fail('GATEWAY_READY_PROCESS_ERROR', 'Gateway startup process error: ' + error.message);
    const onExit = (code, signal) => fail('GATEWAY_READY_PROCESS_EXIT', `Gateway exited before readiness: code=${code}, signal=${signal}`);
    child.stdout.on('data', onOutput); child.stderr.on('data', onDiagnostic); child.once('error', onError); child.once('exit', onExit);
    if (child.exitCode != null || child.signalCode != null) { onExit(child.exitCode, child.signalCode); return; }
    timer = setTimeout(() => fail('GATEWAY_READY_TIMEOUT', `Gateway readiness unconfirmed after ${timeoutMs} ms (pid=${child.pid}); this does not confirm process exit.`), timeoutMs);
  });
}
