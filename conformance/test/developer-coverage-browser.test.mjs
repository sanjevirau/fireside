import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { chromium } from 'playwright';

test('native coverage JSON and HTML render actual counts, reload, errors and safe Unicode source', {timeout: 600000}, async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const execute = promisify(execFile);
  await execute('cargo', ['build', '--locked', '-p', 'fireside'], {cwd: root});
  const metadata = JSON.parse((await execute('cargo', ['metadata', '--no-deps', '--format-version', '1'], {cwd: root})).stdout);
  const work = await mkdtemp(join(tmpdir(), 'fireside-coverage-browser-'));
  const fixture = JSON.parse(await readFile(new URL('../fixtures/developer-tools-coverage-v1/fixture.json', import.meta.url)));
  const captured = fixture.profiles.find(profile => profile.id === 'request');
  const source = captured.source + '\n// 中文 🚀 </script><img src=x onerror="window.injected=true">\n';
  await writeFile(join(work, 'firestore.rules'), source);
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const project = 'demo-fireside-coverage';
  const origin = `http://127.0.0.1:${port}`;
  const control = `${origin}/emulator/v1/projects/${project}`;
  const peer = spawn(join(metadata.target_directory, 'debug', process.platform === 'win32' ? 'fireside.exe' : 'fireside'),
    ['firestore', '--host', '127.0.0.1', '--port', String(port), '--diagnostics', '--rules', join(work, 'firestore.rules')],
    {cwd: work, env: {...process.env, FIRESIDE_CONTROL_STDIN: '1'}, stdio: ['pipe', 'pipe', 'pipe']});
  const exited = once(peer, 'exit');
  let log = ''; for (const stream of [peer.stdout, peer.stderr]) stream.on('data', chunk => { log += chunk; });
  let browser;
  const errors = [];
  try {
    const deadline = Date.now() + 30000;
    while (true) {
      assert.equal(peer.exitCode, null, log);
      try { const response = await fetch(`${control}:ruleCoverage`, {signal: AbortSignal.timeout(500)}); await response.arrayBuffer(); if (response.ok) break; } catch {}
      assert.ok(Date.now() < deadline, log); await delay(50);
    }
    const executablePath = [process.env.PHASE4_BROWSER_EXECUTABLE,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
    browser = await chromium.launch({headless: true, ...(executablePath ? {executablePath} : {})});
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${control}:ruleCoverage.html`);
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('Actual evaluator visits'));
    assert.equal(await page.title(), 'Firestore Rule Coverage Report');
    assert.equal(await page.locator('#source').textContent(), source);
    assert.ok(await page.locator('.coverage-expr').count() > 0);
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    const read = await fetch(`${origin}/v1/projects/${project}/databases/(default)/documents/items/one`);
    assert.equal(read.status, 404); // allowed request, no seeded document
    await page.getByRole('button', {name: 'Refresh coverage'}).click();
    await page.waitForFunction(() => document.querySelector('.coverage-expr summary')?.textContent.includes('1 retained visits'));
    await page.locator('.coverage-expr').first().locator('summary').click();
    assert.ok((await page.locator('.coverage-expr').first().innerText()).includes('boolValue'));
    const actual = await (await fetch(`${control}:ruleCoverage`)).json();
    assert.equal(actual.report[0].values[0].count, 1);
    assert.equal(actual.report[0].values[0].value.boolValue, true);
    const invalid = await fetch(`${control}:securityRules`, {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({source: 'broken'})});
    assert.equal(invalid.status, 400);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.coverage-expr summary')?.textContent.includes('1 retained visits'));
    assert.equal(await page.locator('#source').textContent(), source);
    await page.screenshot({path: join(work, 'coverage.png'), fullPage: true});
    assert.deepEqual(errors, []);
    await writeFile(join(work, 'result.json'), JSON.stringify({passed:true, browser:browser.version(), checks:['source','counts','manual-refresh','reload','invalid-reload','unicode','no-script-injection','no-page-or-console-errors']}, null, 2));
    console.log(`Coverage browser evidence: ${work}`);
  } catch (error) {
    const page = browser?.contexts()[0]?.pages()[0];
    await page?.screenshot({path: join(work, 'failure.png'), fullPage: true}).catch(() => {});
    await writeFile(join(work, 'failure.json'), JSON.stringify({message:error.message, errors}, null, 2));
    throw error;
  } finally {
    await browser?.close();
    await writeFile(join(work, 'server.log'), log);
    if (peer.exitCode === null && peer.signalCode === null) peer.stdin.end('FIRESIDE_SHUTDOWN\n');
    const result = await Promise.race([exited, delay(10000, null, {ref:false})]);
    if (!result && peer.exitCode === null && peer.signalCode === null) { peer.kill('SIGTERM'); await exited; }
    assert.ok(result, 'isolated peer must exit cleanly through its private shutdown pipe');
    assert.equal(result[0], 0, log);
  }
});
