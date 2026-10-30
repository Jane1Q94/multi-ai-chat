// 站点适配器。grid 页面和 content script 共用这一份，所以写成挂全局的普通脚本
// 而不是 ES module（content_scripts 不支持 module）。
//
// input:  编辑器元素。豆包 / ChatGPT / Claude / Gemini 都是 contenteditable 富文本编辑器，
//         DeepSeek 是普通 textarea，填词逻辑会自动分流。
// send:   发送按钮候选，按顺序取第一个命中且没禁用的。它是提交的主路径，回车只作兜底；
//         填词是否被编辑器真正接受，也靠「这个按钮还禁不禁用」来判断，所以要填准。
// files:  可选。站点生成的附件（文档、表格）所在的那一行/一块。这类附件通常只有按钮、
//         没有可复制的地址，所以卡片里只放一个胶囊，点它把点击转发进 iframe。
// answer: 回答正文容器，取最后一个匹配（也就是最新一轮）。必须排除用户消息和思考过程，
//         否则抓回来的是自己刚发出去的问题。
globalThis.MULTI_AI_SITES = [
  {
    id: 'doubao',
    name: '豆包',
    url: 'https://www.doubao.com/chat/',
    host: 'www.doubao.com',
    input: '[data-testid="chat_input"] .ProseMirror, [data-testid="chat_input"] textarea',
    fileInput: 'input[type=file].hidden',
    send: ['[data-testid="chat_input_send_button"]', '#flow-end-msg-send'],
    // 用户消息也带 message_text_content，所以必须限定在 receive_message 里面。
    answer: '[data-testid="receive_message"] [data-testid="message_text_content"]'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    host: 'chat.deepseek.com',
    input: 'textarea#chat-input, textarea',
    send: ['[data-testid="chat-input-send-button"]', '.ds-button--primary.ds-button--filled'],
    answer: '.ds-markdown.ds-assistant-message-main-content'
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com/',
    host: 'chatgpt.com',
    // 新版 composer 不再提供固定 id，只保留标明 Markdown composer 的语义属性。
    // 旧选择器留作兼容；ProseMirror 还要限定 data-composer-markdown，避免误中页面里的其他编辑器。
    input:
      '[data-composer-markdown][contenteditable="true"], #prompt-textarea, #mobile-composer-prompt',
    send: [
      '[aria-label="发送"]',
      '[aria-label="Send"]',
      '[aria-label="发送消息"]',
      '[aria-label="Send message"]',
      '#composer-submit-button'
    ],
    // 新版消息不再提供 data-message-author-role，正文仍有稳定的语义属性。
    // 直接取 Markdown 根，排除同一轮里的隐藏角色标题和操作栏。
    answer: '[data-markdown-text-style="assistant-message"]',
    // 生成的文件挂在整段对话轮次上，不在回答容器里，而且只有按钮没有链接地址 ——
    // 卡片里放不了真链接，只能把点击转发回来让站点自己下载。见 inject.js 的 collectFiles。
    files: '[class*="artifact-row"]'
  },
  {
    id: 'qianwen',
    name: '千问',
    url: 'https://www.qianwen.com/',
    // 写成裸域，这样带 www 和不带 www 都能匹配上
    host: 'qianwen.com',
    input: 'textarea, [contenteditable="true"]',
    send: ['[aria-label="发送消息"]'],
    answer: '[class*="markdown"]'
  },
  {
    id: 'claude',
    name: 'Claude',
    url: 'https://claude.ai/new',
    host: 'claude.ai',
    input: '[data-testid="chat-input"], .ProseMirror[contenteditable="true"]',
    fileInput: 'input[data-testid="file-upload"]',
    send: ['[data-testid="chat-input-send"]', '[aria-label="Send message"]'],
    // `.font-claude-response` 已经没了。正文在 assistant-message 里的 `.standard-markdown`，
    // 外层还包着「正在搜索」和操作栏，整条拿过来会把那些也回显出来。
    answer: '[data-testid="assistant-message"] .standard-markdown'
  },
  {
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com/app',
    host: 'gemini.google.com',
    input: '.ql-editor[contenteditable="true"]',
    send: ['button.send-button', '[aria-label="发送消息"]', '[aria-label="Send message"]'],
    answer: '.markdown-main-panel'
  }
];

globalThis.MULTI_AI_CHANNEL = 'multi-ai-chat';
