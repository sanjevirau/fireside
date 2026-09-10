import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import test from 'node:test';

const root=fileURLToPath(new URL('../../',import.meta.url));
const fixture=JSON.parse(await readFile(new URL('../fixtures/rest-read-options-v1/fixture.json',import.meta.url)));
const execute=promisify(execFile);

function normalized(value){
  if(Array.isArray(value))return value.map(normalized);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
    .filter(([key])=>!['createTime','updateTime','readTime'].includes(key))
    .map(([key,item])=>[key,key==='transaction'?'<opaque-transaction>':normalized(item)]));
  return value;
}

test('native HTTP read options replay in memory and disk/WAL with explicit Java adapter deviations',{timeout:600000},async()=>{
  await execute('cargo',['build','--locked','-p','fireside'],{cwd:root});
  const metadata=JSON.parse((await execute('cargo',['metadata','--no-deps','--format-version','1'],{cwd:root})).stdout);
  for(const mode of ['memory','disk-wal']){
    const work=await mkdtemp(join(tmpdir(),'fireside-rest-reads-'));
    await writeFile(join(work,'firestore.rules'),fixture.rules);
    const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
    const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
    const binary=join(metadata.target_directory,'debug',process.platform==='win32'?'fireside.exe':'fireside');
    const args=['firestore','--host','127.0.0.1','--port',String(port),'--rules',join(work,'firestore.rules')];
    if(mode==='disk-wal')args.push('--data-dir',join(work,'state'));
    const peer=spawn(binary,args,{cwd:work,env:{...process.env,FIRESIDE_CONTROL_STDIN:'1'},stdio:['pipe','pipe','pipe']});
    const exited=once(peer,'exit');let log='';for(const stream of [peer.stdout,peer.stderr])stream.on('data',bytes=>log+=bytes);
    const origin=`http://127.0.0.1:${port}`,base=origin+`/v1/projects/${fixture.project}/databases/(default)/documents`;
    const observations=[],native=new Map();let passed=false;
    try{
      const deadline=Date.now()+30000;
      while(true){
        assert.equal(peer.exitCode,null,log);
        try{const response=await fetch(origin+'/emulator/v1/debug/memory',{signal:AbortSignal.timeout(250)});await response.arrayBuffer();if(response.ok)break;}catch{}
        assert(Date.now()<deadline,log);await delay(25);
      }
      for(const row of fixture.exchanges){
        let path=row.path;const body=structuredClone(row.body);
        if(row.bindings.transactionFrom){
          const token=native.get(row.bindings.transactionFrom).transaction;
          path=path.replace(/transaction=[^&]*/,'transaction='+encodeURIComponent(token));
          if(body?.transaction)body.transaction=token;
        }
        if(row.bindings.readTimeFrom){
          const time=native.get(row.bindings.readTimeFrom).updateTime;
          path=path.replace(/readTime=[^&]*/,'readTime='+encodeURIComponent(time));
          if(body?.readTime)body.readTime=time;
        }
        const response=await fetch(base+path,{method:row.method,headers:{...(row.owner?{authorization:'Bearer owner'}:{}),...(body?{'content-type':'application/json'}:{})},
          ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
        const actual=await response.json();native.set(row.id,actual);
        observations.push({id:row.id,status:response.status,response:actual});
        if(row.status===null||row.id==='get-read-time'){
          // Do not reproduce the official GET query transcoder hang/invalid
          // timestamp conversion. Validate usable native gRPC semantics instead.
          const valid=['get-in-read-only','get-read-only-after-mutation','get-read-time'].includes(row.id);
          assert.equal(response.status,valid?200:400,row.id);
          if(valid)assert.equal(actual.fields.title.stringValue,'before 火🔥');
        }else{
          assert.equal(response.status,row.status,row.id);
          if(response.ok)assert.deepEqual(normalized(actual),normalized(row.response),row.id);
          else assert.equal(actual.error.status,row.response.error.status,row.id);
        }
      }
      passed=true;
    }finally{
      peer.stdin.end('FIRESIDE_SHUTDOWN\n');
      const exit=await Promise.race([exited,delay(10000,null,{ref:false})]);
      await writeFile(join(work,'server.log'),log);
      await writeFile(join(work,'result.json'),JSON.stringify({passed,syntheticOnly:true,acceptance:false,mode,observations,exit},null,2)+'\n');
      assert.deepEqual(exit,[0,null],'owned native shutdown');
    }
    console.log(`REST read-options ${mode}: ${observations.length} observations; ${work}`);
  }
});
