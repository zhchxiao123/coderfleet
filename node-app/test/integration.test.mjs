import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { serve } from '../dist/server.js';

const fakeDocker =
    "import { createInterface } from 'node:readline';\n"
  + "const [command, ...args] = process.argv.slice(2);\n"
  + "if (command === 'ps' || command === 'rm') process.exit(0);\n"
  + "if (args.at(-1) === 'models') { console.log('flash\\tGemini Flash'); process.exit(0); }\n"
  + "const options = { configOptions: [{type:'select',category:'mode',id:'mode',currentValue:'auto'}, {type:'select',category:'model',id:'model',currentValue:'base'}] };\n"
  + "const send = fields => console.log(JSON.stringify({jsonrpc:'2.0',...fields}));\n"
  + "let sessionId, promptId, prompt, model, defaultMode = false;\n"
  + "const delta = value => send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:value}}}});\n"
  + "for await (const line of createInterface({input: process.stdin})) {\n"
  + "  const { id, method, params, result } = JSON.parse(line);\n"
  + "  if (method === 'initialize') send({id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{},close:{}}}}});\n"
  + "  else if (method === 'session/new') { sessionId = 'native-1'; send({id,result:{...options,sessionId}}); }\n"
  + "  else if (method === 'session/resume') { if (params.sessionId !== 'native-1') throw Error('Wrong resume ID'); sessionId = params.sessionId; send({id,result:options}); }\n"
  + "  else if (method === 'session/set_config_option') { if (params.configId === 'mode' && params.value === 'default') defaultMode = true; else model = params.value; send({id,result:{}}); }\n"
  + "  else if (method === 'session/prompt') {\n"
  + "    if (!defaultMode) throw Error('Approval mode not set'); promptId = id; prompt = params.prompt[0].text;\n"
  + "    if (prompt === 'hold') continue;\n"
  + "    if (prompt === 'approve') {\n"
  + "      if (model !== 'flash') throw Error('Model was not selected'); delta('working');\n"
  + "      send({id:'ask',method:'session/request_permission',params:{sessionId,toolCall:{title:'Read example',rawInput:{file:'example.txt'}},options:[{kind:'allow_once',optionId:'one'},{kind:'reject_once',optionId:'no'}]}});\n"
  + "    } else { delta('resumed'); send({id,result:{stopReason:'end_turn'}}); }\n"
  + "  } else if (id === 'ask') { if (result.outcome.optionId !== 'one') throw Error('Wrong approval'); delta(' approved'); send({id:promptId,result:{stopReason:'end_turn'}}); }\n"
  + "  else if (method === 'session/cancel') send({id:promptId,result:{stopReason:'cancelled'}});\n"
  + "  else if (method === 'session/close') send({id,result:{}});\n"
  + "}\n";

async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await close(server);
  return port;
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function until(operation, matches) {
  for (let index = 0; index < 125; index += 1) {
    const result = await operation();
    if (matches(result)) return result;
    await sleep(50);
  }
  throw new Error('The expected task state did not arrive');
}

test('two backends isolate state and an active Antigravity turn survives server restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coderfleet-node-test-'));
  const image = 'example:1.5.15';
  const dockerPath = join(root, 'docker');
  const token = 'synthetic-node-test-token-0000000';
  let local;
  let remote;
  try {
    await writeFile(dockerPath, '#!' + process.execPath + '\n' + fakeDocker);
    await chmod(dockerPath, 0o700);
    await mkdir(join(root, 'project'));
    const localPort = await port();
    const localConfig = join(root, 'local.json');
    const project = { id: 'agy', image, workspace: 'project', accountDirectory: 'account', network: 'none' };
    await writeFile(localConfig, JSON.stringify({ token, port: localPort, dockerPath, projects: [project], stateDirectory: 'local' }));
    const remotePort = await port();
    const remoteConfig = join(root, 'remote.json');
    await writeFile(remoteConfig, JSON.stringify({ token, port: remotePort, dockerPath, projects: [project], stateDirectory: 'remote' }));
    local = await serve(localConfig);
    remote = await serve(remoteConfig);
    async function api(path, body, backend = localPort) {
      const response = await fetch('http://127.0.0.1:' + backend + '/v1' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', connection: 'close' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json();
      assert.ok(response.ok, JSON.stringify(value));
      return value;
    }
    assert.equal((await fetch('http://127.0.0.1:' + localPort + '/v1/projects')).status, 401);
    assert.deepEqual(await api('/projects/agy/models'), [{ id: 'flash', label: 'Gemini Flash' }]);
    const conversation = await api('/conversations', { projectId: 'agy', name: 'Test' });
    assert.deepEqual(await api('/conversations', undefined, remotePort), []);
    const path = '/conversations/' + conversation.id + '/turns';
    const first = await api(path, { prompt: 'approve', model: 'flash' });
    const latest = async () => (await api(path)).at(-1);
    const pending = await until(latest, turn => turn.permission && turn.answer === 'working');
    const duplicate = await fetch('http://127.0.0.1:' + localPort + '/v1' + path, {
      method: 'POST', headers: { authorization: 'Bearer ' + token, connection: 'close' },
      body: JSON.stringify({ prompt: 'overlapping' }),
    });
    assert.equal(duplicate.status, 409);
    await duplicate.text();
    await close(local);
    local = undefined;
    local = await serve(localConfig);
    const approval = { id: pending.permission.id, decision: 'allow' };
    await api('/turns/' + first.id + '/permission', approval);
    const finished = await until(latest, turn => turn.status === 'done');
    assert.equal(finished.answer, 'working approved');
    assert.equal(finished.model, 'flash');
    await api('/turns/' + first.id + '/permission', approval);
    await api(path, { prompt: 'follow up' });
    const resumed = await until(latest, turn => turn.status === 'done' && turn.id !== first.id);
    assert.equal(resumed.answer, 'resumed');
    assert.equal(resumed.sessionId, finished.sessionId);
    const holding = await api(path, { prompt: 'hold' });
    await until(latest, turn => turn.id === holding.id && turn.status === 'running');
    await api('/turns/' + holding.id + '/cancel', {});
    const stopped = await until(latest, turn => turn.status === 'cancelled');
    assert.equal(stopped.id, holding.id);
    assert.equal(stopped.sessionId, resumed.sessionId);
  } finally {
    await Promise.all([local && close(local), remote && close(remote)]);
    await rm(root, { recursive: true, force: true });
  }
});
