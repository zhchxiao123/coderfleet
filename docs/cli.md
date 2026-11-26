# 后端命令行

后端可以不依赖桌面 App 单独运行，例如部署在服务器上，或在脚本里使用。通过 SSH 添加的远程机器上，程序在 `~/.coderfleet-backend` 里。

## 运行后端

```bash
coderfleet-backend init      # 生成配置文件和随机令牌
coderfleet-backend serve     # 启动
coderfleet-backend status    # 查看状态
coderfleet-backend version
```

| 项 | 默认值 | 用环境变量修改 |
| --- | --- | --- |
| 配置文件 | `~/.coderfleet-backend/config.json` | `CODERFLEET_BACKEND_HOME` |
| 端口 | `8877`，只监听 `127.0.0.1` | `CODERFLEET_BACKEND_PORT` |
| 工作区 | `~/.coderfleet` | `CODERFLEET_WORKSPACE` |

所有命令都可以加 `--config <路径>` 指定配置文件。

要让别的机器访问，放在一个提供 HTTPS 的反向代理后面，然后在 App 里用「已有服务地址和令牌」添加。

## 做完为止

```bash
coderfleet-backend job list
coderfleet-backend job show <对话>
coderfleet-backend job start <项目> <要做的事>
coderfleet-backend job continue <对话> <补充内容>
coderfleet-backend job accept <对话>
coderfleet-backend job discard <对话>
```

## 定时

```bash
coderfleet-backend schedule list
coderfleet-backend schedule add <项目> <规则> <要做的事> [--job]
coderfleet-backend schedule edit <id> rule <规则>
coderfleet-backend schedule edit <id> prompt <要做的事>
coderfleet-backend schedule on <id>
coderfleet-backend schedule off <id>
coderfleet-backend schedule run <id>
coderfleet-backend schedule remove <id>
```

规则的写法：

| 规则 | 含义 |
| --- | --- |
| `daily 09:00` | 每天 9 点 |
| `weekly 1,3 09:00` | 每周一、周三 9 点（1 = 周一 … 7 = 周日） |
| `every 6` | 每隔 6 小时 |

## 机器助手

```bash
coderfleet-backend helper status
coderfleet-backend helper install | start | stop | upgrade
coderfleet-backend helper restart-relay
coderfleet-backend helper access <项目> command   # 允许这个项目
coderfleet-backend helper access <项目> off       # 收回
coderfleet-backend helper audit [条数]            # 最近的操作
```
