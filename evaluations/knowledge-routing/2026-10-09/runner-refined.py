from pathlib import Path
import json,subprocess,time
root=Path(Path('/private/tmp/temari-routing-live-path').read_text().strip())
f=json.loads((root/'fixture.json').read_text())
server_args=['-m','knowledge_agent.cli','mcp','serve','--workspace',str(root/'registry'),'--profile','source-read-only','--allow-source',f['sourceId']]
server='{ command = '+json.dumps(f['python'])+', args = '+json.dumps(server_args)+' }'
cases={
'research-refined':'For the Cobalt pilot, how should we handle a station that stops sending heartbeats when reporting uptime? Give the relevant project rule and any unresolved assumptions.',
'engineering-refined':'Explain why station-report.js subtracts unknown minutes. Is that consistent with the Cobalt pilot policy? This is an explanation request; leave the product unchanged.',

}
results=[]
for name,prompt in cases.items():
 args=['codex','exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','workspace-write','--json','--color','never','-c','approval_policy="never"','-c','web_search="disabled"','-c','mcp_servers.temari_fixture='+server,'-C',str(root/name),'-']
 print('Starting '+name,flush=True)
 start=time.monotonic()
 with (root/(name+'.jsonl')).open('w') as out, (root/(name+'.stderr')).open('w') as err:
  p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=out,stderr=err,text=True)
  try:
   p.communicate(prompt,timeout=105)
   result={'case':name,'exitCode':p.returncode,'elapsedSeconds':round(time.monotonic()-start,1)}
  except subprocess.TimeoutExpired:
   p.terminate()
   try:p.wait(timeout=10)
   except subprocess.TimeoutExpired:p.kill();p.wait()
   result={'case':name,'exitCode':p.returncode,'elapsedSeconds':round(time.monotonic()-start,1),'timeout':True}
 results.append(result)
 print(json.dumps(result),flush=True)
 if p.returncode and name=='research':
  print('First live probe failed; retained local logs, stopping dependent trials.',flush=True)
  break
(root/'results-refined.json').write_text(json.dumps(results,indent=2)+'\n')
