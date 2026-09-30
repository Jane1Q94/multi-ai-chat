import './sites.js';
import './store.js';
import { mountSettings } from './settings.js';
import { createPanel } from './panel.js';
import { htmlToMarkdown } from './markdown.js';

const CHANNEL = globalThis.MULTI_AI_CHANNEL;
const store = globalThis.MultiAiStore;
// 站点慢起来时，content script 光等输入框出现就要 8 秒，回执超时要留够余量。
const REPLY_TIMEOUT = 25000;

const grid = document.getElementById('grid');
const workspace = document.getElementById('workspace');
const hint = document.getElementById('hint');
const composer = document.getElementById('composer');
const prompt = document.getElementById('prompt');
const attachments = document.getElementById('attachments');
const sessionList = document.getElementById('session-list');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('toggle-sidebar');
const activeSessionName = document.getElementById('active-session');

const panels = new Map();
// 面板用 CSS order 排，按站点固定顺序显示，这样增删面板不必重排 DOM（重排会重载 iframe）。
const siteOrder = new Map();
const pendingFiles = [];
let askSeq = 0;

function relayout() {
  const shown = [...panels.values()].filter((panel) => panel.visible);
  const count = shown.length;
  grid.style.setProperty('--columns', count <= 1 ? 1 : count <= 4 ? 2 : count <= 6 ? 3 : 4);
  for (const panel of shown) panel.reposition();

  // 「只看这家」藏起来的那几家不能真的消失：跨源 iframe 一移出视口就会被 Chrome 节流，
  // 站点停止渲染，那一家的回答也就抓不到了。所以把它们的 iframe 叠到留下那张卡片的矩形上，
  // 照旧在视口里跑，只是压在不透明卡片背后看不见。
  const park = shown[0]?.rect();
  if (!park) return;
  for (const panel of panels.values()) if (!panel.visible) panel.reposition(park);
}

// 只看一家：再点同一家就回到全部。状态只在内存里，刷新后回到默认的全部显示。
let soloId = null;

function applySolo() {
  for (const panel of panels.values()) {
    panel.setVisible(!soloId || panel.site.id === soloId);
    panel.setSolo(panel.site.id === soloId);
  }
  relayout();
}

function toggleSolo(siteId) {
  soloId = soloId === siteId ? null : siteId;
  applySolo();
}

function addPanel(site, startUrl) {
  if (panels.has(site.id)) return;
  const panel = createPanel({
    site,
    grid,
    workspace,
    order: siteOrder.get(site.id) ?? siteOrder.size,
    startUrl,
    onUrl: (url) => rememberUrl(site.id, url),
    onSolo: () => toggleSolo(site.id)
  });
  panels.set(site.id, panel);
  applySolo();
  panel.load();
}

function removePanel(site) {
  const panel = panels.get(site.id);
  if (!panel) return;
  panel.destroy();
  panels.delete(site.id);
  if (soloId === site.id) soloId = null;
  applySolo();
}

// ---- 会话 ----
// 这份状态由 grid 页面独占：内存里改完整份存回去。切换会话 = 把每个面板送到该会话记下的
// 那条对话上；没记过的站点就回它首页，问第一句时自然开出新的一条。

let sessions = { list: [], activeId: null };

const activeSession = () => sessions.list.find((item) => item.id === sessions.activeId);

function saveSessions() {
  store.saveSessions(sessions);
}

function applySession() {
  const { urls } = activeSession() ?? { urls: {} };
  for (const panel of panels.values()) panel.openUrl(urls[panel.site.id]);
}

function switchSession(id) {
  if (id === sessions.activeId) return;
  sessions.activeId = id;
  saveSessions();
  applySession();
  renderSessions();
}

function startSession() {
  const session = store.blankSession();
  sessions.list.unshift(session);
  sessions.activeId = session.id;
  saveSessions();
  applySession();
  renderSessions();
  prompt.focus();
}

function dropSession(id) {
  sessions.list = sessions.list.filter((item) => item.id !== id);
  if (!sessions.list.length) sessions.list.push(store.blankSession());
  if (!sessions.list.some((item) => item.id === sessions.activeId)) {
    sessions.activeId = sessions.list[0].id;
    applySession();
  }
  saveSessions();
  renderSessions();
}

// 会话列表默认收起，空间全让给卡片。展开会挤窄卡片，所以要连带把背后的 iframe 重新定位。
function showSidebar(on) {
  sidebar.hidden = !on;
  sidebarToggle.setAttribute('aria-expanded', String(on));
  relayout();
}

function rememberUrl(siteId, url) {
  const session = activeSession();
  if (!session || session.urls[siteId] === url) return;
  session.urls[siteId] = url;
  saveSessions();
}

// 站点被删掉后，各会话里残留的地址也一并清掉。
function pruneUrls(validIds) {
  let changed = false;
  for (const session of sessions.list) {
    for (const siteId of Object.keys(session.urls)) {
      if (validIds.includes(siteId)) continue;
      delete session.urls[siteId];
      changed = true;
    }
  }
  if (changed) saveSessions();
}

function beginRename(item, session) {
  const input = document.createElement('input');
  input.className = 'session-input';
  input.value = session.name;
  input.placeholder = '这个会话用来做什么';
  input.maxLength = 40;

  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    if (keep) session.name = input.value.trim();
    saveSessions();
    renderSessions();
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finish(true);
    if (event.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));

  item.replaceChildren(input);
  input.focus();
  input.select();
}

