# 发版规则

桌面 App、后端和手机 App 用同一个版本号，一起发布。

## 发一个版本

在 `main` 上、工作区干净、和远端一致时执行：

```bash
scripts/release.sh 0.2.1
```

它会依次：

1. 把 `node-app/package.json`、`node-app/package-lock.json` 和 `mobile/pubspec.yaml` 的版本号改成 `0.2.1`；
2. 提交 `chore: release App 0.2.1`，打标签 `app-v0.2.1`；
3. 确认后推送 `main` 和标签（加 `--yes` 不再询问）。

之后由 CI（[app.yml](.github/workflows/app.yml)）测试、构建全部平台的安装包，创建 GitHub Release 并标为 Latest，更新说明按上一个版本以来的提交自动生成。大约 15 分钟。

同一个标签还会触发 [image.yml](.github/workflows/image.yml)：构建 amd64 和 arm64 的容器镜像，发布为 `ghcr.io/zhchxiao123/coderfleet-worker:0.2.1` 和 `:latest`。App 里的「下载镜像」取的就是和自己版本号相同的那个。

不要手工改版本号或手工打标签。

## 版本号怎么定

格式是 `主.次.修订`，按[语义化版本](https://semver.org/lang/zh-CN/)：

| 改了什么 | 升哪一位 | 例子 |
| --- | --- | --- |
| 只修问题 | 修订 | 0.2.0 → 0.2.1 |
| 有新功能 | 次 | 0.2.1 → 0.3.0 |
| 用户必须手工处理才能继续用（工作区格式不兼容、配置要迁移） | 主 | 0.9.0 → 1.0.0 |

1.0.0 之前，不兼容的改动升次版本号即可。

## `main` 上的版本号

`main` 上的版本号一直是**最近发布的那个版本**，发下一版时才改。

不是从标签构建出来的包（`main` 上的每次推送、PR），CI 会在版本号后面加上提交号：`0.2.0+36a1781`，意思是「0.2.0 之后、提交 36a1781 的构建」。文件名、App 里显示的后端版本、远程后端的升级判断用的都是这个带提交号的版本，所以测试包和正式版、测试包和测试包之间都分得清。

这些包在 [Actions → Build apps](https://github.com/zhchxiao123/coderfleet/actions/workflows/app.yml) 每次运行的 Artifacts 里，保留 90 天，不进 Releases。

## CI 会拦下的情况

- 标签和 `node-app/package.json` 的版本号不一致；
- `mobile/pubspec.yaml` 和 `node-app/package.json` 的版本号不一致；
- 打标签的提交不在 `main` 上；
- 任何平台的测试或构建失败（这时不会创建 Release）。

发版失败时修好问题，发下一个修订号。已经公开的标签不要移动或重用。

## 不跟着一起走的版本号

- **机器助手**（`node-app/helper/package.json`）有自己的版本号。它变了，用户那边才会出现「升级到 …」；只在机器助手本身有改动时才升。
- **`v0.1.x` 标签**是已经停止维护的 Python 版，App 的标签一律以 `app-v` 开头。

## 发完检查

- [Releases](https://github.com/zhchxiao123/coderfleet/releases/latest) 里是新版本，安装包齐全：`.dmg` ×2、`-setup.exe` ×2、`.deb` ×2、`.tar.gz` ×2、`.apk`、后端包 ×2；
- 下载一个安装包装上，能打开并连上后端。
