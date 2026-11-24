'use strict';
// Settings → 手机访问: the addresses a phone can use (LAN switch, mesh,
// tunnels), pairing a phone by QR code, and the paired devices.
(() => {
  const CF = window.CF;
  const { h } = CF;
  const KIND = { lan: '局域网', mesh: '组网', public: '公网' };

  /** A QR code image for `text` (the vendored qrcode-generator draws a GIF data URL). */
  function qrImage(text) {
    const code = window.qrcode(0, 'M');
    code.addData(text, 'Byte');
    code.make();
    return h('img.qr', { src: code.createDataURL(6, 2), alt: '配对二维码' });
  }

  function pair(profile, refresh) {
    const name = h('input', { value: '我的手机', maxLength: 60, 'aria-label': '手机名称' });
    const sheet = CF.sheet({ title: '添加手机', subtitle: '手机拿到的令牌只能聊天，随时可以在这里吊销。', onClose: refresh }, () => h('div.pair',
      h('label.field', h('span', '手机名称'), name)));
    const create = h('button.btn.primary', { on: { click: () => CF.busy(create, async () => {
      const result = await CF.api('POST', 'devices', { name: name.value, backendName: profile?.name || 'CoderFleet' });
      const copy = h('button.btn', { on: { click: async () => {
        await navigator.clipboard.writeText(result.link);
        copy.textContent = '已复制';
      } } }, '复制配对链接');
      sheet.dialog.querySelector('.sheet-body').replaceChildren(h('div.pair',
        qrImage(result.link),
        h('p.pair-hint', '用 CoderFleet 手机 App 扫码。二维码里有令牌，关掉后不会再显示。'),
        h('ol.pair-addresses', result.addresses.map(address => h('li', h('span.badge', KIND[address.kind] || address.kind), h('code', address.url), h('small', address.label)))),
        h('p.pair-hint', '手机会按这个顺序尝试，用第一个连得上的。')));
      sheet.foot(copy, h('button.btn.primary', { on: { click: () => sheet.close() } }, '完成'));
    }) } }, '生成二维码');
    sheet.foot(h('button.btn', { on: { click: () => sheet.close() } }, '取消'), create);
    name.select();
  }

  /** The 手机访问 card. `profile` is the connected backend; the LAN switch exists only for the local one. */
  CF.mobileCard = profile => {
    const card = h('div.card.mobile-card', h('div.card-head', h('h2', '手机访问')), h('div.card-body', h('div.empty-note', '正在读取…')));
    const refresh = async () => {
      let info;
      try { info = await CF.get('mobile'); }
      catch (error) { card.querySelector('.card-body').replaceChildren(h('div.empty-note', '读取失败：' + CF.errorText(error))); return; }
      render(info);
    };
    const saveExtra = async list => {
      await CF.api('PUT', 'mobile', { addresses: list.map(item => ({ url: item.url, label: item.label })) });
      await refresh();
    };

    const render = info => {
      const local = profile?.kind === 'local' && CF.transport.setLan;
      const lan = info.listening.beyondLoopback;
      const toggle = local ? h('button.switch' + (lan ? '.on' : ''), {
        role: 'switch', 'aria-checked': String(lan), title: lan ? '关闭局域网访问' : '开放局域网访问',
        on: { click: () => CF.busy(toggle, async () => {
          if (!lan && !await CF.confirm('开放局域网访问？', '同一 Wi-Fi 或组网（ZeroTier、WireGuard）里的设备可以连到后端。传输不加密，只在可信网络里打开。后端会重启，容器里的对话不受影响。', { label: '开放' })) return;
          await CF.transport.setLan(profile.id, !lan);
          await CF.app.loadProfiles(profile.id);
        }) },
      }, h('span.knob')) : null;

      const input = h('input', { type: 'url', placeholder: 'https://cf.example.com 或 http://10.147.17.5:8877' });
      const add = h('button.btn.small', { on: { click: () => CF.busy(add, async () => {
        if (!input.value.trim()) return;
        await saveExtra([...info.extra, { url: input.value.trim() }]);
      }) } }, '添加');
      input.addEventListener('keydown', event => { if (event.key === 'Enter') add.click(); });
      const tailscale = info.tailscale && !info.extra.some(item => item.url === 'https://' + info.tailscale)
        ? h('div.mobile-suggest', CF.icon('link', 13),
          h('span', '检测到 Tailscale。在这台电脑上运行 ', h('code', 'tailscale serve --bg ' + info.listening.port), ' 后，手机可以用 ', h('code', 'https://' + info.tailscale), '。'),
          h('button.btn.small', { on: { click: event => CF.busy(event.currentTarget, () => saveExtra([...info.extra, { url: 'https://' + info.tailscale, label: 'Tailscale' }])) } }, '加入地址'))
        : null;

      const ownAddresses = lan ? info.interfaces : [];
      const addressRows = [
        ...ownAddresses.map(address => h('li.address', h('span.badge', KIND[address.kind]), h('code', address.url), h('small', address.label))),
        ...info.extra.map((address, index) => h('li.address', h('span.badge', KIND[address.kind]), h('code', address.url), h('small', address.label),
          h('button.icon-btn', { title: '移除', on: { click: event => CF.busy(event.currentTarget, () => saveExtra(info.extra.filter((_, other) => other !== index))) } }, CF.icon('x', 12)))),
      ];

      const devices = info.devices.length ? h('ul.list', info.devices.map(device => h('li.row',
        h('div.row-lead', h('span.row-avatar', CF.icon('user', 16)),
          h('div.row-main', h('div.row-title', h('span.name', device.name)),
            h('div.row-sub', h('span', '添加于 ' + CF.relative(device.createdAt)),
              h('span', device.lastUsedAt ? '最近使用 ' + CF.relative(device.lastUsedAt) + (device.lastAddress ? ' · ' + device.lastAddress.replace(/^::ffff:/, '') : '') : '还没用过')))),
        h('div.row-actions', h('button.btn.small', { on: { click: async event => {
          if (!await CF.confirm('吊销「' + device.name + '」？', '这台手机会立即断开，需要重新扫码才能再用。', { danger: true, label: '吊销' })) return;
          await CF.busy(event.currentTarget, () => CF.api('DELETE', 'devices/' + device.id));
          await refresh();
        } } }, '吊销')))))
        : h('div.empty-note', '还没有手机。');

      const failures = info.failures.filter(item => item.count >= 3);
      const pairButton = h('button.btn.primary.small', { on: { click: () => pair(profile, refresh) } }, CF.icon('plus', 13), '添加手机');
      card.replaceChildren(
        h('div.card-head', h('div', h('h2', '手机访问'), h('p', '在手机 App 里聊天。手机只拿到能聊天的令牌，项目、账号和终端仍只在电脑上管理。')), pairButton),
        h('div.card-body',
          local ? h('div.mobile-lan', h('div', h('strong', '允许局域网访问'),
            h('small', lan ? '后端在所有网卡上监听（端口 ' + info.listening.port + '）。同一 Wi-Fi 或组网里的手机可以直接连。' : '只在这台电脑上监听。打开后，同一 Wi-Fi 或 ZeroTier / WireGuard 组网里的手机可以连。')), toggle) : null,
          h('div.mobile-label', '手机按顺序尝试的地址'),
          addressRows.length ? h('ul.addresses', addressRows) : h('div.empty-note', '还没有地址。打开局域网访问，或添加组网 / 内网穿透地址。'),
          tailscale,
          h('div.mobile-add', input, add),
          h('small.mobile-hint', '内网穿透（frp、Cloudflare Tunnel、ngrok）或反向代理的公网地址必须是 https://；明文 http:// 只允许局域网和组网地址。'),
          failures.length ? h('div.mobile-warn', CF.icon('shield', 13), '最近有 ' + failures.length + ' 个来源连续认证失败：' + failures.map(item => item.address.replace(/^::ffff:/, '') + '（' + item.count + ' 次）').join('，')) : null,
          h('div.mobile-label', '已添加的手机'),
          devices));
    };
    void refresh();
    return card;
  };
})();
