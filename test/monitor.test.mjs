import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT, boundedBody, collect, REQUESTS, deduplicate } from '../scripts/engine.mjs';
import { PROTOCOL, rpcOptions, payload, checkCall, checkCache, fixture } from '../scripts/monitor.mjs';
import { reconcile, marker, TITLE } from '../scripts/alert.mjs';

test('modern RPC headers and metadata match public contract',()=>{
 const options=rpcOptions('tools/call',{name:'list_services',arguments:{}},'list_services');
 assert.equal(options.headers['mcp-name'],'list_services');
 assert.equal(JSON.parse(options.body).params._meta['io.modelcontextprotocol/protocolVersion'],PROTOCOL);
 assert.equal(options.headers.accept,'application/json, text/event-stream');
});
test('SSE parser selects response by request ID',()=>{assert.deepEqual(payload('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n').result,{ok:true});});
test('tool calls require explicit isError false and frozen lineage',()=>{
 const value={jsonrpc:'2.0',id:1,result:{isError:false,structuredContent:{ok:true,lineage:{...CONTRACT.knowledge},data:{id:'public'}}}};
 assert.deepEqual(checkCall(value),{id:'public'});
 for(const mutate of [x=>delete x.result.isError,x=>x.result.isError=true,x=>x.result.structuredContent.lineage.sourceSiteSha='bad',x=>x.error={code:-1}]) {const clone=structuredClone(value);mutate(clone);assert.throws(()=>checkCall(clone));}
});
test('missing A2A cache policy is a failure',()=>{assert.throws(()=>checkCache({}));checkCache({'cache-control':'public, max-age=300, must-revalidate'});});
test('mutable cache contract rejects excessive, ambiguous, or private caching',()=>{
 for(const value of ['public, max-age=31536000, must-revalidate','public, max-age=300','public, max-age=300, must-revalidate, immutable','public, max-age=300, must-revalidate, private','public, max-age=300, must-revalidate, private="set-cookie"','public, max-age=300, max-age=60, must-revalidate','public, max-age=300, s-maxage=301, must-revalidate','public, max-age=300, s-maxage=300, s-maxage=60, must-revalidate','public, max-age=abc, must-revalidate']) assert.throws(()=>checkCache({'cache-control':value}),value);
 checkCache({'cache-control':'public, max-age=0, s-maxage=300, must-revalidate'});
});
test('body size is bounded',async()=>{await assert.rejects(()=>boundedBody(new Response('x',{headers:{'content-length':String(CONTRACT.maxBytes+1)}})),/RESPONSE_TOO_LARGE/);});
test('base transport preserves ten checks within twelve attempts',async()=>{
 let calls=0;const observations=await collect({fetchImpl:async()=>{calls++;throw new Error('offline');}});
 assert.equal(Object.keys(observations).length,REQUESTS.length);assert.equal(calls,12);
});
test('base event dedup emits one failure then recovery',()=>{
 const failed={ok:false,checks:[{id:'home',ok:false,code:'HTTP_500'}]};
 const first=deduplicate(null,failed,'1');assert.equal(first.event.type,'failure');
 assert.equal(deduplicate(first.state,failed,'2').event,null);
 assert.equal(deduplicate(first.state,{ok:true,checks:[]},'3').event.type,'recovery');
});
function fakeApi(seed=[]) {
 const issues=structuredClone(seed),calls=[];
 return {issues,calls,api:async(method,path,body)=>{
  calls.push({method,path,body});
  if(method==='GET') return structuredClone(issues);
  if(method==='POST' && path==='/issues'){const issue={number:issues.length+1,state:'open',user:{login:'github-actions[bot]',type:'Bot'},...body};issues.push(issue);return issue;}
  const number=Number(path.split('/')[2]);const issue=issues.find(x=>x.number===number);
  if(method==='PATCH'){Object.assign(issue,body);return issue;}
  if(path.endsWith('/comments')) return {id:calls.length};
  throw new Error('unexpected API');
 }};
}
test('issue failure dedup and recovery, production/fixture isolation',async()=>{
 const prod={number:1,state:'open',user:{login:'github-actions[bot]',type:'Bot'},title:TITLE,body:marker(false)+'\nproduction incident'};
 const fake=fakeApi([prod]);
 assert.equal((await reconcile(fixture('fixture-failure'),fake.api,'https://github.com/run/1')).action,'created');
 assert.equal((await reconcile(fixture('fixture-failure'),fake.api,'https://github.com/run/2')).action,'unchanged');
 assert.equal(fake.issues.filter(x=>x.title===TITLE).length,2);
 assert.equal((await reconcile(fixture('fixture-recovery'),fake.api,'https://github.com/run/3')).action,'recovered');
 assert.equal(fake.issues[0].state,'open');assert.equal(fake.issues[1].state,'closed');
 assert.equal(fake.calls.filter(x=>x.path.endsWith('/comments')).length,1);
});
test('last known good persists across successful runs and alert includes it',async()=>{
 const fake=fakeApi();await reconcile(fixture('fixture-recovery'),fake.api,'https://github.com/good');
 await reconcile(fixture('fixture-failure'),fake.api,'https://github.com/bad');
 assert.match(fake.issues.find(x=>x.title===TITLE).body,/https:\/\/github.com\/good/);
});
test('unconfirmed production failures cannot open an incident',async()=>{
 const fake=fakeApi();await assert.rejects(()=>reconcile({...fixture('fixture-failure'),fixture:false,confirmed:false},fake.api,'run'),/UNCONFIRMED/);
 assert.equal(fake.issues.length,0);
});
test('fast success cannot close an uncovered full-only failure',async()=>{
 const fake=fakeApi();const failed={...fixture('fixture-failure'),fixture:false,mode:'full',checks:[{id:'tool.get_case',ok:false,code:'MCP_ERROR'}]};
 await reconcile(failed,fake.api,'full-failure');
 await reconcile({...failed,ok:true,mode:'fast',checks:[{id:'tool.list_services',ok:true,code:'PASS'}]},fake.api,'fast-pass');
 assert.equal(fake.issues.find(x=>x.title===TITLE).state,'open');
 await reconcile({...failed,ok:true,checks:[{id:'tool.get_case',ok:true,code:'PASS'}]},fake.api,'full-pass');
 assert.equal(fake.issues.find(x=>x.title===TITLE).state,'closed');
});
test('forged user incident and malformed state markers are ignored',async()=>{
 const fake=fakeApi([
  {number:1,state:'open',user:{login:'attacker',type:'User'},title:TITLE,body:marker(true)+'\nforged'},
  {number:2,state:'open',user:{login:'attacker',type:'User'},title:'SHAR PUBLIC MONITOR TEST STATE',body:'<!-- shar-public-monitor:fixture:state:v1 -->\ninvalid JSON'},
  {number:3,state:'open',user:{login:'github-actions[bot]',type:'User'},title:TITLE,body:marker(true)+'\nforged type'},
  {number:4,state:'open',user:{login:'other[bot]',type:'Bot'},title:TITLE,body:marker(true)+'\nwrong bot'},
 ]);
 assert.equal((await reconcile(fixture('fixture-failure'),fake.api,'failure')).action,'created');
 assert.equal((await reconcile(fixture('fixture-failure'),fake.api,'repeat')).action,'unchanged');
 assert.equal((await reconcile(fixture('fixture-recovery'),fake.api,'recovery')).action,'recovered');
 for(const issue of fake.issues.slice(0,4)) assert.equal(issue.state,'open');
 assert.equal(fake.issues[4].state,'closed');
 assert.equal(fake.calls.filter(x=>x.method==='PATCH' && /^\/issues\/[1-4]$/u.test(x.path)).length,0);
});
