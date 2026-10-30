// 设置面板：站点开关、添加/删除自定义站点。
// 只负责 UI 和存储，面板的增删交给 grid.js 传进来的回调。
const store = globalThis.MultiAiStore;

const dialog = document.getElementById('settings');
const list = document.getElementById('site-list');
const addForm = document.getElementById('add-site');
const addError = document.getElementById('add-error');

// 自定义站点的域名不在 manifest 里，改它的响应头和注入脚本都要先拿到该域的权限。
// 必须在用户点击的上下文里申请，所以放在提交处理里。
async function grantAndRegister(site) {
  const origin = `${new URL(site.url).origin}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error('没有拿到该站点的访问权限，无法嵌入');
  const result = await chrome.runtime.sendMessage({ type: 'REGISTER_SITE', site });
  if (!result?.ok) throw new Error(result?.error ?? '注册注入脚本失败');
}

function renderRow({ site, enabled, onToggle, onRemove }) {
  const row = document.createElement('li');

  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = enabled;
  checkbox.addEventListener('change', () => onToggle(site, checkbox.checked));
  label.append(checkbox, document.createTextNode(` ${site.name}`));

  const host = document.createElement('span');
  host.className = 'site-host';
  host.textContent = site.host;

  row.append(label, host);

  if (site.custom) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '删除';
    remove.addEventListener('click', () => onRemove(site));
    row.append(remove);
  }
  return row;
}

async function render(handlers) {
  const { all, disabled } = await store.sites();
  list.replaceChildren(
    ...all.map((site) => renderRow({ site, enabled: !disabled.includes(site.id), ...handlers }))
  );
}

// grid.js 通过 onAdd / onRemove / onToggle 得知要增删哪个面板，避免整页重载、
// 把其它几家已有的对话一起刷掉。
export function mountSettings({ onAdd, onRemove, onToggle }) {
  const handlers = {
    async onToggle(site, enabled) {
      const { disabled } = await store.read();
      const next = enabled ? disabled.filter((id) => id !== site.id) : [...new Set([...disabled, site.id])];
      await store.write({ disabled: next });
      onToggle(site, enabled);
    },
    async onRemove(site) {
      const { custom, disabled } = await store.read();
      await store.write({
        custom: custom.filter((item) => item.id !== site.id),
        disabled: disabled.filter((id) => id !== site.id)
      });
      await chrome.runtime.sendMessage({ type: 'UNREGISTER_SITE', siteId: site.id });
      onRemove(site);
      await render(handlers);
    }
  };

  document.getElementById('open-settings').addEventListener('click', async () => {
    await render(handlers);
    dialog.showModal();
  });
  document.getElementById('close-settings').addEventListener('click', () => dialog.close());

  addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    addError.textContent = '';
    try {
      const site = store.siteFromForm(Object.fromEntries(new FormData(addForm)));
      await grantAndRegister(site);
      const { custom } = await store.read();
      await store.write({ custom: [...custom, site] });
      addForm.reset();
      onAdd(site);
      await render(handlers);
    } catch (error) {
      addError.textContent = error.message;
    }
  });
}
