const { app, BrowserWindow, BrowserView } = require('electron');
const { buildUnfriendStepScript } = require('../modules/zalo-user-management');

app.disableHardwareAcceleration();

const fixture = `<!doctype html><html><body>
  <button id="contacts" title="Danh bạ">Danh bạ</button>
  <main id="root"></main>
  <script>
    const root = document.getElementById('root');
    document.getElementById('contacts').onclick = () => {
      root.innerHTML = '<div id="friends">Danh sách bạn bè</div>';
      document.getElementById('friends').onclick = () => {
        root.innerHTML = '<input id="search" placeholder="Tìm bạn"><div role="grid" aria-label="grid"></div>';
        document.getElementById('search').addEventListener('input', (event) => {
          const grid = document.querySelector('[role="grid"]');
          grid.innerHTML = event.target.value ? '<div class="row"><span>Tên Zalo</span><div class="icon__action__more">...</div></div>' : '';
          const more = grid.querySelector('.icon__action__more');
          if (more) more.onclick = () => {
            const menu = document.createElement('div'); menu.className = 'popover-v3'; menu.innerHTML = '<div id="delete">Xóa bạn</div>';
            document.body.appendChild(menu);
            document.getElementById('delete').onclick = () => {
              const modal = document.createElement('div'); modal.className = 'zl-modal';
              modal.innerHTML = '<p>Xóa Tên Zalo khỏi danh sách bạn bè?</p><div class="zl-modal__footer__button">Xóa</div>';
              document.body.appendChild(modal);
              modal.querySelector('.zl-modal__footer__button').onclick = () => { grid.innerHTML = ''; modal.remove(); menu.remove(); };
            };
          };
        });
      };
    };
  </script>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  const view = new BrowserView();
  win.setBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  await view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fixture)}`);
  win.setBrowserView(null);

  const user = { userId: '123', name: 'Tên Zalo', zaloName: 'Tên Zalo' };
  for (const stage of ['CONTACTS', 'FRIEND_LIST', 'SEARCH', 'MORE', 'DELETE', 'CONFIRM', 'VERIFY']) {
    const startedAt = Date.now();
    const result = await Promise.race([
      view.webContents.executeJavaScript(buildUnfriendStepScript(user, stage), true),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true, stage }), 2_000)),
    ]);
    if (!result?.ok) throw new Error(`${stage}: ${JSON.stringify(result)}`);
    if (Date.now() - startedAt >= 2_000) throw new Error(`${stage}: exceeded detached BrowserView deadline`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  console.log('DETACHED_BROWSER_VIEW_UNFRIEND_OK');
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
