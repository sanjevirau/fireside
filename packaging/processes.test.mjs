import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { nativeEnvironment, requestNativeStop, resolveExecutable } from '../packages/cli/src/processes.mjs';

test('Windows allocator defaults are before spawn and preserve explicit overrides', () => {
  assert.deepEqual(nativeEnvironment({},'win32'),{MIMALLOC_PURGE_DELAY:'100',MIMALLOC_PURGE_DECOMMITS:'1',FIRESIDE_CONTROL_STDIN:'1'});
  assert.equal(nativeEnvironment({MIMALLOC_PURGE_DELAY:'800'},'win32').MIMALLOC_PURGE_DELAY,'800');
  assert.deepEqual(nativeEnvironment({},'linux'),{});
});
test('Windows requests private graceful control, never emulates a Unix signal', () => {
  let message;
  const child = {exitCode:null,signalCode:null,stdin:{end(value){message=value;}},kill(){assert.fail('must not kill');}};
  requestNativeStop(child,'SIGINT','win32');
  assert.equal(message,'FIRESIDE_SHUTDOWN\n');
  assert.throws(()=>requestNativeStop({...child,stdin:undefined},'SIGINT','win32'),/pipe/);
});
test('runtime executable resolution accepts absolute native paths without a shell', () => {
  assert.equal(resolveExecutable(process.execPath),process.execPath);
  assert.throws(()=>resolveExecutable('fireside-missing-executable'),/not found/);
});
test('Windows never chooses an npm-generated extensionless Unix shim', () => {
  const root = mkdtempSync(join(tmpdir(),'fireside-exe-selection-'));
  try {
    const shim = join(root,'bun');
    writeFileSync(shim,'#!/bin/sh\n',{mode:0o755});
    writeFileSync(`${shim}.exe`,'synthetic executable placeholder',{mode:0o755});
    assert.equal(resolveExecutable(shim,{},'win32'),`${shim}.exe`);
  } finally {rmSync(root,{recursive:true});}
});
