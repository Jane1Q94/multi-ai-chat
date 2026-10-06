// 协议验证：不打开浏览器。假网格页连上服务，核对拒绝、排队、断开和超时。
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeClientFrames, formatReport, start } from './server.mjs';

const SERVER = path.join(import.meta.dirname, 'server.mjs');
process.env.MULTI_AI_CHAT_ANSWERS = mkdtempSync(path.join(tmpdir(), 'multi-ai-html-'));
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function encodeClientText(text) {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0xfe;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, mask, masked]);
}

function connect(port, origin) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const req = request({
      host: '127.0.0.1',
      port,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        Origin: origin
      }
    });
    req.on('upgrade', (_res, socket) => {
      let buffer = Buffer.alloc(0);
      const messages = [];
      let waiting = null;
      const push = (text) => {
        if (waiting) {
          const resolveNext = waiting;
          waiting = null;
          resolveNext(JSON.parse(text));
          return;
        }
        messages.push(JSON.parse(text));
      };
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const decoded = decodeClientFrames(buffer);
        buffer = decoded.rest;
        for (const frame of decoded.frames) {
          if (frame.opcode === 0x1) push(frame.payload.toString('utf8'));
        }
      });
      resolve({
        send(value) {
          socket.write(encodeClientText(JSON.stringify(value)));
        },
        buffered() {
          return messages.length;
        },
        next() {
          if (messages.length) return Promise.resolve(messages.shift());
          return new Promise((resolveNext) => {
            waiting = resolveNext;
          });
        },
        close() {
          // 掩码空关闭帧。浏览器关页时会先发这个，不能只依赖 TCP 断开。
          socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]));
          socket.end();
        }
      });
    });
    req.on('response', (res) => {
      res.resume();
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function testOrigin(server) {
  const rejected = await connect(server.port, 'https://evil.example').then(
    () => null,
    (error) => error
  );
  assert(rejected?.statusCode === 403, `错误来源应被 403 拒绝，实际是 ${rejected?.message ?? '连上了'}`);
}

async function testEmpty(server) {
  const client = await connect(server.port, server.origin);
  const pending = server.ask('   ');
  const result = await pending;
  assert(result.isError && result.text === '问题不能为空。', `空问题应被拒绝，实际 ${JSON.stringify(result)}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  client.close();
  // next() 若已经收到 ask，说明空问题被发出去了。用一个很短的竞态窗口不够稳，
  // 改为：空问题返回后客户端缓冲里不该有消息。这里用 send 计数改在 connect 内不方便，
  // 所以再发一次非空问题，确认第一条才是它。
  const again = await connect(server.port, server.origin);
  const call = server.ask('只有这一条');
  const first = await again.next();
  assert(first.text === '只有这一条', `空问题之后不该抢先发出别的帧，第一条是 ${JSON.stringify(first)}`);
  again.send({ type: 'begin', id: first.id, sites: ['豆包'] });
  again.send({ type: 'result', id: first.id, answers: [{ site: '豆包', status: 'done', text: '好' }] });
  await call;
  again.close();
}

async function testQueue(server) {
  const client = await connect(server.port, server.origin);
  const first = server.ask('第一问');
  const asked = await client.next();
  const second = server.ask('第二问');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert(client.buffered() === 0, '第一问未结束就发出了第二问');
  client.send({ type: 'begin', id: asked.id, sites: ['豆包'] });
  client.send({ type: 'result', id: asked.id, answers: [{ site: '豆包', status: 'done', text: '一' }] });
  await first;
  const next = await client.next();
  assert(next.text === '第二问', `排队后的第二问没有发出，实际 ${JSON.stringify(next)}`);
  client.send({ type: 'begin', id: next.id, sites: ['豆包'] });
  client.send({ type: 'result', id: next.id, answers: [{ site: '豆包', status: 'done', text: '二' }] });
  const done = await second;
  assert(!done.isError && JSON.parse(done.text).answers[0].text === '二', `第二问结果不对 ${done.text}`);
  client.close();
}

async function testDisconnect(server) {
  const dropped = await connect(server.port, server.origin);
  const pending = server.ask('会断开');
  await dropped.next();
  dropped.close();
  const early = await pending;
  assert(early.isError && early.text === '网格页已断开', `begin 前断开应报错，实际 ${JSON.stringify(early)}`);

  const client = await connect(server.port, server.origin);
  const call = server.ask('答了一半');
  const asked = await client.next();
  client.send({ type: 'begin', id: asked.id, sites: ['豆包', 'DeepSeek'] });
  client.send({
    type: 'update',
    id: asked.id,
    answers: [{ site: '豆包', status: 'done', text: '已经收到' }]
  });
  client.close();
  const result = await call;
  assert(!result.isError, `断开后应返回已收到的原文，实际 ${JSON.stringify(result)}`);
  const answers = JSON.parse(result.text).answers;
  const doubao = answers.find((item) => item.site === '豆包');
  const deepseek = answers.find((item) => item.site === 'DeepSeek');
  assert(doubao?.status === 'done' && doubao.text === '已经收到', `已完成的一家被改掉了 ${JSON.stringify(doubao)}`);
  const report = JSON.parse(result.text);
  assert(
    report.html && readFileSync(report.html, 'utf8').includes('已经收到'),
    `明细 HTML 没有写上原文 ${report.html}`
  );
  assert(
    report.link === `http://127.0.0.1:${server.port}/answers/${encodeURIComponent(path.basename(report.html))}`,
    `原文链接不对 ${report.link}`
  );
  assert(report.markdown === `[各家原文](${report.link})`, `可点击链接格式不对 ${report.markdown}`);
  const page = await new Promise((resolve, reject) => {
    const req = request(report.link, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
  assert(page.status === 200 && page.body.includes('已经收到'), `点开链接没有原文 ${page.status}`);
  assert(
    deepseek?.status === 'disconnected' && deepseek.error === '网格页已断开',
    `未完成的一家应为 disconnected，实际 ${JSON.stringify(deepseek)}`
  );
}

async function testTimeout(server) {
  const client = await connect(server.port, server.origin);
  const call = server.ask('会超时');
  const asked = await client.next();
  client.send({ type: 'begin', id: asked.id, sites: ['豆包', 'Claude'] });
  client.send({
    type: 'update',
    id: asked.id,
    answers: [{ site: '豆包', status: 'done', text: '先答完' }]
  });
  const result = await call;
  const answers = JSON.parse(result.text).answers;
  const claude = answers.find((item) => item.site === 'Claude');
  const doubao = answers.find((item) => item.site === '豆包');
  assert(doubao?.status === 'done', `已完成的一家不应被超时覆盖 ${JSON.stringify(doubao)}`);
  assert(
    claude?.status === 'timeout' && claude.error?.includes('不能最小化'),
    `未结束的一家应为 timeout，实际 ${JSON.stringify(claude)}`
  );
  client.close();
}

function frameMessage(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

function readFrames(buffer) {
  const messages = [];
  let rest = buffer;
  while (true) {
    const headerEnd = rest.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const match = rest.subarray(0, headerEnd).toString('utf8').match(/Content-Length:\s*(\d+)/i);
    if (!match) break;
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (rest.length < start + length) break;
    messages.push(JSON.parse(rest.subarray(start, start + length).toString('utf8')));
    rest = rest.subarray(start + length);
  }
  return { messages, rest };
}

async function testStdio() {
  const port = 20000 + (createHash('sha256').update(String(Date.now())).digest()[0] % 20000);
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      MULTI_AI_CHAT_PORT: String(port),
      MULTI_AI_CHAT_DEADLINE_MS: '500',
      MULTI_AI_CHAT_CONTROL: path.join(mkdtempSync(path.join(tmpdir(), 'multi-ai-')), 'bridge.sock')
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffer = Buffer.alloc(0);
  let waiting = null;
  const inbox = [];
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const read = readFrames(buffer);
    buffer = read.rest;
    for (const message of read.messages) {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(message);
      } else inbox.push(message);
    }
  });
  const next = () => {
    if (inbox.length) return Promise.resolve(inbox.shift());
    return new Promise((resolve) => {
      waiting = resolve;
    });
  };
  child.stdin.write(
    frameMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
  );
  const initialized = await next();
  assert(initialized.result?.protocolVersion === '2024-11-05', `initialize 没回协议版本 ${JSON.stringify(initialized)}`);
  child.stdin.write(frameMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask', arguments: { question: '  ' } } }));
  const empty = await next();
  assert(empty.result?.isError === true && empty.result.content[0].text === '问题不能为空。', `stdio 空问题不对 ${JSON.stringify(empty)}`);
  child.kill();
  await new Promise((resolve) => child.on('exit', resolve));
}

async function testLineStdio() {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      MULTI_AI_CHAT_PORT: String(port),
      MULTI_AI_CHAT_DEADLINE_MS: '500',
      MULTI_AI_CHAT_CONTROL: path.join(mkdtempSync(path.join(tmpdir(), 'multi-ai-')), 'bridge.sock')
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffer = '';
  let waiting = null;
  const inbox = [];
  const take = () => {
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(message);
      } else inbox.push(message);
    }
  };
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    take();
  });
  const next = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve) => {
    waiting = resolve;
  }));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cursor', version: '1' } } });
  const initialized = await next();
  assert(initialized.result?.serverInfo?.name === 'multi-ai-chat', `换行 JSON 握手失败 ${JSON.stringify(initialized)}`);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const listed = await next();
  assert(listed.result?.tools?.[0]?.name === 'ask', `换行 JSON 没有列出 ask ${JSON.stringify(listed)}`);
  assert(!listed.result?.tools?.[0]?.inputSchema || listed.result.tools[0].inputSchema.type === 'object', '工具 schema 不是 object');
  child.kill();
  await new Promise((resolve) => child.on('exit', resolve));
}

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function openMcp(child) {
  let buffer = Buffer.alloc(0);
  let waiting = null;
  const inbox = [];
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const read = readFrames(buffer);
    buffer = read.rest;
    for (const message of read.messages) {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(message);
      } else inbox.push(message);
    }
  });
  return {
    send(message) {
      child.stdin.write(frameMessage(message));
    },
    next() {
      if (inbox.length) return Promise.resolve(inbox.shift());
      return new Promise((resolve) => {
        waiting = resolve;
      });
    }
  };
}

