// Cloud-style runtime smoke test. Isolated SQLite only; outbound connections blocked.
// node scripts/verify-cloud-runtime.mjs [project-directory] [evidence-file]
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm, stat, mkdir} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join, resolve, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';

const REPO = resolve(process.env.MEME_LAB_TEST_REPO || process.argv[2] || process.cwd());
const OUTPUT = resolve(process.env.MEME_LAB_TEST_OUTPUT || process.argv[3] || 'docs/evidence/cloud-runtime-verification.json');
const {Store} = await import(pathToFileURL(join(REPO, 'core/store.mjs')));
const {sqliteDriver} = await import(pathToFileURL(join(REPO, 'runtime/sqlite.mjs')));
const {encrypt, decrypt} = await import(pathToFileURL(join(REPO, 'core/util.mjs')));
const started = Date.now();
const folder = await mkdtemp(join(tmpdir(), 'meme-lab-cloud-runtime-'));
const admin = randomBytes(32).toString('base64');
const networkLog = join(folder, 'blocked-network.jsonl');
const guardPath = join(folder, 'network-guard.mjs');
const databasePath = join(folder, 'meme-lab.sqlite');
const db = sqliteDriver(databasePath);
const store = new Store(db);
const evidence = {
  status: 'RUNNING', started_at: new Date(started).toISOString(),
  scope: 'Actual API, supervisor, worker and SQLite; local isolated cloud-style configuration',
  checks: [], external_network_attempts: [], transactions: 0,
  limitations: ['Does not validate Render provisioning, proxy TLS/SSE behavior, live providers, trading performance or 24-hour uptime. Secure cookie is inspected over loopback HTTP, not tested by a browser.'],
};
let server = null, base = null, cookie = null, streamAbort = null;
let logs = '', masterKey = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const redact = value => {
  let text = String(value);
  for (const secret of [admin, masterKey, cookie].filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  return text;
};
function record(name, detail = {}) {
  evidence.checks.push({name, ...detail});
  console.log(name, JSON.stringify(detail));
}
async function until(label, predicate, timeout = 20000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeout) {
    try { const value = await predicate(); if (value) return value; }
    catch (error) { lastError = error.message; }
    if (server && (server.exitCode !== null || server.signalCode !== null)) {
      throw Error(`${label}: test server exited (${server.exitCode ?? server.signalCode})`);
    }
    await sleep(200);
  }
  throw Error(`${label} timed out${lastError ? ': ' + lastError : ''}`);
}
async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function request(path, {body, authenticated = true, method} = {}) {
  const response = await fetch(base + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {...(authenticated && cookie ? {Cookie: cookie} : {}), ...(body === undefined ? {} : {'content-type': 'application/json', Origin: base})},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const value = await response.json();
  return {response, value};
}
async function api(path, body) {
  const result = await request('/api/lab/' + path, {body});
  assert.equal(result.response.status, 200, 'Authenticated API request must succeed: ' + path);
  return result.value;
}
async function launch(previousBoot = null) {
  const port = await freePort();
  base = 'http://127.0.0.1:' + port;
  const env = {
    ...process.env, NODE_ENV: 'production', DATA_DIR: folder, PORT: String(port), HOST: '127.0.0.1',
    ADMIN_TOKEN: admin, ENCRYPTION_KEY: '', COOKIE_SECURE: '1', RUNTIME_LOCATION: 'cloud',
    DISABLE_WORKER: '0', REMOTE_API_TOKEN: '', SOLANA_KEYPAIR_FILE: '', EVM_PRIVATE_KEY_FILE: '',
    BNB_KEYSTORE_FILE: '', BNB_PASSWORD_FILE: '', JUPITER_API_KEY: '', ALLOWED_RPC_HOSTS: '',
    NODE_OPTIONS: '--import=' + guardPath,
  };
  server = spawn(process.execPath, ['runtime/server.mjs'], {cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe']});
  server.stdout.on('data', chunk => { logs = (logs + String(chunk)).slice(-12000); });
  server.stderr.on('data', chunk => { logs = (logs + String(chunk)).slice(-12000); });
  let spawnError = null;
  server.once('error', error => { spawnError = error; });
  await until('HTTP readiness', async () => {
    if (spawnError) throw spawnError;
    const r = await fetch(base + '/healthz', {signal: AbortSignal.timeout(1000)});
    await r.arrayBuffer();
    return r.status === 200;
  });
  const unauthorized = await request('/api/lab/state', {authenticated: false});
  assert.equal(unauthorized.response.status, 401);
  const invalid = await request('/api/auth/login', {authenticated: false, body: {token: 'invalid-test-token'}});
  assert.equal(invalid.response.status, 401);
  const login = await request('/api/auth/login', {authenticated: false, body: {token: admin}});
  assert.equal(login.response.status, 200);
  const setCookie = login.response.headers.get('set-cookie') ?? '';
  assert.ok(/(?:^|;\s*)Secure(?:;|$)/i.test(setCookie), 'Session cookie must use Secure');
  assert.ok(/(?:^|;\s*)HttpOnly(?:;|$)/i.test(setCookie), 'Session cookie must use HttpOnly');
  assert.ok(/(?:^|;\s*)SameSite=Strict(?:;|$)/i.test(setCookie), 'Session cookie must use SameSite=Strict');
  cookie = setCookie.split(';')[0];
  return until('New worker heartbeat', async () => {
    const beat = await store.setting('engine_heartbeat');
    return beat && beat.boot_id !== previousBoot && Date.now() - beat.at < 5000 ? beat : null;
  }, 25000);
}
async function shutdown() {
  if (!server) return;
  const target = server;
  if (target.exitCode === null && target.signalCode === null) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { target.kill('SIGKILL'); reject(Error('Test server exceeded 22-second graceful shutdown')); }, 22000);
      target.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code !== 0) reject(Error('Test server stopped unexpectedly: ' + (signal ?? code)));
        else resolve();
      });
      target.kill('SIGTERM');
    });
  }
  server = null;
}
try {
  await store.init();
  await store.run('UPDATE chains SET enabled=0');
  await store.run('UPDATE copy_targets SET enabled=0');
  await store.set('copy_providers', []);
  await store.set('copy_secrets', {});
  await store.set('execution_wallets', {});
  await store.set('copy_config', {...await store.setting('copy_config'), enabled: false, live_enabled: false, auto_armed: false, execution_wallet: null});
  await store.set('mode', 'OBSERVE');
  await store.set('trading_enabled', false);
  const now = Date.now();
  for (const [id, type] of [['scan', 'SCAN'], ['paper-exits', 'PAPER_EXITS'], ['health', 'HEALTH'], ['reconcile', 'RECONCILE'], ['learning', 'LEARNING'], ['evm-catchup', 'EVM_CATCHUP']]) {
    await store.run("INSERT INTO engine_jobs(id,type,payload,state,available_at,created_at,updated_at) VALUES (?,?,'{}','DONE',?,?,?)", id, type, now + 3600000, now, now);
  }
  // The guard is inherited by server, worker and signer processes. No outbound socket is needed in this fixture.
  await writeFile(guardPath, `import {appendFileSync} from 'node:fs';\nimport net from 'node:net';\nimport tls from 'node:tls';\nimport {syncBuiltinESMExports} from 'node:module';\nconst block=transport=>{appendFileSync(${JSON.stringify(networkLog)},JSON.stringify({at:Date.now(),transport,pid:process.pid})+'\\n');throw Error('TEST_OUTBOUND_NETWORK_FORBIDDEN');};\nglobalThis.fetch=async()=>block('fetch');\nnet.Socket.prototype.connect=function(){return block('tcp');};\ntls.connect=function(){return block('tls');};\nsyncBuiltinESMExports();\n`, {mode: 0o600});

  const first = await launch();
  masterKey = (await readFile(join(folder, 'master-key'), 'utf8')).trim();
  assert.ok(masterKey.length >= 40, 'Runtime must create an encryption key');
  const secretMode = (await stat(join(folder, 'master-key'))).mode & 0o777;
  assert.equal(secretMode & 0o077, 0, 'Generated master-key must not be group/world readable');
  await until('Unconfigured copy signer readiness', async () => (await store.setting('copy_signer'))?.status === 'NOT_CONFIGURED');
  const initialState = await api('state');
  assert.equal(initialState.runtime.kind, 'standalone');
  assert.equal(initialState.runtime.location, 'cloud');
  assert.equal(initialState.runtime.secret_storage, true);
  assert.deepEqual(initialState.runtime.signer, {});
  assert.equal(initialState.copy.signer.status, 'NOT_CONFIGURED');
  record('Authenticated cloud runtime and Secure session cookie', {api: 'OK', runtime: 'standalone', location: 'cloud', secure_cookie: true, master_key_restricted: true, signer: 'NOT_CONFIGURED'});

  const persistentConfig = {scan_interval_ms: 45000, wallet_interval_ms: 60000, concurrency: 2, max_tokens: 4, retention_days: 3};
  await api('engine/settings', persistentConfig);
  await api('notes/save', {entity_type: 'experiment', entity_id: 'cloud-runtime-verification', text: 'ISOLATED TEST — persistence marker'});
  await store.set('cloud_test_encrypted_marker', await encrypt('ISOLATED TEST VALUE', masterKey));
  await api('engine/start', {});
  await until('Running engine', async () => (await store.setting('engine_heartbeat'))?.state === 'RUNNING');
  const health = await request('/healthz', {authenticated: false});
  assert.equal(health.response.status, 200);
  assert.equal(health.value.api, 'OK');
  assert.equal(health.value.engine, 'RUNNING');

  streamAbort = new AbortController();
  const stream = await fetch(base + '/api/stream', {headers: {Cookie: cookie}, signal: AbortSignal.any([streamAbort.signal, AbortSignal.timeout(10000)])});
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.getReader();
  let streamed = '';
  while (!/event: state\ndata: (.+)\n\n/.test(streamed)) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    streamed += new TextDecoder().decode(chunk.value);
  }
  const streamedState = JSON.parse(streamed.match(/event: state\ndata: (.+)\n\n/)[1]);
  assert.equal(streamedState.runtime.location, 'cloud', 'SSE must report cloud runtime');
  streamAbort.abort();
  await reader.cancel().catch(() => {});
  streamAbort = null;
  const before = await store.setting('engine_heartbeat');
  const closedAt = Date.now();
  // Deliberately no HTTP or SQLite reads during this interval.
  await sleep(6500);
  const after = await store.setting('engine_heartbeat');
  assert.equal(after.boot_id, before.boot_id, 'Worker must stay alive with no connected client');
  assert.ok(after.at > before.at + 3000, 'Heartbeat must advance without an SSE client');
  assert.ok(after.process_uptime_seconds > before.process_uptime_seconds + 3, 'Worker uptime must advance');
  record('Engine continues with SSE closed and no HTTP requests', {closed_at: closedAt, observation_ms: Date.now() - closedAt, heartbeat_advanced: true, uptime_advanced: true});

  const databaseBefore = await stat(databasePath);
  const oldCookie = cookie;
  await shutdown();
  const restarted = await launch(first.boot_id);
  const databaseAfter = await stat(databasePath);
  const reloadedKey = (await readFile(join(folder, 'master-key'), 'utf8')).trim();
  assert.ok(reloadedKey === masterKey, 'Restart must preserve master-key bytes');
  assert.equal(databaseAfter.ino, databaseBefore.ino, 'Restart must keep the same SQLite file');
  assert.deepEqual(await store.setting('engine_config'), persistentConfig);
  assert.equal(await store.setting('engine_desired'), 'RUNNING');
  assert.equal((await store.get("SELECT COUNT(*) n FROM notes WHERE entity_id='cloud-runtime-verification'")).n, 1);
  assert.equal(await decrypt(await store.setting('cloud_test_encrypted_marker'), reloadedKey), 'ISOLATED TEST VALUE');
  const staleSession = await fetch(base + '/api/lab/state', {headers: {Cookie: oldCookie}, signal: AbortSignal.timeout(5000)});
  assert.equal(staleSession.status, 401);
  await staleSession.arrayBuffer();
  assert.equal((await api('state')).runtime.location, 'cloud');
  record('Server restart preserves SQLite, master-key, saved settings and encrypted data', {new_worker_boot: restarted.boot_id !== first.boot_id, database_preserved: true, master_key_preserved: true, settings_preserved: true, encrypted_marker_readable: true, prior_session_rejected: true});

  await api('engine/stop', {});
  await until('Stopped engine', async () => (await store.setting('engine_heartbeat'))?.state === 'STOPPED');
  assert.equal((await request('/healthz', {authenticated: false})).response.status, 200);
  assert.equal((await store.get('SELECT COUNT(*) n FROM chains WHERE enabled=1')).n, 0);
  assert.equal((await store.setting('copy_providers')).length, 0);
  assert.equal((await store.get('SELECT COUNT(*) n FROM orders')).n, 0);
  assert.equal((await store.get('SELECT COUNT(*) n FROM copy_actions')).n, 0);
  assert.equal((await store.get('SELECT COUNT(*) n FROM copy_receipts')).n, 0);
  record('Stopped engine remains healthy; no configured providers or transactions', {health: 200, enabled_chains: 0, copy_providers: 0, orders: 0, copy_actions: 0, copy_receipts: 0});
  evidence.status = 'PASSED';
} catch (error) {
  evidence.status = 'FAILED';
  evidence.error = redact(error.message);
  process.exitCode = 1;
  console.error('Cloud runtime check failed:', redact(error.message));
} finally {
  streamAbort?.abort();
  try { await shutdown(); }
  catch (error) { evidence.status = 'FAILED'; evidence.shutdown_error = redact(error.message); process.exitCode = 1; }
  try {
    const blocked = await readFile(networkLog, 'utf8');
    evidence.external_network_attempts = blocked.split('\n').filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error.code !== 'ENOENT') { evidence.status = 'FAILED'; evidence.network_log_error = redact(error.message); process.exitCode = 1; }
  }
  if (evidence.external_network_attempts.length) {
    evidence.status = 'FAILED'; evidence.error ??= 'Unexpected outbound network attempt was blocked'; process.exitCode = 1;
  }
  if (evidence.status === 'FAILED') evidence.server_log = redact(logs);
  db.close();
  evidence.duration_seconds = (Date.now() - started) / 1000;
  await mkdir(dirname(OUTPUT), {recursive: true});
  await writeFile(OUTPUT, JSON.stringify(evidence, null, 2) + '\n');
  await rm(folder, {recursive: true, force: true});
  console.log('Result:', evidence.status, OUTPUT, evidence.duration_seconds + 's');
}
