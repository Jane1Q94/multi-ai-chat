import './store.js';
import { htmlToMarkdown } from './markdown.js';

// details 做的菜单点别处不会自己收起，补一个全局监听（一次就够，不必每个面板一个）。
document.addEventListener('click', (event) => {
  for (const open of document.querySelectorAll('.panel-menu[open]')) {
    if (!open.contains(event.target)) open.open = false;
  }
});

// 一个面板 = 一张回答卡片 + 一个藏在卡片背后的 iframe。
//
// iframe 必须留在视口内且保持渲染：Chrome 会对完全移出视口的跨源 iframe 做渲染节流，
// 站点的前端框架就不再提交更新，DOM 里根本不会出现回答，抓也抓不到。
// 所以它被定位在卡片的同一个矩形上，用 z-index: -1 压到不透明卡片背后，
// 既不挡鼠标选中，也不会被节流。

export function createPanel({ site, grid, workspace, order, startUrl, onUrl, onSolo }) {
  const panel = {
    site,
    origin: new URL(site.url).origin,
    lastResult: null,
    lastAnswer: null,
    pendingId: null,
    visible: true
  };
  // 打开页面时回到上次那条对话，而不是每次都从站点首页开一轮新的。
  let currentUrl = startUrl ?? site.url;
  let timer = null;
  let rawVisible = false;

  const root = document.createElement('section');
  root.className = 'panel';
  root.style.order = order;
  root.style.setProperty('--order', order);

  const header = document.createElement('div');
  header.className = 'panel-header';

  // 站点图标取自 Chrome 自己的 favicon 缓存（manifest 里的 favicon 权限），
  // 不联网、不依赖第三方取图服务，自定义添加的站点也照样有图标。
  const icon = document.createElement('img');
  icon.className = 'panel-icon';
  icon.alt = '';
  icon.src = `${chrome.runtime.getURL('_favicon/')}?${new URLSearchParams({ pageUrl: site.url, size: '32' })}`;

  const name = document.createElement('span');
  name.className = 'panel-name';
  name.textContent = site.name;
  name.title = '双击标题栏：只看这一家，再双击回到全部';

  const status = document.createElement('span');
  status.className = 'panel-status';

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = '复制';
  copy.disabled = true;

  const raw = document.createElement('button');
  raw.type = 'button';
  raw.textContent = '原始页面';

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = '重载';

  const fresh = document.createElement('button');
  fresh.type = 'button';
  fresh.textContent = '新对话';
  fresh.title = '丢掉记住的对话，回到站点首页重新开一轮';

  const solo = document.createElement('button');
  solo.type = 'button';
  solo.textContent = '只看这家';
  solo.title = '双击卡片标题栏同样能切换';

  const openTab = document.createElement('a');
  openTab.href = site.url;
  openTab.target = '_blank';
  openTab.rel = 'noreferrer';
  openTab.textContent = '新标签页';

  // 常用的两个留在外面，其余收进菜单：六张卡片各摊开五个按钮，满屏都是控件。
  const menu = document.createElement('details');
  menu.className = 'panel-menu';
  const menuLabel = document.createElement('summary');
  menuLabel.textContent = '···';
  menuLabel.title = '更多';
  const menuItems = document.createElement('div');
  menuItems.append(solo, reload, fresh, openTab);
  menuItems.addEventListener('click', () => (menu.open = false));
  menu.append(menuLabel, menuItems);

  const tools = document.createElement('div');
  tools.className = 'panel-tools';
  tools.append(copy, raw, menu);

  header.append(icon, name, status, tools);

  const article = document.createElement('article');
  article.className = 'answer';
  // 空卡片上用它做水印，见 .answer:empty::before
  article.dataset.site = site.name;

  const frame = document.createElement('iframe');
  frame.title = site.name;
  // 站点的反爬指纹会去读传感器、compute-pressure 这类接口，默认策略下它们直接抛异常，
  // 有的站点（Grok）会因此卡在自检里不肯发请求。放宽到它们期望的集合。
  frame.allow =
    'clipboard-read; clipboard-write; microphone; camera; autoplay; fullscreen; ' +
    'compute-pressure; accelerometer; gyroscope; magnetometer; unload';

  root.append(header, article);
  grid.append(root);
  workspace.append(frame);

  panel.setStatus = (text, state) => {
    status.textContent = text;
    if (state) status.dataset.state = state;
    else delete status.dataset.state;
  };

  panel.rect = () => article.getBoundingClientRect();

  // 只改定位，不搬 DOM：搬动 iframe 会让它重新加载，正在进行的对话会丢。
  // box 可以由外面指定：卡片被「只看这家」藏起来时，它的 iframe 要停到别人的矩形上，
  // 否则一离开视口就被节流，那一家的回答从此抓不到。
  panel.reposition = (box = panel.rect()) => {
    Object.assign(frame.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`
    });
  };

  const showRaw = (on) => {
    rawVisible = on;
    raw.textContent = on ? '回到回答' : '原始页面';
    root.classList.toggle('raw', on);
    frame.classList.toggle('visible', on);
    panel.reposition();
  };

  // 「只看这家」：其余卡片整张收起，留下的那张独占整个网格。
  panel.setVisible = (on) => {
    panel.visible = on;
    root.hidden = !on;
    // 收起时要把「原始页面」关掉，否则这张卡片的 iframe 会浮在留下那张的上面。
    if (!on && rawVisible) showRaw(false);
  };

  panel.setSolo = (on) => {
    solo.textContent = on ? '显示全部' : '只看这家';
  };

  panel.post = (message) => frame.contentWindow?.postMessage(message, panel.origin);

  panel.load = () => {
    panel.pendingId = null;
    clearTimeout(timer);
    panel.lastAnswer = null;
    copy.disabled = true;
    article.replaceChildren();
    panel.setStatus('加载中…');
    frame.src = currentUrl;
  };

  // 切换会话时把这个面板送到该会话记下的那条对话上。
  panel.openUrl = (url) => {
    currentUrl = url || site.url;
    panel.load();
  };

  // 比较前先扒掉查询串、锚点和尾斜杠：站点回首页时经常带上 ?model=… 这类参数，
  // 只按字面比就会把它当成一条新对话记下来。
  const strip = (url) => url.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const isHome = (url) => strip(url) === strip(site.url) || strip(url) === new URL(site.url).origin;

  // 站点在单页应用里换了地址（新建对话、打开某条历史对话），报给 grid 记进当前会话。
  //
  // 打不开我们送它去的那条对话时，站点往往把地址弹回首页（ChatGPT 在 iframe 里是匿名的，
  // 就会这样）。这种回退不能覆盖已经记住的那条，否则每重开一次就退化一级，最后永远停在首页。
  // 明确的重置走 openUrl，不经过这里。
  panel.noteUrl = (url) => {
    if (!url || url === currentUrl) return;
    if (isHome(url) && !isHome(currentUrl)) return;
    currentUrl = url;
    onUrl?.(url);
  };

  panel.beginAsk = (id, onTimeout, timeout) => {
    panel.pendingId = id;
    panel.lastAnswer = null;
    copy.disabled = true;
    article.replaceChildren();
    panel.setStatus('发送中…');
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (panel.pendingId !== id) return;
      panel.pendingId = null;
      onTimeout();
    }, timeout);
  };

  const RESULT_STATUS = {
    sent: ['等待回答…', null],
    filled: ['已填入', 'ok'],
    'not-submitted': ['已填入，但没提交成功，打开原始页面回车', 'warn'],
    'no-input': ['没找到输入框，可能未登录', 'error'],
    'fill-failed': ['填词失败，选择器可能不对了', 'error'],
    'no-adapter': ['该站点没有适配器', 'error']
  };

  // 站点内部跳转（比如新建会话）会重新注入 content script，就绪会再报一次，
  // 所以提问进行中要忽略，否则会把「发送中」盖掉。
  panel.applyReady = (data) => {
    if (panel.pendingId) return;
    // 卡片里已经有回答了，就别再用「没找到输入框」去盖掉它：能渲染出回答说明这一家是好的。
    if (panel.lastAnswer && !data.inputFound) return;
    if (data.inputFound) panel.setStatus('就绪');
    else panel.setStatus('没找到输入框，可能未登录或卡在验证', 'error');
  };

  panel.applyResult = (data) => {
    if (panel.pendingId !== data.id) return;
    panel.pendingId = null;
    clearTimeout(timer);
    panel.lastResult = data;
    // 回答已经在卡片里了，就别再用「有没有提交成功」的推断去盖掉它：回答是更硬的证据，
    // 而这条回执可能是等清空等超时后才迟到的。
    if (panel.lastAnswer) return;
    const key = data.ok ? (data.sent ? 'sent' : (data.reason ?? 'filled')) : data.reason;
    panel.setStatus(...(RESULT_STATUS[key] ?? [String(key), 'error']));
  };

  // html 已在 content script 里按白名单消毒过，这里直接渲染。
  panel.applyAnswer = (data) => {
    panel.lastAnswer = data;
    article.innerHTML = data.html;
    copy.disabled = false;
    const words = data.text.trim().length;
    panel.setStatus(data.streaming ? `回答中…（${words} 字）` : `已完成（${words} 字）`, data.streaming ? null : 'ok');
    // 刻意不跟着滚到底：卡片是拿来横向对比的，停在开头比追着生成看更有用。
  };

  panel.destroy = () => {
    clearTimeout(timer);
    root.remove();
    frame.remove();
  };

  copy.addEventListener('click', async () => {
    if (!panel.lastAnswer) return;
    // text/plain 放 Markdown：粘到富文本编辑器会用 text/html 保留排版，
    // 粘到代码编辑器 / Markdown 编辑器则拿到带格式的源码。
    const { html } = panel.lastAnswer;
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([htmlToMarkdown(html)], { type: 'text/plain' })
        })
      ]);
      copy.textContent = '已复制';
      setTimeout(() => (copy.textContent = '复制'), 1200);
    } catch (error) {
      panel.setStatus(`复制失败：${error.message}`, 'error');
    }
  });

  raw.addEventListener('click', () => showRaw(!rawVisible));

  solo.addEventListener('click', () => onSolo?.());

  // 双击标题栏切换「只看这家」。正文区不接这个手势：那里双击是选词，是用来复制的。
  header.addEventListener('dblclick', (event) => {
    if (event.target.closest('button, a, summary')) return;
    onSolo?.();
  });

  reload.addEventListener('click', panel.load);

  // 只重开这一家：当前会话里其余面板的对话都留着。
  fresh.addEventListener('click', () => {
    panel.openUrl(site.url);
    onUrl?.(site.url);
  });

  return panel;
}
