// Agent 用 MCP stdio 调用本进程，网格页用 WebSocket 连到 127.0.0.1。
// 只实现文本帧：浏览器发来的帧带掩码，服务端发出的帧不带。不新增依赖。
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const REPO = path.resolve(import.meta.dirname, '../..');
const DEFAULT_PORT = 47321;
const DEFAULT_DEADLINE_MS = 180000;
const DEFAULT_CONTROL = path.join(homedir(), '.multi-ai-chat', 'bridge.sock');
const MAX_MESSAGE = 8 * 1024 * 1024;

const NOT_CONNECTED = '扩展未连接。点一次扩展图标，之后窗口可留在后台。';
const EMPTY_QUESTION = '问题不能为空。';
const NO_SITES = '没有开启的站点';
const DISCONNECTED = '网格页已断开';
const WINDOW_FROZEN = '网格窗口要开着，且不能最小化';

// 与 tools/probe/run.mjs 里原来的算法相同：未打包扩展的 ID 由目录绝对路径决定。
export function extensionId(dir) {
  const hash = createHash('sha256').update(dir).digest('hex').slice(0, 32);
  return [...hash].map((char) => 'abcdefghijklmnop'[parseInt(char, 16)]).join('');
}

export function expectedOrigin(dir = REPO) {
  return `chrome-extension://${extensionId(dir)}`;
}

function encodeServerFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) header = Buffer.from([0x80 | opcode, body.length]);
  else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

// 返回 { frames, rest }。帧没收全时 frames 为空、rest 为全部缓冲。
export function decodeClientFrames(buffer) {
  const frames = [];
  let rest = buffer;
  while (rest.length >= 2) {
    const opcode = rest[0] & 0x0f;
    const masked = (rest[1] & 0x80) !== 0;
    let length = rest[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (rest.length < 4) break;
      length = rest.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (rest.length < 10) break;
      length = Number(rest.readBigUInt64BE(2));
      offset = 10;
    }
    const maskLength = masked ? 4 : 0;
    if (length > MAX_MESSAGE || rest.length < offset + maskLength + length) break;
    const mask = masked ? rest.subarray(offset, offset + 4) : null;
    offset += maskLength;
    const payload = Buffer.from(rest.subarray(offset, offset + length));
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    frames.push({ opcode, fin: (rest[0] & 0x80) !== 0, payload });
    rest = rest.subarray(offset + length);
  }
  return { frames, rest };
}

function attachSocket(socket, { onText, onClose }) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  const send = (text) => socket.write(encodeServerFrame(0x1, text));
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MESSAGE) {
      socket.destroy();
      return;
    }
    const decoded = decodeClientFrames(buffer);
    buffer = decoded.rest;
    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        onClose();
        socket.end(encodeServerFrame(0x8));
        return;
      }
      if (frame.opcode === 0x9) {
        socket.write(encodeServerFrame(0xa, frame.payload));
        continue;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x0) {
        fragments.push(frame.payload);
        if (!frame.fin) continue;
        const text = Buffer.concat(fragments).toString('utf8');
        fragments = [];
        onText(text);
      }
    }
  });
  socket.on('close', onClose);
  socket.on('error', onClose);
  return {
    send,
    close: () => socket.end(encodeServerFrame(0x8))
  };
}

