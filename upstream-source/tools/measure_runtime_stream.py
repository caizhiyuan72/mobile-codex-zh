"""Compare bundled exec/app-server with the same synthetic loopback Responses stream."""
import asyncio
import json
import os
import shutil
import statistics
import tempfile
import time
from pathlib import Path


async def main():
    binary = shutil.which('codex')
    if not binary:
        raise RuntimeError('codex must be on PATH')
    clock = time.perf_counter
    chunks = ['sample '] * 24
    answer = ''.join(chunks)
    sent = []

    async def respond(reader, writer):
        try:
            headers = (await reader.readuntil(b'\r\n\r\n')).decode('ascii').split('\r\n')
            if headers[0].split()[:2] != ['POST', '/v1/responses']:
                writer.write(b'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); return
            size = int(next(line.split(':', 1)[1] for line in headers if line.lower().startswith('content-length:')))
            await reader.readexactly(size)
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n')
            counter = 0

            async def emit(kind, **data):
                nonlocal counter
                body = json.dumps(dict(type=kind, sequence_number=counter, **data)).encode()
                writer.write(b'event: ' + kind.encode() + b'\ndata: ' + body + b'\n\n'); await writer.drain(); counter += 1

            response = dict(id='resp_fixture', object='response', created_at=1, model='gpt-5', status='in_progress', output=[])
            item = dict(type='message', id='msg_fixture', role='assistant', status='in_progress', content=[])
            await emit('response.created', response=response)
            await emit('response.output_item.added', output_index=0, item=item)
            for chunk in chunks:
                await emit('response.output_text.delta', item_id=item['id'], output_index=0, content_index=0, delta=chunk)
                await asyncio.sleep(.005)
            item.update(status='completed', content=[dict(type='output_text', text=answer, annotations=[])])
            await emit('response.output_item.done', output_index=0, item=item)
            response.update(status='completed', output=[item], usage=dict(input_tokens=8, output_tokens=24, total_tokens=32))
            sent.append(clock()); await emit('response.completed', response=response)
        finally:
            writer.close()

    server = await asyncio.start_server(respond, '127.0.0.1', 0)
    port = server.sockets[0].getsockname()[1]
    results = {kind: [] for kind in ('exec', 'app-server')}
    async with server:
        for sample in range(6):
            for kind in (('exec', 'app-server') if sample % 2 == 0 else ('app-server', 'exec')):
                with tempfile.TemporaryDirectory() as home:
                    env = {key: os.environ[key] for key in ('PATH', 'LD_LIBRARY_PATH', 'TMPDIR', 'ANDROID_ROOT', 'ANDROID_DATA') if key in os.environ}
                    env.update(HOME=home, CODEX_HOME=home, CODEX_SELF_EXE=binary)
                    Path(home, 'config.toml').write_text(f'model="gpt-5"\nmodel_provider="fixture"\ncheck_for_update_on_startup=false\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:{port}/v1"\nwire_api="responses"\nsupports_websockets=false\n')
                    args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', 'Say sample.'] if kind == 'exec' else ['app-server', '--listen', 'stdio://']
                    proc = await asyncio.create_subprocess_exec(binary, *args, cwd=home, env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                    count = len(sent)

                    async def rpc(method, params, req=None):
                        msg = dict(method=method, params=params)
                        if req is not None:
                            msg['id'] = req
                        proc.stdin.write(json.dumps(msg).encode() + b'\n'); await proc.stdin.drain()
                        if req is not None:
                            while True:
                                obj = await receive()
                                if obj.get('id') == req:
                                    return obj['result']

                    async def receive():
                        line = await proc.stdout.readline()
                        if not line:
                            raise RuntimeError(f'{kind}: ended before turn completion')
                        return json.loads(line)

                    try:
                        async with asyncio.timeout(20):
                            if kind == 'exec':
                                proc.stdin.close()
                            else:
                                await rpc('initialize', dict(clientInfo=dict(name='fixture', version='1'), capabilities=dict(experimentalApi=True)), 1)
                                await rpc('initialized', {})
                                thread = (await rpc('thread/start', dict(cwd=home, sandbox='read-only', approvalPolicy='never', ephemeral=True), 2))['thread']['id']
                                await rpc('turn/start', dict(threadId=thread, input=[dict(type='text', text='Say sample.')]), 3)
                            text = ''
                            while True:
                                event = await receive(); method = event.get('method', event.get('type'))
                                if method == 'item/agentMessage/delta':
                                    text += event['params']['delta']
                                if method == 'item.completed' and event['item']['type'] == 'agent_message':
                                    text = event['item']['text']
                                if method in ('turn/completed', 'turn.completed'):
                                    finished = clock(); break
                            if text.strip() != answer.strip() or len(sent) != count + 1:
                                raise RuntimeError(f'{kind}: stream content or request count mismatch')
                            results[kind].append(round((finished - sent[-1]) * 1000, 2))
                    finally:
                        if proc.returncode is None:
                            proc.kill()
                        await proc.wait()
    for kind, samples in results.items():
        print(json.dumps(dict(mode=kind, finish_ms=samples, median_ms=statistics.median(samples))))


if __name__ == '__main__':
    asyncio.run(main())
