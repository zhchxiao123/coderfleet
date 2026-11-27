# CoderFleet 手机客户端

只做聊天的 iOS / Android App，连 CoderFleet 的 Node 后端（`node-app`）。项目、账号、终端仍在电脑上管理。

## 连接

在电脑的桌面 App 里打开「设置 → 手机访问」：

- 同一网络：打开「允许局域网访问」。
- 组网：ZeroTier / WireGuard 打开局域网访问后自动出现；Tailscale 运行 `tailscale serve --bg <端口>` 后加入 `https://<机器>.ts.net`。
- 内网穿透：把 frp / Cloudflare Tunnel / ngrok 的 `https://` 地址加进去。

点「添加手机」，用 App 扫二维码。手机拿到的是只能聊天、可随时吊销的设备令牌；App 按顺序尝试二维码里的地址，用第一个连得上的。明文 `http://` 只允许局域网和组网地址。

## 领航

对话列表右上角的指南针打开领航：上面是它在跟的对话（按项目分组，点开进对话），下面是你和它的对话、它替你定下的事（还在跑的可以撤回）和交给你的卡片（批准/拒绝、回答、收下并合并、回复）。可以带附件跟它说（和对话里一样：拍照、相册、任意文件，传到领航自己那里），它交给对话时附件一起过去；线程里能看到你发的和它转交的附件，图片点开看大图。领航的开关只在电脑上，手机只显示它开着没有。

## 通知

App 切到后台后，对话列表继续轮询；有对话等你批准或回答、完成或失败时弹系统通知，点开直达该对话。这是本地通知，只在系统还让 App 运行时有效：Android 通常能撑一段时间，iOS 进后台几十秒后就会挂起 App，锁屏久了收不到。在前台时不弹（列表里的状态点已经说明）。

## 开发

```bash
flutter pub get
flutter analyze
flutter test                      # 单元 + 组件测试（假后端，test/fake_backend.dart）
SHOTS=/tmp/shots flutter test test/screenshots_test.dart   # 渲染主要页面截图
```

在 Mac 上：

```bash
open -a Simulator && flutter run                 # iOS 模拟器
flutter emulators --launch <id> && flutter run   # Android 模拟器
```

模拟器连电脑上的后端：iOS 模拟器可用 `http://127.0.0.1:<端口>`（与 Mac 共用网络），Android 模拟器用 `http://10.0.2.2:<端口>`。用「手动填写地址和令牌」，令牌在桌面 App 的「添加手机」→「复制配对链接」里（`token=cfd_…`）。

代码结构：`lib/src/backend.dart`（地址规则、配对链接、HTTP 客户端），`lib/src/state.dart`（已保存的后端、长轮询），`lib/src/notifications.dart`（后台通知），`lib/src/ui/`（连接、对话列表、对话页、领航）。
