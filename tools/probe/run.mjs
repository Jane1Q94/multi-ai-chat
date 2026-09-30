// 挂到 cchrome（`~/bin/cchrome`，固定 --remote-debugging-port=9222 + ~/ChromeDebugProfile）
// 上验证扩展。用的是日常浏览器，四家都带真实登录态。
//
// 前置：先在 cchrome 里 chrome://extensions → 加载已解压的扩展程序 → 选本仓库目录。
//
// 用法:
//   node tools/probe/run.mjs                  只验证四个面板能否嵌入
//   node tools/probe/run.mjs --ask=你的问题     额外验证填词链路（只填不发送）
//   node tools/probe/run.mjs --ask=xx --send   连发送一起验证（会真的提问）
//   node tools/probe/run.mjs --keep            跑完保留 grid 标签页
//   node tools/probe/run.mjs --fresh           重载扩展并新开标签页（改了 manifest 才需要）
//   node tools/probe/run.mjs --reload=grok     只重载一个站点的 iframe，让它吃到新的选择器
//   node tools/probe/run.mjs --net=grok        同上，并打印这个站点失败/未返回的请求
//
// 绝不碰这个 Chrome 的 profile，也绝不 kill 它。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? 9222);
const ASK = process.argv.find((a) => a.startsWith('--ask='))?.slice('--ask='.length);
const SEND = process.argv.includes('--send');
const KEEP = process.argv.includes('--keep');
const FRESH = process.argv.includes('--fresh');
const EVAL_JS = process.argv.find((a) => a.startsWith('--eval='))?.slice('--eval='.length);
const EVAL_SITE = process.argv.find((a) => a.startsWith('--on='))?.slice('--on='.length);
const NET_SITE = process.argv.find((a) => a.startsWith('--net='))?.slice('--net='.length);
const RELOAD_SITE = process.argv.find((a) => a.startsWith('--reload='))?.slice('--reload='.length) ?? NET_SITE;
const NET_DUMP = process.argv.includes('--net') || !!NET_SITE;
const EDIT_DUMP = process.argv.includes('--editors');
const COOKIES = process.argv.includes('--cookies');
const TOGGLE = process.argv.find((a) => a.startsWith('--toggle='))?.slice('--toggle='.length);
const ANSWER_DUMP = process.argv.includes('--answers');
const COPY = process.argv.includes('--copy');
const IMAGE = process.argv.includes('--image');
const HTML_OF = process.argv.find((a) => a.startsWith('--html='))?.slice('--html='.length);

