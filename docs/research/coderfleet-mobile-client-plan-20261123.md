# CoderFleet 手机客户端（iOS / Android）调研与规划

2026-11-23 · 状态：规划；框架和连接方式已定，通知与 iOS 安装方式待定

## 1. 目标与边界

一个独立安装的手机 App，只做**聊天**：填一个后端地址（或扫码）就能用，连的是现在桌面版用的 Node 后端。

要做：

- 连接：填地址 + 令牌，或扫桌面端二维码；可存多个后端，切换。
- 对话列表：按项目分组、搜索、状态点（进行中 / 等你确认 / 失败），新建对话时选项目。
- 聊天：流式回答（Markdown、代码块）、工具调用（运行中/完成/失败/已拒绝等状态，点开看输入输出）、批准/拒绝、回答提问、中断、插话 / 排队、拍照或相册发图、自动模式、选模型、重命名。
- 回到前台立即刷新；断网重连。

不做（留在桌面端）：项目和账号管理、终端、镜像构建、设置。

## 2. 技术选型：Flutter（推荐）

| 方案 | 优点 | 缺点 |
|---|---|---|
| **Flutter** | 一套代码出 iOS + Android；你已有 Flutter 工具链和 Mac 验证流程（Reminis）；Dart 的单元/组件测试能在 Linux 容器里跑，截图检查方式成熟 | 和后端 TypeScript 不共享类型（接口不多，手写模型即可） |
| React Native (Expo) | 和后端同为 TS | 桌面 UI 是原生 DOM 不是 React，实际能复用的很少；又多一套工具链 |
| Swift + Kotlin 原生 | 体验最原生 | 两套代码，工作量翻倍 |
| WebView 套壳（Capacitor） | 最快 | 就是现在“感觉不太行”的 Web 页面，否决 |

主要依赖（均需在动工时确认最新版本）：

- Markdown：官方 `flutter_markdown` 已于 2025-04-30 停止维护，用接手维护的 `flutter_markdown_plus`。
- 网络：`http`（长轮询，见 4.2）；图片：`image_picker` + 压缩；扫码：`mobile_scanner`；令牌存储：`flutter_secure_storage`（Keychain / Keystore）。

代码放在仓库 `mobile/` 目录，和 `node-app/` 并列。

## 3. 手机怎么连到后端（三种都支持）

已定：内网、组网、内网穿透到公网三种都要能用。App 里一个后端 = **一个设备令牌 + 一组地址**，按顺序探测 `/v1/health`，用第一个连得上的（例如先试内网，不通再走公网）。扫码配对时，二维码里带上桌面端知道的全部地址；以后也能在 App 里手动增删地址。

| 方式 | 例子 | 后端要做的 | 传输安全 |
|---|---|---|---|
| 内网 | `http://192.168.1.20:8877` | 打开“允许局域网访问”（默认关），监听改为 `0.0.0.0` 或指定网卡地址 | 明文 HTTP；令牌在同一 Wi-Fi 里能被截获，只建议在自己家/办公室用 |
| 组网 | Tailscale：`https://mac.xxx.ts.net`（`tailscale serve`）；ZeroTier / WireGuard：`http://10.147.x.x:8877` | Tailscale serve：不用改，仍只监听本机；ZeroTier/WireGuard：监听那张网卡 | 组网本身端到端加密，HTTP 也可以 |
| 内网穿透到公网 | frp、Cloudflare Tunnel、ngrok → `https://cf.example.com` | 仍只监听本机，由穿透客户端转发 | **必须 HTTPS**（在穿透服务端或 Cloudflare 终止 TLS）；公网暴露，见下 |

App 的规则：

- `https://` 任何地址都可以。
- `http://` 只允许私有和组网地址：`10/8`、`172.16/12`、`192.168/16`、`100.64/10`（Tailscale/CGNAT）、`169.254/16`、`fd00::/8`、`*.local`、`*.ts.net`。填公网 `http://` 地址直接拒绝并说明原因。
- iOS：首次访问局域网会弹“本地网络”权限（需要 `NSLocalNetworkUsageDescription`）；ATS 不拦截 IP 地址，`*.local` 用 `NSAllowsLocalNetworking`。Android：网络安全配置只对私有地址放开明文。

公网暴露时后端的额外保护（阶段 0 一起做）：

- 手机只拿**设备令牌**（见 4.1），只能聊天；主令牌永不离开电脑。
- 认证失败限速：同一来源连续失败后指数退避，并在桌面端显示。
- 设备列表显示最近使用时间和来源地址，可一键吊销。
- 穿透地址只能由你在桌面端“手机访问”页手动填写（后端无法自己知道公网地址），用于生成二维码。

桌面端「设置 → 手机访问」：显示可用地址（局域网 IP、检测到的 Tailscale 名称、手动填写的公网地址），“允许局域网访问”开关，“添加手机”生成一次性二维码，设备列表与吊销。

## 4. 后端（Node）需要的改动

### 4.1 设备令牌（必须）

