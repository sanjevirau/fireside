import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

// Locators were first observed in the pinned official UI, not invented DOM models.
export async function observeDeveloperUi({origin,project,work,output,requestId,readyLog='All emulators ready!'}) {
  const executablePath=[process.env.PHASE4_BROWSER_EXECUTABLE,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(path=>path&&existsSync(path));
  const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
  const context=await browser.newContext(); context.setDefaultTimeout(15000);
  // The UI may contain external documentation links. No external request is allowed.
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    return url.hostname==='127.0.0.1'||url.protocol==='data:' ? route.continue():route.abort('blockedbyclient');
  });
  const page=await context.newPage();
  const checks=[],errors=[],exchanges=[],pending=[];
  const watchdog=setTimeout(()=>{errors.push('browser capture exceeded 90-second diagnostic allowance');void browser.close();},90000);
  const checked=name=>{checks.push(name);console.log(JSON.stringify({browserCheckpoint:name}));};
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{
    const url=new URL(response.url());
    if (url.pathname!=='/b' && !url.pathname.startsWith('/identitytoolkit.googleapis.com/') && !url.pathname.startsWith('/v0/') && !url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/emulator/'))return;
    pending.push((async()=>{
      const request=response.request(); let body; try{
        const text=await Promise.race([response.text(),delay(5000,null,{ref:false})]);
        try{body=JSON.parse(text);}catch{body=text?.slice(0,65536);}
      }catch{body=null;}
      // Auth session/token material and upload download tokens are deliberately not fixture data.
      const sanitize=value=>Array.isArray(value)?value.map(sanitize):value&&typeof value==='object'?
        Object.fromEntries(Object.entries(value).filter(([key])=>!/(token|password|salt)/i.test(key)).map(([key,v])=>[key,sanitize(v)])):value;
      let requestBody;try{requestBody=JSON.parse(request.postData());}catch{requestBody=null;}
      exchanges.push({service:Object.keys({auth:1,storage:1,firestore:1}).find(name=>response.url().startsWith(origin(name))),
        method:request.method(),path:url.pathname,queryKeys:[...url.searchParams.keys()].sort(),status:response.status(),
        request:sanitize(requestBody),response:sanitize(body)});
    })());
  });
  const checkpoint=async(name,condition)=>{assert.ok(await condition(),name);checked(name);};
  try {
    await page.goto(origin('ui'));
    await page.getByRole('heading',{name:'Firestore emulator',exact:true}).waitFor();
    const overview=await page.locator('body').innerText();
    assert.ok(overview.includes('Authentication emulator')&&overview.includes('Storage emulator'));
    checked('service-overview-rendered');
    await page.goto(`${origin('ui')}/firestore/default/requests`);
    await page.getByRole('cell',{name:'/databases/(default)/documents/notes/denied',exact:true}).first().waitFor();
    await page.getByRole('cell',{name:'/databases/(default)/documents/notes/denied',exact:true}).first().click();
    await page.getByTestId('request-details').waitFor();
    const details=await page.getByTestId('request-details').innerText();
    assert.ok(details.includes('request.auth')&&details.includes('request.resource')&&details.includes('allow write:'));
    checked('denied-request-rule-and-context-rendered');
    await page.screenshot({path:join(output,'denied-request.png')});
    await page.reload();
    await page.getByTestId('request-details').waitFor();
    checked('request-details-survive-reload-history-replay');
    await page.goto(`${origin('firestore')}/emulator/v1/projects/${project}:ruleCoverage.html`);
    await page.waitForFunction(()=>document.querySelectorAll('.coverage-expr').length>0);
    const coverage={title:await page.title(),expressionCount:await page.locator('.coverage-expr').count(),
      rulesVisible:(await page.locator('body').innerText()).includes('allow write:')};
    assert.ok(coverage.rulesVisible);checked('coverage-html-renders-expressions');
    await page.goto(`${origin('ui')}/firestore/default/data/notes/visible`);
    await page.getByRole('link',{name:'View contents of document with id: visible',exact:true}).waitFor();
    await page.getByRole('listitem').filter({hasText:'title'}).getByRole('button',{name:'Edit field',exact:true}).click();
    await page.getByRole('textbox',{name:'Value',exact:true}).fill('Edited synthetic 中文 🚀');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.getByRole('listitem').filter({hasText:'Edited synthetic 中文 🚀'}).waitFor();
    // The UI updates optimistically; await the server's acknowledged value.
    let doc; const deadline=Date.now()+5000;
    do {
      doc=await (await fetch(`${origin('firestore')}/v1/projects/${project}/databases/(default)/documents/notes/visible`,{headers:{authorization:'Bearer owner'}})).json();
      if(doc.fields.title.stringValue==='Edited synthetic 中文 🚀')break;
      await delay(50);
    } while(Date.now()<deadline);
    assert.equal(doc.fields.title.stringValue,'Edited synthetic 中文 🚀');checked('document-browse-edit-persisted');
    await page.getByRole('button',{name:'Clear all data',exact:true}).click();
    await page.getByRole('button',{name:'Clear',exact:true}).click();
    await page.getByRole('heading',{name:'Delete all data?',exact:true}).waitFor({state:'hidden'});
    const cleared=await fetch(`${origin('firestore')}/v1/projects/${project}/databases/(default)/documents/notes/visible`,{headers:{authorization:'Bearer owner'}});
    assert.equal(cleared.status,404);checked('document-clear-control-persisted');
    await page.goto(`${origin('ui')}/auth`);
    await page.getByRole('button',{name:'Add user',exact:true}).click();
    await page.getByRole('textbox',{name:'Display name (optional)',exact:true}).fill('Synthetic Operator');
    await page.getByRole('textbox',{name:'Email (optional)',exact:true}).fill('operator@example.test');
    await page.getByRole('textbox',{name:'Password',exact:true}).fill('Synthetic-only-123!');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.getByRole('cell',{name:'Synthetic Operator',exact:true}).waitFor();
    checked('auth-create-and-list');
    await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.getByRole('cell',{name:'Synthetic Operator',exact:true}).waitFor();
    checked('auth-list-refresh');
    await page.getByRole('button',{name:'Clear all data',exact:true}).click();
    await page.getByRole('button',{name:'Delete',exact:true}).click();
    await page.getByRole('cell',{name:'Synthetic Operator',exact:true}).waitFor({state:'hidden'});
    checked('auth-clear-control');
    await page.goto(`${origin('ui')}/storage`);
    const upload=join(work,'synthetic.txt');await writeFile(upload,'Independent developer-tool fixture 中文 🚀\n');
    // The table inserts an optimistic row before any upload has committed.
    const [uploaded]=await Promise.all([
      page.waitForResponse(response=>response.url().startsWith(origin('storage')+'/v0/b/')&&response.request().method()==='POST'),
      page.locator('input[type=file]').first().setInputFiles(upload),
    ]);
    assert.equal(uploaded.status(),200,'upload must be acknowledged before inspecting the object');
    await page.getByRole('row').filter({hasText:'synthetic.txt'}).waitFor();
    checked('storage-upload-and-list');
    const bytes=await (await fetch(`${origin('storage')}/v0/b/${project}.appspot.com/o/synthetic.txt?alt=media`)).text();
    assert.equal(bytes,'Independent developer-tool fixture 中文 🚀\n');checked('storage-upload-bytes-preserved');
    await page.getByRole('row').filter({hasText:'synthetic.txt'}).click();
    await page.getByRole('button',{name:'Custom metadata expand_more',exact:true}).waitFor();
    checked('storage-metadata-panel');
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await page.getByRole('button',{name:'Delete all files',exact:true}).click();
    await page.getByRole('button',{name:'Delete',exact:true}).click();
    await page.getByRole('row').filter({hasText:'synthetic.txt'}).waitFor({state:'hidden'});
    // A temporarily empty loading table is not evidence of completed deletion.
    const deletionDeadline=Date.now()+10000;let deleted;
    do {
      const response=await fetch(`${origin('storage')}/v0/b/${project}.appspot.com/o/synthetic.txt`);
      deleted=response.status===404;await response.arrayBuffer();
      if(deleted)break;await delay(50);
    }while(Date.now()<deletionDeadline);
    assert.equal(deleted,true,'UI deletion must complete on the Storage server');
    checked('storage-clear-control');
    await page.goto(`${origin('ui')}/logs`);
    await page.getByRole('link',{name:'Logs',exact:true}).waitFor();
    await page.getByText(readyLog,{exact:false}).waitFor();
    await checkpoint('logs-history-rendered',async()=>(await page.locator('body').innerText()).includes(readyLog));
    await Promise.all(pending);assert.deepEqual(errors,[]);
    return {browserVersion:browser.version(),checks,coverage,errors,exchanges};
  } catch(error) {
    await Promise.all(pending);
    await writeFile(join(output,'browser-failure.json'),JSON.stringify({message:error.message,checks,errors,
      exchanges,url:page.url(),text:await page.locator('body').innerText({timeout:2000}).catch(()=>'<page unavailable>')},null,2));
    await page.screenshot({path:join(output,'browser-failure.png'),timeout:2000}).catch(()=>{});throw error;
  } finally {clearTimeout(watchdog);await browser.close();}
}