// Chrome 给未打包扩展分配的 ID = SHA256(绝对路径) 前 16 字节，每个 nibble 映射到 a-p。
function extensionId(dir) {
  const hash = createHash('sha256').update(dir).digest('hex').slice(0, 32);
  return [...hash].map((c) => 'abcdefghijklmnop'[parseInt(c, 16)]).join('');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        return;
      }
      for (const handler of this.handlers) handler(msg);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Cdp(ws);
  }

  // 换过 src 的 iframe 会留下一个还没收到 detachedFromTarget 的僵尸会话，往它发命令永远收不到
  // 回复。没有超时的话整个探测就停在那儿，看着像浏览器挂了。
  send(method, params = {}, sessionId, timeout = 20000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeout}ms 没回复，会话可能已经是僵尸）`));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  // Runtime.evaluate 的异常默认只体现在 exceptionDetails 里，不会 reject，容易看成 undefined。
  async eval(expression, sessionId, { userGesture = false } = {}) {
    const { result, exceptionDetails } = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture },
      sessionId
    ).catch((error) => {
      if (!String(error).includes('Session with given id not found')) throw error;
      throw new Error('grid 标签页的 CDP 会话失效了：它被销毁了，通常是另一个探测进程重载了扩展');
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }

  on(handler) {
    this.handlers.push(handler);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browserWebSocket() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return (await res.json()).webSocketDebuggerUrl;
  } catch {
    throw new Error(`127.0.0.1:${PORT} 上没有 DevTools 端点，先把 cchrome 跑起来`);
  }
}

// 站点改版后用来重新找选择器：列出页面里所有可编辑元素和疑似发送按钮。
const EDITORS = `JSON.stringify({
  editors: [...document.querySelectorAll('textarea, [contenteditable=""], [contenteditable="true"]')].map((el) => ({
    tag: el.tagName,
    id: el.id || null,
    cls: (el.className?.toString?.() ?? '').slice(0, 90) || null,
    testid: el.dataset?.testid ?? null,
    lexical: el.getAttribute('data-lexical-editor'),
    placeholder: el.getAttribute('placeholder') ?? el.getAttribute('data-placeholder'),
    visible: !!el.offsetParent
  })),
  fileInputs: [...document.querySelectorAll('input[type=file]')].map((el) => ({
    id: el.id || null,
    cls: (el.className?.toString?.() ?? '').slice(0, 50) || null,
    testid: el.dataset?.testid ?? null,
    accept: el.accept || null,
    multiple: el.multiple
  })),
  fileInputs: [...document.querySelectorAll('input[type=file]')].map((el) => ({
    id: el.id || null,
    cls: (el.className?.toString?.() ?? '').slice(0, 50) || null,
    testid: el.dataset?.testid ?? null,
    accept: el.accept || null,
    multiple: el.multiple
  })),
  // 发送按钮不一定在输入框附近的 DOM 里，所以整站再按关键词搜一遍。
  sendish: [...document.querySelectorAll('button, [role="button"], [class*="send"], [class*="Send"]')]
    .filter((el) =>
      /send|发送|submit/i.test(
        (el.className?.toString?.() ?? '') + ' ' + el.id + ' ' + (el.getAttribute('aria-label') ?? '') + ' ' + (el.dataset?.testid ?? '')
      )
    )
    .slice(0, 8)
    .map((el) => ({
      tag: el.tagName,
      id: el.id || null,
      testid: el.dataset?.testid ?? null,
      cls: (el.className?.toString?.() ?? '').slice(0, 60) || null,
      label: el.getAttribute('aria-label'),
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
      visible: !!el.offsetParent
    })),
  buttons: (() => {
    // 从输入框往上找几层容器，把里面的按钮全列出来 —— 发送按钮通常只有图标，
    // 没有 aria-label 也没有 testid，靠关键词过滤会全漏掉。
    const input = [...document.querySelectorAll('textarea, [contenteditable="true"]')].find((n) => !!n.offsetParent);
    let box = input;
    for (let i = 0; i < 8 && box?.parentElement; i++) box = box.parentElement;
    return [...(box?.querySelectorAll('button, [role="button"]') ?? [])].map((el) => ({
      tag: el.tagName,
      id: el.id || null,
      testid: el.dataset?.testid ?? null,
      cls: (el.className?.toString?.() ?? '').slice(0, 60) || null,
      label: el.getAttribute('aria-label'),
      text: el.textContent?.trim().slice(0, 10) || null,
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true'
    }));
  })()
})`;

// 找回答容器用：列出页面里所有像「消息 / markdown 正文」的元素，按出现顺序取最后几个。
const ANSWERS = `JSON.stringify(
  [...document.querySelectorAll('[class*="markdown"], [class*="message"], [class*="answer"], [data-testid*="message"], [data-message-author-role]')]
    .filter((el) => (el.innerText || '').trim().length > 15)
    .slice(-8)
    .map((el) => ({
      tag: el.tagName,
      cls: (el.className?.toString?.() ?? '').slice(0, 70) || null,
      testid: el.dataset?.testid ?? null,
      role: el.getAttribute('data-message-author-role'),
      len: el.innerText.trim().length,
      kids: el.children.length,
      head: el.innerText.trim().slice(0, 25)
    }))
)`;

// 站点在 iframe 里报网络错误时用：先看它自己能读到哪些 cookie（Lax 的在跨站子框架里会消失），
// 再看它自家接口挂在哪个状态码上。只看同源请求，跨源的 responseStatus 一律是 0，没有信息量。
const NET = `JSON.stringify({
  cookies: document.cookie.split('; ').map((c) => c.split('=')[0]).filter(Boolean),
  failed: performance.getEntriesByType('resource')
    .filter((e) => e.name.startsWith(location.origin) && (e.responseStatus === 0 || e.responseStatus >= 400))
    .slice(-10)
    .map((e) => e.responseStatus + ' ' + e.name.slice(location.origin.length, location.origin.length + 90))
})`;

// 站点选择器只在 src/sites.js 里维护一份。用参数遮蔽 globalThis，避免污染真实页面。
function inspectFrameExpression() {
  const sites = readFileSync(path.join(REPO, 'src/sites.js'), 'utf8');
  return `(() => {
    const scope = {};
    (function (globalThis) { ${sites} })(scope);
    const site = scope.MULTI_AI_SITES.find((s) => location.hostname === s.host || location.hostname.endsWith('.' + s.host));
    // 与 inject.js 的 findInput 同一套规则：按选择器顺序找，只认可编辑且可见的那个。
    const pick = (selector) =>
      selector
        .split(',')
        .map((one) => one.trim())
        .filter(Boolean)
        .reduce(
          (found, one) =>
            found ??
            [...document.querySelectorAll(one)].find(
              (n) => n.offsetParent && (typeof n.value === 'string' || n.isContentEditable)
            ) ??
            null,
          null
        );
    const el = site ? pick(site.input) : null;
    return JSON.stringify({
      url: location.href,
      site: site?.id ?? null,
      title: document.title,
      framed: window.top !== window.self,
      textLen: (document.body?.innerText || '').length,
      head: (document.body?.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 260),
      inputFound: !!el,
      inputTag: el ? el.tagName + (el.isContentEditable ? '[contenteditable]' : '') : null,
      answerSelector: site?.answer ?? null,
      answerCount: site?.answer ? document.querySelectorAll(site.answer).length : null,
      sendButton: (site?.send ?? []).find((sel) => document.querySelector(sel)) ?? null
    });
  })()`;
}

// 扩展文件改了要重新加载才生效。有调试开关时直接 loadUnpacked；没有就借扩展页自己调
// chrome.runtime.reload()，这样不用手点 chrome://extensions。
async function refreshExtension(browser, extId) {
  try {
    const { id } = await browser.send('Extensions.loadUnpacked', { path: REPO });
    console.log(`Extensions.loadUnpacked 成功: ${id}`);
    return id;
  } catch {
    // cchrome 没带 --enable-unsafe-extension-debugging，走 runtime.reload 兜底。
  }

  const { targetInfos } = await browser.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${extId}/`));
  if (!page) {
    console.log('没有已打开的扩展页，跳过重载（改动可能未生效）');
    return extId;
  }
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Runtime.evaluate', { expression: 'chrome.runtime.reload()' }, sessionId).catch(() => {});
  await sleep(2000);
  console.log('已通过 chrome.runtime.reload() 重载扩展');
  return extId;
}

