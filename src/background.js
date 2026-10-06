import './sites.js';
import './store.js';

const GRID_URL = chrome.runtime.getURL('src/grid.html');
const CONTENT_JS = ['src/sites.js', 'src/store.js', 'src/sanitize.js', 'src/content/inject.js'];

// 这些站点用 CSP frame-ancestors / X-Frame-Options 禁止被嵌入。规则只绑定 grid 标签页的
// 子框架请求，日常浏览时这些站点的安全策略不受影响。
const STRIPPED_HEADERS = [
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options'
];

// 这些站点把登录 cookie 设成了 SameSite=Lax，跨站 iframe 里浏览器根本不发，
// 嵌进来的就是个匿名会话：能聊，但不认账号、不存历史，重开话题页只会被弹回首页。
// 对策是只给本扩展这个标签页里该站点的请求，把被扣下的 cookie 用 Cookie 头补回去；
// profile 里的 cookie 一个字都不改，别的网站也拿不到任何好处。
// 判断某家是不是该进这个名单：看 `--cookies` 勘查里它的会话 cookie 是不是 Lax/Strict。
const LAX_AUTH_HOSTS = ['chatgpt.com'];

// 规则 id 只要在会话规则里唯一就够。不拿 tabId 去算：这台机器的 tabId 已经到 14 亿，
// 稍微一乘就超出 int32，接口会直接报「expected integer, found number」。
function freeIds(used, count) {
  const ids = [];
  for (let id = 1; ids.length < count; id += 1) if (!used.has(id)) ids.push(id);
  return ids;
}

const ownedBy = (rule, tabId) => (rule.condition.tabIds ?? []).includes(tabId);
const isCookieRule = (rule) => !!rule.action.requestHeaders;

// 只补浏览器因为 SameSite 扣下的那些。已经是 None 的它自己会发，重复发反而容易撞车。
async function heldBackCookies(host) {
  const all = await chrome.cookies.getAll({ domain: host });
  const held = all.filter((item) => item.path === '/' && item.sameSite !== 'no_restriction');
  const byName = new Map(held.map((item) => [item.name, item.value]));
  return [...byName].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function cookieRule(id, tabId, host) {
  const value = await heldBackCookies(host).catch(() => '');
  if (!value) return null;
  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      // append 而不是 set：set 会把浏览器自己那份 Cookie 头整条换掉，
      // 里面还有 cf_clearance 这类会轮换的值，换成快照就等着出问题。
      requestHeaders: [{ header: 'cookie', operation: 'append', value }]
    },
    condition: { tabIds: [tabId], requestDomains: [host] }
  };
}

async function cookieRules(ids, tabId) {
  const rules = await Promise.all(LAX_AUTH_HOSTS.map((host, index) => cookieRule(ids[index], tabId, host)));
  return rules.filter(Boolean);
}

async function armTab(tabId) {
  if (tabId === undefined) throw new Error('拿不到标签页 id');
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const mine = existing.filter((rule) => ownedBy(rule, tabId));
  const used = new Set(existing.filter((rule) => !ownedBy(rule, tabId)).map((rule) => rule.id));
  const [cspId, ...cookieIds] = freeIds(used, 1 + LAX_AUTH_HOSTS.length);

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: mine.map((rule) => rule.id),
    addRules: [
      {
        id: cspId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: STRIPPED_HEADERS.map((header) => ({
            header,
            operation: 'remove'
          }))
        },
        condition: {
          tabIds: [tabId],
          resourceTypes: ['sub_frame']
        }
      },
      ...(await cookieRules(cookieIds, tabId))
    ]
  });
}

chrome.action.onClicked.addListener(async () => {
  const [existing] = await chrome.tabs.query({ url: GRID_URL });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: GRID_URL });
});

// 自定义站点的域名在打包时未知，静态 content_scripts 覆盖不到，只能运行时注册。
async function registerSite(site) {
  const id = `site-${site.id}`;
  await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
  await chrome.scripting.registerContentScripts([
    {
      id,
      matches: [`${new URL(site.url).origin}/*`],
      allFrames: true,
      js: CONTENT_JS,
      runAt: 'document_idle',
      persistAcrossSessions: true
    }
  ]);
}

async function unregisterSite(siteId) {
  await chrome.scripting.unregisterContentScripts({ ids: [`site-${siteId}`] }).catch(() => {});
}

// 注册本身是持久的，但用户可能在别处清过，或注册时权限还没批下来，启动时对齐一次。
async function syncCustomSites() {
  const { custom } = await globalThis.MultiAiStore.read();
  for (const site of custom) await registerSite(site).catch(() => {});
}

// 网格窗口要留在屏幕上，Chrome 才会继续渲染里面的跨站页面。不抢焦点，也不最小化。
async function ensureGridWindow() {
  const [existing] = await chrome.tabs.query({ url: `${GRID_URL}*` });
  if (existing) return;
  await chrome.windows.create({
    url: GRID_URL,
    focused: false,
    state: 'normal',
    width: 1200,
    height: 800,
    type: 'normal'
  });
}

function boot() {
  syncCustomSites();
  ensureGridWindow();
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);

const HANDLERS = {
  // grid 页面在挂载 iframe 之前会先来要一次授权，避免规则还没生效就发出子框架请求。
  ARM_TAB: (message, sender) => armTab(message.tabId ?? sender.tab?.id),
  REGISTER_SITE: (message) => registerSite(message.site),
  UNREGISTER_SITE: (message) => unregisterSite(message.siteId)
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return;
  Promise.resolve(handler(message, sender)).then(
    () => sendResponse({ ok: true }),
    (error) => sendResponse({ ok: false, error: String(error) })
  );
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const removeRuleIds = rules.filter((rule) => ownedBy(rule, tabId)).map((rule) => rule.id);
  if (removeRuleIds.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
});

// 会话 cookie 会轮换，规则里的快照一过期，iframe 又变回匿名。跟着 cookie 变化重建，
// 沿用原来那几个 id，免得和别的标签页的规则撞号。
async function refreshCookieRules() {
  const cookieOnes = (await chrome.declarativeNetRequest.getSessionRules()).filter(isCookieRule);
  if (!cookieOnes.length) return;
  const rebuilt = await Promise.all(
    cookieOnes.map((rule) => {
      const [tabId] = rule.condition.tabIds ?? [];
      const [host] = rule.condition.requestDomains ?? [];
      return tabId !== undefined && host ? cookieRule(rule.id, tabId, host) : null;
    })
  );
  const addRules = rebuilt.filter(Boolean);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: cookieOnes.map((rule) => rule.id),
    addRules
  });
}

let refreshTimer = null;
chrome.cookies.onChanged.addListener(({ cookie }) => {
  if (!LAX_AUTH_HOSTS.some((host) => cookie.domain.endsWith(host))) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshCookieRules, 1000);
});