function renderSessions() {
  const active = activeSession();
  activeSessionName.textContent = active?.name || '未命名会话';
  sidebarToggle.title = `当前会话：${active?.name || '未命名'}。点这里展开全部 ${sessions.list.length} 条，可切换、改名`;

  sessionList.replaceChildren(
    ...sessions.list.map((session) => {
      const item = document.createElement('li');
      item.className = 'session';
      if (session.id === sessions.activeId) item.dataset.active = 'true';

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'session-name';
      open.textContent = session.name || '未命名';
      if (!session.name) open.dataset.unnamed = 'true';
      open.title = session.name || '未命名（第一次提问会拿问题当名字）';
      open.addEventListener('click', () => switchSession(session.id));

      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'session-act';
      rename.textContent = '改名';
      rename.title = '给这个会话起个名字，记住它的用途';
      rename.addEventListener('click', () => beginRename(item, session));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'session-act';
      remove.textContent = '×';
      remove.title = '删掉这条记录（各站点自己的对话历史不会动）';
      remove.addEventListener('click', () => dropSession(session.id));

      item.append(open, rename, remove);
      return item;
    })
  );
}

function renderAttachments() {
  attachments.replaceChildren(
    ...pendingFiles.map((file, index) => {
      const chip = document.createElement('li');
      chip.textContent = file.name || `图片 ${index + 1}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = '移除';
      remove.addEventListener('click', () => {
        pendingFiles.splice(index, 1);
        renderAttachments();
      });
      chip.append(remove);
      return chip;
    })
  );
}

function ask(text, { send = true, files = [] } = {}) {
  const id = `q${++askSeq}`;

  // 没起过名的会话，拿第一个问题当名字，侧边栏里才认得出这是哪一摊事。
  const session = activeSession();
  if (session && !session.name && text) {
    session.name = text.slice(0, 24);
    saveSessions();
    renderSessions();
  }
  for (const panel of panels.values()) {
    panel.beginAsk(id, () => panel.setStatus('无响应，面板可能还没加载完', 'error'), REPLY_TIMEOUT);
    panel.post({ channel: CHANNEL, type: 'ask', id, siteId: panel.site.id, text, send, files });
  }
  return id;
}

window.addEventListener('message', (event) => {
  const data = event.data;
  if (data?.channel !== CHANNEL) return;
  const panel = panels.get(data.siteId);
  if (!panel || event.origin !== panel.origin) return;

  // origin 已经校验过，所以这里记下的一定是站点自己的地址；掉登录跳到第三方登录页时
  // 消息根本进不来，不会把登录页当成对话记住。
  if (data.type === 'url' || data.type === 'ready') panel.noteUrl(data.url);
  if (data.type === 'ready') panel.applyReady(data);
  if (data.type === 'ask-result') panel.applyResult(data);
  if (data.type === 'answer') panel.applyAnswer(data);
});

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text && !pendingFiles.length) return;
  ask(text, { files: [...pendingFiles] });
  prompt.value = '';
  prompt.style.height = 'auto';
  pendingFiles.length = 0;
  renderAttachments();
});

prompt.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  composer.requestSubmit();
});

prompt.addEventListener('input', () => {
  prompt.style.height = 'auto';
  prompt.style.height = `${prompt.scrollHeight}px`;
});

// 粘贴图片：截图直接往输入框里贴，提问时随文字一起分发到每个站点。
prompt.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files ?? [])];
  if (!files.length) return;
  event.preventDefault();
  pendingFiles.push(...files);
  renderAttachments();
});

document.getElementById('reload-all').addEventListener('click', () => {
  for (const panel of panels.values()) panel.load();
});

document.getElementById('new-session').addEventListener('click', startSession);
sidebarToggle.addEventListener('click', () => showSidebar(sidebar.hidden));

// Esc 退出「只看这家」。输入框里的 Esc 另有用处（取消改名），不抢。
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !soloId) return;
  if (event.target.closest('input, textarea')) return;
  toggleSolo(soloId);
});

window.addEventListener('resize', relayout);

// tools/probe/run.mjs 用这两个钩子验证填词，并在失败时取回各面板回报的现场。
globalThis.__multiAiAsk = ask;
globalThis.__multiAiLast = () => Object.fromEntries([...panels].map(([id, panel]) => [id, panel.lastResult]));
globalThis.__multiAiMarkdown = htmlToMarkdown;
globalThis.__multiAiSessions = () => sessions;

async function main() {
  const self = await chrome.tabs.getCurrent();
  const armed = await chrome.runtime.sendMessage({ type: 'ARM_TAB', tabId: self?.id });
  if (!armed?.ok) {
    hint.textContent = `嵌入权限申请失败：${armed?.error ?? '未知原因'}`;
    return;
  }
  // 提示行只留给出错用。用法都挂在各自控件的 tooltip 上，不占正文的地方。
  hint.hidden = true;

  const { all, enabled } = await store.sites();
  sessions = await store.loadSessions();
  pruneUrls(all.map((site) => site.id));
  renderSessions();
  const { urls } = activeSession();
  all.forEach((site, index) => siteOrder.set(site.id, index));
  for (const site of enabled) addPanel(site, urls[site.id]);

  mountSettings({
    onAdd: (site) => {
      siteOrder.set(site.id, siteOrder.size);
      addPanel(site);
    },
    onRemove: removePanel,
    onToggle: (site, on) => (on ? addPanel(site) : removePanel(site))
  });
}

main();
