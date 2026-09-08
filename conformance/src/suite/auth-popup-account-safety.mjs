import assert from 'node:assert/strict';
import { popupProject } from './auth-popup-browser.mjs';

export async function observePopupAccountSafety(origin) {
  const path = `/identitytoolkit.googleapis.com/v1/projects/${popupProject}/accounts`;
  const call = async (endpoint,body,method='POST') => {
    const response = await fetch(origin+endpoint,{method,headers:{'content-type':'application/json',authorization:'Bearer owner'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
    return {status:response.status,body:await response.json()};
  };
  const seeded = await call(path+':batchCreate',{users:[{localId:'linked-safety',email:'linked@example.test',
    providerUserInfo:[{providerId:'google.com',rawId:'linked-google',email:'linked@example.test'},
      {providerId:'github.com',rawId:'linked-github',email:'linked@example.test'}]}]});
  assert.equal(seeded.status,200);
  const credentials = new URLSearchParams({providerId:'google.com',id_token:JSON.stringify({
    sub:'linked-google',email:'linked@example.test',email_verified:true,
  })}).toString();
  const request = {requestUri:`${origin}/emulator/auth/handler?${credentials}`,returnSecureToken:true};
  const signedIn = await call('/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo',request);
  const listed = await call(path+':batchGet',undefined,'GET');
  const providers = listed.body.users.find(user=>user.localId==='linked-safety').providerUserInfo.map(info=>info.providerId).sort();
  await call(path+':update',{localId:'linked-safety',disableUser:true});
  const disabled = await call('/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo',request);
  return {signInStatus:signedIn.status,existingUidReused:signedIn.body.localId==='linked-safety',
    providers,disabledStatus:disabled.status,disabledError:disabled.body.error?.message ?? null};
}
