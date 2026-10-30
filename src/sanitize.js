// 把站点的回答 HTML 洗成一个固定的标签白名单。在 content script 里执行，
// 保证扩展页面（有 chrome API 权限的特权上下文）永远拿不到原始 HTML。
//
// 顺带也是「统一版式」那一步：class 和 style 基本全丢，只留代码高亮用的类名，
// 由 grid.css 自己配色，这样四家的回答看起来是一套样式。
const TAGS = new Set([
  'p', 'br', 'hr', 'span', 'div',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'sup', 'sub', 'small', 'kbd',
  'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'a', 'img', 'figure', 'figcaption', 'details', 'summary'
]);

// 这些整棵子树都不要：脚本、样式、可交互控件、外链框架。
const DROP = new Set(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'template', 'svg', 'canvas', 'form', 'input', 'button', 'select', 'textarea', 'video', 'audio', 'link', 'meta']);

const ATTRS = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  ol: ['start'],
  details: ['open']
};

const SAFE_URL = /^(https?:\/\/|data:image\/|mailto:)/i;
const KEEP_CLASS = /^(hljs-[\w-]+|language-[\w+#-]+)$/;

// 回答容器里混着站点自己的工具栏，比如代码块和表格上方的「复制 / 下载」。
// 这些不是 button 元素，光靠标签白名单挡不住，按文案剔掉。
const UI_NOISE = /^(复制|已复制|Copy|Copy code|复制代码|下载|Download|表格|Table|运行|Run|编辑|Edit|重新生成|Regenerate|分享|Share)$/;

function isUiNoise(el) {
  return el.children.length === 0 && UI_NOISE.test(el.textContent.trim());
}

// 地址要变成绝对的：正文里有相对链接（站内跳转、引用），原样搬进扩展页面就指到
// chrome-extension:// 下面去了。这里是 content script，location 就是站点自己，解析得对。
function absolute(value) {
  try {
    return new URL(value.trim(), location.href).href;
  } catch {
    return null;
  }
}

function copyAttributes(source, target) {
  for (const name of ATTRS[target.localName] ?? []) {
    const value = source.getAttribute(name);
    if (value === null) continue;
    if (name === 'href' || name === 'src') {
      const url = absolute(value);
      if (!url || !SAFE_URL.test(url)) continue;
      target.setAttribute(name, url);
      continue;
    }
    target.setAttribute(name, value);
  }

  // 卡片里的链接一律新标签页打开。grid 页面里装着六个 iframe 和整场对话，
  // 让它被一次点击导航走，等于把所有人的回答一起关掉。
  if (target.localName === 'a' && target.hasAttribute('href')) {
    target.setAttribute('target', '_blank');
    target.setAttribute('rel', 'noopener noreferrer');
  }
  const classes = [...source.classList].filter((name) => KEEP_CLASS.test(name));
  if (classes.length) target.setAttribute('class', classes.join(' '));
}

function walk(source, target) {
  for (const node of source.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      target.append(node.data);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || DROP.has(node.localName) || isUiNoise(node)) continue;

    // 不认识的标签就地拆掉，但内容保留 —— 站点常用自定义元素包裹正文。
    if (!TAGS.has(node.localName)) {
      walk(node, target);
      continue;
    }
    const clone = document.createElement(node.localName);
    copyAttributes(node, clone);
    walk(node, clone);
    target.append(clone);
  }
}

globalThis.MultiAiSanitize = function sanitize(html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const out = document.createElement('div');
  walk(parsed.body, out);
  return out.innerHTML;
};
