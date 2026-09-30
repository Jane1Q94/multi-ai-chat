// 注入到各 AI 站点的 iframe 里，负责把 grid 页面发来的问题填进输入框并发送。
// 通过 postMessage 与父页通信：父页是扩展页，与站点跨源，但 message 事件在
// isolated world 里照样收得到。
const CHANNEL = globalThis.MULTI_AI_CHANNEL;
const EXT_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');

// 适配器要从存储里查，自定义站点的选择器只存在那里。每个 frame 只查一次。
let sitePromise = null;
function currentSite() {
  sitePromise ??= globalThis.MultiAiStore.sites().then(({ all }) =>
    globalThis.MultiAiStore.findSite(all, location.hostname)
  );
  return sitePromise;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isTextField = (el) => typeof el.value === 'string';
const readText = (el) => (isTextField(el) ? el.value : el.innerText);
const normalize = (text) => text.replace(/\s+/g, ' ').trim();

// 逗号分隔的选择器列表按顶层逗号切开，方括号和括号里的不算。
function splitSelectors(selector) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts.map((one) => one.trim()).filter(Boolean);
}

// 选择器允许命中多个，挑出那个真能用的：
// 要可编辑（有的站点把编辑器包在同类名的外层容器里，外层不可编辑），
// 也要可见（ChatGPT 在窄面板下渲染移动版 composer，桌面版那个还在 DOM 里但不显示）。
//
// 逐个选择器按顺序找，而不是一次 querySelectorAll：后者给的是文档顺序，而适配器里写在
// 前面的才是首选。豆包的 chat_input 里既有真正的 ProseMirror，又有一个陪衬的 textarea，
// 而那个 textarea 在 DOM 里还更靠前——往它写字，站点完全不认。
function usableInput(el) {
  return el.isConnected && !!el.offsetParent && (isTextField(el) || el.isContentEditable);
}

function findInput(selector) {
  for (const one of splitSelectors(selector)) {
    const hit = [...document.querySelectorAll(one)].find(usableInput);
    if (hit) return hit;
  }
  return null;
}

async function waitForInput(selector, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const el = findInput(selector);
    if (el) return el;
    await sleep(200);
  }
  return null;
}

