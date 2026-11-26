# 安装

## 需要先准备的

- **Docker。** macOS / Windows 上装 Docker Desktop（macOS 也可以用 OrbStack）；Linux 上装 Docker Engine 和 Compose V2。当前用户要能直接运行 `docker`。
- **代理（可选）。** 容器要经代理访问外网时，宿主机上运行 Clash、v2ray 等，并打开「允许局域网连接」（allow-lan）。

Docker 不在这台电脑上也可以：App 装在你的电脑上，Docker 在另一台 Linux 机器上，见 [远程机器](remote.md)。

## 下载

在 [Releases](https://github.com/zhchxiao123/coderfleet/releases/latest) 下载对应平台的文件。

| 平台 | 文件 | 安装 |
| --- | --- | --- |
| macOS（Apple 芯片） | `CoderFleet-<版本>-mac-arm64.dmg` | 打开后把 CoderFleet 拖进「应用程序」 |
| macOS（Intel） | `CoderFleet-<版本>-mac-x64.dmg` | 同上 |
| Windows | `CoderFleet-<版本>-windows-x64-setup.exe`（ARM 设备用 `-arm64-`） | 双击安装，不需要管理员权限 |
| Debian / Ubuntu | `CoderFleet-<版本>-linux-amd64.deb`（ARM 用 `-arm64`） | `sudo apt install ./CoderFleet-*.deb` |
| 其他 Linux | `CoderFleet-<版本>-linux-x64.tar.gz`（ARM 用 `-arm64`） | 解压后运行里面的 `CoderFleet` |
| Android | `CoderFleet-<版本>-android.apk` | 直接安装 |

iOS 暂时没有安装包，需要用 Xcode 自行编译，见仓库里的 `mobile/README.md`。

每次提交到 `main` 的最新构建在 [Actions → Build apps](https://github.com/zhchxiao123/coderfleet/actions/workflows/app.yml) 每次运行的 Artifacts 里。

## 首次打开的系统提示

安装包目前没有开发者签名，系统会拦一下。

=== "macOS"

    提示「无法验证开发者」或「已损坏」时，在终端执行一次：

    ```bash
    xattr -dr com.apple.quarantine /Applications/CoderFleet.app
    ```

    然后再打开。

=== "Windows"

    SmartScreen 提示时点「更多信息」→「仍要运行」。

=== "Linux"

    `.deb` 装好后在应用菜单里找 CoderFleet，或在终端运行 `coderfleet`。

    用 `.tar.gz` 时，如果启动报沙箱相关的错误，给沙箱辅助程序加上权限：

    ```bash
    sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox
    ```

## 升级和卸载

- **升级：** 下载新版本照常安装即可，会覆盖旧版本。工作区（默认 `~/.coderfleet`）、账号登录数据和对话都不在安装目录里，不受影响。
- **卸载：** macOS 把 App 拖进废纸篓；Windows 在「已安装的应用」里卸载；Debian / Ubuntu 执行 `sudo apt remove coderfleet`。工作区需要的话自己删除。
