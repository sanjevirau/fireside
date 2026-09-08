// Real browser SDK contract; only synthetic accounts on an isolated Auth peer.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

export const popupProject = 'demo-fireside-auth-refresh';
const importedUid = 'imported-google-popup-user';
const importedName = 'Popup 中文 😀';
const importedEmail = 'popup@example.test';

export async function observePopup(origin, project = popupProject) {
  const seed = { users: [
    { localId: importedUid, email: importedEmail, displayName: importedName,
      emailVerified: true, providerUserInfo: [{ providerId: 'google.com', rawId: 'google-popup-subject',
        email: importedEmail, displayName: importedName }] },
    { localId: 'github-only-user', email: 'github@example.test', providerUserInfo: [
      { providerId: 'github.com', rawId: 'github-subject', email: 'github@example.test' }] },
  ] };
  const seeded = await fetch(`${origin}/identitytoolkit.googleapis.com/v1/projects/${project}/accounts:batchCreate`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify(seed), signal: AbortSignal.timeout(5000),
  });
  assert.equal(seeded.status, 200);
  assert.deepEqual((await seeded.json()).error ?? [], []);
  const validation = [];
  for (const query of ['', '?apiKey=demo', '?providerId=google.com']) {
    const response = await fetch(`${origin}/emulator/auth/handler${query}`);
    validation.push({ status: response.status, body: await response.text() });
  }
  const bundle = await build({
    stdin: { contents: `
      import { initializeApp } from 'firebase/app';
      import { getAuth, connectAuthEmulator, GoogleAuthProvider, signInWithPopup,
        signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged } from 'firebase/auth';
      const auth = getAuth(initializeApp({apiKey:'synthetic-api-key',authDomain:'${project}.firebaseapp.com',projectId:${JSON.stringify(project)}}, 'popup-regression'));
      connectAuthEmulator(auth, ${JSON.stringify(origin)}, {disableWarnings:true});
      const summarize = user => user && ({uid:user.uid,email:user.email,displayName:user.displayName,
        providers:user.providerData.map(p=>p.providerId)});
      window.popupResult = null;
      window.popupError = null;
      window.authStates = [];
      onAuthStateChanged(auth, user => window.authStates.push(!!user));
      window.probe = { ready:async()=>{await auth.authStateReady();return summarize(auth.currentUser)},
        signOut:()=>signOut(auth), redirectResult:async()=>{
          const result=await getRedirectResult(auth);return result && summarize(result.user);
        }};
      document.getElementById('popup').onclick=()=>{
        window.popupResult=null;window.popupError=null;
        signInWithPopup(auth,new GoogleAuthProvider()).then(result=>{
          window.popupResult={user:summarize(result.user),operationType:result.operationType};
        }).catch(error=>window.popupError=error.code);
      };
      document.getElementById('redirect').onclick=()=>signInWithRedirect(auth,new GoogleAuthProvider());
    `, resolveDir: process.env.AUTH_POPUP_SDK_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)) },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  });
  const server = createServer((req, res) => {
    res.setHeader('content-type', req.url === '/app.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/app.js' ? bundle.outputFiles[0].text : '<button id="popup">Google popup</button><button id="redirect">Google redirect</button><script type="module" src="/app.js"></script>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const appOrigin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = [process.env.PHASE4_BROWSER_EXECUTABLE,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p=>p && existsSync(p));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? {executablePath} : {}) });
  const pageErrors = [], events = [], exchanges = [], pending = [], stages = [], requestFailures = [];
  try {
    const context = await browser.newContext();
    context.setDefaultTimeout(20_000);
    context.on('requestfailed', request=>requestFailures.push({url:request.url(),error:request.failure()?.errorText}));
    context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
    await context.exposeBinding('__observeAuthRelay', (_source, data) => {
      const event = data.data.authEvent;
      const url = new URL(event.urlResponse);
      const profile = JSON.parse(url.searchParams.get('id_token'));
      events.push({ envelopeKeys: Object.keys(data).sort(), storageKey: data.data.storageKey,
        eventKeys: Object.keys(event).sort(), type: event.type, eventIdPresent: !!event.eventId,
        sessionId: event.sessionId, postBody: event.postBody, tenantId: event.tenantId, error: event.error,
        responsePath: url.pathname, responseKeys: [...url.searchParams.keys()].sort(),
        provider: url.searchParams.get('providerId'), claimsKeys: Object.keys(profile).sort() });
    });
    await context.addInitScript({content:`window.addEventListener('message', e => {
      if(e.data && e.data.eventType==='sendAuthEvent') window.__observeAuthRelay(e.data);
    });`});
    context.on('response', response => {
      if (!response.url().includes('/accounts:signInWithIdp')) return;
      pending.push((async () => {
        const request = JSON.parse(response.request().postData());
        const responseBody = await response.json();
        const requestUrl = new URL(request.requestUri);
        exchanges.push({ status: response.status(), requestKeys: Object.keys(request).sort(),
          requestUriPath: requestUrl.pathname, requestUriKeys: [...requestUrl.searchParams.keys()].sort(),
          postBody: request.postBody ?? null, sessionId: request.sessionId,
          returnSecureToken: request.returnSecureToken, returnIdpCredential: request.returnIdpCredential,
          providerId: responseBody.providerId, isNewUser: responseBody.isNewUser,
          existingUidReused: responseBody.localId === importedUid,
          error: responseBody.error?.message ?? null });
      })());
    });
    const page = await context.newPage();
    await page.goto(appOrigin);
    await page.waitForFunction('!!window.probe');
    assert.equal(await page.evaluate('window.probe.ready()'), null);
    const openPopup = async () => {
      const next = page.waitForEvent('popup');
      await page.click('#popup');
      const popup = await next.catch(async error=>{
        throw new Error(JSON.stringify({stage:'open-popup',sdkError:await page.evaluate('window.popupError'),pageErrors,requestFailures}),{cause:error});
      });
      await popup.waitForURL('**/emulator/auth/handler?**');
      await popup.locator('.js-reuse-account').first().waitFor();
      return popup;
    };
    let popup = await openPopup();
    assert.equal(await popup.locator('.js-reuse-account').count(), 1, 'only Google-linked accounts appear');
    assert.ok((await popup.locator('.js-reuse-account').innerText()).includes(importedEmail));
    assert.ok((await popup.locator('.js-reuse-account').innerText()).includes(importedName));
    stages.push('imported-google-picker-provider-filter-unicode');
    await popup.locator('.js-reuse-account').click();
    await page.waitForFunction('window.popupResult || window.popupError');
    assert.equal(await page.evaluate('window.popupError'), null);
    const signedIn = await page.evaluate('window.popupResult');
    assert.deepEqual(signedIn, {user:{uid:importedUid,email:importedEmail,displayName:importedName,providers:['google.com']},operationType:'signIn'});
    if (!popup.isClosed()) await popup.waitForEvent('close');
    stages.push('popup-completes-existing-uid-and-closes');
    assert.equal(await page.evaluate('window.authStates.includes(true)'), true);
    await page.reload(); await page.waitForFunction('!!window.probe');
    assert.equal((await page.evaluate('window.probe.ready()')).uid, importedUid);
    stages.push('reload-restores-auth-user');
    await page.evaluate('window.probe.signOut()');
    popup = await openPopup(); await popup.close();
    await page.waitForFunction('!!window.popupError');
    assert.equal(await page.evaluate('window.popupError'), 'auth/popup-closed-by-user');
    stages.push('popup-cancel-rejects-with-sdk-error');
    popup = await openPopup();
    await popup.locator('.js-new-account').click();
    await popup.locator('#email-input').fill('created@example.test');
    await popup.locator('#display-name-input').fill('New 中文 😀');
    await popup.locator('#sign-in').click();
    await page.waitForFunction('window.popupResult || window.popupError');
    assert.equal(await page.evaluate('window.popupError'), null);
    assert.equal((await page.evaluate('window.popupResult')).user.email, 'created@example.test');
    stages.push('new-google-account-popup');
    await page.evaluate('window.probe.signOut()');
    await page.click('#redirect');
    await page.waitForURL('**/emulator/auth/handler?**');
    await page.locator('.js-reuse-account').filter({hasText:importedEmail}).click();
    await page.waitForURL(appOrigin + '/'); await page.waitForFunction('!!window.probe');
    assert.equal((await page.evaluate('window.probe.redirectResult()')).uid, importedUid);
    stages.push('redirect-roundtrip-existing-uid');
    await Promise.all(pending);
    assert.deepEqual(pageErrors, []);
    assert.equal(exchanges.length, 3);
    assert.equal(events.length, 2);
    return {validation, stages, events, exchanges, pageErrors, browserVersion:browser.version()};
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
  }
}