现在只有一个后端令牌，能做所有事（含删账号、开终端）。手机不该拿它。

- 新增“设备”：`POST /v1/devices`（仅主令牌）生成设备令牌，记录名称、创建时间、最近使用；`DELETE /v1/devices/:id` 吊销。存在后端状态目录，令牌只存哈希。
- 设备令牌只能访问聊天相关接口：`health`、`projects`（只读）、`projects/:id/models`、`conversations*`、`turns*`、`uploads`、`follow-ups`。其余一律 403。
- 配对二维码内容：`coderfleet://pair?url=…&token=…&name=…`，App 扫码后存入 Keychain/Keystore。二维码在桌面端点“添加手机”时一次性生成。

### 4.2 增量更新（必须）

桌面端现在每 0.6 秒拉一次整段对话的全部轮次，手机上费流量、费电。

- 每次对话变更递增一个版本号；新增 `GET /v1/conversations/:id/changes?since=<版本>&wait=25000` 长轮询：有变化立即返回变化的轮次，否则等到超时返回空。
- 对话列表同理：`GET /v1/conversations?since=…&wait=…`。
- 选长轮询不选 WebSocket/SSE：后端已有同样做法（终端输出），HTTP 代理和 Tailscale 都没有额外问题，App 进后台断开、回前台重连也简单。

### 4.3 其他

- 上传：现有 `POST /v1/projects/:id/uploads`（base64 JSON，单张 20 MB）可直接用；App 端先压缩到长边 2048。
- 桌面端“手机访问”页、设备列表与吊销。
- “允许局域网访问”开关：改监听地址（默认只监听本机），改完重启后端。

## 5. 通知（第二阶段，需要你定）

App 不在前台时，“等你确认”和“这轮完成了”怎么提醒：

| 方式 | 说明 |
|---|---|
| 不做推送 | 只在打开 App 时看到；最简单 |
| ntfy | 后端往 ntfy 主题发消息，手机装 ntfy App 收；iOS 上自建 ntfy 要把 `upstream-base-url` 设为 `https://ntfy.sh` 才能即时送达（只转发唤醒信号，内容不经过 ntfy.sh），否则可能延迟数小时 |
| 自己的 App 直接推送 | iOS 走 APNs（需要付费开发者账号和 .p8 密钥，后端直接调用 APNs），Android 走 FCM（需要 Firebase 项目）。体验最好，配置最多 |

建议第一阶段不做，第二阶段先接 ntfy（成本最低），确实需要再做 APNs/FCM。

## 6. 分阶段计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| 0 后端准备 | 设备令牌 + 权限范围、认证失败限速、增量长轮询、局域网监听开关、桌面端“手机访问”页（多地址二维码、设备列表） | Node 测试覆盖：设备令牌访问管理接口被拒、吊销即失效、失败限速、长轮询有变化即返回、局域网开关生效 |
| 1 只读聊天 | Flutter 工程；连接/扫码；对话列表；对话页（流式回答、Markdown、工具行与详情）；回前台刷新 | 对着 `scripts/preview.mjs` 的假后端跑组件测试和截图（含中文字体、浅色/深色、小屏） |
| 2 完整聊天 | 发消息、新建对话、批准/拒绝、回答提问、中断、插话/排队、发图、自动模式、选模型 | 同上 + 真机：Tailscale 连 Mac 上的后端走一遍 |
| 3 发布 | iOS TestFlight（或开发者签名直装），Android 签名 APK | 两端真机安装 |
| 4 通知（可选） | 按第 5 节选定的方式 | 锁屏收到“等你确认” |

测试方式：Dart 逻辑和组件测试在 Linux 容器里跑；后端用现有 Node 测试；iOS/Android 构建和真机检查在 Mac 上（按你现在 Reminis 的流程，我给 Codex 提示词和手动检查清单）。这个容器里目前没有 Flutter，阶段 1 开始时需要装。

## 7. 需要你决定

1. ~~框架~~：已定 Flutter。
2. ~~连接方式~~：已定内网、组网、穿透三种都支持（第 3 节）。
3. **通知**：第一版不做（推荐），之后用 ntfy 还是 APNs/FCM？
4. **iOS 安装**：用你的 Apple 开发者账号走 TestFlight，还是只在自己手机上直装？

## 来源

- flutter_markdown 停止维护、flutter_markdown_plus 接手：<https://pub.dev/packages/flutter_markdown>，<https://pub.dev/packages/flutter_markdown_plus>
- Tailscale Serve（仅 tailnet 可访问、自动 HTTPS、证书透明日志）：<https://tailscale.com/kb/1312/serve>，<https://tailscale.com/kb/1153/enabling-https>
- iOS ATS 不作用于 IP 地址、本地网络权限：<https://developer.apple.com/forums/thread/66417>，<https://developer.apple.com/forums/thread/663775>，<https://developer.apple.com/forums/thread/761927>
- ntfy iOS 即时通知需 upstream-base-url：<https://docs.ntfy.sh/known-issues/>，<https://docs.ntfy.sh/config/>
