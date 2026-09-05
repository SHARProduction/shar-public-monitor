import { CONTRACT, REQUESTS, collect, evaluate, boundedBody } from './engine.mjs';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const PROTOCOL = '2026-07-28';
export const REGISTRY = 'https://registry.modelcontextprotocol.io/v0.1/servers/com.sharprod%2Fpublic-knowledge/versions/latest';
const assert = (value, code) => { if (!value) throw new Error(code); };
export function payload(body) {
  if (/^(event:|data:)/u.test(body)) {
    const events = body.split(/\r?\n\r?\n/u).map(block => block.split(/\r?\n/u).filter(x => x.startsWith('data:')).map(x => x.slice(5).trim()).join('\n')).filter(Boolean).map(x => JSON.parse(x));
    return events.find(x => x.id === 1 && (x.result || x.error));
  }
  return JSON.parse(body);
}
export function rpcOptions(method, params = {}, name) {
  return {method:'POST', redirect:'manual', headers:{accept:'application/json, text/event-stream','content-type':'application/json','mcp-protocol-version':PROTOCOL,'mcp-method':method,...(name ? {'mcp-name':name} : {})}, body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':PROTOCOL,'io.modelcontextprotocol/clientInfo':{name:'shar-public-monitor',version:'1.0.0'},'io.modelcontextprotocol/clientCapabilities':{}}}})};
}
export function checkCache(headers) {
  const directives=(headers['cache-control'] || '').toLowerCase().split(',').map(x=>x.trim());
  assert(directives.includes('public'), 'CACHE_PUBLIC_MISSING');
  assert(directives.includes('must-revalidate'), 'CACHE_REVALIDATION_MISSING');
  assert(!directives.some(x=>/^(?:immutable|private)(?:=|$)/u.test(x)), 'CACHE_FORBIDDEN_DIRECTIVE');
  for(const name of ['max-age','s-maxage']) {
    const values=directives.filter(x=>new RegExp(`^${name}(?:=|$)`,'u').test(x));
    if(name==='max-age') assert(values.length>0,'CACHE_MAX_AGE_MISSING');
    assert(values.length<=1,'CACHE_DUPLICATE_AGE');
    for(const value of values) {
      const match=new RegExp(`^${name}=(\\d+)$`,'u').exec(value);
      assert(match && Number(match[1])<=300,'CACHE_AGE_OUT_OF_RANGE');
    }
  }
}
export function checkCall(value) {
  assert(value?.jsonrpc === '2.0' && value.id === 1 && !value.error, 'MCP_PROTOCOL_ERROR');
  assert(value.result?.isError === false, 'MCP_IS_ERROR_NOT_FALSE');
  const structured = value.result.structuredContent;
  assert(structured?.ok === true, 'MCP_STRUCTURED_NOT_OK');
  for (const [key, expected] of Object.entries(CONTRACT.knowledge)) assert(structured.lineage?.[key] === expected, `MCP_LINEAGE_${key}`);
  return structured.data;
}
export async function run(mode = 'fast', fetchImpl = globalThis.fetch) {
  assert(['fast','full'].includes(mode), 'INVALID_MODE');
  const startedAt = new Date().toISOString();
  const observations = await collect({fetchImpl});
  const base = evaluate(observations);
  const checks = base.checks.map(check => ({...check,url:REQUESTS.find(x => x.id === check.id).url,expected:check.id === 'contactsAlias' ? 'HTTP 301 canonical contact redirect' : check.id === 'leadMethodGuard' ? 'HTTP 405 method_not_allowed' : 'HTTP 200; frozen public contract',actual:{status:observations[check.id]?.status ?? null,code:check.code}}));
  let attempts = Object.values(observations).reduce((n,x) => n+x.attempts.length,0);
  async function request(id,url,validate,options={method:'GET',redirect:'manual',headers:{accept:'*/*'}}) {
    let observed;
    attempts++;
    try {
      const response = await fetchImpl(url,{...options,signal:AbortSignal.timeout(CONTRACT.timeoutMs)});
      observed = {status:response.status,headers:Object.fromEntries([...response.headers].filter(([key]) => ['content-type','cache-control','location'].includes(key))),body:(await boundedBody(response)).toString('utf8')};
      assert(observed.status === 200,`HTTP_${observed.status}`);
      const data = validate(observed);
      checks.push({id,url,ok:true,code:'PASS',expected:'HTTP 200; public protocol/content/cache contract',actual:{status:observed.status,headers:observed.headers}});
      return data;
    } catch(error) {
      checks.push({id,url,ok:false,code: error.name === 'TimeoutError' ? 'TRANSPORT_TIMEOUT' : error.message,expected:'HTTP 200; public protocol/content/cache contract',actual:{status:observed?.status ?? null,headers:observed?.headers ?? {}}});
      return null;
    }
  }
  // Additional assertions reuse the observations from the original ten fixed requests.
  for (const id of ['serverCard','websiteLineage','sitemap','websiteRobots','mcpRobots']) {
    try {
      const observed=observations[id];
      assert(observed && !observed.error,'OBSERVATION_MISSING');
      const expected=id==='sitemap' ? /(?:application|text)\/xml/iu : id.endsWith('Robots') ? /text\/plain/iu : /application\/(?:mcp-server-card\+)?json/iu;
      assert(expected.test(observed.headers['content-type'] || ''),'CONTENT_TYPE');
      if(['serverCard','mcpRobots'].includes(id)) checkCache(observed.headers);
      else assert(/(?:max-age=\d+|no-cache|no-store)/iu.test(observed.headers['cache-control'] || ''),'CACHE_POLICY_MISSING');
      checks.push({id:`${id}.headers`,url:REQUESTS.find(x=>x.id===id).url,ok:true,code:'PASS'});
    } catch(error) { checks.push({id:`${id}.headers`,url:REQUESTS.find(x=>x.id===id).url,ok:false,code:error.message,expected:'public cache-control with max-age and matching content type',actual:{status:observations[id]?.status,headers:observations[id]?.headers}}); }
  }
  await request('mcpHome',`${CONTRACT.mcp}/`,o=> { assert(/text\/html/iu.test(o.headers['content-type'] || ''),'CONTENT_TYPE'); assert(o.body.includes(CONTRACT.endpoint),'MCP_HOME_ENDPOINT'); });
  await request('a2aCard',`${CONTRACT.mcp}/.well-known/agent-card.json`,o=> {
    assert(/application\/json/iu.test(o.headers['content-type'] || ''),'CONTENT_TYPE'); checkCache(o.headers);
    const card=JSON.parse(o.body); assert(card.provider?.url === CONTRACT.website,'A2A_PROVIDER');
    assert(card.supportedInterfaces?.some(x=>x.url===`${CONTRACT.mcp}/a2a`),'A2A_ENDPOINT');
    assert(Array.isArray(card.skills) && card.skills.length>0,'A2A_SKILLS');
  });
  await request('registryLatest',REGISTRY,o=> {
    assert(/application\/json/iu.test(o.headers['content-type'] || ''),'CONTENT_TYPE');
    const value=JSON.parse(o.body), official=value._meta?.['io.modelcontextprotocol.registry/official'];
    assert(official?.status==='active' && official.isLatest===true,'REGISTRY_NOT_ACTIVE_LATEST');
    assert(value.server?.name==='com.sharprod/public-knowledge' && value.server.remotes?.some(x=>x.url===CONTRACT.endpoint),'REGISTRY_ENDPOINT');
    const meta=value.server._meta?.['io.modelcontextprotocol.registry/publisher-provided']?.['com.sharprod/discovery'];
    for(const [key,expected] of Object.entries(CONTRACT.knowledge)) assert(meta?.[key]===expected,`REGISTRY_LINEAGE_${key}`);
    assert(meta?.readOnly===true && meta.toolCount===15 && meta.writeToolCount===0 && meta.canonicalContactUrl===`${CONTRACT.website}/contact.html`,'REGISTRY_PUBLIC_CONTRACT');
  });
  const rpc = (id,method,params,name,validator) => request(id,CONTRACT.endpoint,o=> {assert(/(?:application\/json|text\/event-stream)/iu.test(o.headers['content-type'] || ''),'MCP_CONTENT_TYPE'); const value=payload(o.body); return validator(value);},rpcOptions(method,params,name));
  await request('initialize',CONTRACT.endpoint,o=> { assert(/(?:application\/json|text\/event-stream)/iu.test(o.headers['content-type'] || ''),'MCP_CONTENT_TYPE'); const value=payload(o.body); assert(!value?.error && value?.result?.protocolVersion==='2025-11-25' && value.result.serverInfo?.name==='shar-public-knowledge','INITIALIZE_PROTOCOL'); }, {method:'POST',redirect:'manual',headers:{accept:'application/json, text/event-stream','content-type':'application/json','mcp-method':'initialize'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'shar-public-monitor',version:'1.0.0'}}})});
  const call = (name,args) => rpc(`tool.${name}`,'tools/call',{name,arguments:args},name,checkCall);
  const services=await call('list_services',{limit:2,locale:'en'});
  await call('get_organization_facts',{});
  await call('search_knowledge',{query:'video production',limit:2,locale:'en'});
  if(mode==='full') {
    const cases=await call('search_cases',{query:'video production',limit:2,locale:'en'});
    const serviceId=services?.services?.[0]?.id, caseId=cases?.hits?.find(x=>x.collection==='cases')?.id;
    const calls={get_service:{serviceId},get_price:{serviceId},compare_production_methods:{methods:['ai','hybrid'],locale:'en'},get_case:{caseId},get_public_evidence:{subjectId:caseId,limit:2},get_public_clients:{limit:2},get_industry_experience:{industry:'retail',limit:2},get_timeline_context:{query:'production schedule',limit:2},get_deliverables:{serviceId,locale:'en'},get_brief_requirements:{locale:'en'},get_media_provenance:{}};
    for(const [name,args] of Object.entries(calls)) {
      if(Object.values(args).includes(undefined)) { checks.push({id:`tool.${name}`,url:CONTRACT.endpoint,ok:false,code:'PUBLIC_ID_DEPENDENCY_MISSING',expected:'ID from successful public list/search',actual:'missing'}); continue; }
      await call(name,args);
    }
  }
  return {schemaVersion:'1.0.0',mode,startedAt,finishedAt:new Date().toISOString(),ok:checks.every(x=>x.ok),checks,metrics:base.metrics,lineage:base.lineage,requestAttempts:attempts,attemptBudget:mode==='full'?31:19};
}
export function fixture(mode) {
  assert(['fixture-failure','fixture-recovery'].includes(mode),'INVALID_FIXTURE');
  return {schemaVersion:'1.0.0',mode,fixture:true,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),ok:mode==='fixture-recovery',confirmed:true,requestAttempts:0,checks:[{id:'TEST.synthetic',url:'https://example.invalid/monitor-test',ok:mode==='fixture-recovery',code:mode==='fixture-recovery'?'PASS':'TEST_FAILURE',expected:'synthetic HTTP 200',actual:{status:mode==='fixture-recovery'?200:503,protocol:'TEST ONLY'}}]};
}
async function main() {
  const mode=process.argv[2] || 'fast';
  let report;
  if(mode.startsWith('fixture-')) {
    assert(process.env.GITHUB_EVENT_NAME==='workflow_dispatch' || process.env.MONITOR_LOCAL_FIXTURE==='1','FIXTURE_REQUIRES_MANUAL_DISPATCH');
    report=fixture(mode);
  } else {
    report=await run(mode);
    if(!report.ok) {
      const first=report;
      report=await run(mode);
      report.confirmation={firstFinishedAt:first.finishedAt,firstFailures:first.checks.filter(x=>!x.ok),firstAttempts:first.requestAttempts};
      report.confirmed=!report.ok && report.checks.filter(x=>!x.ok).every(current=>first.checks.some(prior=>!prior.ok && prior.id===current.id && prior.code===current.code));
    }
  }
  await writeFile('report.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  if(!report.ok) process.exitCode=2;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(async()=> { const report={schemaVersion:'1.0.0',ok:false,confirmed:true,mode:process.argv[2]||'fast',finishedAt:new Date().toISOString(),checks:[{id:'monitorRuntime',ok:false,code:'MONITOR_RUNTIME_ERROR',url:'monitor runtime',expected:'completed checks',actual:'runtime failure'}]}; await writeFile('report.json',JSON.stringify(report,null,2)); console.error('MONITOR_RUNTIME_ERROR'); process.exitCode=4; });