function toolResult(text, isError = false) {
  return { isError, text };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const GRID_CSS = readFileSync(path.join(REPO, 'src/grid.css'), 'utf8');

function columnCount(count) {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  return 4;
}

function panelStatus(answer) {
  const words = String(answer.text ?? '').trim().length;
  const status = answer.status ?? '';
  if (status === 'done') return { text: `已完成（${words} 字）`, state: 'ok' };
  if (status === 'timeout' || status === 'disconnected') return { text: answer.error || status, state: 'error' };
  if (status) return { text: answer.error || status, state: 'warn' };
  return { text: '', state: '' };
}

// 正文是网格页已经消毒过的 HTML。这里再去掉脚本和事件，避免文件被打开时执行。
function safeHtml(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<(iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

function answerBody(answer) {
  if (answer.html) return safeHtml(answer.html);
  const text = String(answer.text ?? '').trim();
  return text ? `<p class="plain">${escapeHtml(text)}</p>` : '';
}

export function formatReport(question, answers) {
  const panels = answers
    .map((answer, index) => {
      const status = panelStatus(answer);
      const state = status.state ? ` data-state="${status.state}"` : '';
      return `<section class="panel" style="--order: ${index}">
        <div class="panel-header">
          <span class="panel-name">${escapeHtml(answer.site)}</span>
          <span class="panel-status"${state}>${escapeHtml(status.text)}</span>
        </div>
        <article class="answer" data-site="${escapeHtml(answer.site)}">${answerBody(answer)}</article>
      </section>`;
    })
    .join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(question)}</title>
  <style>
${GRID_CSS}
    .snapshot-question { margin: 0; padding: 7px 12px; white-space: pre-wrap; }
    .answer .plain { white-space: pre-wrap; margin: 0; }
  </style>
</head>
<body>
  <header class="topbar">
    <h1>Multi AI Chat</h1>
    <div class="composer">
      <div class="composer-box">
        <p class="snapshot-question">${escapeHtml(question)}</p>
      </div>
    </div>
  </header>
  <div class="stage">
    <main class="grid" style="--columns: ${columnCount(answers.length)}">
      ${panels}
    </main>
  </div>
</body>
</html>
`;
}

// 对话里只放总结。各家原文写进这个文件，避免工具结果过长时被截断。
function answersDir() {
  return process.env.MULTI_AI_CHAT_ANSWERS || path.join(homedir(), '.multi-ai-chat', 'answers');
}

function writeReport(question, answers) {
  const dir = answersDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}.html`);
  writeFileSync(file, formatReport(question, answers), { mode: 0o600 });
  return file;
}

function reportLink(port, file) {
  return `http://127.0.0.1:${port}/answers/${encodeURIComponent(path.basename(file))}`;
}

function packAnswers(question, answers, port) {
  const file = writeReport(question, answers);
  const link = reportLink(port, file);
  const slim = answers.map(({ html, ...rest }) => rest);
  return toolResult(JSON.stringify({ html: file, link, markdown: `[各家原文](${link})`, answers: slim }));
}

function serveAnswer(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  let pathname = '';
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const name = pathname.startsWith('/answers/') ? pathname.slice('/answers/'.length) : '';
  const dir = path.resolve(answersDir());
  const file = path.resolve(dir, name);
  if (!name || name !== path.basename(name) || !name.endsWith('.html') || path.dirname(file) !== dir) {
    res.writeHead(404);
    res.end();
    return;
  }
  let body;
  try {
    body = readFileSync(file);
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function answersFrom(current, fallbackStatus) {
  return current.sites.map((site) => {
    const got = current.answers.get(site);
    if (got?.status) return got;
    return {
      site,
      status: fallbackStatus,
      text: got?.text ?? '',
      error: fallbackStatus === 'timeout' ? WINDOW_FROZEN : DISCONNECTED
    };
  });
}

export function start({
  port = DEFAULT_PORT,
  deadlineMs = DEFAULT_DEADLINE_MS,
  stdio = false,
  origin = expectedOrigin(),
  controlPath = null
} = {}) {
  let client = null;
  let current = null;
  let boundPort = port;
  let tail = Promise.resolve();
  const waiters = new Set();
  let askSeq = 0;

  const enqueue = (task) => {
    const run = tail.then(task, task);
    tail = run.then(
      () => {},
      () => {}
    );
    return run;
  };

  const finish = (result) => {
    if (!current) return;
    clearTimeout(current.timer);
    const done = current.done;
    current = null;
    done(result);
  };

  const failCurrent = () => {
    if (!current) return;
    if (!current.beginSeen) finish(toolResult(DISCONNECTED, true));
    else finish(packAnswers(current.question, answersFrom(current, 'disconnected'), boundPort));
  };

  const onClientText = (socket, raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!current || current.socket !== socket || message.id !== current.id) return;
    if (message.type === 'begin') {
      current.beginSeen = true;
      current.sites = Array.isArray(message.sites) ? message.sites : [];
      if (!current.sites.length) finish(toolResult(NO_SITES, true));
      return;
    }
    if (message.type === 'update' || message.type === 'result') {
      for (const answer of message.answers ?? []) {
        if (answer?.site) current.answers.set(answer.site, answer);
      }
    }
    if (message.type === 'result') finish(packAnswers(current.question, answersFrom(current, 'disconnected'), boundPort));
  };

  const adopt = (socket) => {
    if (client) client.close();
    failCurrent();
    client = socket;
    for (const waiter of waiters) waiter();
    waiters.clear();
  };

  const httpServer = createServer((req, res) => serveAnswer(req, res));

  httpServer.on('upgrade', (req, socket) => {
    if ((req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    if (req.headers.origin !== origin) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const wrapped = attachSocket(socket, {
      onText: (text) => onClientText(wrapped, text),
      onClose: () => {
        if (client === wrapped) client = null;
        if (current?.socket === wrapped) failCurrent();
      }
    });
    adopt(wrapped);
  });

  const ask = (question) =>
    enqueue(async () => {
      const text = String(question ?? '').trim();
      if (!text) return toolResult(EMPTY_QUESTION, true);
      if (!client) return toolResult(NOT_CONNECTED, true);

      const id = `a${++askSeq}`;
      const socket = client;
      const result = await new Promise((resolve) => {
        current = {
          id,
          question: text,
          socket,
          sites: [],
          answers: new Map(),
          beginSeen: false,
          done: resolve,
          timer: setTimeout(() => {
            if (!current || current.id !== id) return;
            if (!current.beginSeen) finish(toolResult(WINDOW_FROZEN, true));
            else finish(packAnswers(current.question, answersFrom(current, 'timeout'), boundPort));
          }, deadlineMs)
        };
        socket.send(JSON.stringify({ type: 'ask', id, text }));
      });
      return result;
    });

  const waitForClient = (timeoutMs) => {
    if (client) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(ready);
        reject(new Error(NOT_CONNECTED));
      }, timeoutMs);
      const ready = () => {
        clearTimeout(timer);
        resolve();
      };
      waiters.add(ready);
    });
  };

  const listening = new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.off('error', reject);
      boundPort = httpServer.address().port;
      resolve(boundPort);
    });
  });

  return listening.then(async (boundPort) => {
    const control = controlPath ? await serveControl(controlPath, ask) : null;
    if (stdio) attachStdio(ask);
    return {
      port: boundPort,
      origin,
      ask,
      waitForClient,
      close: () =>
        new Promise((resolve) => {
          client?.close();
          failCurrent();
          control?.close(() => resolve());
          if (!control) httpServer.close(() => resolve());
          else httpServer.close(() => {});
          if (controlPath) {
            try {
              unlinkSync(controlPath);
            } catch {
              // 套接字已经没了。
            }
          }
        })
    };
  });
}

