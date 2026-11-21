/** RPC receipt deadlines, not provider request deadlines or retry policy. */
export const PI_RPC_TIMEOUTS=Object.freeze({requestMs:30000,startupMs:45000,browserStartupMs:60000,compactMs:180000,browserSlackMs:10000,maxMs:600000});
/** @param {string} command */
export function piRpcTimeoutMs(command){return command==='compact'?PI_RPC_TIMEOUTS.compactMs:command==='startup'?PI_RPC_TIMEOUTS.startupMs:PI_RPC_TIMEOUTS.requestMs;}
/** @param {string} command */
export function piRpcBrowserTimeoutMs(command){return command==='startup'?PI_RPC_TIMEOUTS.browserStartupMs:piRpcTimeoutMs(command)+PI_RPC_TIMEOUTS.browserSlackMs;}
