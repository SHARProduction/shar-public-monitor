import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const TITLE='SHAR PUBLIC MONITOR ALERT';
export const marker=fixture=>`<!-- shar-public-monitor:${fixture?'fixture':'production'}:incident:v1 -->`;
const stateMarker=fixture=>`<!-- shar-public-monitor:${fixture?'fixture':'production'}:state:v1 -->`;
export const fingerprint=report=>createHash('sha256').update(JSON.stringify(report.checks.filter(x=>!x.ok).map(x=>({id:x.id,code:x.code})).sort((a,b)=>a.id.localeCompare(b.id)))).digest('hex');
export function issueBody(report,runUrl,lastGood) {
  return `${marker(report.fixture)}\n${report.fixture?'**TEST ONLY — synthetic fixture; production incidents are isolated.**\n':''}UTC: ${report.finishedAt}\nRun: ${runUrl}\nLast known good: ${lastGood || 'Not yet observed by this monitor'}\n\nConfirmed failure checks:\n\n${report.checks.filter(x=>!x.ok).map(x=>`- Check: ${x.id}; URL/tool: ${x.url || x.id}; expected: ${x.expected || 'public contract PASS'}; actual: ${JSON.stringify(x.actual ?? x.code)}; code: ${x.code}`).join('\n')}\n\n<!-- fingerprint:${fingerprint(report)} -->\n<!-- failures:${JSON.stringify(report.checks.filter(x=>!x.ok))} -->`;
}
export async function reconcile(report,api,runUrl,trustedActor='github-actions[bot]') {
  const issues=[];
  for(let page=1;page<=20;page++) {
    const batch=await api('GET',`/issues?state=all&per_page=100&page=${page}`);
    issues.push(...batch.filter(x=>!x.pull_request && x.user?.login===trustedActor && x.user?.type==='Bot'));
    if(batch.length<100) break;
    if(page===20) throw new Error('ISSUE_SCAN_BOUND_EXCEEDED');
  }
  const stateIssue=issues.find(x=>x.body?.startsWith(stateMarker(report.fixture)));
  let state={lastGood:null};
  if(stateIssue) { const encoded=stateIssue.body.split('\n')[1]; state=JSON.parse(encoded); }
  const incidents=issues.filter(x=>x.state==='open' && x.body?.startsWith(marker(report.fixture)));
  const priorFailures=incidents.flatMap(issue=>{
    const encoded=issue.body.match(/<!-- failures:(.*) -->/u)?.[1];
    if(!encoded) return [];
    return JSON.parse(encoded);
  });
  const unassessed=priorFailures.filter(prior=>!report.checks.some(current=>current.id===prior.id));
  let action='unchanged';
  if(!report.ok) {
    if(report.confirmed!==true) throw new Error('UNCONFIRMED_FAILURE');
    const combined={...report,checks:[...report.checks,...unassessed]};
    const body=issueBody(combined,runUrl,state.lastGood);
    if(!incidents.length) { await api('POST','/issues',{title:TITLE,body}); action='created'; }
    else if(!incidents[0].body.includes(`<!-- fingerprint:${fingerprint(combined)} -->`)) { await api('POST',`/issues/${incidents[0].number}/comments`,{body}); await api('PATCH',`/issues/${incidents[0].number}`,{body}); action='updated'; }
  } else {
    for(const incident of unassessed.length ? [] : incidents) {
      await api('POST',`/issues/${incident.number}/comments`,{body:`${report.fixture?'TEST ONLY — ':''}Recovered at ${report.finishedAt} UTC. All ${report.mode} checks passed. Run: ${runUrl}`});
      await api('PATCH',`/issues/${incident.number}`,{state:'closed',state_reason:'completed'});
      action='recovered';
    }
    state.lastGood=`${report.finishedAt} — ${runUrl} (${report.mode})`;
  }
  const body=`${stateMarker(report.fixture)}\n${JSON.stringify({...state,lastCheckedAt:report.finishedAt,lastRun:runUrl,status:report.ok?'pass':'fail'})}\n\nMonitor state; updated without comments. ${report.fixture?'TEST ONLY.':'Public status only.'}`;
  if(stateIssue) await api('PATCH',`/issues/${stateIssue.number}`,{body});
  else await api('POST','/issues',{title:report.fixture?'SHAR PUBLIC MONITOR TEST STATE':'SHAR PUBLIC MONITOR STATE',body});
  return {action,fixture:!!report.fixture};
}
async function main() {
  const report=JSON.parse(await readFile('report.json','utf8'));
  if(report.fixture && process.env.GITHUB_EVENT_NAME!=='workflow_dispatch') throw new Error('FIXTURE_REQUIRES_MANUAL_DISPATCH');
  const repo=process.env.GITHUB_REPOSITORY;
  if(!/^[\w.-]+\/[\w.-]+$/u.test(repo || '')) throw new Error('INVALID_REPOSITORY');
  const api=async(method,path,body)=> {
    const response=await fetch(`https://api.github.com/repos/${repo}${path}`,{method,headers:{authorization:`Bearer ${process.env.GITHUB_TOKEN}`,accept:'application/vnd.github+json','content-type':'application/json','x-github-api-version':'2022-11-28'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw new Error(`GITHUB_API_HTTP_${response.status}`);
    return response.json();
  };
  console.log(JSON.stringify(await reconcile(report,api,`${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`)));
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(error=>{console.error(error.message);process.exitCode=1;});
