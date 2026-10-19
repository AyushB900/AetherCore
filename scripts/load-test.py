#!/usr/bin/env python3
"""Bounded hot-account HTTP benchmark. Run only against your own isolated demo deployment."""
import argparse
import concurrent.futures
import datetime
import json
import math
import os
import platform
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--url',default='http://localhost:8080')
parser.add_argument('--requests',type=int,default=200)
parser.add_argument('--concurrency',type=int,default=16)
parser.add_argument('--output',type=Path)
args=parser.parse_args()
if not 1<=args.requests<=10000 or not 1<=args.concurrency<=64:
    parser.error('Use 1–10,000 requests and 1–64 workers')
key=os.environ.get('AETHER_API_KEY')
if not key:parser.error('Export AETHER_API_KEY; do not pass credentials on the command line')
base=args.url.rstrip('/')

def request(method,path,body=None,request_key=None):
    headers={'Content-Type':'application/json','X-API-Key':key}
    if request_key:headers['Idempotency-Key']=request_key
    req=urllib.request.Request(base+'/api/v1'+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method)
    started=time.perf_counter()
    try:
        with urllib.request.urlopen(req,timeout=45) as response:
            return response.status,json.load(response),(time.perf_counter()-started)*1000
    except urllib.error.HTTPError as error:
        return error.code,json.load(error),(time.perf_counter()-started)*1000

def must(method,path,body=None,request_key=None):
    status,body,_=request(method,path,body,request_key)
    if status not in (200,201):raise RuntimeError(f'{path} failed with HTTP {status}: {body.get("code","unknown")}')
    return body

def percentile(values,p):return sorted(values)[max(0,math.ceil(p*len(values))-1)]
def git(*cmd):
    try:return subprocess.check_output(['git',*cmd],text=True).strip()
    except (OSError,subprocess.CalledProcessError):return 'unavailable'

a=must('POST','/accounts',{'ownerName':'Load test sender','currency':'USD'})['id']
b=must('POST','/accounts',{'ownerName':'Load test recipient','currency':'USD'})['id']
for account in [a,b]:must('POST','/deposits',{'destinationId':account,'amountMinor':(args.requests+32)*100,'currency':'USD'},str(uuid.uuid4()))
before=must('GET','/reconciliation')

def payment(i):
    body={'sourceId':a if i%2==0 else b,'destinationId':b if i%2==0 else a,'amountMinor':100,'currency':'USD'}
    return request('POST','/transfers',body,str(uuid.uuid4()))
started=time.perf_counter()
with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
    results=list(pool.map(payment,range(args.requests)))
elapsed=time.perf_counter()-started
errors=[status for status,_,_ in results if status!=201]
ids={body.get('id') for status,body,_ in results if status==201}
if errors or len(ids)!=args.requests:raise RuntimeError(f'Load check failed: {len(errors)} HTTP failures or duplicate receipts')
retry_key=str(uuid.uuid4());payload={'sourceId':a,'destinationId':b,'amountMinor':100,'currency':'USD'}
with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
    retries=list(pool.map(lambda _:request('POST','/transfers',payload,retry_key),range(32)))
if sum(status==201 for status,_,_ in retries)!=1 or sum(status==200 for status,_,_ in retries)!=31 or len({body.get('id') for _,body,_ in retries})!=1:
    raise RuntimeError('Concurrent idempotency invariant failed')
after=must('GET','/reconciliation')
if any(after[field]!=0 for field in ['drifted_accounts','drifted_holds','unbalanced_transfers','net_balance_minor']):raise RuntimeError('Reconciliation drift detected')
if after['transfer_count']-before['transfer_count']!=args.requests+1:raise RuntimeError('Unexpected posting count: run against an isolated instance without other clients')
# Holds remain separate from posted balances; compare account conservation for the funded hot pair.
if must('GET',f'/accounts/{a}')['balanceMinor']+must('GET',f'/accounts/{b}')['balanceMinor']!=2*(args.requests+32)*100:raise RuntimeError('Account conservation failed')
latencies=[latency for _,_,latency in results]
report={'recorded_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'commit':git('rev-parse','HEAD'),'working_tree_dirty':bool(git('status','--porcelain')),
 'environment':{'platform':platform.platform(),'machine':platform.machine(),'available_cpus':len(os.sched_getaffinity(0)) if hasattr(os,'sched_getaffinity') else os.cpu_count(),
  'java_runtime':subprocess.run(['java','-version'],capture_output=True,text=True).stderr.splitlines()[0]},
 'workload':'Unique $1 transfers alternating across one hot account pair; HTTP includes connection setup; 32-request retry batch measured separately.',
 'requests':args.requests,'concurrency':args.concurrency,'duration_seconds':round(elapsed,4),
 'successful_requests_per_second':round(args.requests/elapsed,2),'latency_ms':{p:round(percentile(latencies,q),2) for p,q in [('p50',.5),('p95',.95),('p99',.99)]},
 'http_errors':len(errors),'retry_batch':{'requests':32,'created':1,'replayed':31,'unique_receipts':1},
 'reconciliation':{k:after[k] for k in ['drifted_accounts','drifted_holds','unbalanced_transfers','net_balance_minor']},
 'limitations':['Small development-host sample, not a capacity or production SLO claim.','One hot account pair; not a representative mixed banking workload.','No sustained soak, multi-region latency, or external settlement is measured.','Broker delivery latency is not included in transfer response latency.']}
if args.output:
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
