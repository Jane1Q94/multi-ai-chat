// 把消毒后的回答 HTML 转成 Markdown，供复制时写进 text/plain。
// 只需要覆盖 sanitize.js 的标签白名单，不用做通用的 HTML 转换器。
const INLINE_WRAP = { strong: '**', b: '**', em: '*', i: '*', del: '~~', s: '~~' };

const INLINE_TAGS = new Set([
  ...Object.keys(INLINE_WRAP),
  'a', 'code', 'img', 'br', 'span', 'sup', 'sub', 'kbd', 'small', 'u', 'ins', 'mark'
]);

const BLOCK_TAGS = new Set([
  'p', 'div', 'pre', 'ul', 'ol', 'dl', 'table', 'blockquote', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'figcaption', 'details', 'summary'
]);

const isElement = (node) => node.nodeType === Node.ELEMENT_NODE;
const isText = (node) => node.nodeType === Node.TEXT_NODE;
const indentBy = (depth) => '  '.repeat(depth);

function inline(node) {
  if (isText(node)) return node.data.replace(/\s+/g, ' ');
  if (!isElement(node)) return '';

  const tag = node.localName;
  const inner = () => [...node.childNodes].map(inline).join('');

  if (tag === 'br') return '\n';
  if (tag === 'code') return `\`${node.textContent}\``;
  if (tag === 'a') {
    const text = inner().trim();
    const href = node.getAttribute('href');
    // 只裹着一个装饰性图标的链接（联网回答的来源角标）在 Markdown 里没有意义
    if (!text) return '';
    return href ? `[${text}](${href})` : text;
  }
  if (tag === 'img') {
    // alt="" 在 HTML 语义里就表示装饰性图片，直接省掉
    const alt = node.getAttribute('alt');
    return alt ? `![${alt}](${node.getAttribute('src')})` : '';
  }

  const wrap = INLINE_WRAP[tag];
  if (!wrap) return inner();
  const text = inner().trim();
  return text ? `${wrap}${text}${wrap}` : '';
}

function codeFence(pre) {
  const code = pre.querySelector('code') ?? pre;
  const language = [...code.classList, ...pre.classList]
    .map((name) => name.match(/^language-(.+)$/)?.[1])
    .find(Boolean);
  return `\`\`\`${language ?? ''}\n${code.textContent.replace(/\n+$/, '')}\n\`\`\``;
}

const tidy = (text) =>
  text
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();

// 一组子节点如果全是内联内容，就当成一个段落整体输出。
// 不这么分流的话，站点用 div/span 包住的行内强调会被拆成一个个独立块，
// 变成「文字 / **强调** / 文字」三段。li 的内容同理。
function container(nodes, depth) {
  const hasBlock = nodes.some((node) => isElement(node) && BLOCK_TAGS.has(node.localName));
  if (!hasBlock) return tidy(nodes.map(inline).join(''));
  return blocks(nodes, depth);
}

function list(node, depth) {
  const ordered = node.localName === 'ol';
  let index = Number(node.getAttribute('start') ?? 1);

  return [...node.children]
    .filter((child) => child.localName === 'li')
    .map((item) => {
      const nested = [...item.children].filter((child) => child.localName === 'ul' || child.localName === 'ol');
      const own = [...item.childNodes].filter((child) => !nested.includes(child));
      const marker = ordered ? `${index++}. ` : '- ';

      // 续行要跟着缩进，否则 li 里的代码块会被拆出列表；空行不缩进，免得留下一行空格
      const body = container(own, depth)
        .split('\n')
        .map((line, i) => (i === 0 || !line.trim() ? line : `${indentBy(depth + 1)}${line}`))
        .join('\n');

      const sub = nested.map((child) => list(child, depth + 1)).join('\n');
      const head = `${indentBy(depth)}${marker}${body}`;
      return sub ? `${head}\n${sub}` : head;
    })
    .join('\n');
}

function table(node) {
  const rows = [...node.querySelectorAll('tr')].map((row) =>
    [...row.children].map((cell) => inline(cell).trim().replace(/\|/g, '\\|'))
  );
  if (!rows.length) return '';
  const [head, ...body] = rows;
  return [head, head.map(() => '---'), ...body].map((cells) => `| ${cells.join(' | ')} |`).join('\n');
}

function block(node, depth) {
  if (isText(node)) return node.data.replace(/\s+/g, ' ').trim();
  if (!isElement(node)) return '';

  const tag = node.localName;
  if (INLINE_TAGS.has(tag)) return inline(node).trim();

  const heading = tag.match(/^h([1-6])$/);
  if (heading) return `${'#'.repeat(Number(heading[1]))} ${inline(node).trim()}`;

  if (tag === 'hr') return '---';
  if (tag === 'pre') return codeFence(node);
  if (tag === 'ul' || tag === 'ol') return list(node, depth);
  if (tag === 'table') return table(node);
  if (tag === 'p' || tag === 'li') return inline(node).trim();
  if (tag === 'blockquote') {
    return blocks([...node.childNodes], depth)
      .split('\n')
      .map((line) => `> ${line}`.trimEnd())
      .join('\n');
  }

  // div / figure / details 这类容器没有对应语法，按里面是内联还是块分别处理
  return container([...node.childNodes], depth);
}

function blocks(nodes, depth = 0) {
  return nodes
    .map((node) => block(node, depth))
    .filter((text) => text.trim())
    .join('\n\n');
}

export function htmlToMarkdown(html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return blocks([...parsed.body.childNodes])
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
