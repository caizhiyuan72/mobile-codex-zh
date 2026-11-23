"""Run explicitly with the pinned Android codex on PATH. No real provider or key."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from prepare_runtime import ultra_catalog


def main():
    requests = []

    class Capture(BaseHTTPRequestHandler):
        def do_POST(self):
            assert self.path == '/v1/responses'
            requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            self.send_error(400, 'End of fixture')  # non-retryable, no model or tools execute

        def log_message(self, *args):
            pass

    binary = shutil.which('codex')
    with tempfile.TemporaryDirectory() as root, ThreadingHTTPServer(('127.0.0.1', 0), Capture) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        env = {k: os.environ[k] for k in ('PATH', 'LD_LIBRARY_PATH', 'TMPDIR', 'ANDROID_ROOT', 'ANDROID_DATA') if k in os.environ}
        env.update(HOME=root, CODEX_HOME=root, CODEX_SELF_EXE=binary)
        catalog = Path(root, 'mobile-models.json')
        catalog.write_text(json.dumps(ultra_catalog(Path(binary).read_bytes())))
        config = (f'model_provider="wire"\n[agents]\nenabled=true\nmax_threads=3\n[features]\nmulti_agent=true\nmulti_agent_v2=true\n[model_providers.wire]\n'
                  f'name="Wire"\nbase_url="http://127.0.0.1:{server.server_port}/v1"\nwire_api="responses"\nsupports_websockets=false\n')

        def request(model, effort, patched):
            Path(root, 'config.toml').write_text((f'model_catalog_json={json.dumps(str(catalog))}\n' if patched else '') + config)
            before = len(requests)
            with subprocess.Popen([binary, 'app-server', '--listen', 'stdio://'], cwd=root, env=env, text=True,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as p:
                timer = threading.Timer(15, p.kill); timer.start()
                def rpc(method, params, i):
                    p.stdin.write(json.dumps(dict(method=method, params=params, id=i)) + '\n'); p.stdin.flush()
                    for line in p.stdout:
                        event = json.loads(line)
                        if event.get('id') == i:
                            if 'error' in event: raise ValueError(event['error'])
                            return event['result']
                    raise RuntimeError(f'{method}: missing response')
                try:
                    rpc('initialize', dict(clientInfo=dict(name='wire', version='1'), capabilities=dict(experimentalApi=True)), 1)
                    thread = rpc('thread/start', dict(model=model, cwd=root, sandbox='read-only', approvalPolicy='never', ephemeral=True), 2)['thread']['id']
                    rpc('turn/start', dict(threadId=thread, model=model, effort=effort, summary='auto', serviceTierForTurn='priority',
                                           input=[dict(type='text', text='Say sample.')]), 3)
                    for line in p.stdout:
                        if json.loads(line).get('method') == 'turn/completed': break
                finally:
                    timer.cancel(); p.kill()
            assert len(requests) == before + 1, 'expected a single Responses request'
            return requests[-1]

        for model in ('gpt-6.2-sol', 'gpt-6.2-astra'):
            for effort in ('low', 'max', 'ultra'):
                old, new = [request(model, effort, patched) for patched in (False, True)]
                assert new['reasoning']['effort'] == ('max' if effort == 'ultra' else effort), new['reasoning']
                assert new['model'] == old['model'] == model
                for key in ('tools', 'instructions', 'service_tier', 'tool_choice'):
                    assert new.get(key) == old.get(key), key
                def developer_messages(body):
                    return [msg['content'] for msg in body['input'] if msg.get('role') == 'developer']
                assert developer_messages(old) == developer_messages(new), 'developer instructions changed'
                assert new['reasoning'].get('summary') == old['reasoning'].get('summary')
                def delegation(body):
                    return [c['text'] for msg in body['input'] for c in msg.get('content', [])
                            if '<multi_agent_mode>' in c.get('text', '')]
                assert delegation(old) == delegation(new)
                if effort == 'ultra': assert any('Proactive multi-agent delegation is active' in text for text in delegation(new)), 'proactive delegation instructions lost'
                print(f"{model} {effort}: {old['reasoning']['effort']} -> {new['reasoning']['effort']}", flush=True)
        server.shutdown()


if __name__ == '__main__':
    main()
