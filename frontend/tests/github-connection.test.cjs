const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../src/lib/github-connection.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
function setup({blocked=false,startError=null,authUrl='https://github.com/login/oauth/authorize?state=opaque',connected=true}={}){
  const messages = new Set(), timers = new Map(), requests = [];
  let nextTimer=0;
  const popup = {closed:false,location:{href:'about:blank'},close(){this.closed=true;}};
  const window={location:{origin:'http://frontend:3000'},open:()=>blocked?null:popup,addEventListener:(type,fn)=>messages.add(fn),removeEventListener:(type,fn)=>messages.delete(fn)};
  const axios={post:async(url,body,config)=>{requests.push({url,body,config});if(startError)throw startError;return{data:{authorization_url:authUrl}};},get:async(url,config)=>{requests.push({url,config});return{data:{connected,repos:[]}};},delete:async(url,config)=>{requests.push({url,config});return{data:{deleted:true}};}};
  const context={exports:{},URL,DOMException,window,Date,setInterval:fn=>{timers.set(++nextTimer,fn);return nextTimer;},clearInterval:id=>timers.delete(id),require:()=>({API_BASE:'http://backend:8000',authedAxios:axios})};
  vm.runInNewContext(compiled,context);
  return {...context.exports,popup,requests,messages,timers,send:(overrides={})=>{for(const fn of messages)fn({origin:'http://backend:8000',source:popup,data:{source:'github-connection',connected:true},...overrides});}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('GitHub connection starts with authenticated POST and accepts only the backend popup response',async()=>{
  const env=setup();const pending=env.connectGithubAccount();await tick();
  assert.equal(env.requests[0].url,'http://backend:8000/auth/github/connect/');
  assert.ok(env.popup.location.href.startsWith('https://github.com/login/oauth/authorize'));
  let complete=false;pending.then(()=>complete=true);
  env.send({origin:'https://evil.example'});env.send({source:{}});env.send({data:{source:'github-oauth',connected:true}});await tick();assert.equal(complete,false);
  env.send();await pending;assert.equal(env.messages.size,0);assert.equal(env.timers.size,0);assert.equal(env.popup.closed,true);
});
test('authorization denial is shown and popup/listeners are cleaned up',async()=>{
  const env=setup();const pending=env.connectGithubAccount();await tick();env.send({data:{source:'github-connection',connected:false,error:'Repository access denied'}});
  await assert.rejects(pending,/Repository access denied/);assert.equal(env.messages.size,0);assert.equal(env.timers.size,0);
});
test('closing the authorization popup allows reconnect instead of leaving the form busy',async()=>{
  const env=setup({connected:false});const pending=env.connectGithubAccount();await tick();env.popup.closed=true;for(const fn of [...env.timers.values()])fn();await assert.rejects(pending,/cancelled/);assert.equal(env.messages.size,0);
});
test('unmounting aborts the pending OAuth popup',async()=>{
  const env=setup(), controller=new AbortController();const pending=env.connectGithubAccount(controller.signal);await tick();controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(env.messages.size,0);assert.equal(env.timers.size,0);assert.equal(env.popup.closed,true);
});
test('blocked popup, startup errors and untrusted authorization URLs do not navigate or hang',async()=>{
  const blocked=setup({blocked:true});await assert.rejects(blocked.connectGithubAccount(),/Allow pop-ups/);assert.equal(blocked.requests.length,0);
  for(const options of [{startError:new Error('GitHub unavailable')},{authUrl:'https://evil.example/authorize'}]){
    const env=setup(options);await assert.rejects(env.connectGithubAccount());assert.equal(env.popup.closed,true);assert.equal(env.messages.size,0);assert.equal(env.timers.size,0);
  }
});
test('private repository selection requests the requested page with cancellation',async()=>{
  const env=setup(), controller=new AbortController();await env.githubRepositories('workspace-root',2,controller.signal);assert.equal(env.requests[0].url,'http://backend:8000/sandbox/sandboxes/workspace-root/github/repos/');assert.equal(env.requests[0].config.params.page,2);assert.equal(env.requests[0].config.signal,controller.signal);
});

test('OAuth popup with unavailable postMessage verifies the saved GitHub connection',async()=>{
  const env=setup();const pending=env.connectGithubAccount(undefined,'workspace-root');await tick();env.popup.closed=true;for(const fn of [...env.timers.values()])fn();await pending;assert.equal(env.requests[1].url,'http://backend:8000/sandbox/sandboxes/workspace-root/github/repos/');assert.equal(env.messages.size,0);assert.equal(env.timers.size,0);
});

test('disconnecting a GitHub account sends an authenticated DELETE with cancellation',async()=>{
  const env=setup(), controller=new AbortController();
  assert.equal(await env.disconnectGithubAccount('user/42',controller.signal),true);
  assert.equal(env.requests[0].url,'http://backend:8000/auth/github/accounts/user%2F42/');
  assert.equal(env.requests[0].config.signal,controller.signal);
});
