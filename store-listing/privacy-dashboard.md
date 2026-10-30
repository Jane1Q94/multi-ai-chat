# Chrome Web Store Privacy Dashboard 填写稿

## Single purpose

把用户主动输入的问题发送到用户选择启用的多个 AI 网页，并在浏览器内并排展示这些网站返回的回答，以便比较和继续对话。

## Permission justifications

### declarativeNetRequestWithHostAccess

仅在扩展自己的网格标签页内修改 AI 站点子框架请求：移除阻止 iframe 嵌入的响应头；用户明确同意后，为 ChatGPT 子框架补充 Chrome 因 SameSite 未附带的认证 Cookie。规则绑定具体 tabId，不影响普通浏览标签页。

### tabs

用于创建和聚焦扩展网格标签页、记录各 AI 对话页面地址，并在用户点击 AI 生成文件时临时打开对应对话页面完成下载后关闭。

### storage

用于保存启用的站点、自定义站点、隐私选择、会话名称和会话 URL。问题正文和回答正文不写入扩展存储。

### scripting

用于在用户主动添加自定义站点后，为该站点注册与内置站点相同的内容脚本；不会向任意网页注入远程代码。

### clipboardWrite

用于在用户点击“复制”后，把回答以富文本和 Markdown 两种格式写入剪贴板。

### favicon

用于从 Chrome 本地 favicon 缓存显示每个站点的图标，不调用第三方图标服务。

### cookies

该权限声明为可选权限。仅在用户于隐私页面明确勾选并同意 Chrome 系统权限提示后，读取 `chatgpt.com` 的认证 Cookie，并只追加到扩展网格标签页发往 ChatGPT 的请求，使跨站 iframe 可以复用用户已有登录状态。用户关闭选项时撤销该权限。Cookie 不写入扩展存储，不发送给开发者或其他域名。

### Host permissions

内置 AI 站点权限用于加载站点 iframe、注入发送与回答提取脚本。任意 HTTP(S) 权限属于可选权限，只在用户主动添加自定义站点并同意 Chrome 权限提示后使用。

## Remote code

选择：No, I am not using remote code.

扩展包中的所有执行逻辑均随 ZIP 提交。AI 网站在隔离的跨源 iframe 中运行自己的网页应用，扩展不下载或执行来自远程服务器的扩展代码。

## Data usage checkboxes

应披露：

- Authentication information：可选处理 ChatGPT 认证 Cookie；
- Personal communications：处理用户问题及 AI 返回的对话；
- User-generated content：处理用户输入、附件和 AI 生成内容；
- Website content：读取 AI 页面回答和生成文件信息；
- Web history：保存用户在扩展内使用的 AI 对话 URL，用于恢复会话。

不收集：个人身份资料、健康信息、财务信息、支付信息、地理位置。

## Limited Use certifications

全部按实际行为勾选：

- 数据仅用于扩展单一用途；
- 不向无关第三方出售或转移；
- 不用于与单一用途无关的广告或个性化广告；
- 不用于信用、贷款或类似资格判断；
- 不允许人工读取用户内容，除非用户主动提交到公开 Issue 并自行附带内容，或法律/安全事件要求。