// 每次新建标签页，等于在六个产品里各开一轮新对话，聊天记录会被探测刷满。所以默认复用已经
// 开着的 grid 页——里面的 iframe 还停在上次的对话上，追问就落在同一个会话里。
// 代价是拿不到新改的扩展代码（重载扩展会销毁这个标签页），改了源码要显式 --fresh。
async function gridTab(browser, extId) {
  const gridUrl = `chrome-extension://${extId}/src/grid.html`;
  const { targetInfos } = await browser.send('Target.getTargets');
  const open = FRESH ? null : targetInfos.find((t) => t.type === 'page' && t.url.startsWith(gridUrl));
  if (open) {
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId: open.targetId, flatten: true });
    console.log('复用已打开的 grid 标签页，沿用各站现有对话（改了扩展代码请加 --fresh）');
    return { sessionId, targetId: open.targetId, reused: true };
  }

  // 重载扩展会让旧 grid 页里的 content script 失效，留着只会是个假面板，顺手关掉。
  for (const stale of targetInfos.filter((t) => t.type === 'page' && t.url.startsWith(gridUrl))) {
    await browser.send('Target.closeTarget', { targetId: stale.targetId }).catch(() => {});
  }
  await refreshExtension(browser, extId);
  const { targetId } = await browser.send('Target.createTarget', { url: gridUrl });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  return { sessionId, targetId, reused: false };
}