// Cursor 发现工具时会再起一个进程。端口已被自己的前一个进程占用时，这个新进程
// 不退出，提问转给持有浏览器连接的那个。网页连不上这个本机套接字。
function serveControl(controlPath, ask) {
  mkdirSync(path.dirname(controlPath), { recursive: true, mode: 0o700 });
  try {
    unlinkSync(controlPath);
  } catch {
    // 没有旧文件。
  }
  const control = createNetServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        void onControl(socket, line, ask);
      }
    });
  });
  return new Promise((resolve, reject) => {
    control.once('error', reject);
    control.listen(controlPath, () => {
      control.off('error', reject);
      try {
        chmodSync(controlPath, 0o600);
      } catch {
        // 权限设不上也不影响本机转发。
      }
      resolve(control);
    });
  });
}

async function onControl(socket, line, ask) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.ping) {
    socket.write(`${JSON.stringify({ pong: true })}\n`);
    return;
  }
  const result = await ask(message.question);
  socket.write(`${JSON.stringify({ isError: result.isError, text: result.text })}\n`);
}

function controlReady(controlPath) {
  return new Promise((resolve) => {
    const socket = connect(controlPath);
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 400);
    socket.on('error', () => finish(false));
    socket.on('data', (chunk) => finish(String(chunk).includes('"pong":true')));
    socket.write(`${JSON.stringify({ ping: true })}\n`);
  });
}

function forwardAsk(controlPath, question) {
  return new Promise((resolve, reject) => {
    const socket = connect(controlPath);
    let buffer = '';
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const message = JSON.parse(buffer.slice(0, newline));
      socket.end();
      resolve({ isError: message.isError, text: message.text });
    });
    socket.write(`${JSON.stringify({ question })}\n`);
  });
}