// Cursor 刷新工具列表时会再启动一个进程。前一个还占着端口时，后一个必须仍能握手。
async function testSecondProcess() {
  const port = await freePort();
  const control = path.join(mkdtempSync(path.join(tmpdir(), 'multi-ai-')), 'bridge.sock');
  const env = {
    ...process.env,
    MULTI_AI_CHAT_PORT: String(port),
    MULTI_AI_CHAT_CONTROL: control,
    MULTI_AI_CHAT_DEADLINE_MS: '1000'
  };
  const primary = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const primaryMcp = openMcp(primary);
  primaryMcp.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const listed = await primaryMcp.next();
  assert(listed.result?.tools?.[0]?.name === 'ask', `第一个进程没有列出 ask ${JSON.stringify(listed)}`);

  const secondary = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let secondaryErr = '';
  secondary.stderr.on('data', (chunk) => {
    secondaryErr += chunk.toString();
  });
  const secondaryMcp = openMcp(secondary);
  secondaryMcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  secondaryMcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const initialized = await secondaryMcp.next();
  const tools = await secondaryMcp.next();
  assert(initialized.result?.serverInfo?.name === 'multi-ai-chat', `第二个进程握手失败 ${JSON.stringify(initialized)} ${secondaryErr}`);
  assert(tools.result?.tools?.[0]?.name === 'ask', `第二个进程没有列出 ask ${JSON.stringify(tools)} ${secondaryErr}`);
  secondaryMcp.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'ask', arguments: { question: '在吗' } }
  });
  const called = await secondaryMcp.next();
  assert(
    called.result?.isError === true && called.result.content[0].text.includes('扩展未连接'),
    `第二个进程的提问没有转到第一个 ${JSON.stringify(called)} ${secondaryErr}`
  );
  primary.kill();
  secondary.kill();
  await Promise.all([
    new Promise((resolve) => primary.on('exit', resolve)),
    new Promise((resolve) => secondary.on('exit', resolve))
  ]);
}

