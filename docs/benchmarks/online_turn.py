"""Compare cold Codex exec and the app-server transport with the same online provider.

The loopback relay only measures the first text delta. It forwards the fixed test
request to the HTTPS Responses endpoint configured in the caller's Codex home.
No request bodies, response text or credentials are written to disk or stdout.
"""
import asyncio
import hmac
import http.client
import json
import os
import secrets
import shutil
import tempfile
import threading
import time
import tomllib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

PROMPT = 'Reply with these words only, in this order: amber river silver cloud.'
MODEL = os.getenv('BENCH_MODEL', 'gpt-6.2-astra')


async def main():
    cfg = tomllib.loads((Path(os.environ['CODEX_HOME']) / 'config.toml').read_text())
    provider = cfg['model_providers'][cfg['model_provider']]
    upstream = urlsplit(provider['base_url'])
    if upstream.scheme != 'https' or upstream.username or upstream.password or upstream.query or upstream.fragment:
        raise ValueError('Expected a configured HTTPS provider base URL')
    api_key = os.environ[provider['env_key']]
    local_secret = secrets.token_hex(24)
    samples = []

    class Relay(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            if self.path != '/v1/responses' or not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + local_secret):
                self.send_error(403); return
            if self.headers.get('Content-Encoding', 'identity') != 'identity':
                self.send_error(415); return
            body = self.rfile.read(int(self.headers['Content-Length']))
            request = json.loads(body)
            sample = dict(model=request['model'], tier=request.get('service_tier', 'default'),
                          effort=(request.get('reasoning') or {}).get('effort', 'default'), sent=time.monotonic())
            samples.append(sample)
            conn = http.client.HTTPSConnection(upstream.hostname, upstream.port, timeout=70)
            try:
                conn.request('POST', upstream.path.rstrip('/') + '/responses', body=body,
                             headers={'Authorization': 'Bearer ' + api_key, 'Content-Type': 'application/json', 'Accept': 'text/event-stream'})
                resp = conn.getresponse(); sample['status'] = resp.status
                self.send_response(resp.status)
                self.send_header('Content-Type', resp.getheader('Content-Type', 'text/event-stream'))
                self.send_header('Connection', 'close'); self.end_headers()
                if resp.status != 200:
                    return
                while line := resp.readline():
                    if line.startswith(b'data:'):
                        try:
                            event = json.loads(line[5:])
                            if event.get('type') == 'response.output_text.delta' and event.get('delta'):
                                sample.setdefault('first', time.monotonic())
                        except ValueError:
                            pass
                    self.wfile.write(line); self.wfile.flush()
            except (OSError, http.client.HTTPException):
                sample['network_error'] = True
            finally:
                conn.close()

    server = ThreadingHTTPServer(('127.0.0.1', 0), Relay)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    binary = shutil.which('codex')
    async def trial(mode):
        with tempfile.TemporaryDirectory() as home:
            settings = f'''model={json.dumps(MODEL)}
model_provider="benchmark"
model_reasoning_effort="low"
check_for_update_on_startup=false
[model_providers.benchmark]
name="Benchmark"
base_url="http://127.0.0.1:{server.server_port}/v1"
wire_api="responses"
env_key="BENCH_LOCAL_KEY"
supports_websockets=false
request_max_retries=0
stream_max_retries=0
'''
            Path(home, 'config.toml').write_text(settings)
            env = {k:os.environ[k] for k in ('PATH','LD_LIBRARY_PATH','TMPDIR','ANDROID_ROOT','ANDROID_DATA') if k in os.environ}
            env.update(HOME=home,CODEX_HOME=home,CODEX_SELF_EXE=binary,BENCH_LOCAL_KEY=local_secret)
            args = ['exec','--json','--ephemeral','--skip-git-repo-check','-s','read-only',PROMPT] if mode=='exec' else ['app-server','--listen','stdio://']
            prev = len(samples); begin = time.monotonic()
            proc = await asyncio.create_subprocess_exec(binary,*args,cwd=home,env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL)
            async def receive():
                line = await proc.stdout.readline()
                if not line: raise RuntimeError('engine ended before final output')
                return json.loads(line)
            async def rpc(method,params,req_id=None):
                msg = {'method':method,'params':params}
                if req_id is not None: msg['id'] = req_id
                proc.stdin.write(json.dumps(msg).encode()+b'\n'); await proc.stdin.drain()
                if req_id is not None:
                    while True:
                        m = await receive()
                        if m.get('id')==req_id: return m['result']
            try:
                async with asyncio.timeout(100):
                    if mode=='app-server':
                        await rpc('initialize',{'clientInfo':{'name':'benchmark','version':'1'},'capabilities':{'experimentalApi':True}},1)
                        await rpc('initialized',{})
                        thread=(await rpc('thread/start',{'cwd':home,'ephemeral':True,'sandbox':'read-only','approvalPolicy':'never'},2))['thread']['id']
                        await rpc('turn/start',{'threadId':thread,'input':[{'type':'text','text':PROMPT}]},3)
                    else:
                        proc.stdin.close()
                    text=''
                    while True:
                        m=await receive(); kind=m.get('method',m.get('type'))
                        if kind=='item/agentMessage/delta': text+=m['params']['delta']
                        if kind=='item.completed' and m['item']['type']=='agent_message': text=m['item']['text']
                        if kind in ('turn/completed','turn.completed','turn.failed'): break
                    end=time.monotonic()
                    if len(samples)!=prev+1 or 'first' not in samples[-1] or 'amber river silver cloud' not in text.lower():
                        raise RuntimeError('Unexpected output, upstream status or request count: '+str([s.get('status') for s in samples[prev:]]))
                    s=samples[-1]; print(json.dumps(dict(mode=mode,model=s['model'],tier=s['tier'],effort=s['effort'],requests=1,
                        first_s=round(s['first']-begin,3),turn_s=round(end-begin,3),provider_first_s=round(s['first']-s['sent'],3))),flush=True)
            finally:
                if proc.returncode is None: proc.kill()
                await proc.wait()
    try:
        for mode in ('exec','app-server','app-server','exec','exec','app-server'):
            await trial(mode)
    finally:
        server.shutdown(); server.server_close()

if __name__=='__main__':
    asyncio.run(main())