// 两个探测进程不能并存：启动时的扩展重载会销毁另一个进程正在观察的 grid 标签页，
// 表现是莫名其妙的 "Session with given id not found"。
function acquireLock() {
  const lock = path.join(REPO, '.probe/lock');
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      // 进程已经不在了，锁是上次异常退出留下的
    }
    if (alive) throw new Error(`已有探测进程在跑（pid ${pid}），两个一起跑会互相踢掉标签页`);
  }
  writeFileSync(lock, String(process.pid));
  return () => rmSync(lock, { force: true });
}

async function main() {
  mkdirSync(path.join(REPO, '.probe'), { recursive: true });
  const release = acquireLock();
  process.on('exit', release);
  const extId = extensionId(REPO);
  const browser = await Cdp.connect(await browserWebSocket());
  console.log(`已连上 cchrome (127.0.0.1:${PORT})，扩展 ID: ${extId}`);

  // 诊断 iframe 里掉登录的原因：SameSite=Lax/Strict 的 cookie 不会随跨站子框架请求发送。
  // 只看名字和属性，不碰值。
  if (COOKIES) {
    const { cookies } = await browser.send('Storage.getCookies');
    console.log('\n=== 各站点 cookie 的 SameSite ===');
    const sites = readFileSync(path.join(REPO, 'src/sites.js'), 'utf8').matchAll(/host: '([^']+)'/g);
    for (const [, host] of sites) {
      const mine = cookies.filter((c) => host.endsWith(c.domain.replace(/^\./, '')) || c.domain.endsWith(host));
      // 只盯「疑似会话」会漏掉各家自造的命名，跨站 iframe 里谁掉了都得看得见，所以全列。
      console.log(`${host.padEnd(20)} 共 ${String(mine.length).padStart(3)} 个:`);
      for (const c of mine) {
        console.log(`   ${c.name.padEnd(34)} sameSite=${c.sameSite ?? '(未设置，按 Lax 处理)'} secure=${c.secure}`);
      }
    }
  }

  const { sessionId, targetId, reused } = await gridTab(browser, extId);

  const logs = [];
  const netUrls = new Map();
  const netOpen = new Map();
  const netFails = [];
  const netApi = [];
  const parentOf = new Map();
  // worker 的请求记在 worker 自己的 session 上，要顺着附加关系往上归到所属站点。
  const under = (session, frame) => {
    for (let s = session; s; s = parentOf.get(s)) if (s === frame) return true;
    return false;
  };
  const frameSessions = new Map();
  browser.on((msg) => {
    if (msg.method === 'Target.attachedToTarget') {
      const info = msg.params.targetInfo;
      if (info.type === 'iframe') frameSessions.set(msg.params.sessionId, info.url);
      browser.send('Runtime.enable', {}, msg.params.sessionId).catch(() => {});
      browser.send('Log.enable', {}, msg.params.sessionId).catch(() => {});
      if (NET_DUMP) {
        browser.send('Network.enable', {}, msg.params.sessionId).catch(() => {});
        // 有的站点（Grok）把聊天请求放在 blob Web Worker 里发，worker 是独立的调试目标，
        // 不逐层往下开自动附加就完全看不到那些请求。
        browser
          .send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, msg.params.sessionId)
          .catch(() => {});
      }
      parentOf.set(msg.params.sessionId, msg.sessionId ?? null);
    }
    // iframe 跳转会销毁旧 target，留着会导致后面 evaluate 报 session not found。
    if (msg.method === 'Target.detachedFromTarget') frameSessions.delete(msg.params.sessionId);
    // 附加时 iframe 的 url 往往还是空的，所以只记 sessionId，等探测拿到真实站点再翻译。
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      logs.push({ session: msg.sessionId, text: msg.params.entry.text.slice(0, 300) });
    }
    // content script 跑在隔离世界，它抛的异常只会以 exceptionThrown 出现，
    // 不进 Log.entryAdded，之前这类错误在探测里完全是隐形的。
    if (msg.method === 'Runtime.exceptionThrown') {
      const detail = msg.params.exceptionDetails;
      logs.push({
        session: msg.sessionId,
        text: `未捕获异常: ${(detail.exception?.description ?? detail.text ?? '').slice(0, 300)}`
      });
    }
    // 站点自己弹「网络问题」时，它到底哪个请求挂了、是被谁拦的，只有网络事件说得清；
    // performance 里的 responseStatus 对失败请求一律给 0，看不出原因。
    if (msg.method === 'Network.requestWillBeSent') {
      netUrls.set(msg.params.requestId, msg.params.request.url);
      netOpen.set(msg.params.requestId, { session: msg.sessionId, url: msg.params.request.url });
    }
    // 一直挂着不返回的请求既不报错也没状态码，只能靠「发出去了但没收尾」认出来。
    if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') {
      netOpen.delete(msg.params.requestId);
    }
    // 光看失败不够：站点接口返回 200 但内容是错误体的情况也要能看见，所以接口请求全记一笔。
    if (msg.method === 'Network.responseReceived' && /rest|api|conversation|graphql/i.test(msg.params.response.url)) {
      netApi.push({ session: msg.sessionId, text: `HTTP ${msg.params.response.status} ${msg.params.response.url}` });
    }
    if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
      netFails.push({ session: msg.sessionId, text: `HTTP ${msg.params.response.status} ${netUrls.get(msg.params.requestId) ?? ''}` });
    }
    // 跨站 iframe 里掉登录的直接证据：Chrome 会逐个 cookie 说明为什么没带上（SameSiteLax 等）。
    if (msg.method === 'Network.requestWillBeSentExtraInfo') {
      for (const entry of msg.params.associatedCookies ?? []) {
        if (!entry.blockedReasons?.length) continue;
        const url = netUrls.get(msg.params.requestId) ?? '(还没看到这个请求)';
        netFails.push({
          session: msg.sessionId,
          text: `cookie ${entry.cookie.name} 未发送: ${entry.blockedReasons.join(',')} → ${url}`
        });
      }
    }
    if (msg.method === 'Network.loadingFailed') {
      const blocked = msg.params.blockedReason ? ` blockedReason=${msg.params.blockedReason}` : '';
      netFails.push({ session: msg.sessionId, text: `${msg.params.errorText}${blocked} ${netUrls.get(msg.params.requestId) ?? ''}` });
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      logs.push({ session: msg.sessionId, text: text.slice(0, 300) });
    }
  });

  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Log.enable', {}, sessionId);
  await browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);

  let loaded = false;
  for (let i = 0; i < 20 && !loaded; i++) {
    loaded = await browser.eval('!!document.getElementById("grid")', sessionId).catch(() => false);
    if (!loaded) await sleep(500);
  }
  if (!loaded) {
    console.log(`\n打不开 ${gridUrl}`);
    console.log('请先在 cchrome 里打开 chrome://extensions，开启开发者模式，加载已解压的扩展程序：');
    console.log(`  ${REPO}`);
    process.exit(1);
  }

  if (reused) {
    console.log('面板已在位，跳过等待');
  } else {
    console.log('等待各面板加载…');
    await sleep(20000);
  }
  console.log(`\n顶栏提示: ${await browser.eval('document.getElementById("hint").textContent', sessionId)}`);

  const ready = JSON.parse(
    await browser.eval(
      `JSON.stringify([...document.querySelectorAll('.panel')].map((p) =>
        p.querySelector('.panel-name').textContent + ': ' + p.querySelector('.panel-status').textContent))`,
      sessionId
    )
  );
  console.log(`面板状态: ${ready.join(' | ')}`);

  // 重载单个站点的 iframe，有两个用处：content script 改了选择器，重新注入就生效，不用重载
  // 整个扩展（那会连带销毁标签页、把别家对话也冲掉）；另外 Network 事件只抓得到开启之后的
  // 请求，站点首屏那批早在自动附加之前就发完了，想看清首屏哪个接口挂了也得重载一次。
  if (RELOAD_SITE) {
    for (const [frameSession] of frameSessions) {
      const host = String(await browser.eval('location.hostname', frameSession).catch(() => ''));
      if (!host.includes(RELOAD_SITE)) continue;
      await browser.send('Runtime.evaluate', { expression: 'location.reload()' }, frameSession).catch(() => {});
      console.log(`已重载 ${host} 的 iframe，重新抓它的首屏请求…`);
      await sleep(15000);
      break;
    }
  }

  console.log('\n=== 各 iframe 内部探测 ===');
  const expression = inspectFrameExpression();
  const results = [];
  const owner = new Map([[sessionId, 'grid']]);
  for (const [frameSession, url] of frameSessions) {
    try {
      const parsed = JSON.parse(await browser.eval(expression, frameSession));
      owner.set(frameSession, parsed.site ?? new URL(parsed.url).hostname);
      results.push(parsed);
      if (EDIT_DUMP) parsed.candidates = JSON.parse(await browser.eval(EDITORS, frameSession));
      console.log(
        `${parsed.inputFound ? '✅' : '⚠️ '} ${(parsed.site ?? new URL(parsed.url).hostname).padEnd(10)} ` +
          `framed=${parsed.framed} 正文${String(parsed.textLen).padStart(5)}字 ` +
          `输入框=${parsed.inputTag ?? '未找到'} 回答容器命中 ${parsed.answerCount ?? '-'} 个`
      );
      if (parsed.candidates) console.log(`   ${JSON.stringify(parsed.candidates)}`);
      if (NET_DUMP) {
        console.log(`   ${await browser.eval(NET, frameSession)}`);
        const mine = [...new Set(netFails.filter((f) => under(f.session, frameSession)).map((f) => f.text))];
        for (const text of mine.slice(0, 8)) console.log(`   ✖ ${text.slice(0, 150)}`);
      }
    } catch (error) {
      console.log(`❌ ${url} 无法求值: ${String(error).slice(0, 160)}`);
    }
  }

  let askStatus = null;
  if (ASK) {
    console.log(`\n=== ${SEND ? '提问' : '填词'}验证: "${ASK}" ===`);
    await browser.eval(`__multiAiAsk(${JSON.stringify(ASK)}, { send: ${SEND} })`, sessionId);
    // 开了深度思考的站点 16 秒经常还没出正文，等久一点，验证结果才稳定。
    await sleep(SEND ? 28000 : 12000);
    askStatus = JSON.parse(
      await browser.eval(
        `JSON.stringify([...document.querySelectorAll('.panel')].map((p) => ({
          name: p.querySelector('.panel-name').textContent,
          status: p.querySelector('.panel-status').textContent,
          answer: (p.querySelector('.answer')?.innerText ?? '').trim().length,
          nodes: p.querySelectorAll('.answer *').length
        })))`,
        sessionId
      )
    );
    const good = SEND ? /^(等待回答|回答中|已完成)/ : /^已填入/;
    for (const row of askStatus) {
      console.log(
        `${good.test(row.status) ? '✅' : '⚠️ '} ${row.name.padEnd(10)} ${row.status.padEnd(18)} ` +
          `回答 ${String(row.answer).padStart(4)} 字 / ${String(row.nodes).padStart(3)} 个节点`
      );
    }
    // 提问后再量一次：卡片是空的时候，要先分清是选择器没命中，还是回传链路断了。
    for (const [frameSession, site] of owner) {
      if (site === 'grid') continue;
      const after = JSON.parse(await browser.eval(expression, frameSession).catch(() => 'null'));
      if (!after) continue;
      console.log(`   ${site}: 回答容器命中 ${after.answerCount} 个（${after.answerSelector}）`);
      console.log(`     ${after.url}`);
      console.log(`     正文: ${after.head}`);
      // 发送按钮往往只在输入框有内容后才出现或启用，所以这里再勘查一次才看得到它。
      if (EDIT_DUMP) console.log(`     ${await browser.eval(EDITORS, frameSession)}`);
      if (NET_DUMP) {
        const failed = [...new Set(netFails.filter((f) => under(f.session, frameSession)).map((f) => f.text))];
        for (const text of failed.slice(0, 6)) console.log(`     ✖ ${text.slice(0, 150)}`);
        const pending = [...netOpen.values()].filter((o) => under(o.session, frameSession));
        for (const { url } of pending.slice(-6)) console.log(`     ⏳ 未返回 ${url.slice(0, 130)}`);
        const api = netApi.filter((a) => under(a.session, frameSession));
        for (const { text } of api.slice(-8)) console.log(`     → ${text.slice(0, 140)}`);
      }
    }

    // 渲染走样时用来看消毒后的真实结构，比猜 CSS 靠谱。
    if (HTML_OF) {
      const html = await browser.eval(
        `(() => {
          const panel = [...document.querySelectorAll('.panel')].find((p) =>
            p.querySelector('.panel-name').textContent.includes(${JSON.stringify(HTML_OF)}));
          const source = panel?.querySelector('.answer')?.innerHTML ?? '';
          return JSON.stringify({ html: source.slice(0, 1200), markdown: __multiAiMarkdown(source) });
        })()`,
        sessionId
      );
      const dump = JSON.parse(html);
      console.log(`\n=== ${HTML_OF} 消毒后的 HTML ===\n${dump.html}`);
      console.log(`\n=== ${HTML_OF} 转成的 Markdown ===\n${dump.markdown}`);
    }

    const detail = JSON.parse(await browser.eval('JSON.stringify(__multiAiLast())', sessionId));
    for (const [site, data] of Object.entries(detail)) {
      if (data.debug) console.log(`   ${site}: ${JSON.stringify(data.debug)}`);
    }
  }

  // 图片粘贴：在页面里画一张带数字的 PNG 贴进输入框，再看四家能不能读出这个数字。
  // 光看「附件出现了」不算数，要走到站点真的收到图。
  if (IMAGE) {
    console.log('\n=== 图片粘贴验证（图中数字 7395）===');
    const chips = await browser.eval(
      `(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 260;
        canvas.height = 96;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000';
        ctx.font = 'bold 56px sans-serif';
        ctx.fillText('7395', 34, 68);
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
        const data = new DataTransfer();
        data.items.add(new File([blob], 'number.png', { type: 'image/png' }));
        const box = document.getElementById('prompt');
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 200));
        // 附件条要在提交前读：提交处理器会把 pendingFiles 清空并重绘。
        const chips = document.getElementById('attachments').textContent.trim();
        box.value = '图片里的数字是什么？只回答数字。';
        document.getElementById('composer').requestSubmit();
        return chips;
      })()`,
      sessionId
    );
    console.log(`附件: ${chips || '(无)'}`);
    // 读图比纯文本慢不少，30 秒经常还在流式输出。
    await sleep(60000);
    const rows = JSON.parse(
      await browser.eval(
        `JSON.stringify([...document.querySelectorAll('.panel')].map((p) => ({
          name: p.querySelector('.panel-name').textContent,
          status: p.querySelector('.panel-status').textContent,
          text: (p.querySelector('.answer')?.innerText ?? '').trim().slice(0, 40)
        })))`,
        sessionId
      )
    );
    for (const row of rows) {
      console.log(`${row.text.includes('7395') ? '✅' : '⚠️ '} ${row.name.padEnd(10)} ${row.status.padEnd(18)} ${row.text}`);
    }
  }

  // 富文本复制要靠页面获得焦点 + 用户手势，静默失败的概率不低，所以单独验一次。
  if (COPY) {
    console.log('\n=== 富文本复制验证 ===');
    await browser.send('Page.bringToFront', {}, sessionId).catch(() => {});
    const result = await browser.eval(
      `(async () => {
        const panel = [...document.querySelectorAll('.panel')].find((p) => !p.querySelector('button').disabled);
        if (!panel) return '没有可复制的面板';
        [...panel.querySelectorAll('button')].find((b) => b.textContent.startsWith('复制')).click();
        await new Promise((r) => setTimeout(r, 600));
        return panel.querySelector('.panel-name').textContent + ' → 按钮: ' +
          [...panel.querySelectorAll('button')][0].textContent + '，状态: ' + panel.querySelector('.panel-status').textContent;
      })()`,
      sessionId,
      { userGesture: true }
    );
    console.log(result);
  }

  // 在设置面板里真点一次复选框，验证开关 → 存储 → 面板增删 → 布局这条链路。
  if (TOGGLE) {
    console.log(`\n=== 站点开关验证: ${TOGGLE} ===`);
    const click = `(async () => {
      document.getElementById('open-settings').click();
      await new Promise((r) => setTimeout(r, 400));
      const row = [...document.querySelectorAll('#site-list li')].find((li) => li.textContent.includes(${JSON.stringify(TOGGLE)}));
      if (!row) return JSON.stringify({ error: '设置面板里没有这个站点' });
      row.querySelector('input[type=checkbox]').click();
      await new Promise((r) => setTimeout(r, 800));
      return JSON.stringify({
        panels: document.querySelectorAll('.panel').length,
        columns: getComputedStyle(document.getElementById('grid')).getPropertyValue('--columns').trim(),
        names: [...document.querySelectorAll('.panel-name')].map((n) => n.textContent)
      });
    })()`;
    console.log(`关掉后: ${await browser.eval(click, sessionId)}`);
    console.log(`再打开: ${await browser.eval(click, sessionId)}`);
  }

  // 回答要先有内容才能勘查，所以这一步放在提问之后。
  if (ANSWER_DUMP) {
    console.log('\n=== 回答容器候选 ===');
    for (const [frameSession, site] of owner) {
      if (site === 'grid') continue;
      const rows = JSON.parse(await browser.eval(ANSWERS, frameSession).catch(() => '[]'));
      console.log(`--- ${site}`);
      for (const r of rows) console.log(`   ${JSON.stringify(r)}`);
    }
  }

  // 选择器考古经常需要临时问一句「这一刻这个 frame 里到底是什么」，固定的勘查项覆盖不了。
  if (EVAL_JS) {
    const [frameSession] = [...owner].find(([, site]) => site === (EVAL_SITE ?? 'grid')) ?? [];
    if (!frameSession) console.log(`\n没有 ${EVAL_SITE} 的 frame`);
    else console.log(`\n=== ${EVAL_SITE ?? 'grid'} 求值 ===\n${await browser.eval(EVAL_JS, frameSession)}`);
  }

  await browser.send('Page.enable', {}, sessionId).catch(() => {});
  const shot = await browser.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, sessionId);
  const shotPath = path.join(REPO, '.probe/grid.jpeg');
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log(`\n截图: ${shotPath}`);

  if (logs.length) {
    console.log('\n=== 错误日志 ===');
    for (const l of logs.slice(0, 25)) console.log(`[${owner.get(l.session) ?? '已关闭的 frame'}] ${l.text}`);
  } else {
    console.log('\n无 error 级日志');
  }

  writeFileSync(
    path.join(REPO, '.probe/result.json'),
    JSON.stringify(
      { extId, results, askStatus, logs: logs.map((l) => ({ from: owner.get(l.session) ?? '?', text: l.text })) },
      null,
      2
    )
  );
  // 复用来的标签页不是我们开的，留给下次探测继续用。
  if (!KEEP && !reused) await browser.send('Target.closeTarget', { targetId });
  browser.ws.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
