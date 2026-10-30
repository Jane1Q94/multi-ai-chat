// 站点配置的读写。grid 页面、设置面板和 content script 都用这一份，所以和 sites.js
// 一样写成挂全局的普通脚本（content_scripts 不支持 ES module，但 module 侧可以 import 它）。
//
// 存的是 disabled 而不是 enabled：以后往 sites.js 里加预置站点时默认是开着的。
const DEFAULTS = { disabled: [], custom: [] };

async function read() {
  return chrome.storage.sync.get(DEFAULTS);
}

async function write(patch) {
  await chrome.storage.sync.set(patch);
}

async function sites() {
  const { disabled, custom } = await read();
  const all = [...globalThis.MULTI_AI_SITES, ...custom];
  return { all, enabled: all.filter((site) => !disabled.includes(site.id)), disabled, custom };
}

// 一个会话 = 各站点当前停在哪条对话上的地址，加一个用户可改的名字（留空时界面显示
// 「未命名」，第一次提问会拿问题当名字）。存 local 而不是 sync：地址每次跳转都在变，
// 没必要跨设备同步，也不该占 sync 的配额。
//
// grid 页面是这份状态唯一的所有者：它在内存里改，然后整份存回来。这样六个面板几乎同时
// 上报地址也不会互相覆盖——早先按站点分别读—改—写，就丢过条目。
const SESSION_KEYS = { sessions: [], activeId: null };

function blankSession() {
  return { id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name: '', urls: {} };
}

async function loadSessions() {
  const raw = await chrome.storage.local.get(SESSION_KEYS);
  let list = raw.sessions;
  // 更早的版本只存了一组地址（{siteId: url}），迁移成第一个会话。
  if (!Array.isArray(list)) {
    const urls = list ?? {};
    list = Object.keys(urls).length ? [{ ...blankSession(), urls }] : [];
  }
  list = list.filter((item) => item && typeof item.id === 'string');
  if (!list.length) list = [blankSession()];
  const activeId = list.some((item) => item.id === raw.activeId) ? raw.activeId : list[0].id;
  return { list, activeId };
}

// 写操作排成一条队：连续的改名、切换、地址上报如果并发落盘，后写的会盖掉前一个。
let writes = Promise.resolve();

function saveSessions({ list, activeId }) {
  const snapshot = { sessions: structuredClone(list), activeId };
  writes = writes.then(() => chrome.storage.local.set(snapshot), () => {});
  return writes;
}

function findSite(all, hostname) {
  return all.find((site) => hostname === site.host || hostname.endsWith(`.${site.host}`));
}

// 表单 → 适配器。host 从 URL 推导，避免用户填两遍还填不一致。
function siteFromForm({ name, url, input, answer, send }) {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('只支持 http / https 地址');
  if (!input.trim()) throw new Error('输入框选择器不能为空');
  return {
    id: `custom-${Date.now().toString(36)}`,
    name: name.trim() || parsed.hostname,
    url: parsed.href,
    host: parsed.hostname,
    input: input.trim(),
    answer: answer.trim() || null,
    send: send
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    custom: true
  };
}

globalThis.MultiAiStore = { read, write, sites, findSite, siteFromForm, loadSessions, saveSessions, blankSession };
