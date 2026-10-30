import './store.js';

const cookieAccess = document.getElementById('cookie-access');
const continueButton = document.getElementById('continue');
const error = document.getElementById('error');

const current = await globalThis.MultiAiStore.read();
cookieAccess.checked = current.chatgptCookieAccess;

continueButton.addEventListener('click', async () => {
  continueButton.disabled = true;
  error.textContent = '';
  try {
    let granted = false;
    if (cookieAccess.checked) {
      granted = await chrome.permissions.request({ permissions: ['cookies'] });
      if (!granted) throw new Error('Chrome 未授予 Cookie 权限，你可以取消勾选后继续');
    } else {
      await chrome.permissions.remove({ permissions: ['cookies'] });
    }
    await globalThis.MultiAiStore.write({
      privacyChoice: 'accepted-v1',
      chatgptCookieAccess: granted
    });
    await chrome.runtime.sendMessage({ type: 'PRIVACY_UPDATED' });
    location.href = chrome.runtime.getURL('src/grid.html');
  } catch (cause) {
    error.textContent = `保存失败：${cause.message}`;
    continueButton.disabled = false;
  }
});
