import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Exercise the actual inline shutdown function without loading a workload host
// or pretending its upstream queue is a real integration. Browser qualification
// separately invokes the pinned host and verifies process exit.
const source=await readFile(new URL('../support/functions-host.cjs',import.meta.url),'utf8');
const start=source.indexOf('async function stop(signal');
const end=source.indexOf('process.once("SIGINT"',start);
assert(start>=0&&end>start,'locate the actual host shutdown function');
function host(stop){
  const calls=[];
  const context=vm.createContext({stopping:false,functionsEmulator:{stop},
    EmulatorRegistry:{clear:name=>calls.push(['clear',name])},Emulators:{FUNCTIONS:'functions',EXTENSIONS:'extensions'},
    process:{stderr:{write:()=>{}},exitCode:undefined,exit:code=>calls.push(['exit',code])}});
  vm.runInContext(source.slice(start,end),context);
  return {calls,stop:context.stop};
}
test('owned Functions host exits only after upstream drain/stop completes',async()=>{
  let complete;const state=host(()=>new Promise(resolve=>{complete=resolve;}));
  const pending=state.stop('SIGTERM');assert.deepEqual(state.calls,[]);
  await state.stop('SIGINT');assert.deepEqual(state.calls,[],'repeated signal cannot bypass drain');
  complete();await pending;
  assert.deepEqual(state.calls,[['clear','functions'],['clear','extensions'],['exit',0]]);
});
test('upstream stop failure cannot become a clean host exit',async()=>{
  const state=host(async()=>{throw new Error('synthetic stop failure');});
  await state.stop('SIGTERM');assert.deepEqual(state.calls,[['exit',1]]);
});
test('startup rejection drains upstream before retaining a failing exit status',async()=>{
  let complete;const state=host(()=>new Promise(resolve=>{complete=resolve;}));
  const pending=state.stop('startup failure',1);assert.deepEqual(state.calls,[]);
  complete();await pending;
  assert.deepEqual(state.calls,[['clear','functions'],['clear','extensions'],['exit',1]]);
  assert(source.includes('stop("startup failure", 1)'), 'main rejection must use the owned shutdown path');
});