function testReportReading() {
  const page = formatReport('国庆新闻', [
    { site: '豆包', status: 'done', text: '已经收到', html: '<p>已经收到</p><script>alert(1)</script>' },
    { site: 'DeepSeek', status: 'timeout', text: '', error: '网格窗口要开着，且不能最小化' }
  ]);
  assert(page.includes('class="panel"') && page.includes('class="answer"'), `没有沿用网格卡片 ${page.slice(0, 200)}`);
  assert(page.includes('国庆新闻') && page.includes('<p>已经收到</p>'), `正文没有放进卡片 ${page.slice(-400)}`);
  assert(!page.includes('<script'), `脚本被写进了文件`);
  assert(page.includes('已完成（4 字）'), `状态不是网格页那行字 ${page}`);
  assert(page.includes('--columns: 2'), `两家时应是两列 ${page}`);
}

testReportReading();

const server = await start({ port: 0, deadlineMs: 300, stdio: false });
try {
  await testOrigin(server);
  await testEmpty(server);
  await testQueue(server);
  await testDisconnect(server);
  await testTimeout(server);
  await testStdio();
  await testLineStdio();
  await testSecondProcess();
} finally {
  await server.close();
}

if (failures.length) {
  for (const failure of failures) console.error(`❌ ${failure}`);
  process.exit(1);
}
console.log('协议验证通过');