function attachStdio(ask) {
  let buffer = Buffer.alloc(0);
  let pending = 0;
  let stdinEnded = false;
  // Cursor 自带的 SDK 一行一个 JSON。探针仍用 Content-Length 头。应答跟来时的格式走。
  let framing = 'lsp';
  const send = (message) => {
    const body = Buffer.from(JSON.stringify(message));
    const frame =
      framing === 'line'
        ? Buffer.concat([body, Buffer.from('\n')])
        : Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
    process.stdout.write(frame);
  };
  const finishStdio = () => {
    if (stdinEnded && pending === 0) process.exit(0);
  };
  const respond = async (message) => {
    if (message.id === undefined || message.id === null) return;
    pending += 1;
    try {
      send({ jsonrpc: '2.0', id: message.id, result: await handleMcp(message, ask) });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: error.code ?? -32603, message: error instanceof Error ? error.message : String(error) }
      });
    } finally {
      pending -= 1;
      finishStdio();
    }
  };
  const pull = () => {
    while (buffer.length) {
      if (isContentLengthPrefix(buffer)) {
        framing = 'lsp';
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = buffer.subarray(0, headerEnd).toString('utf8');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        const length = Number(match[1]);
        const start = headerEnd + 4;
        if (buffer.length < start + length) return;
        const body = buffer.subarray(start, start + length).toString('utf8');
        buffer = buffer.subarray(start + length);
        respond(JSON.parse(body));
        continue;
      }
      if (buffer[0] === 0x7b) {
        framing = 'line';
        const newline = buffer.indexOf(0x0a);
        if (newline === -1) return;
        const line = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '');
        buffer = buffer.subarray(newline + 1);
        if (line.trim()) respond(JSON.parse(line));
        continue;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      buffer = buffer.subarray(newline + 1);
    }
  };
  // Cursor 断开这条 stdio 时要退出，否则进程会留下来继续占着 47321，下一次启动就会失败。
  // 等正在写的应答完成再退，避免应答还在事件队列里进程就没了。
  process.stdin.on('end', () => {
    stdinEnded = true;
    finishStdio();
  });
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    pull();
  });
  process.stdin.resume();
}

function isContentLengthPrefix(buffer) {
  const prefix = 'Content-Length';
  const sample = buffer.subarray(0, prefix.length).toString('utf8');
  return prefix.startsWith(sample) || sample.startsWith(prefix);
}

function toolSpec() {
  return {
    name: 'ask',
    description:
      '把一个问题同时发给浏览器里已开启的各家 AI 网页版，沿用当前会话。返回各家原文。markdown 是一行可点击链接，调用方必须把这一行原样放在总结最后，不要改成纯文本或括号。不要把文件当附件，也不要在对话里粘贴原文。网格窗口必须开着且不能最小化。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', minLength: 1, description: '要同时询问的问题' }
      },
      required: ['question'],
      additionalProperties: false
    }
  };
}

async function handleMcp(message, ask) {
  if (message.method === 'initialize') {
    return {
      protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'multi-ai-chat', version: '1.0.2' }
    };
  }
  if (message.method === 'ping') return {};
  if (message.method === 'tools/list') return { tools: [toolSpec()] };
  if (message.method === 'tools/call') {
    if (message.params?.name !== 'ask') throw new Error(`未知工具 ${message.params?.name ?? ''}`);
    const result = await ask(message.params?.arguments?.question);
    return {
      content: [{ type: 'text', text: result.text }],
      isError: result.isError
    };
  }
  const error = new Error(`未知方法 ${message.method ?? ''}`);
  error.code = -32601;
  throw error;
}

function isMain() {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return entry === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const port = Number(process.env.MULTI_AI_CHAT_PORT ?? DEFAULT_PORT);
  const deadlineMs = Number(process.env.MULTI_AI_CHAT_DEADLINE_MS ?? DEFAULT_DEADLINE_MS);
  const controlPath = process.env.MULTI_AI_CHAT_CONTROL || DEFAULT_CONTROL;
  start({ port, deadlineMs, stdio: true, controlPath }).catch(async (error) => {
    if (error?.code === 'EADDRINUSE' && (await controlReady(controlPath))) {
      attachStdio((question) => forwardAsk(controlPath, question));
      return;
    }
    const message = error?.code === 'EADDRINUSE' ? `${port} 已被占用。请先停掉正在运行的 multi-ai-chat。` : String(error);
    console.error(message);
    process.exit(1);
  });
}