// 选中已有内容，让后续插入变成「替换」而不是「追加」。显式操作 Selection 而不是只靠
// focus()，因为跨源 iframe 未必拿得到窗口焦点。
function selectAll(el) {
  el.focus();
  if (isTextField(el)) {
    el.setSelectionRange(0, el.value.length);
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

// 三种写入方式，从最通用到最兜底。contenteditable 编辑器（ProseMirror / Lexical）
// 只认走 beforeinput 的输入，直接赋值不会进它们的内部状态。
const FILL_STRATEGIES = [
  {
    name: 'insertText',
    run: (el, text) => {
      selectAll(el);
      document.execCommand('insertText', false, text);
    }
  },
  {
    name: 'paste',
    run: (el, text) => {
      selectAll(el);
      const data = new DataTransfer();
      data.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }
  },
  {
    // 千问这类自维护状态的编辑器不认 execCommand 写进去的内容（发送按钮保持禁用），
    // 但会处理带 data 的 beforeinput。
    name: 'inputEvent',
    run: (el, text) => {
      selectAll(el);
      const init = { inputType: 'insertText', data: text, bubbles: true, cancelable: true, composed: true };
      el.dispatchEvent(new InputEvent('beforeinput', init));
      if (isTextField(el)) el.value = text;
      else el.textContent = text;
      el.dispatchEvent(new InputEvent('input', init));
    }
  },
  {
    name: 'nativeSetter',
    run: (el, text) => {
      if (!isTextField(el)) return;
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      descriptor?.set?.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
];

// 光看「DOM 里有文字」不够：有的编辑器自己维护状态，文字写进去了但它仍认为是空的，
// 表现就是发送按钮一直禁用。有按钮可判断时就一起作为验收条件，这样才会继续试下一种写法。
// 有的站点的发送键是 div，禁用状态只体现在 class 上，读 disabled 属性看不出来。
function looksDisabled(el) {
  return el.disabled === true || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled');
}

function sendStillDisabled(site) {
  for (const selector of site.send ?? []) {
    const el = document.querySelector(selector);
    if (el) return looksDisabled(el);
  }
  return false;
}

// 失败时把每一步的现场一并带回去：站点改版后光看「填词失败」没法定位。
async function fill(site, el, text) {
  const attempts = [];
  for (const strategy of FILL_STRATEGIES) {
    let error = null;
    try {
      strategy.run(el, text);
    } catch (e) {
      error = String(e);
    }
    await sleep(120);
    const got = readText(el);
    const blocked = sendStillDisabled(site);
    attempts.push({
      strategy: strategy.name,
      error,
      got: got.slice(0, 60),
      active: document.activeElement?.tagName,
      sendDisabled: blocked
    });
    if (normalize(got).includes(normalize(text)) && !blocked) return { strategy: strategy.name, attempts };
  }
  return { strategy: null, attempts };
}

function enterKey(type) {
  const event = new KeyboardEvent(type, {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
    composed: true
  });
  // 部分站点仍在读 keyCode / which，构造函数不接受这两个字段，只能补上。
  for (const prop of ['keyCode', 'which']) {
    Object.defineProperty(event, prop, { get: () => 13 });
  }
  return event;
}

// 光标必须落在内容末尾：编辑器只在自己持有选区时才响应回车。
function focusEnd(el) {
  el.focus();
  if (isTextField(el)) {
    el.setSelectionRange(el.value.length, el.value.length);
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function pressEnter(el) {
  focusEnd(el);
  for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(enterKey(type));
}

function clickSendButton(selectors) {
  for (const selector of selectors ?? []) {
    const el = document.querySelector(selector);
    if (!el || looksDisabled(el)) continue;
    el.click();
    return selector;
  }
  return null;
}

// 发出去的判据是输入框被清空 —— 四家聊天界面提交后都会清 composer。
async function waitUntilCleared(selector, fallbackEl, idleText = '', timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const el = findInput(selector) ?? fallbackEl;
    const now = readText(el ?? fallbackEl).trim();
    // 千问的空 composer 里躺着占位文字（「向千问提问」），只比对空串会永远等不到清空。
    if (!el?.isConnected || now === '' || now === idleText) return true;
    await sleep(150);
  }
  return false;
}

// 送附件有两条路。合成的 paste 事件对 DeepSeek 和 ChatGPT 实测可用，但有的站点收不到
// （会回「未提供图片」）。所以适配器声明了 fileInput 就直接塞站点自己的上传输入框，
// 那是它真正的上传入口，比伪造粘贴可靠。
function attachFiles(site, editor, files) {
  const data = new DataTransfer();
  for (const file of files) data.items.add(file);

  const input = site.fileInput ? document.querySelector(site.fileInput) : null;
  if (input) {
    input.files = data.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  editor.focus();
  editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}

// 先点发送键，回车只作兜底：有的站点回车会把编辑器清空却不发送，而「清空」正是我们判定
// 已发送的依据，于是回车优先会稳定地误报成功。点按钮是各家都有的正规入口。
// 回车前要重新取一次输入框：点按钮可能让站点把 composer 整个重挂（豆包首页就是），
// 那时原来那个元素已经脱离文档，敲给它的回车不会有任何反应。
async function submit(site, target, idleText) {
  const clicked = clickSendButton(site.send);
  if (clicked && (await waitUntilCleared(site.input, target, idleText))) return clicked;

  const live = findInput(site.input) ?? target;
  pressEnter(live);
  return (await waitUntilCleared(site.input, live, idleText)) ? 'enter' : null;
}

async function handleAsk(site, text, shouldSend, files) {
  const el = await waitForInput(site.input);
  if (!el) return { ok: false, reason: 'no-input' };

  // 记下提问前已有的回答正文，之后只认没见过的，否则会把上一轮的回答当成本轮的。
  // 这里比的是文字而不是节点数量或节点身份，两者都试过、都会错：
  // 数量——豆包答完一轮后节点总数可能不变（旧的思考块会收起来），永远等不到「变多」；
  // 身份——豆包的消息列表是虚拟滚动，旧消息重新挂载后就是新节点，上一轮的回答会被当成本轮的。
  answeredBefore = new Set(
    [...document.querySelectorAll(site.answer ?? ':not(*)')].map((node) => node.innerText.trim())
  );
  // 空 composer 的原样文字，发送后会回到这个样子，判定「已清空」时要认它。
  const idleText = readText(el).trim();

  if (files?.length) {
    attachFiles(site, el, files);
    // 给站点留出上传时间，附件没传完就回车会只发出文字。
    await sleep(2500);
  }

  const { strategy, attempts } = await fill(site, el, text);
  const debug = { tag: el.tagName, editable: el.isContentEditable, attempts };
  if (!strategy) return { ok: false, reason: 'fill-failed', debug };
  if (!shouldSend) return { ok: true, sent: false, strategy };

  // 豆包首页会在填词后重挂 composer，把内容和焦点一起弄丢，所以提交前再确认一次。
  const target = findInput(site.input) ?? el;
  if (!normalize(readText(target)).includes(normalize(text))) {
    const retry = await fill(site, target, text);
    if (!retry.strategy) return { ok: false, reason: 'fill-failed', debug: { ...debug, remount: true, attempts: retry.attempts } };
  }

  const sent = await submit(site, target, idleText);
  if (sent) return { ok: true, sent: true, strategy, via: sent };

  // 到这儿多半是编辑器没真正接受我们写的文字：它自己维护状态，DOM 里有字也当空的。
  // 合成 paste 最接近真实输入，多数这类编辑器只认它，所以重写一遍再试一次提交。
  // 放在失败之后而不是一开始，是为了不给本来就正常的站点每轮都多加一次等待。
  const retryEl = findInput(site.input) ?? target;
  FILL_STRATEGIES.find((item) => item.name === 'paste').run(retryEl, text);
  await sleep(300);
  const sentAgain = await submit(site, retryEl, idleText);
  if (sentAgain) return { ok: true, sent: true, strategy: 'paste', via: sentAgain };

  // 没提交成功时也把填词现场带回去：多半是站点的编辑器没认我们写进去的内容。
  return { ok: true, sent: false, strategy, reason: 'not-submitted', debug };
}

window.addEventListener('message', (event) => {
  if (event.origin !== EXT_ORIGIN || event.data?.channel !== CHANNEL || event.data.type !== 'ask') return;
  const { id, siteId, text, send = true, files } = event.data;
  const reply = (payload) =>
    event.source?.postMessage({ channel: CHANNEL, type: 'ask-result', id, siteId, ...payload }, event.origin);

  currentSite()
    .then((site) => (site ? handleAsk(site, text, send, files) : { ok: false, reason: 'no-adapter' }))
    .then(reply, (error) => reply({ ok: false, reason: String(error) }));
});

// 就绪上报。由 content script 主动通知，而不是父页在 iframe onload 时轮询：
// content script 本来就在文档加载后才运行，这样没有「问了但对面还没注入」的竞态。
// 顺便把「有没有找到输入框」一起带上，这样掉登录或卡验证码时，不用等提问就能看出来。
async function announceReady() {
  if (location.ancestorOrigins?.[0] !== EXT_ORIGIN) return;
  const site = await currentSite();
  if (!site) return;
  // 就绪上报可以慢，但不能误判：ChatGPT 打开一条历史对话时，输入框比正文晚十几秒才挂上，
  // 按提问时的 8 秒来判，卡片会先红一下说「可能未登录」，其实只是还没加载完。
  // 地址跟踪先起来：它不该被上面这段等待拖后，否则这段时间内站点换了对话就漏报。
  trackUrl(site);
  const el = await waitForInput(site.input, 25000);
  window.parent.postMessage(
    { channel: CHANNEL, type: 'ready', siteId: site.id, inputFound: !!el, url: location.href },
    EXT_ORIGIN
  );
}

// 父页要记住这个面板停在哪条对话上，下次打开才能接着聊。站点都是单页应用，用 pushState
// 换地址；pushState 发生在页面自己的 JS 世界里，隔离世界补不上钩子，所以只能轮询比对。
function trackUrl(site) {
  let last = location.href;
  setInterval(() => {
    if (location.href === last) return;
    last = location.href;
    window.parent.postMessage({ channel: CHANNEL, type: 'url', siteId: site.id, url: last }, EXT_ORIGIN);
  }, 2000);
}

announceReady();

// ---- 附件 ----
// 站点生成的文件（ChatGPT 的 docx/xlsx 之类）只是个按钮，既没有可复制的地址，也不在回答
// 容器里，而是挂在整段对话轮次上。所以这里只能把文件名报给父页，让卡片上有个胶囊。
//
// 「轮次」要比「消息」更外层：ChatGPT 的附件挂在整轮上，和助手消息是兄弟，
// 所以这里不能退到 [data-message-author-role]，closest 会就近停在消息上，找不到附件。
const TURN = 'article, [data-testid^="conversation-turn"]';

function fileName(row) {
  const named = [...row.querySelectorAll('[aria-label]')].find((el) => /\.[a-z0-9]{2,5}$/i.test(el.getAttribute('aria-label')));
  return (named?.getAttribute('aria-label') ?? row.innerText.trim().split('\n')[0] ?? '').slice(0, 80);
}

function collectFiles(site, answerEl) {
  if (!site.files) return [];
  const turn = answerEl.closest(TURN) ?? document.body;
  const names = [...turn.querySelectorAll(site.files)]
    .filter((row) => row.offsetParent)
    .map(fileName)
    .filter(Boolean);
  return [...new Set(names)].map((name) => ({ name }));
}

// 下面这段在顶层标签页里跑，不在 iframe 里。
//
// Chrome 会拦掉从跨源 iframe 发起的下载，除非那个 iframe 内部有真实的用户手势，合成点击
// 不算。实测过：我们在 iframe 里 click() 站点的下载按钮，把 CDP 的下载行为强行改成
// allowAndName 时文件能下来，恢复默认后连一个下载事件都不产生，静默失败。
// 而同一个 click()，在顶层标签页里（哪怕是后台标签页、哪怕没有任何手势）浏览器照常放行。
// 所以背景页会临时开一条这个对话的标签页，让我们在那儿把这一下点掉，文件名用来认是哪个附件。
function clickFileByName(site, name) {
  if (!site?.files) return false;
  const row = [...document.querySelectorAll(site.files)].find((item) => fileName(item) === name);
  if (!row) return false;
  const button = [...row.querySelectorAll('button, a')].find((el) =>
    /下载|download/i.test(el.getAttribute('aria-label') ?? el.innerText ?? '')
  );
  if (!button) return false;
  button.click();
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'CLICK_FILE') return;
  currentSite().then(
    (site) => sendResponse({ ok: clickFileByName(site, message.name) }),
    () => sendResponse({ ok: false })
  );
  return true;
});

// ---- 回答回传 ----
// 页面上显示的是 grid 自己渲染的卡片，所以这里要把回答正文持续推给父页。
let answeredBefore = new Set();

function debounce(fn, wait) {
  let timer = null;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, wait);
  };
}

async function relayAnswers() {
  // 只在被 grid 页面嵌着时才观察；用户自己正常访问这些站点时不做任何事。
  if (location.ancestorOrigins?.[0] !== EXT_ORIGIN) return;
  const site = await currentSite();
  if (!site?.answer) return;

  let lastHtml = null;
  let idle = null;

  const publish = (streaming) => {
    const fresh = [...document.querySelectorAll(site.answer)]
      .filter((node) => node.innerText.trim() && !answeredBefore.has(node.innerText.trim()));
    if (!fresh.length) return;
    // 先按文档顺序取最后一个——最新那条回答总在最下面；再往外扩到包住它的最大容器，
    // 因为有的站点（千问）的选择器会同时命中同一条回答的多层嵌套节点，只取最后一个
    // 会抓到最内层的碎片。querySelectorAll 是文档顺序，祖先一定排在后代前面。
    const last = fresh[fresh.length - 1];
    const el = fresh.find((node) => node.contains(last)) ?? last;
    const html = globalThis.MultiAiSanitize(el.innerHTML);
    const files = collectFiles(site, el);
    // 附件是流式输出结束后才出现的，所以 html 没变也可能是附件刚挂上来。
    const stamp = `${html}\u0000${files.map((item) => item.name).join('\u0000')}`;
    if (streaming && stamp === lastHtml) return;
    lastHtml = stamp;
    window.parent.postMessage(
      { channel: CHANNEL, type: 'answer', siteId: site.id, html, text: el.innerText, streaming, files },
      EXT_ORIGIN
    );
  };

  // 没有「回答结束」的通用信号，改用「一段时间不再变化」来判定。
  const onChange = debounce(() => {
    publish(true);
    clearTimeout(idle);
    idle = setTimeout(() => publish(false), 1500);
  }, 250);

  new MutationObserver(onChange).observe(document.body, { childList: true, subtree: true, characterData: true });
  // 只靠 mutation 是一次性的：漏掉一个变更窗口（站点整片重挂、回调里出过异常），
  // 卡片就会一直空着等下去。定时跑一遍同样的逻辑，漏了也能自己补上；
  // publish 对相同 html 会去重，所以空转几乎没有代价。
  setInterval(onChange, 3000);
  publish(false);
}

relayAnswers();
