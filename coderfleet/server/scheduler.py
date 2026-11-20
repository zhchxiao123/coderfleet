"""
scheduler.py — 任务调度核心

职责：
- 解析 accounts.conf，获取账号列表
- 判断账号空闲/忙碌状态
- 分配任务到合适账号
- 异步执行任务，维护任务生命周期
"""
from __future__ import annotations

import asyncio
import codecs
import hashlib
import json
import logging
import os
import random
import re
import secrets
import shlex
import subprocess
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Awaitable, Callable, Literal, Optional

from coderfleet.config import load_config, parse_conf, truthy
from coderfleet import usage_probe
from coderfleet.server import docker_mgr
from coderfleet.server.log_parser import split_complete_lines
from coderfleet.server.runtime import ContainerRuntime, ContainerSpec, DockerRuntime, LocalRuntime, Process
from coderfleet.server.store import JsonStore
from coderfleet.ports import allocate_ide_port
from coderfleet.server.models import (
    Account,
    AccountAuth,
    AccountProxy,
    AccountResponse,
    AccountRuntime,
    AccountType,
    AccountUsage,
    Board,
    BoardCard,
    BoardCardStatus,
    Conversation,
    ConversationFork,
    ConversationMode,
    ConversationStatus,
    Continuation,
    ContinuationStatus,
    ContinuationTrigger,
    ContinuationTriggerRequest,
    ContinuationTriggerType,
    ImageBuild,
    LogicalProject,
    LogicalProjectEntry,
    NodeType,
    PendingIntervention,
    Pipeline,
    PipelineNodeRun,
    Project,
    Schedule,
    ScheduleType,
    Skill,
    TASK_STATUS_LABELS,
    Task,
    TaskStatus,
    TemplateNode,
    NodeExecution,
    WorkflowNodeState,
    WorkflowRun,
    WorkflowTemplate,
    WebhookDelivery,
    now_iso,
    parse_iso,
    utc_now,
)

logger = logging.getLogger(__name__)

# 每个会话最多允许的 pending/scheduled 排队任务数（API 与 Telegram 入口共用）
MAX_PENDING_PER_CONV = 5

# Intervention 默认超时（秒）：CLI 主动暂停问人，人没在这个时限内回答就自动放行，
# 不无限期挂起（见 issue #69）。
DEFAULT_INTERVENTION_TIMEOUT_SECONDS = 600

_TRANSIENT_FAILURE_RE = re.compile(
    r"(?:API Error:\s*(?:502|503|504)\b|"
    r"(?:502|503|504)\s+status code\b|"
    r"\b(?:bad gateway|service unavailable|gateway timeout)\b|"
    r"\bconnection (?:reset|refused|timed out)\b|"
    r"\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED)\b)",
    re.IGNORECASE,
)
_SIDE_EFFECT_EVENT_RE = re.compile(
    r'"(?:type|item_type)"\s*:\s*"'
    r'(?:tool_use|command_execution|file_change|mcp_tool_call|collab_tool_call)"'
)


class Scheduler:
    def __init__(
        self,
        workspace_dir: Path,
        runtime: "ContainerRuntime | None" = None,
        local_runtime: "ContainerRuntime | None" = None,
    ):
        self.workspace_dir  = workspace_dir
        # 容器运行时 seam：默认走真正的 docker，测试注入 FakeRuntime。
        self.runtime: "ContainerRuntime" = runtime or DockerRuntime()
        # local 账号不经过 docker，走同一个 LocalRuntime 单例（无状态无所谓复用）；测试注入 FakeRuntime。
        self._local_runtime: "ContainerRuntime" = local_runtime or LocalRuntime()
        self.accounts_conf  = workspace_dir / "accounts.conf"
        self.projects_conf  = workspace_dir / "projects.conf"
        self.tasks_dir      = workspace_dir / "tasks"
        self.conversations_dir = workspace_dir / "conversations"
        self.continuations_dir = workspace_dir / "continuations"
        self.webhook_deliveries_dir = workspace_dir / "webhook_deliveries"
        self.boards_dir     = workspace_dir / "boards"
        self.board_cards_dir = workspace_dir / "board_cards"
        self.pipelines_dir  = workspace_dir / "pipelines"
        self.templates_dir  = workspace_dir / "workflow_templates"
        self.workflow_runs_dir = workspace_dir / "workflow_runs"   # v2 工作流执行记录（完整修改计划）
        self.schedules_dir  = workspace_dir / "schedules"
        self.digests_dir    = workspace_dir / "digests"
        self.sessions_dir   = workspace_dir / "sessions"
        self.builds_dir     = workspace_dir / "builds"
        # task_id → asyncio.Task（后台运行的协程）
        self._running: dict[str, asyncio.Task] = {}
        self._sdk_launching: set[str] = set()
        self._sdk_native_busy: set[tuple[str,str]] = set()
        self._loop_task: Optional[asyncio.Task] = None
        # 任务终态通知渠道（Web Push / Telegram …），由 main.py 在启动时注册
        self._notifiers: list = []
        # 工作流审批等非任务消息仍直接走 Web Push
        self._push_manager = None  # set by main.py after both are initialized
        self._last_auto_digest_date: str = ""
        self._board_migration_done = False  # 单一引用迁移只跑一次/进程
        self._pipeline_migration_done = False  # Pipeline→WorkflowRun backfill 只跑一次/进程
        # legacy_pipeline_id → WorkflowRun.id 的内存索引：WorkflowRun 文件按自己的 id 存盘，
        # 没有按 legacy_pipeline_id 建索引的文件名，查找只能靠内容匹配。懒加载建好后，
        # 后续按 legacy id 查找不必每次都把 workflow_runs/ 目录全量扫一遍。
        self._legacy_pipeline_run_ids: dict[str, str] = {}
        # Claude Max 套餐用量：内存缓存 + accounts/<name>/usage-cache.json 落盘
        self._usage_cache: dict[str, AccountUsage] = {}
        self._usage_loop_task: Optional[asyncio.Task] = None
        self._load_cached_usage()
        # Intervention：f"{task_id}:{tool_call_id}" → 等待人工作答的 Future。
        # 进程内内存态——调度器重启会丢失，是已知的可接受边界（见 issue #69）。
        self._pending_intervention_futures: dict[str, "asyncio.Future"] = {}
        self._continuation_lock = asyncio.Lock()
        # Generic webhook 原始 token 只在创建响应中返回一次；磁盘只保存 SHA-256。
        self._issued_webhook_tokens: dict[str, dict[str, str]] = {}
        from coderfleet.server.conversation_titles import ConversationTitles
        self.titles = ConversationTitles(self)

    def register_notifier(self, notifier: "Callable[[Task], Awaitable[None]]") -> None:
        """注册一个任务终态通知渠道。"""
        self._notifiers.append(notifier)

    async def _notify(self, task: Task) -> None:
        """任务到达终态时向所有已注册渠道扇出；单渠道失败不影响其余渠道。"""
        if task.platform_run_id:
            from coderfleet.server.platform_agent import PlatformHarness
            await asyncio.to_thread(PlatformHarness(self).get, task.platform_run_id)
            return
        if task.status not in TASK_STATUS_LABELS:
            return
        self.titles.observe(task)
        if task.execution_backend == "sdk":
            current = self.get_task(task.id)
            if current is None or current.terminal_notified:
                return
            current.terminal_notified = True
            current.save(self.tasks_dir)
            task = current
        for notifier in self._notifiers:
            try:
                await notifier(task)
            except Exception as exc:
                logger.warning("通知渠道失败 [task=%s]: %s", task.id, exc)

    @staticmethod
    def task_process_marker(task_id: str) -> str:
        return f"coderfleet-task-{task_id}"

    # 匹配 prompt 开头的 "/skill-slug 其余参数"（其余参数可跨行）
    _SLASH_COMMAND_RE = re.compile(r"^/([a-zA-Z0-9_-]+)(?:[ \t]+(.*))?$", re.DOTALL)

    def _expand_skill_command(self, prompt: str, account_name: str) -> str:
        """
        把 Web UI "/" 自动补全选中的 skill 展开成完整 prompt 再喂给 CLI。
        只在此处（提交给容器执行前）展开，task.prompt 本身保留用户原始输入，
        用于会话历史 / 日志展示。
        """
        m = self._SLASH_COMMAND_RE.match(prompt.strip())
        if not m or not account_name:
            return prompt
        slug, rest = m.group(1), (m.group(2) or "").strip()
        skill_path = self.workspace_dir / "accounts" / account_name / "skills" / slug / "SKILL.md"
        if not skill_path.exists():
            return prompt
        try:
            skill = Skill.from_file(slug, skill_path)
        except Exception:
            return prompt
        if not skill.user_invocable:
            return prompt
        if "$ARGUMENTS" in skill.content:
            return skill.content.replace("$ARGUMENTS", rest)
        return f"{skill.content}\n\n{rest}" if rest else skill.content

    @staticmethod
    def build_cli_command(
        acc_type: AccountType,
        prompt: str,
        auto: bool,
        task_id: str,
        native_session_id: str = "",
        container_workdir: str = "",
        images: list[str] | None = None,
        model: str = "",
        fork: Optional[ConversationFork] = None,
    ) -> str:
        """
        构建在容器内执行的 CLI 命令。
        per-type 逻辑委托给注册表中的 build_inner_cmd，此处只处理通用包装。
        """
        from coderfleet.account_type_registry import get_spec
        spec     = get_spec(acc_type.value)
        marker   = shlex.quote(Scheduler.task_process_marker(task_id))
        task_env = shlex.quote(task_id)

        fork_kwargs = ({"fork_session_id": fork.target_session_id,
                        "resume_session_at": fork.message_uuid} if fork else {})
        inner_cmd = spec.build_inner_cmd(
            prompt, auto, task_id, marker, task_env,
            native_session_id, list(images or []), model.strip(),
            **fork_kwargs,
        )

        if container_workdir:
            inner_cmd = f"cd {shlex.quote(container_workdir)} && {inner_cmd}"

        task_log  = f"/workspace/.coderfleet-tasks/{task_id}.log"
        task_exit = f"/workspace/.coderfleet-tasks/{task_id}.exit"
        # 用子 shell ( ... ) 包裹 inner_cmd：exec -a 替换的是子 shell 进程，
        # 外层 bash 在子 shell 退出后仍可执行 echo $? 写入 exit 文件。
        wrapper_body = (
            f"( {inner_cmd} ) >> {shlex.quote(task_log)} 2>&1"
            f"; echo $? > {shlex.quote(task_exit)}"
        )
        return (
            f"mkdir -p /workspace/.coderfleet-tasks"
            f" && setsid bash -c {shlex.quote(wrapper_body)} &"
        )

    @staticmethod
    def build_usage_status_command(acc_type: AccountType) -> str:
        from coderfleet.account_type_registry import get_spec
        try:
            return get_spec(acc_type.value).usage_status_cmd
        except KeyError:
            return ""

    @staticmethod
    def extract_native_session_id(acc_type: AccountType, text: str) -> str:
        from coderfleet.account_type_registry import get_spec
        try:
            return get_spec(acc_type.value).extract_session_id(text)
        except KeyError:
            return ""

    # ── 账号管理 ──────────────────────────────────────────

    def get_accounts(self) -> list[Account]:
        """解析 accounts.conf，返回所有账号。词法与「形状」分别由 parse_conf 与模型持有。"""
        return [
            acc for acc in (Account.from_conf_record(r) for r in parse_conf(self.accounts_conf))
            if acc is not None
        ]

    def get_projects(self) -> list[Project]:
        return [
            proj for proj in (Project.from_conf_record(r) for r in parse_conf(self.projects_conf))
            if proj is not None
        ]

    # ── conf 文件写入 ──────────────────────────────────────

    def _rewrite_conf(self, conf_path: Path, key: str, new_line: Optional[str]) -> None:
        """原子重写 conf 文件：替换/追加/删除 NAME=key 的行，注释行保留。"""
        lines: list[str] = []
        if conf_path.exists():
            lines = conf_path.read_text(encoding="utf-8").splitlines(keepends=True)

        target_idx: Optional[int] = None
        for i, raw in enumerate(lines):
            stripped = raw.strip()
            if not stripped or stripped.startswith("#"):
                continue
            parts: dict[str, str] = {}
            for token in stripped.split():
                if "=" in token:
                    k, v = token.split("=", 1)
                    parts[k.upper()] = v
            if parts.get("NAME") == key:
                target_idx = i
                break

        if new_line is None:          # 删除
            if target_idx is not None:
                lines.pop(target_idx)
        else:
            entry = new_line.rstrip("\n") + "\n"
            if target_idx is not None:
                lines[target_idx] = entry
            else:
                lines.append(entry)

        conf_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = conf_path.with_suffix(".tmp")
        tmp.write_text("".join(lines), encoding="utf-8")
        tmp.replace(conf_path)

    def save_account(
        self,
        name:     str,
        acc_type: AccountType,
        auth:     AccountAuth,
        proxy:    AccountProxy,
        runtime:  AccountRuntime = AccountRuntime.container,
        sandbox_confirmed: bool = False,
        claude_backend: Literal["cli", "sdk"] = "cli",
    ) -> Account:
        """新增或修改 accounts.conf 中的账号行，env 认证时自动创建 env 文件占位。"""
        from coderfleet.server.models import check_account_runtime_proxy_compat
        rejection = check_account_runtime_proxy_compat(acc_type, runtime, proxy)
        if rejection:
            raise ValueError(rejection)
        validated = Account(
            name=name, type=acc_type, auth=auth, proxy=proxy, runtime=runtime,
            sandbox_confirmed=sandbox_confirmed, claude_backend=claude_backend,
        )
        parts = [
            f"NAME={name}", f"TYPE={acc_type.value}", f"AUTH={auth.value}",
            f"PROXY={proxy.value}", f"RUNTIME={runtime.value}",
            f"SANDBOX_CONFIRMED={'true' if sandbox_confirmed else 'false'}",
            f"CLAUDE_BACKEND={validated.claude_backend}",
        ]
        env_file = ""
        if auth == AccountAuth.env:
            env_file = f"./accounts/{name}/env"
            parts.append(f"ENV_FILE={env_file}")
            env_path = self.workspace_dir / "accounts" / name / "env"
            env_path.parent.mkdir(parents=True, exist_ok=True)
            if not env_path.exists():
                env_path.write_text("", encoding="utf-8")
                try:
                    env_path.chmod(0o600)
                except OSError:
                    pass
        self._rewrite_conf(self.accounts_conf, name, " ".join(parts))
        return Account(
            name=name, type=acc_type, auth=auth, proxy=proxy, runtime=runtime,
            sandbox_confirmed=sandbox_confirmed, env_file=env_file,
            claude_backend=validated.claude_backend,
        )

    def delete_account(self, name: str) -> None:
        """从 accounts.conf 删除账号行。"""
        self._rewrite_conf(self.accounts_conf, name, None)

    async def claude_sdk_status(self, name: str) -> dict:
        """Inspect the selected account's SDK installation without creating a Task."""
        from coderfleet.claude_sdk import build_doctor_command, worker_source
        acc = next((account for account in self.get_accounts() if account.name == name), None)
        if acc is None:
            raise ValueError(f"账号 '{name}' 不存在")
        if acc.type.value != "claude":
            raise ValueError("只有 Claude 账号支持 SDK 诊断")
        report = {"ready": False, "sdk_version": "", "cli_version": "", "python_path": "", "error": ""}
        env = self.get_account_env(name)
        doctor_container = ""
        runtime = self._runtime_for(acc)
        try:
            source = worker_source()
            filename = f"sdk-worker-{hashlib.sha256(source).hexdigest()[:16]}.py"
            if acc.runtime == AccountRuntime.local:
                worker = self.workspace_dir / "cache" / "claude-sdk" / filename
                self._write_sdk_artifact(worker, source)
                env["CLAUDE_CONFIG_DIR"] = str(self.local_auth_dir(acc))
                command = build_doctor_command(worker, local=True)
                doctor_container = f"coderfleet-sdk-doctor-{uuid.uuid4().hex[:12]}"
                proc = await runtime.run(ContainerSpec(
                    image="", command=["bash", "-c", command], env=env,
                    name=doctor_container, workdir=str(self.workspace_dir.resolve()),
                ))
            else:
                def find_running_project() -> Optional[Project]:
                    return next((project for project in self.get_projects()
                                 if project.account == name and not project.ephemeral
                                 and runtime.is_running(project.container_name(acc.type))), None)

                running_project = await asyncio.to_thread(find_running_project)
                if running_project:
                    worker = Path(running_project.path) / ".coderfleet-tasks" / filename
                    self._write_sdk_artifact(worker, source)
                    command = build_doctor_command(f"/workspace/.coderfleet-tasks/{filename}")
                    proc = await runtime.exec(running_project.container_name(acc.type), ["bash", "-c", command], env=env)
                else:
                    worker = self.workspace_dir / "cache" / "claude-sdk" / filename
                    self._write_sdk_artifact(worker, source)
                    doctor_container = f"coderfleet-sdk-doctor-{uuid.uuid4().hex[:12]}"
                    proc = await runtime.run(ContainerSpec(
                        image=self._get_account_image(acc), name=doctor_container, remove=True,
                        command=["bash", "-c", build_doctor_command("/tmp/coderfleet-sdk-doctor.py")],
                        env=env, mounts=[(str(worker), "/tmp/coderfleet-sdk-doctor.py:ro")], workdir="/tmp",
                    ))
            output, _ = await asyncio.wait_for(proc.communicate(), timeout=20)
            decoded = json.loads(output.decode("utf-8"))
            if not isinstance(decoded, dict):
                raise ValueError("SDK 诊断返回无效结果")
            for key in ("sdk_version", "cli_version", "python_path", "error"):
                if isinstance(decoded.get(key), str):
                    report[key] = decoded[key]
            report["ready"] = decoded.get("ready") is True and proc.returncode == 0
            if not report["ready"] and not report["error"]:
                report["error"] = "SDK 环境未就绪，请安装隔离环境或更新项目镜像"
        except Exception as exc:
            report["error"] = f"SDK 预检失败：{exc}"
            if doctor_container:
                try:
                    await asyncio.wait_for(runtime.remove(doctor_container), timeout=5)
                except Exception:
                    logger.warning("SDK 诊断进程清理失败 [account=%s]", name)
        return report

    def _resolve_env_path(self, acc: Account) -> Path:
        env_file = acc.env_file or f"./accounts/{acc.name}/env"
        p = Path(env_file)
        return p if p.is_absolute() else self.workspace_dir / p

    def get_account_env(self, name: str) -> dict[str, str]:
        """读取账号 env 文件，返回变量字典（原始值，由调用方决定是否脱敏）。"""
        acc = next((a for a in self.get_accounts() if a.name == name), None)
        if acc is None:
            raise ValueError(f"账号 '{name}' 不存在")
        env_path = self._resolve_env_path(acc)
        if not env_path.exists():
            return {}
        result: dict[str, str] = {}
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            result[k.strip()] = v.strip()
        return result

    def set_account_env(self, name: str, vars: dict[str, str]) -> None:
        """合并写入 env 文件；value 为空字符串表示删除该变量。"""
        acc = next((a for a in self.get_accounts() if a.name == name), None)
        if acc is None:
            raise ValueError(f"账号 '{name}' 不存在")
        env_path = self._resolve_env_path(acc)
        env_path.parent.mkdir(parents=True, exist_ok=True)
        existing: dict[str, str] = {}
        if env_path.exists():
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                existing[k.strip()] = v.strip()
        for k, v in vars.items():
            if v == "":
                existing.pop(k, None)
            else:
                existing[k] = v
        env_path.write_text("".join(f"{k}={v}\n" for k, v in existing.items()), encoding="utf-8")
        try:
            env_path.chmod(0o600)
        except OSError:
            pass

    def _project_env_path(self, name: str) -> Path:
        return self.workspace_dir / "projects" / name / "env"

    def get_project_env(self, name: str) -> dict[str, str]:
        """读取项目 env 文件，返回变量字典。"""
        if not any(p.name == name for p in self.get_projects()):
            raise ValueError(f"项目 '{name}' 不存在")
        env_path = self._project_env_path(name)
        if not env_path.exists():
            return {}
        result: dict[str, str] = {}
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            result[k.strip()] = v.strip()
        return result

    def set_project_env(self, name: str, vars: dict[str, str]) -> None:
        """合并写入项目 env 文件；value 为空字符串表示删除该变量。"""
        if not any(p.name == name for p in self.get_projects()):
            raise ValueError(f"项目 '{name}' 不存在")
        env_path = self._project_env_path(name)
        env_path.parent.mkdir(parents=True, exist_ok=True)
        existing: dict[str, str] = {}
        if env_path.exists():
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                existing[k.strip()] = v.strip()
        for k, v in vars.items():
            if v == "":
                existing.pop(k, None)
            else:
                existing[k] = v
        env_path.write_text("".join(f"{k}={v}\n" for k, v in existing.items()), encoding="utf-8")
        try:
            env_path.chmod(0o600)
        except OSError:
            pass

    def save_project(
        self,
        name: str,
        account: str,
        path: str,
        active: bool = True,
        ide_enabled: bool = False,
        ide_port: Optional[int] = None,
        ide_auth: str = "none",
        ide_remote: bool = False,
        image: str = "",
        docker_socket: str = "",
        secondary_accounts: Optional[list[str]] = None,
        extra_mounts: Optional[list[str]] = None,
    ) -> Project:
        """新增或修改 projects.conf 中的项目行。"""
        secondary_accounts = secondary_accounts or []
        extra_mounts = extra_mounts or []
        path_norm = str(Path(path).expanduser())
        if not ide_enabled:
            ide_port = None
            ide_auth = "none"
            ide_remote = False
        elif ide_port is None:
            used_ports = [
                p.ide_port
                for p in self.get_projects()
                if p.name != name
            ]
            ide_port = allocate_ide_port(used_ports)
        parts = [f"NAME={name}", f"ACCOUNT={account}", f"PATH={path_norm}"]
        if not active:
            parts.append("ACTIVE=off")
        if ide_enabled:
            parts.append("IDE=on")
            if ide_port is not None:
                parts.append(f"IDE_PORT={ide_port}")
            if ide_auth and ide_auth != "none":
                parts.append(f"IDE_AUTH={ide_auth}")
            if ide_remote:
                parts.append("IDE_REMOTE=on")
        if image:
            parts.append(f"IMAGE={image}")
        if docker_socket:
            parts.append(f"DOCKER_SOCKET={docker_socket}")
        if secondary_accounts:
            parts.append(f"SECONDARY_ACCOUNTS={','.join(secondary_accounts)}")
        if extra_mounts:
            parts.append(f"EXTRA_MOUNTS={','.join(extra_mounts)}")
        self._rewrite_conf(self.projects_conf, name, " ".join(parts))
        return Project(
            name=name,
            account=account,
            path=path_norm,
            active=active,
            ide_enabled=ide_enabled,
            ide_port=ide_port,
            ide_auth=ide_auth,
            ide_remote=ide_remote,
            image=image,
            docker_socket=docker_socket,
            secondary_accounts=secondary_accounts,
            extra_mounts=extra_mounts,
        )

    def delete_project(self, name: str) -> None:
        """从 projects.conf 删除项目行。"""
        self._rewrite_conf(self.projects_conf, name, None)

    def get_busy_accounts(self) -> set[str]:
        """返回当前有 running 任务的账号名集合"""
        busy = set()
        for task in Task.load_all(self.tasks_dir):
            if task.status == TaskStatus.running:
                busy.add(task.account)
        return busy

    def list_accounts(self) -> list[AccountResponse]:
        # Single pass: collect running tasks + done/failed counts per account
        running_tasks: dict[str, Task] = {}
        done_counts:   dict[str, int]  = {}
        failed_counts: dict[str, int]  = {}
        for task in Task.load_all(self.tasks_dir):
            if task.status == TaskStatus.running:
                if task.account not in running_tasks:
                    running_tasks[task.account] = task
            elif task.status == TaskStatus.done:
                done_counts[task.account] = done_counts.get(task.account, 0) + 1
            elif task.status == TaskStatus.failed:
                failed_counts[task.account] = failed_counts.get(task.account, 0) + 1
        busy = set(running_tasks.keys())

        result = []
        projects_by_account: dict[str, list[str]] = {}
        for project in self.get_projects():
            projects_by_account.setdefault(project.account, []).append(project.name)
        for acc in self.get_accounts():
            project_names = projects_by_account.get(acc.name, [])
            containers = []
            running = False
            if acc.runtime == AccountRuntime.local:
                # local 账号没有持久容器 —— "running" 退化为「当前是否有任务在跑」，
                # 不去查一个根本不存在的 docker 容器名。
                running = acc.name in busy
            else:
                for pn in project_names:
                    ctr = f"{acc.type.value}-{pn}"
                    containers.append(ctr)
                    if docker_mgr.is_container_running(ctr):
                        running = True
            rt = running_tasks.get(acc.name)
            result.append(AccountResponse(
                name      = acc.name,
                type      = acc.type,
                auth      = acc.auth,
                env_file  = acc.env_file,
                proxy     = acc.proxy,
                runtime   = acc.runtime,
                claude_backend = acc.claude_backend,
                projects  = project_names,
                running   = running,
                busy      = acc.name in busy,
                container = " ".join(containers),
                running_task_id     = rt.id     if rt else "",
                running_task_prompt = rt.prompt if rt else "",
                task_done_count     = done_counts.get(acc.name, 0),
                task_failed_count   = failed_counts.get(acc.name, 0),
                usage     = self._usage_cache.get(acc.name),
            ))
        return result

    # ── Claude Max / ChatGPT (Codex) 套餐用量 ─────────────────────

    _USAGE_PROBED_ACCOUNT_TYPES = (AccountType.claude, AccountType.codex)

    def account_dir(self, name: str) -> Path:
        return self.workspace_dir / "accounts" / name

    def _usage_eligible_accounts(self) -> list[Account]:
        """只有真正走 OAuth login 的 Claude / Codex 账号才有套餐用量可查。"""
        return [
            acc for acc in self.get_accounts()
            if acc.type in self._USAGE_PROBED_ACCOUNT_TYPES and acc.auth == AccountAuth.login
        ]

    def _usage_cache_path(self, name: str) -> Path:
        return self.account_dir(name) / "usage-cache.json"

    def _load_cached_usage(self) -> None:
        """server 重启后先用上一次落盘的结果垫底，避免刚启动时 UI 一片空白。"""
        for acc in self._usage_eligible_accounts():
            path = self._usage_cache_path(acc.name)
            if not path.exists():
                continue
            try:
                self._usage_cache[acc.name] = AccountUsage.model_validate_json(path.read_text())
            except (ValueError, OSError):
                pass

    def _running_container_for_account(self, name: str, acc_type: AccountType) -> Optional[str]:
        """探测必须从账号本身惯用的网络路径（容器 -> gost 代理）打出去，不能走宿主机裸连，
        否则同一账号的请求一会儿走代理一会儿裸连，容易被判定异常触发风控。
        这里找一个当下正在跑、挂载了这个账号凭据的容器。"""
        for project in self.get_projects():
            if project.account != name:
                continue
            container = project.container_name(acc_type)
            if docker_mgr.is_container_running(container):
                return container
        return None

    async def refresh_account_usage(self, name: str) -> AccountUsage:
        """立即探测一次指定账号的用量（供手动刷新 / CLI 调用）。"""
        acc = next((a for a in self.get_accounts() if a.name == name), None)
        if acc is None:
            raise ValueError(f"账号 '{name}' 不存在")
        if acc.type not in self._USAGE_PROBED_ACCOUNT_TYPES or acc.auth != AccountAuth.login:
            raise ValueError(f"账号 '{name}' 不是 OAuth 登录的 Claude/Codex 账号，没有套餐用量可查")

        container = self._running_container_for_account(name, acc.type)
        if container is None:
            usage = AccountUsage(fetched_at=usage_probe.now_iso(), error="no_running_container")
        elif acc.type == AccountType.codex:
            usage = await usage_probe.probe_codex_via_container_async(container)
        else:
            usage = await usage_probe.probe_via_container_async(container)
        self._usage_cache[name] = usage
        try:
            self._usage_cache_path(name).write_text(usage.model_dump_json())
        except OSError:
            pass
        return usage

    # Adaptive 探测间隔：以「账号是不是有任务在跑」为基准，而不是固定周期。
    _USAGE_DELAY_BUSY = 300.0    # 账号当前有任务在跑
    _USAGE_DELAY_IDLE = 3600.0   # 其他情况（包括从未跑过任务）
    _USAGE_POLL_TICK_SECONDS = 30.0  # 轮询循环本身的检查粒度（不是探测间隔）

    def _usage_adaptive_delay(self, name: str, busy: set[str]) -> float:
        return self._USAGE_DELAY_BUSY if name in busy else self._USAGE_DELAY_IDLE

    def start_usage_polling_loop(self, tick_seconds: float = _USAGE_POLL_TICK_SECONDS) -> None:
        if self._usage_loop_task is None or self._usage_loop_task.done():
            self._usage_loop_task = asyncio.create_task(
                self._usage_polling_loop(tick_seconds),
                name="scheduler-usage-poll-loop",
            )

    async def _usage_polling_loop(self, tick_seconds: float) -> None:
        while True:
            try:
                await self._poll_due_account_usage()
            except Exception:
                import traceback
                print("Error in usage polling loop:")
                traceback.print_exc()
            await asyncio.sleep(tick_seconds)

    async def _poll_due_account_usage(self) -> None:
        busy = self.get_busy_accounts()
        now = utc_now()
        for acc in self._usage_eligible_accounts():
            delay = self._usage_adaptive_delay(acc.name, busy)
            cached = self._usage_cache.get(acc.name)
            if cached and cached.fetched_at:
                try:
                    last_fetch = parse_iso(cached.fetched_at)
                    if (now - last_fetch).total_seconds() < delay:
                        continue
                except ValueError:
                    pass
            try:
                await self.refresh_account_usage(acc.name)
            except Exception:
                import traceback
                print(f"Error polling usage for account '{acc.name}':")
                traceback.print_exc()

    def list_projects(self) -> list[Project]:
        return self.get_projects()

    def find_idle_account(
        self,
        prefer_type:    Optional[AccountType] = None,
        prefer_project: Optional[str]         = None,
    ) -> Optional[Account]:
        """
        找一个满足条件的可用账号：
        - 类型匹配（可选）
        - 项目路径匹配（可选，规范化后比较）
        - 至少有一个项目容器在线
        同一账号可以并发执行多个任务（不同 conversation），不再过滤 busy 账号。
        """
        for acc in self.get_accounts():
            if prefer_type and acc.type != prefer_type:
                continue
            if prefer_project:
                project_match = self.find_project_for_path(prefer_project, acc.name)
                if not project_match:
                    continue
            account_projects = [p for p in self.get_projects() if p.account == acc.name]
            if not account_projects:
                continue
            any_running = any(
                docker_mgr.is_container_running(p.container_name(acc.type))
                for p in account_projects
            )
            if not any_running:
                continue
            return acc

        return None

    @staticmethod
    def _canonical_path(path: str) -> Path:
        return Path(path).expanduser().resolve()

    def _path_under_root(self, root: str, project: str) -> bool:
        account_root = self._canonical_path(root)
        project_path = self._canonical_path(project)
        try:
            project_path.relative_to(account_root)
        except ValueError:
            return False
        return True

    def account_can_access_project(self, acc: Account, project: str) -> bool:
        return any(
            p.account == acc.name and self._path_under_root(p.path, project)
            for p in self.get_projects()
        )

    def find_project_by_name(self, name: str) -> Optional[Project]:
        return next((p for p in self.get_projects() if p.name == name), None)

    def find_project_for_path(self, project: Optional[str], account: Optional[str] = None) -> Optional[Project]:
        if not project:
            return None
        matching = [
            p for p in self.get_projects()
            if self._path_under_root(p.path, project)
        ]
        if account:
            matching = [p for p in matching if p.account == account]
        if not matching:
            return None
        return max(matching, key=lambda p: len(str(self._canonical_path(p.path))))

    def resolve_task_project(self, acc: Account, project: Optional[str]) -> str:
        if not project:
            account_projects = [p for p in self.get_projects() if p.account == acc.name]
            if len(account_projects) == 1:
                return str(self._canonical_path(account_projects[0].path))
            if not account_projects:
                raise ValueError(f"账号 '{acc.name}' 未关联项目，请先创建项目")
            raise ValueError(f"账号 '{acc.name}' 关联了多个项目，请选择项目")
        if not self.account_can_access_project(acc, project):
            raise ValueError(f"项目 '{project}' 未关联账号 '{acc.name}'")
        return str(self._canonical_path(project))

    def container_workdir_for_project(self, owner: Project, project: str) -> str:
        account_root = self._canonical_path(owner.path)
        project_path = self._canonical_path(project)
        rel = project_path.relative_to(account_root)
        if str(rel) == ".":
            return "/workspace"
        return "/workspace/" + rel.as_posix()

    # ── 任务管理 ──────────────────────────────────────────

    @staticmethod
    def new_task_id() -> str:
        ts   = datetime.now().strftime("%Y%m%d%H%M%S")
        return f"{ts}-{uuid.uuid4().hex}"

    def list_tasks(self) -> list[Task]:
        return Task.load_all(self.tasks_dir)

    def conversation_queue_full(self, conversation_id: str) -> bool:
        """会话链排队任务是否已达 MAX_PENDING_PER_CONV（API 与 Telegram 入口共用）。"""
        pending_tasks = sum(
            1 for t in self.list_tasks()
            if t.conversation_id == conversation_id
            and t.status in (TaskStatus.pending, TaskStatus.scheduled)
        )
        future_continuations = sum(
            1 for c in self.list_continuations()
            if c.conversation_id == conversation_id
            and c.status in (ContinuationStatus.armed, ContinuationStatus.firing)
        )
        return pending_tasks + future_continuations >= MAX_PENDING_PER_CONV

    def get_task(self, task_id: str) -> Optional[Task]:
        path = self.tasks_dir / f"{task_id}.json"
        if not path.exists():
            return None
        return Task.load(path)

    def get_log_path(self, task_id: str) -> Path:
        return self.tasks_dir / f"{task_id}.log"

    def _auto_retry_settings(self) -> tuple[bool, int, float]:
        cfg = load_config(self.workspace_dir)
        enabled = truthy(cfg.get("TASK_AUTO_RETRY", "on"))
        try:
            max_retries = max(0, min(int(cfg.get("TASK_AUTO_RETRY_MAX", "2")), 10))
        except ValueError:
            max_retries = 2
        try:
            base_delay = max(0.0, min(float(cfg.get("TASK_AUTO_RETRY_DELAY_SECONDS", "2")), 300.0))
        except ValueError:
            base_delay = 2.0
        return enabled, max_retries, base_delay

    @staticmethod
    def is_retryable_failure(log_text: str) -> bool:
        """Return true only for a known transient failure before any tool side effect."""
        return bool(_TRANSIENT_FAILURE_RE.search(log_text)) and not bool(
            _SIDE_EFFECT_EVENT_RE.search(log_text)
        )

    async def clone_task_for_retry(self, original: Task, *, automatic: bool = False) -> Task:
        """Clone a terminal task through the normal submission path."""
        if original.platform_run_id:
            raise ValueError('请在平台助手中用新请求重试，平台任务不能作为普通项目任务重放')
        if original.sdk_action:
            raise ValueError('文件恢复操作不能自动重放，请检查结果后使用新的恢复请求')
        new_task = await self.submit(
            prompt=original.prompt,
            account_name=original.account,
            project_name=original.project_name or None,
            auto=getattr(original, "auto", False),
            conversation_id=original.conversation_id or None,
            images=list(getattr(original, "images", [])),
            model=getattr(original, "model", ""),
            sdk_options=original.sdk_options,
            pipeline_id=original.pipeline_id or None,
            parent_task_id=original.parent_task_id or None,
            depends_on=[],
            board_card_id=original.board_card_id or None,
            ephemeral=getattr(original, "ephemeral", False),
            execution_mode=getattr(original, "execution_mode", None),
            secrets=dict(getattr(original, "task_secrets", {})),
            output_dir=getattr(original, "output_dir", ""),
            ephemeral_retention=getattr(original, "ephemeral_retention", None),
            ephemeral_ttl_minutes=getattr(original, "ephemeral_ttl_minutes", None),
        )
        new_task.retry_of = original.id
        new_task.retry_count = original.retry_count + 1 if automatic else 0
        new_task.save(self.tasks_dir)
        original.retry_task_id = new_task.id
        original.save(self.tasks_dir)
        if original.pipeline_id:
            self.update_pipeline_node_task(original.pipeline_id, original.id, new_task.id)
        return new_task

    async def _maybe_auto_retry(self, task: Task, log_path: Path) -> Optional[Task]:
        if task.execution_backend == "sdk":
            return None  # A result-unknown SDK execution must never be replayed automatically.
        enabled, max_retries, base_delay = self._auto_retry_settings()
        if not enabled or task.retry_count >= max_retries:
            return None
        try:
            log_text = log_path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return None
        if not self.is_retryable_failure(log_text):
            return None

        delay = base_delay * (2 ** task.retry_count)
        with log_path.open("a", encoding="utf-8") as f:
            f.write(
                f"\n自动重试：检测到临时网关/网络故障，"
                f"{delay:g} 秒后进行第 {task.retry_count + 1}/{max_retries} 次重试。\n"
            )
        if delay:
            await asyncio.sleep(delay)
        try:
            return await self.clone_task_for_retry(task, automatic=True)
        except (ValueError, RuntimeError) as exc:
            with log_path.open("a", encoding="utf-8") as f:
                f.write(f"自动重试提交失败：{exc}\n")
            return None

    # ── 镜像构建管理 ──────────────────────────────────────

    def list_builds(self, project_name: Optional[str] = None, kind: Optional[str] = None) -> list[ImageBuild]:
        builds = ImageBuild.load_all(self.builds_dir)
        if project_name is not None:
            builds = [b for b in builds if b.project_name == project_name]
        if kind is not None:
            builds = [b for b in builds if b.kind == kind]
        return builds

    def get_build(self, build_id: str) -> Optional[ImageBuild]:
        path = self.builds_dir / f"{build_id}.json"
        if not path.exists():
            return None
        return ImageBuild.load(path)

    def get_build_log_path(self, build_id: str) -> Path:
        return self.builds_dir / f"{build_id}.log"

    # ── Conversation Continuation ─────────────────────────

    def new_continuation_id(self) -> str:
        return f"cont-{utc_now().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:4]}"

    def list_continuations(self) -> list[Continuation]:
        return Continuation.load_all(self.continuations_dir)

    def get_continuation(self, continuation_id: str) -> Optional[Continuation]:
        path = self.continuations_dir / f"{continuation_id}.json"
        return Continuation.load(path) if path.exists() else None

    @staticmethod
    def _new_idempotency_key(source_task_id: str, idempotency_key: Optional[str]) -> str:
        """`arm_continuation`/`create_agent_schedule` 共用的 key 派生规则：调用方传了就
        用调用方的（通常是 `f"{task_id}:{tool_use_id}"`），没传就现铸一个保证不撞的。"""
        return (idempotency_key or "").strip() or f"{source_task_id}:{uuid.uuid4().hex}"

    async def arm_continuation(
        self,
        source_task_id: str,
        prompt: str,
        triggers: list[ContinuationTriggerRequest],
        *,
        expires_in_seconds: Optional[int] = None,
        idempotency_key: Optional[str] = None,
    ) -> Continuation:
        source = self.get_task(source_task_id)
        if source is None:
            raise ValueError(f"任务 '{source_task_id}' 不存在")
        if not source.conversation_id:
            raise ValueError("当前任务不属于 Conversation，无法安排可恢复的后续任务")
        conversation = self.get_conversation(source.conversation_id)
        if conversation is None or conversation.status != ConversationStatus.active:
            raise ValueError("当前 Conversation 不存在或已归档")
        if not prompt.strip():
            raise ValueError("后续任务 prompt 不能为空")
        if not triggers:
            raise ValueError("至少需要一个触发条件")

        key = self._new_idempotency_key(source_task_id, idempotency_key)
        existing = next((c for c in self.list_continuations() if c.idempotency_key == key), None)
        if existing:
            return existing
        if self.conversation_queue_full(source.conversation_id):
            raise RuntimeError(
                f"该任务链已有 {MAX_PENDING_PER_CONV} 个待执行任务或后续动作，请等待完成后再提交"
            )

        now = utc_now()
        normalized: list[ContinuationTrigger] = []
        issued_tokens: dict[str, str] = {}
        for spec in triggers:
            if spec.type == ContinuationTriggerType.timer:
                if spec.delay_seconds is not None and spec.run_at:
                    raise ValueError("timer 的 delay_seconds 与 run_at 只能提供一个")
                if spec.delay_seconds is not None:
                    if not 10 <= spec.delay_seconds <= 30 * 24 * 3600:
                        raise ValueError("delay_seconds 必须在 10 秒到 30 天之间")
                    fire_at = now + timedelta(seconds=spec.delay_seconds)
                elif spec.run_at:
                    fire_at = parse_iso(spec.run_at)
                    if fire_at <= now:
                        raise ValueError("run_at 必须是未来时间")
                    if fire_at > now + timedelta(days=30):
                        raise ValueError("run_at 不能超过 30 天")
                else:
                    raise ValueError("timer 必须提供 delay_seconds 或 run_at")
                normalized.append(ContinuationTrigger(
                    type=spec.type, fire_at=fire_at.isoformat(timespec="seconds"),
                ))
            elif spec.type == ContinuationTriggerType.generic_webhook:
                token = secrets.token_urlsafe(32)
                trigger = ContinuationTrigger(
                    type=spec.type,
                    webhook_token_hash=hashlib.sha256(token.encode()).hexdigest(),
                )
                normalized.append(trigger)
                issued_tokens[trigger.id] = token
            elif spec.type == ContinuationTriggerType.github_pr_checks_completed:
                repository = spec.repository.strip().lower()
                head_sha = spec.head_sha.strip().lower()
                if "/" not in repository or not spec.pull_request or not head_sha:
                    raise ValueError("GitHub trigger 需要 repository、pull_request 和 head_sha")
                normalized.append(ContinuationTrigger(
                    type=spec.type,
                    repository=repository,
                    pull_request=spec.pull_request,
                    head_sha=head_sha,
                ))
            else:
                raise ValueError(f"尚未支持触发类型 '{spec.type.value}'")

        expires_at = None
        if expires_in_seconds is not None:
            if not 10 <= expires_in_seconds <= 30 * 24 * 3600:
                raise ValueError("expires_in_seconds 必须在 10 秒到 30 天之间")
            expires_at = (now + timedelta(seconds=expires_in_seconds)).isoformat(timespec="seconds")

        continuation = Continuation(
            id=self.new_continuation_id(),
            source_task_id=source.id,
            conversation_id=source.conversation_id,
            prompt=prompt.strip(),
            auto=getattr(source, "auto", False),
            model=getattr(source, "model", ""),
            triggers=normalized,
            expires_at=expires_at,
            idempotency_key=key,
        )
        continuation.save(self.continuations_dir)
        if issued_tokens:
            self._issued_webhook_tokens[continuation.id] = issued_tokens
        return continuation

    def take_issued_webhook_tokens(self, continuation_id: str) -> dict[str, str]:
        """取走创建时的一次性明文 token；后续无法从持久化 hash 反推。"""
        return self._issued_webhook_tokens.pop(continuation_id, {})

    async def signal_generic_webhook(self, token: str) -> Optional[Continuation]:
        digest = hashlib.sha256(token.encode()).hexdigest()
        for continuation in self.list_continuations():
            if continuation.status != ContinuationStatus.armed:
                continue
            trigger = next(
                (
                    t for t in continuation.triggers
                    if t.type == ContinuationTriggerType.generic_webhook
                    and t.status == "waiting"
                    and secrets.compare_digest(t.webhook_token_hash, digest)
                ),
                None,
            )
            if trigger:
                return await self.fire_continuation(continuation.id, trigger.id)
        return None

    async def signal_github_pr_checks(
        self,
        *,
        delivery_id: str,
        repository: str,
        pull_request: int,
        head_sha: str,
    ) -> list[Continuation]:
        delivery_store = JsonStore(WebhookDelivery, self.webhook_deliveries_dir)
        if delivery_store.exists(delivery_id):
            return []
        WebhookDelivery(id=delivery_id, provider="github").save(self.webhook_deliveries_dir)
        matches: list[tuple[str, str]] = []
        repository = repository.strip().lower()
        head_sha = head_sha.strip().lower()
        for continuation in self.list_continuations():
            if continuation.status != ContinuationStatus.armed:
                continue
            for trigger in continuation.triggers:
                if (
                    trigger.type == ContinuationTriggerType.github_pr_checks_completed
                    and trigger.status == "waiting"
                    and trigger.repository == repository
                    and trigger.pull_request == pull_request
                    and trigger.head_sha == head_sha
                ):
                    matches.append((continuation.id, trigger.id))
                    break
        return [
            await self.fire_continuation(continuation_id, trigger_id)
            for continuation_id, trigger_id in matches
        ]

    async def fire_continuation(self, continuation_id: str, fired_by: str) -> Continuation:
        async with self._continuation_lock:
            continuation = self.get_continuation(continuation_id)
            if continuation is None:
                raise ValueError(f"后续动作 '{continuation_id}' 不存在")
            if continuation.status == ContinuationStatus.fired:
                return continuation
            if continuation.status != ContinuationStatus.armed:
                raise RuntimeError(f"后续动作当前状态为 {continuation.status.value}，不能触发")

            continuation.status = ContinuationStatus.firing
            continuation.fired_by = fired_by
            continuation.updated_at = now_iso()
            continuation.save(self.continuations_dir)

            try:
                existing_task = next(
                    (t for t in self.list_tasks() if getattr(t, "continuation_id", "") == continuation.id),
                    None,
                )
                task = existing_task or await self.submit(
                    prompt=continuation.prompt,
                    conversation_id=continuation.conversation_id,
                    auto=continuation.auto,
                    model=continuation.model,
                    parent_task_id=continuation.source_task_id,
                    continuation_id=continuation.id,
                )
            except Exception as exc:
                continuation.status = ContinuationStatus.failed
                continuation.error = str(exc)
                continuation.updated_at = now_iso()
                continuation.save(self.continuations_dir)
                raise

            continuation.status = ContinuationStatus.fired
            continuation.result_task_id = task.id
            continuation.fired_at = now_iso()
            continuation.updated_at = continuation.fired_at
            for trigger in continuation.triggers:
                trigger.status = "fired" if trigger.id == fired_by else "cancelled"
            continuation.save(self.continuations_dir)
            return continuation

    def cancel_continuation(self, continuation_id: str) -> Optional[Continuation]:
        continuation = self.get_continuation(continuation_id)
        if continuation is None:
            return None
        if continuation.status in (ContinuationStatus.armed, ContinuationStatus.firing):
            continuation.status = ContinuationStatus.cancelled
            continuation.updated_at = now_iso()
            for trigger in continuation.triggers:
                if trigger.status == "waiting":
                    trigger.status = "cancelled"
            continuation.save(self.continuations_dir)
        return continuation

    async def process_due_continuations(self) -> None:
        now = utc_now()
        for continuation in self.list_continuations():
            if continuation.status == ContinuationStatus.firing:
                # Crash recovery: re-open the claim, then finish it through the same
                # path. fire_continuation deduplicates by Task.continuation_id, so
                # both "crashed before submit" and "crashed after submit" are safe.
                continuation.status = ContinuationStatus.armed
                continuation.save(self.continuations_dir)
                try:
                    await self.fire_continuation(
                        continuation.id, continuation.fired_by or "recovery",
                    )
                except Exception as exc:
                    logger.warning("Continuation 恢复失败 [%s]: %s", continuation.id, exc)
                continue
            if continuation.status != ContinuationStatus.armed:
                continue
            if continuation.expires_at and parse_iso(continuation.expires_at) <= now:
                continuation.status = ContinuationStatus.expired
                continuation.updated_at = now_iso()
                continuation.save(self.continuations_dir)
                continue
            due = next(
                (
                    trigger for trigger in continuation.triggers
                    if trigger.type == ContinuationTriggerType.timer
                    and trigger.status == "waiting"
                    and trigger.fire_at
                    and parse_iso(trigger.fire_at) <= now
                ),
                None,
            )
            if due:
                try:
                    await self.fire_continuation(continuation.id, due.id)
                except Exception as exc:
                    logger.warning("Continuation 触发失败 [%s]: %s", continuation.id, exc)

    # ── 定时计划管理 ──────────────────────────────────────

    def new_schedule_id(self) -> str:
        ts = datetime.now().strftime("%Y%m%d%H%M%S")
        return f"sched-{ts}-{uuid.uuid4().hex[:4]}"

    def list_schedules(self) -> list[Schedule]:
        return Schedule.load_all(self.schedules_dir)

    def get_schedule(self, sched_id: str) -> Optional[Schedule]:
        p = self.schedules_dir / f"{sched_id}.json"
        if not p.exists():
            return None
        return Schedule.load(p)

    def create_schedule(self, sched: Schedule) -> Schedule:
        sched.next_run_at = self._compute_next_run_at(sched)
        sched.save(self.schedules_dir)
        return sched

    def update_schedule(self, sched_id: str, updates: dict) -> Optional[Schedule]:
        sched = self.get_schedule(sched_id)
        if sched is None:
            return None
        for k, v in updates.items():
            if hasattr(sched, k):
                setattr(sched, k, v)
        sched.updated = now_iso()
        sched.next_run_at = self._compute_next_run_at(sched)
        sched.save(self.schedules_dir)
        return sched

    def delete_schedule(self, sched_id: str) -> bool:
        p = self.schedules_dir / f"{sched_id}.json"
        if not p.exists():
            return False
        p.unlink()
        return True

    async def create_agent_schedule(
        self,
        source_task_id: str,
        name: str,
        prompt: str,
        schedule_type: ScheduleType,
        *,
        time_of_day: Optional[str] = None,
        days_of_week: Optional[list[int]] = None,
        minute_of_hour: Optional[int] = None,
        cron_expr: Optional[str] = None,
        ephemeral_retention: str = "release_on_finish",
        ephemeral_ttl_minutes: int = 120,
        idempotency_key: Optional[str] = None,
    ) -> Schedule:
        """运行中的 agent 经 MCP `create_schedule` 自助建一个循环 Schedule。

        范围恒等于调用方自己的 project/account（从 source_task_id 派生，从不信任
        客户端传入值——跟 arm_continuation 是同一模式）；`created_by`/
        `created_by_conversation_id` 打标，供后续 mutate 的归属校验使用（见
        CONTEXT.md「Schedule 的创建者归属」、docs/adr/0001-agent-self-service-schedules.md）。
        不设人工确认闸、不设频率下限——这是权衡后的决定，不是遗漏。
        """
        source = self.get_task(source_task_id)
        if source is None:
            raise ValueError(f"任务 '{source_task_id}' 不存在")
        if not source.conversation_id:
            raise ValueError("当前任务不属于 Conversation，无法创建定时计划")
        if not prompt.strip():
            raise ValueError("定时计划 prompt 不能为空")

        key = self._new_idempotency_key(source_task_id, idempotency_key)
        existing = next((s for s in self.list_schedules() if s.idempotency_key == key), None)
        if existing:
            return existing

        sched = Schedule(
            id=self.new_schedule_id(),
            name=name,
            prompt=prompt,
            project_name=source.project_name,
            account=source.account,
            schedule_type=schedule_type,
            time_of_day=time_of_day,
            days_of_week=days_of_week or [],
            minute_of_hour=minute_of_hour,
            cron_expr=cron_expr,
            enabled=True,
            ephemeral_retention=ephemeral_retention,
            ephemeral_ttl_minutes=ephemeral_ttl_minutes,
            created_by="agent",
            created_by_conversation_id=source.conversation_id,
            idempotency_key=key,
        )
        return self.create_schedule(sched)

    @staticmethod
    def _redact_webhook_token_if_not_owner(sched: Schedule, conversation_id: str) -> Schedule:
        """`webhook_token` 是公开、无认证的 `/api/webhooks/{token}/trigger` 端点凭证——
        不是自己（当前 Conversation）创建的 Schedule，读的时候就把它抹掉，否则
        list/get 会变成绕过 `_require_agent_owned_schedule` 强制触发别人 Schedule
        的旁路（matt-code-review 发现的真实缺口，不是假设）。返回值是内存副本，
        不影响持久化记录。"""
        if sched.created_by == "agent" and sched.created_by_conversation_id == conversation_id:
            return sched
        return sched.model_copy(update={"webhook_token": ""})

    def list_schedules_for_task(self, source_task_id: str) -> list[Schedule]:
        """agent 经 MCP `list_schedules` 查询——项目内全部可见，不分创建者。"""
        source = self.get_task(source_task_id)
        if source is None:
            raise ValueError(f"任务 '{source_task_id}' 不存在")
        return [
            self._redact_webhook_token_if_not_owner(s, source.conversation_id)
            for s in self.list_schedules() if s.project_name == source.project_name
        ]

    def get_schedule_for_task(self, source_task_id: str, sched_id: str) -> Optional[Schedule]:
        """agent 经 MCP `get_schedule` 查询单条——同样按项目圈定，不分创建者。"""
        source = self.get_task(source_task_id)
        if source is None:
            raise ValueError(f"任务 '{source_task_id}' 不存在")
        sched = self.get_schedule(sched_id)
        if sched is None or sched.project_name != source.project_name:
            return None
        return self._redact_webhook_token_if_not_owner(sched, source.conversation_id)

    def _require_agent_owned_schedule(self, source_task_id: str, sched_id: str) -> Schedule:
        """update/cancel/toggle 共用的归属校验：只认创建它的那条 Conversation。

        人工建的（created_by=="human"）和别的 Conversation 建的都拒绝——
        跟改/删人工配置或别人会话的状态是同一类风险，不因为都是"agent 建的"
        就互相放行（见 CONTEXT.md「Schedule 的创建者归属」）。
        """
        source = self.get_task(source_task_id)
        if source is None:
            raise ValueError(f"任务 '{source_task_id}' 不存在")
        sched = self.get_schedule(sched_id)
        if sched is None:
            raise ValueError(f"定时计划 '{sched_id}' 不存在")
        if sched.created_by != "agent" or sched.created_by_conversation_id != source.conversation_id:
            raise ValueError(f"无权操作定时计划 '{sched_id}'：不是当前会话创建的")
        return sched

    def update_agent_schedule(self, source_task_id: str, sched_id: str, updates: dict) -> Schedule:
        self._require_agent_owned_schedule(source_task_id, sched_id)
        updated = self.update_schedule(sched_id, updates)
        assert updated is not None
        return updated

    def cancel_agent_schedule(self, source_task_id: str, sched_id: str) -> None:
        self._require_agent_owned_schedule(source_task_id, sched_id)
        self.delete_schedule(sched_id)

    def toggle_agent_schedule(self, source_task_id: str, sched_id: str) -> Schedule:
        sched = self._require_agent_owned_schedule(source_task_id, sched_id)
        updated = self.update_schedule(sched_id, {"enabled": not sched.enabled})
        assert updated is not None
        return updated

    def _compute_next_run_at(self, sched: Schedule) -> Optional[str]:
        if not sched.enabled:
            return None
        now = datetime.now()

        if sched.schedule_type == ScheduleType.daily:
            if not sched.time_of_day:
                return None
            h, m = map(int, sched.time_of_day.split(":"))
            candidate = now.replace(hour=h, minute=m, second=0, microsecond=0)
            if candidate <= now:
                candidate += timedelta(days=1)
            return candidate.isoformat(timespec="seconds")

        elif sched.schedule_type == ScheduleType.weekly:
            if not sched.time_of_day or not sched.days_of_week:
                return None
            h, m = map(int, sched.time_of_day.split(":"))
            for delta in range(7):
                candidate = (now + timedelta(days=delta)).replace(hour=h, minute=m, second=0, microsecond=0)
                if candidate > now and candidate.weekday() in sched.days_of_week:
                    return candidate.isoformat(timespec="seconds")
            return None

        elif sched.schedule_type == ScheduleType.hourly:
            minute = sched.minute_of_hour if sched.minute_of_hour is not None else 0
            candidate = now.replace(minute=minute, second=0, microsecond=0)
            if candidate <= now:
                candidate += timedelta(hours=1)
            return candidate.isoformat(timespec="seconds")

        elif sched.schedule_type == ScheduleType.cron:
            if not sched.cron_expr:
                return None
            try:
                from croniter import croniter
                it = croniter(sched.cron_expr, now)
                return it.get_next(datetime).isoformat(timespec="seconds")
            except Exception as e:
                print(f"[schedule {sched.id}] invalid cron_expr '{sched.cron_expr}': {e}")
                return None

        return None

    async def _check_and_trigger_schedules(self) -> None:
        now = datetime.now()
        for sched in self.list_schedules():
            if not sched.enabled:
                continue
            if not sched.next_run_at:
                sched.next_run_at = self._compute_next_run_at(sched)
                sched.save(self.schedules_dir)
                continue
            try:
                dt = datetime.fromisoformat(sched.next_run_at)
            except Exception:
                continue
            if now >= dt:
                await self._trigger_schedule(sched)

    async def _trigger_schedule(self, sched: Schedule) -> None:
        try:
            run_type, run_obj = await self._run_schedule_target(sched)
            sched.last_run_at = now_iso()
            sched.last_run_type = run_type
            if run_type == "workflow":
                sched.last_workflow_run_id = run_obj.id
                sched.last_task_id = ""
            else:
                sched.last_task_id = run_obj.id
                sched.last_workflow_run_id = ""
            sched.next_run_at = self._compute_next_run_at(sched)
            sched.updated = now_iso()
            sched.save(self.schedules_dir)
        except Exception as e:
            import traceback
            print(f"Error triggering schedule {sched.id}: {e}")
            traceback.print_exc()

    async def _run_schedule_target(self, sched: Schedule) -> tuple[str, object]:
        target_type = (getattr(sched, "target_type", "task") or "task").strip()
        if target_type == "workflow":
            if not getattr(sched, "template_id", ""):
                raise ValueError(f"定时计划 '{sched.name}' 未配置工作流模板")
            pipeline = await self.run_template(
                template_id=getattr(sched, "template_id", ""),
                input_str=getattr(sched, "workflow_input", "") or getattr(sched, "prompt", ""),
                project_map=dict(getattr(sched, "project_map", {}) or {}),
                default_project=getattr(sched, "default_project", ""),
                default_account=getattr(sched, "default_account", "") or (getattr(sched, "account", "") or ""),
                workspace_policy=getattr(sched, "workspace_policy", "isolated"),
            )
            return "workflow", pipeline

        retention = self._normalize_ephemeral_retention(getattr(sched, "ephemeral_retention", "release_on_finish"))
        conversation_name = f"schedule:{sched.id}"
        conversation_id = ""
        if retention != "release_on_finish":
            existing = next(
                (
                    c for c in self.list_conversations(include_archived=True)
                    if getattr(c, "ephemeral", False) and c.name == conversation_name
                ),
                None,
            )
            conversation_id = existing.id if existing else ""
        task = await self.submit(
            prompt=sched.prompt,
            project_name=sched.project_name,
            auto=sched.auto,
            account_name=sched.account,
            execution_mode=getattr(sched, "execution_mode", "inherit"),
            output_dir=getattr(sched, "output_dir", ""),
            conversation_id=conversation_id or None,
            conversation_name=conversation_name if retention != "release_on_finish" and not conversation_id else None,
            ephemeral_retention=retention,
            ephemeral_ttl_minutes=getattr(sched, "ephemeral_ttl_minutes", 120),
        )
        return "task", task

    @staticmethod
    def new_conversation_id() -> str:
        ts   = datetime.now().strftime("%Y%m%d%H%M%S")
        return f"conv-{ts}-{uuid.uuid4().hex}"

    @staticmethod
    def new_board_id() -> str:
        ts   = datetime.now().strftime("%Y%m%d%H%M%S")
        rand = random.randint(0, 9999)
        return f"board-{ts}-{rand:04d}"

    @staticmethod
    def new_board_card_id() -> str:
        ts   = datetime.now().strftime("%Y%m%d%H%M%S")
        rand = random.randint(0, 9999)
        return f"card-{ts}-{rand:04d}"

    def list_boards(self) -> list[Board]:
        return Board.load_all(self.boards_dir)

    def get_board(self, board_id: str) -> Optional[Board]:
        path = self.boards_dir / f"{board_id}.json"
        if not path.exists():
            return None
        return Board.load(path)

    def create_board(self, name: str) -> Board:
        board = Board(
            id=self.new_board_id(),
            name=name.strip() or "开发看板",
        )
        board.save(self.boards_dir)
        return board

    def update_board(self, board_id: str, name: Optional[str] = None) -> Board:
        board = self.get_board(board_id)
        if board is None:
            raise ValueError(f"看板 '{board_id}' 不存在")
        if name is not None:
            board.name = name.strip() or board.name
        board.touch(self.boards_dir)
        return board

    def delete_board(self, board_id: str) -> None:
        board_path = self.boards_dir / f"{board_id}.json"
        if not board_path.exists():
            raise ValueError(f"看板 '{board_id}' 不存在")
        board_path.unlink()
        for card in self.list_board_cards(board_id=board_id, include_archived=True):
            self.delete_board_card(card.id)

    def _migrate_board_cards_single_ref(self) -> None:
        """
        一次性迁移（幂等）：把 legacy 卡片的 task_ids 反向写入任务的 board_card_id，
        并将卡片收敛为单一执行单元引用（pipeline_id XOR conversation_id）。迁移后
        重写卡片文件以去除 task_ids。
        """
        if self._board_migration_done:
            return
        self._board_migration_done = True
        if not self.board_cards_dir.exists():
            return
        import json as _json
        for path in self.board_cards_dir.glob("*.json"):
            try:
                raw = _json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            legacy_task_ids = raw.get("task_ids") or []
            card_id = raw.get("id") or ""
            has_both = bool(raw.get("pipeline_id")) and bool(raw.get("conversation_id"))
            if not legacy_task_ids and not has_both:
                continue  # 已是新结构，无需迁移
            # 1) 反向指针：确保关联任务记录其归属卡片
            for tid in legacy_task_ids:
                task = self.get_task(tid)
                if task is not None and getattr(task, "board_card_id", "") != card_id:
                    task.board_card_id = card_id
                    task.save(self.tasks_dir)
            # 2) 收敛为单一引用（工作流优先），并重写文件去除 task_ids
            card = BoardCard.load(path)
            if card.pipeline_id and card.conversation_id:
                card.conversation_id = ""
            card.save(self.board_cards_dir)

    def list_board_cards(self, board_id: str = "", include_archived: bool = False) -> list[BoardCard]:
        self._migrate_board_cards_single_ref()
        cards = BoardCard.load_all(self.board_cards_dir)
        self._reconcile_board_cards_from_tasks(cards)
        if board_id:
            cards = [c for c in cards if c.board_id == board_id]
        if not include_archived:
            cards = [c for c in cards if not c.archived]
        return cards

    def _reconcile_board_cards_from_tasks(self, cards: list[BoardCard]) -> None:
        if not cards:
            return
        cards_by_id = {c.id: c for c in cards}
        for task in Task.load_all(self.tasks_dir):
            card_id = getattr(task, "board_card_id", "")
            if not card_id or card_id not in cards_by_id:
                continue
            self._sync_board_card_for_task(task, cards_by_id[card_id])

    def get_board_card(self, card_id: str) -> Optional[BoardCard]:
        path = self.board_cards_dir / f"{card_id}.json"
        if not path.exists():
            return None
        return BoardCard.load(path)

    def create_board_card(
        self,
        board_id: str,
        title: str,
        description: str = "",
        project_name: str = "",
        status: BoardCardStatus = BoardCardStatus.planned,
        priority: str = "normal",
    ) -> BoardCard:
        if self.get_board(board_id) is None:
            raise ValueError(f"看板 '{board_id}' 不存在")
        card = BoardCard(
            id=self.new_board_card_id(),
            board_id=board_id,
            title=title.strip() or "未命名专题",
            description=description.strip(),
            project_name=project_name.strip(),
            status=status,
            priority=priority.strip() or "normal",
        )
        card.save(self.board_cards_dir)
        return card

    def update_board_card(
        self,
        card_id: str,
        title: Optional[str] = None,
        description: Optional[str] = None,
        project_name: Optional[str] = None,
        status: Optional[BoardCardStatus] = None,
        priority: Optional[str] = None,
        conversation_id: Optional[str] = None,
        pipeline_id: Optional[str] = None,
        archived: Optional[bool] = None,
    ) -> BoardCard:
        card = self.get_board_card(card_id)
        if card is None:
            raise ValueError(f"看板卡片 '{card_id}' 不存在")
        if title is not None:
            card.title = title.strip() or card.title
        if description is not None:
            card.description = description.strip()
        if project_name is not None:
            card.project_name = project_name.strip()
        if status is not None:
            card.status = status
        if priority is not None:
            card.priority = priority.strip() or card.priority
        # 单一引用互斥：设置其一（非空）会清除另一个
        if conversation_id is not None:
            card.conversation_id = conversation_id.strip()
            if card.conversation_id:
                card.pipeline_id = ""
        if pipeline_id is not None:
            card.pipeline_id = pipeline_id.strip()
            if card.pipeline_id:
                card.conversation_id = ""
        if archived is not None:
            card.archived = archived
        card.touch(self.board_cards_dir)
        return card

    def delete_board_card(self, card_id: str) -> None:
        path = self.board_cards_dir / f"{card_id}.json"
        if not path.exists():
            raise ValueError(f"看板卡片 '{card_id}' 不存在")
        path.unlink()

    def add_task_to_board_card(self, card_id: str, task_id: str) -> BoardCard:
        card = self.get_board_card(card_id)
        if card is None:
            raise ValueError(f"看板卡片 '{card_id}' 不存在")
        task = self.get_task(task_id)
        if task is not None:
            # 反向指针：任务记录其归属卡片，用于反查（卡片不再直接持有 task_ids）
            if getattr(task, "board_card_id", "") != card_id:
                task.board_card_id = card_id
                task.save(self.tasks_dir)
            return self._sync_board_card_for_task(task, card)
        card.touch(self.board_cards_dir)
        return card

    @staticmethod
    def _establish_card_ref(card: BoardCard, task: Task) -> bool:
        """
        为卡片建立/校正「单一执行单元引用」：工作流运行(pipeline_id) 优先于会话(conversation_id)，
        二者互斥。仅在卡片尚无引用时建立。返回是否发生变更。
        """
        if card.pipeline_id or card.conversation_id:
            return False
        if task.pipeline_id:
            card.pipeline_id = task.pipeline_id
            return True
        if task.conversation_id:
            card.conversation_id = task.conversation_id
            return True
        return False

    def tasks_for_board_card(self, card: BoardCard) -> list[Task]:
        """
        反查卡片关联的任务：board_card_id 反向指针，或所指执行单元
        （pipeline_id / conversation_id）下的任务。按创建时间排序、去重。
        """
        out: list[Task] = []
        seen: set[str] = set()
        for t in Task.load_all(self.tasks_dir):
            match = (
                getattr(t, "board_card_id", "") == card.id
                or (card.pipeline_id and t.pipeline_id == card.pipeline_id)
                or (card.conversation_id and t.conversation_id == card.conversation_id)
            )
            if match and t.id not in seen:
                seen.add(t.id)
                out.append(t)
        out.sort(key=lambda t: parse_iso(t.created) if t.created else utc_now())
        return out

    def task_ids_for_board_card(self, card: BoardCard) -> list[str]:
        return [t.id for t in self.tasks_for_board_card(card)]

    def _sync_board_card_for_task(self, task: Task, card: Optional[BoardCard] = None) -> Optional[BoardCard]:
        card_id = getattr(task, "board_card_id", "")
        if not card_id and card is None:
            return None
        card = card or self.get_board_card(card_id)
        if card is None:
            return None

        changed = False
        # 建立卡片的单一执行单元引用（工作流优先于会话），任务本身通过 board_card_id 反查
        if self._establish_card_ref(card, task):
            changed = True
        if task.project_name and not card.project_name:
            card.project_name = task.project_name
            changed = True

        if task.status in (TaskStatus.pending, TaskStatus.scheduled) and card.status == BoardCardStatus.planned:
            card.status = BoardCardStatus.todo
            changed = True
        elif task.status == TaskStatus.running and card.status in (
            BoardCardStatus.planned, BoardCardStatus.todo, BoardCardStatus.blocked
        ):
            # blocked → running：重试的新任务开始运行时自动恢复
            card.status = BoardCardStatus.running
            changed = True
        elif task.status == TaskStatus.done and card.status == BoardCardStatus.running:
            card.status = BoardCardStatus.review
            changed = True
        elif task.status in (TaskStatus.failed, TaskStatus.killed) and card.status in (
            BoardCardStatus.planned, BoardCardStatus.todo, BoardCardStatus.running
        ):
            # 关联任务失败/终止：卡片进入 blocked，等待人工重试或放行
            card.status = BoardCardStatus.blocked
            changed = True

        if changed:
            card.touch(self.board_cards_dir)
        return card

    def list_conversations(self, include_archived: bool = False) -> list[Conversation]:
        convs = Conversation.load_all(self.conversations_dir)
        if not include_archived:
            convs = [c for c in convs if c.status != ConversationStatus.archived]
        return convs

    def archive_conversation(self, conversation_id: str, status: ConversationStatus) -> Conversation:
        return self.titles.set_status(conversation_id, status)

    def rename_conversation(self, conversation_id: str, name: str) -> Conversation:
        if not name.strip() or len(name.strip()) > 200:
            raise ValueError("会话名称不能为空或超过200字")
        def change(conv: Conversation) -> None:
            conv.name = name.strip()
            conv.title.source = "manual"
            conv.title.status = "ready"
            conv.title.revision += 1
            conv.title.error = conv.title.retry_at = ""
        return Conversation.mutate(self.conversations_dir, conversation_id, change)

    def delete_conversation(self, conversation_id: str) -> None:
        path = self.conversations_dir / f"{conversation_id}.json"
        if not path.exists():
            raise ValueError(f"任务链 '{conversation_id}' 不存在")
        conversation = self.get_conversation(conversation_id)
        if conversation and getattr(conversation, "ephemeral_container_name", ""):
            self.close_ephemeral_conversation(conversation_id)
        with Conversation.lock(self.conversations_dir, conversation_id):
            path.unlink(missing_ok=True)

    def get_conversation(self, conversation_id: str) -> Optional[Conversation]:
        path = self.conversations_dir / f"{conversation_id}.json"
        if not path.exists():
            return None
        return Conversation.load(path)

    def ensure_conversation_available(self, conversation: Conversation) -> None:
        for task in Task.load_all(self.tasks_dir):
            if task.conversation_id == conversation.id and self._task_is_active(task):
                raise RuntimeError(f"任务链 '{conversation.name}' 正在运行，请等待当前任务结束")

    def _task_is_active(self, task: Task) -> bool:
        watcher = self._running.get(task.id)
        return task.status == TaskStatus.running or bool(watcher and not watcher.done())

    def update_conversation_native_session(
        self,
        conversation_id: str,
        native_session_id: str,
        task_id: str,
    ) -> None:
        conversation = self.get_conversation(conversation_id)
        if conversation is None:
            return
        if conversation.fork and native_session_id != conversation.fork.target_session_id:
            raise ValueError("分叉返回了非目标会话 ID（可能为来源会话 ID），拒绝继续写入")
        conversation.touch(
            self.conversations_dir,
            native_session_id=native_session_id,
            last_task_id=task_id,
        )

    def _create_conversation(self, name: str, acc: Account, project: Project, task_project: str) -> Conversation:
        conversation = Conversation(
            id      = self.new_conversation_id(),
            name    = name,
            account = acc.name,
            type    = acc.type,
            project = task_project,
            project_name = project.name,
        )
        conversation.save(self.conversations_dir)
        return conversation

    @staticmethod
    def _validate_future_execute_at(execute_at: Optional[str]) -> Optional[str]:
        if not execute_at:
            return None
        try:
            dt = datetime.fromisoformat(execute_at)
        except ValueError as err:
            raise RuntimeError("定时时间格式无效，请选择有效的未来时间") from err
        if dt.tzinfo is not None:
            dt = dt.astimezone().replace(tzinfo=None)
        if dt <= datetime.now():
            raise RuntimeError("定时时间必须晚于当前时间")
        return dt.isoformat()

    # ── 提交任务 ──────────────────────────────────────────

    # ── 定时与排队调度 ────────────────────────────────────────

    def start_scheduling_loop(self) -> None:
        if self._loop_task is None or self._loop_task.done():
            self._loop_task = asyncio.create_task(
                self._schedule_pending_tasks_loop(),
                name="scheduler-pending-loop",
            )

    async def _schedule_pending_tasks_loop(self) -> None:
        while True:
            try:
                await self.process_due_continuations()
                await self._check_and_trigger_schedules()
                await self.schedule_next_tasks()
                await self._check_auto_digest()
                await self._cleanup_expired_ephemeral_sessions()
                self.titles.tick()
            except Exception as e:
                import traceback
                print("Error in schedule_next_tasks:")
                traceback.print_exc()
            await asyncio.sleep(1.0)

    async def _check_auto_digest(self) -> None:
        """Optional timezone-aware reports use the same isolated platform harness."""
        from coderfleet.server.platform_agent import PlatformHarness
        await PlatformHarness(self).tick()

    async def schedule_next_tasks(self) -> None:
        now = datetime.now()

        # 1. 扫描并触发已到时间的定时任务 (scheduled -> pending)
        all_tasks = Task.load_all(self.tasks_dir)
        for t in all_tasks:
            if t.status == TaskStatus.scheduled and t.execute_at:
                try:
                    dt = datetime.fromisoformat(t.execute_at)
                    if now >= dt:
                        t.update_status(TaskStatus.pending, self.tasks_dir)
                except Exception as e:
                    t.update_status(TaskStatus.failed, self.tasks_dir)
                    self._write_failed_log(t, f"定时时间解析失败：{e}")

        # 2. 扫描并运行 pending 任务
        all_pending = Task.load_all(self.tasks_dir)
        task_map = {t.id: t for t in all_pending}
        pending_tasks = [t for t in all_pending if t.status == TaskStatus.pending]
        if not pending_tasks:
            return

        # 按照创建时间升序排列，先进先出
        pending_tasks.sort(key=lambda t: parse_iso(t.created) if t.created else utc_now())

        # conversation 级串行约束：同一 conversation 同时只能有一个任务在跑
        busy_conv_ids = {
            t.conversation_id for t in all_pending
            if self._task_is_active(t) and t.conversation_id
        }
        # 本轮已派发的 conversation，防止同一轮调度把同一 conversation 的多个 pending 同时拉起
        in_flight_conv_ids: set[str] = set()

        for task in pending_tasks:
            # ── depends_on 检查 ──────────────────────────────
            if task.depends_on:
                deps = [task_map.get(dep_id) for dep_id in task.depends_on]
                # 任意前置任务失败/终止 → 级联失败
                if any(d is None or d.status in (TaskStatus.failed, TaskStatus.killed) for d in deps):
                    task.update_status(TaskStatus.failed, self.tasks_dir)
                    self._write_failed_log(task, "前置任务失败或不存在，级联失败")
                    continue
                # 前置任务尚未全部完成 → 继续等待
                if not all(d.status == TaskStatus.done for d in deps):
                    continue

            # 有 conversation 的任务：同一 conversation 内保持串行
            if task.conversation_id:
                if task.conversation_id in busy_conv_ids or task.conversation_id in in_flight_conv_ids:
                    continue
                in_flight_conv_ids.add(task.conversation_id)

            # 异步拉起执行该 pending 任务
            await self._start_pending_task(task)

    async def _start_pending_task(self, task: Task) -> None:
        try:
            # 派发前重新读取磁盘状态：调度循环基于本轮开始时的快照，
            # 如果任务在快照之后、真正派发之前被取消（如排队中被用户删除/终止），
            # 需要在这里跳过，避免把已取消的任务仍旧发给 CLI。
            fresh = self.get_task(task.id)
            if fresh is None or fresh.status != TaskStatus.pending:
                return
            task = fresh
            if self._sdk_workspace_busy(self._sdk_workspace_key(task)):
                return

            acc = next((a for a in self.get_accounts() if a.name == task.account), None)
            if acc is None:
                task.update_status(TaskStatus.failed, self.tasks_dir)
                self._write_failed_log(task, f"账号 '{task.account}' 不存在")
                return
            if task.execution_backend == "sdk" and task.execution_runtime:
                acc = acc.model_copy(update={"runtime": AccountRuntime(task.execution_runtime)})

            task_is_ephemeral = (
                getattr(task, "ephemeral", False)
                or getattr(task, "execution_mode", "persistent") == "ephemeral"
            )
            if task_is_ephemeral:
                conversation = self.get_conversation(task.conversation_id) if task.conversation_id else None
                project = self.find_project_by_name(task.project_name) if task.project_name else None
                session_dir: Optional[Path] = None
                if conversation:
                    if acc.runtime == AccountRuntime.local and not conversation.ephemeral:
                        session_dir = Path(task.project)
                    else:
                        session_dir = self._get_session_dir(conversation.id)

                task.ephemeral = True
                task.execution_mode = "ephemeral"
                task.update_status(TaskStatus.running, self.tasks_dir)
                self._sync_board_card_for_task(task)

                log_path = self.get_log_path(task.id)
                self._write_log_header(log_path, task, acc)

                bg = asyncio.create_task(
                    self._run_ephemeral_task(
                        task,
                        acc,
                        log_path,
                        getattr(task, "auto", False),
                        conversation,
                        session_dir,
                        getattr(task, "output_dir", ""),
                        dict(getattr(task, "task_secrets", {}) or {}),
                        getattr(task, "images", []),
                        project=project,
                    ),
                    name=f"task-{task.id}",
                )
                self._running[task.id] = bg
                return

            project = self.find_project_for_path(task.project, task.account)
            if project is None:
                task.update_status(TaskStatus.failed, self.tasks_dir)
                self._write_failed_log(task, f"项目路径 '{task.project}' 未配置")
                return

            container_name = project.container_name(acc.type)
            container_workdir = self.container_workdir_for_project(project, task.project)

            if not docker_mgr.is_container_running(container_name):
                task.update_status(TaskStatus.failed, self.tasks_dir)
                self._write_failed_log(task, f"容器 {container_name} 未运行")
                return

            # 加载对应的 conversation（如果有）
            conversation = self.get_conversation(task.conversation_id) if task.conversation_id else None

            # 转换为运行状态
            task.update_status(TaskStatus.running, self.tasks_dir)
            self._sync_board_card_for_task(task)

            # 写日志头
            log_path = self.get_log_path(task.id)
            self._write_log_header(log_path, task, acc, container_workdir, container_name)

            # 异步后台执行
            bg = asyncio.create_task(
                self._run(
                    task,
                    acc,
                    log_path,
                    getattr(task, "auto", False),
                    conversation,
                    container_workdir,
                    container_name,
                    getattr(task, "images", []),
                ),
                name=f"task-{task.id}",
            )
            self._running[task.id] = bg

        except Exception as e:
            task.update_status(TaskStatus.failed, self.tasks_dir)
            self._write_failed_log(task, f"拉起任务失败：{e}")

    def _write_failed_log(self, task: Task, reason: str) -> None:
        log_path = self.get_log_path(task.id)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("w", encoding="utf-8") as f:
            f.write("=== CoderFleet Task Log ===\n")
            f.write(f"id:      {task.id}\n")
            f.write(f"status:  failed\n")
            f.write(f"prompt:  {task.prompt}\n")
            f.write(f"error:   {reason}\n")
            f.write("=" * 38 + "\n\n")
            f.write(f"任务启动失败：{reason}\n")

    async def submit(
        self,
        prompt:         str,
        account_name:   Optional[str]         = None,
        prefer_project: Optional[str]         = None,
        prefer_type:    Optional[AccountType] = None,
        auto:           bool                  = False,
        conversation_id: Optional[str]         = None,
        conversation_name: Optional[str]       = None,
        conversation_auto_title: bool         = False,
        project_name:   Optional[str]         = None,
        images:         list[str]             = [],
        model:          str                   = "",
        execute_at:     Optional[str]         = None,
        parent_task_id: Optional[str]         = None,
        depends_on:     list[str]             = [],
        pipeline_id:    Optional[str]         = None,
        board_card_id:  Optional[str]         = None,
        ephemeral:      bool                  = False,
        execution_mode: Optional[str]         = None,
        secrets:        dict                  = {},
        output_dir:     str                   = "",
        ephemeral_retention: Optional[str]    = None,
        ephemeral_ttl_minutes: Optional[int]  = None,
        continuation_id: str                  = "",
        sdk_options: Optional[dict]           = None,
        sdk_action: Optional[dict]            = None,
        platform_run_id: str                 = "",
    ) -> Task:
        """
        提交任务，异步在后台执行，立即返回 Task 对象。
        调用方可以通过 task.id 跟踪进度。
        """
        from coderfleet.data.scripts.coderfleet_sdk_features import validate_options
        options = validate_options(sdk_options or {})
        if conversation_auto_title and not conversation_id and not conversation_name:
            conversation_name = prompt.strip()[:32] or "新会话"
        if platform_run_id:
            if not re.fullmatch(r'[a-f0-9]{32}',platform_run_id) or conversation_id or project_name or prefer_project:
                raise ValueError('无效的平台执行请求')
            ephemeral = True; execution_mode = 'ephemeral'; auto = False
        scheduled_execute_at = self._validate_future_execute_at(execute_at)
        selected_model = model.strip()
        is_pending = False
        conversation: Optional[Conversation] = None
        card_id = board_card_id or ""
        if card_id and self.get_board_card(card_id) is None:
            raise ValueError(f"看板卡片 '{card_id}' 不存在")

        if conversation_id:
            conversation = self.get_conversation(conversation_id)
            if conversation is None:
                raise ValueError(f"任务链 '{conversation_id}' 不存在")

            # 判断任务链是否有正在运行的任务
            has_running_in_conv = any(
                t.conversation_id == conversation.id and self._task_is_active(t)
                for t in Task.load_all(self.tasks_dir)
            )
            if has_running_in_conv:
                is_pending = True

            account_name = conversation.account
            prefer_type = conversation.type
            prefer_project = conversation.project
            project_name = conversation.project_name or project_name
            # Propagate ephemeral flag from conversation
            if conversation.ephemeral:
                ephemeral = True
                if not output_dir and conversation.output_dir:
                    output_dir = conversation.output_dir
                if ephemeral_retention is None:
                    ephemeral_retention = getattr(conversation, "ephemeral_retention", "release_on_finish")
                if ephemeral_ttl_minutes is None:
                    ephemeral_ttl_minutes = getattr(conversation, "ephemeral_ttl_minutes", 120)

        if sdk_options is None and conversation is not None:
            options = validate_options(conversation.sdk_options)
        if "permission_mode" in options:
            auto = options["permission_mode"] == "bypassPermissions"

        selected_project: Optional[Project] = None
        if project_name:
            selected_project = self.find_project_by_name(project_name)
            if selected_project is None:
                raise ValueError(f"项目 '{project_name}' 不存在")
            if account_name and account_name != selected_project.account:
                raise ValueError(
                    f"项目 '{project_name}' 关联账号为 {selected_project.account}，与指定账号 {account_name} 不一致"
                )
            account_name = selected_project.account
            prefer_project = selected_project.path

        mode = (execution_mode or "inherit").strip().lower()
        if mode not in ("inherit", "persistent", "ephemeral"):
            mode = "inherit"

        # 确定账号
        acc: Optional[Account] = None
        if account_name:
            acc = next((a for a in self.get_accounts() if a.name == account_name), None)
            if acc is None:
                raise ValueError(f"账号 '{account_name}' 不存在")
            if prefer_type and acc.type != prefer_type:
                raise ValueError(
                    f"账号 '{account_name}' 类型为 {acc.type.value}，与筛选类型 {prefer_type.value} 不一致"
                )
            # 账号级不再限制并发，同一账号的不同 conversation 可以同时跑
        else:
            acc = self.find_idle_account(
                prefer_type    = prefer_type,
                prefer_project = prefer_project,
            )
            if acc is None:
                hints = []
                if prefer_project:
                    hints.append(f"项目：{prefer_project}")
                if prefer_type:
                    hints.append(f"类型：{prefer_type.value}")
                hint_str = "，".join(hints)
                raise RuntimeError(
                    f"没有匹配的可用账号{('（' + hint_str + '）') if hint_str else ''}"
                )

        if options and (acc.type.value != 'claude' or acc.claude_backend != 'sdk'):
            raise ValueError('sdk_options requires a Claude SDK account')
        if platform_run_id and (acc.type != AccountType.claude or acc.claude_backend != 'sdk' or acc.runtime != AccountRuntime.container):
            raise ValueError('平台助手需要容器模式的Claude SDK账号')
        if options.get('permission_mode') in {'auto','bypassPermissions'}:
            gate = self.check_local_sandbox_gate(acc, True) or self.check_local_root_gate(acc, True)
            if gate: raise ValueError(gate)

        # ── Ephemeral 路径：跳过持久容器，直接 docker run --rm（或 LocalRuntime）──
        # 触发条件：显式传 ephemeral=True / execution_mode=ephemeral，
        # 或 execution_mode=inherit 且选中项目本身是 ephemeral 项目，
        # 或账号本身是 runtime=local —— local 账号根本没有"持久容器"这个概念
        # （没有 docker-compose 常驻服务可以 exec 进去），不管请求方传了什么
        # execution_mode，都必须走这条本地能力覆盖到的路径，否则会去 _run()
        # 尝试 exec 一个压根不存在的容器，报错也不直观。
        _is_ephemeral = (
            acc.runtime == AccountRuntime.local
            or ephemeral
            or mode == "ephemeral"
            or (mode == "inherit" and selected_project is not None and selected_project.ephemeral)
        )
        if not _is_ephemeral and project_name and selected_project is None:
            _proj = self.find_project_by_name(project_name)
            if _proj and _proj.ephemeral and mode == "inherit":
                _is_ephemeral = True
                selected_project = _proj

        if _is_ephemeral:
            retention = self._normalize_ephemeral_retention(ephemeral_retention)
            ttl_minutes = self._normalize_ephemeral_ttl(ephemeral_ttl_minutes)
            # _is_ephemeral only says "this task must run through the ephemeral *execution*
            # path" (no persistent container to exec into) — it does NOT mean the
            # *conversation* is semantically temporary/scratch. A `local` account bound to
            # an ordinary, non-ephemeral project is forced through this path purely because
            # it has no persistent container, but the user is having a completely normal,
            # ongoing conversation about their real project; it must not be labelled/treated
            # as an "⚡ 临时" ephemeral conversation in the UI, and must not have its working
            # directory swapped out for a throwaway scratch dir. `is_genuinely_ephemeral`
            # is the semantic question ("does the user actually want a disposable
            # workspace/container?"); `_is_ephemeral` above is the mechanical one ("does this
            # account even have a persistent-container option?") — keep them separate.
            is_genuinely_ephemeral = (
                ephemeral or mode == "ephemeral"
                or (selected_project is not None and selected_project.ephemeral)
            )
            if conversation and conversation.fork and is_genuinely_ephemeral:
                raise ValueError("分叉会话必须继续使用原持久项目，不能切换为临时工作区")
            # Resolve conversation. Retained ephemeral containers need a
            # conversation record so later turns can locate the same container.
            if conversation is None and (conversation_name or retention != "release_on_finish"):
                conv_id = self.new_conversation_id()
                proj_path = selected_project.path if selected_project else "ephemeral"
                proj_name = selected_project.name if selected_project else ""
                conversation = Conversation(
                    id           = conv_id,
                    name         = conversation_name or (prompt.strip()[:32] or conv_id),
                    account      = acc.name,
                    type         = acc.type,
                    project      = proj_path,
                    project_name = proj_name,
                    ephemeral    = is_genuinely_ephemeral,
                    output_dir   = output_dir,
                    ephemeral_retention = retention,
                    ephemeral_ttl_minutes = ttl_minutes,
                    ephemeral_expires_at = self._ephemeral_expires_at(ttl_minutes) if retention == "keep_until_ttl" else "",
                )
                conversation.save(self.conversations_dir)
                if conversation_auto_title:
                    self.titles.enable(conversation.id)
            elif conversation and is_genuinely_ephemeral and not conversation.ephemeral:
                # Existing conversation just detected as ephemeral — update its flag
                conversation.ephemeral = True
                conversation.ephemeral_retention = retention
                conversation.ephemeral_ttl_minutes = ttl_minutes
                conversation.ephemeral_expires_at = self._ephemeral_expires_at(ttl_minutes) if retention == "keep_until_ttl" else ""
                conversation.save(self.conversations_dir)
            elif conversation and conversation.ephemeral:
                conversation.ephemeral_retention = retention
                conversation.ephemeral_ttl_minutes = ttl_minutes
                if retention == "keep_until_ttl":
                    conversation.ephemeral_expires_at = self._ephemeral_expires_at(ttl_minutes)
                elif retention == "release_on_finish":
                    if getattr(conversation, "ephemeral_container_name", ""):
                        subprocess.run(
                            ["docker", "rm", "-f", conversation.ephemeral_container_name],
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                        )
                        conversation.ephemeral_container_name = ""
                    conversation.ephemeral_expires_at = ""
                conversation.save(self.conversations_dir)
            # else: existing non-ephemeral conversation on a `local` account bound to a
            # normal project — nothing about its ephemeral bookkeeping needs touching.

            # Carry output_dir from conversation if not overridden in this request
            if not output_dir and conversation and conversation.output_dir:
                output_dir = conversation.output_dir

            # local 账号被强制走这条路径（见上面 _is_ephemeral 的注释），但如果绑定的其实是
            # 一个正常、非 ephemeral 的项目，就不能用下面 _get_session_dir 那个空的临时
            # scratch 目录当工作区——模型会看到一个空目录，不是用户的真实项目文件。只有
            # "真的要一次性临时工作区"（is_genuinely_ephemeral）才用 scratch 目录；local 账号
            # 绑定普通项目时，直接用项目在宿主机上的真实路径（container 场景下这条路径本来
            # 就是靠 container_workdir_for_project 把它映射成容器内 /workspace/... 路径，
            # local 场景没有容器边界要跨，宿主机路径本身就是要 cd 进去的地方，不需要再映射）。
            session_dir: Optional[Path] = None
            if (
                acc.runtime == AccountRuntime.local
                and not is_genuinely_ephemeral
                and selected_project is not None
            ):
                session_dir = Path(self.resolve_task_project(acc, prefer_project))
            elif conversation:
                session_dir = self._get_session_dir(conversation.id)

            if sdk_action:
                origin = self.get_task(sdk_action['source_task_id'])
                if origin is None or origin.account != acc.name: raise ValueError('恢复来源 Task 不可用')
                session_dir = self._sdk_control_directory(origin).parent.parent
                if not session_dir.is_dir(): raise ValueError('来源工作区已释放，无法恢复文件')

            if platform_run_id:
                session_dir = self.workspace_dir / 'platform' / 'runs' / platform_run_id / 'workspace'
                session_dir.mkdir(parents=True,exist_ok=True)
            task_project = str(session_dir) if session_dir else "ephemeral"
            proj_name    = (selected_project.name if selected_project else
                            (conversation.project_name if conversation else ""))
            task_id      = self.new_task_id()
            dag_parent   = parent_task_id or ""
            dag_depends  = list(depends_on)
            dag_pipeline = pipeline_id or ""
            log_path     = self.get_log_path(task_id)

            status = TaskStatus.running
            if scheduled_execute_at:
                status = TaskStatus.scheduled
            elif is_pending:
                status = TaskStatus.pending

            task = Task(
                id           = task_id,
                status       = status,
                account      = acc.name,
                type         = acc.type,
                execution_backend = acc.claude_backend,
                sdk_options = options,
                sdk_action = dict(sdk_action or {}),
                platform_run_id = platform_run_id,
                execution_runtime = acc.runtime.value,
                prompt       = prompt,
                project      = task_project,
                project_name = proj_name,
                conversation_id    = conversation.id if conversation else "",
                native_session_id  = conversation.native_session_id if conversation else "",
                auto         = auto,
                images       = images,
                model        = selected_model,
                parent_task_id = dag_parent,
                depends_on     = dag_depends,
                pipeline_id    = dag_pipeline,
                board_card_id  = card_id,
                execute_at     = scheduled_execute_at,
                ephemeral      = True,
                execution_mode = "ephemeral",
                output_dir     = output_dir,
                ephemeral_retention = retention,
                ephemeral_ttl_minutes = ttl_minutes,
                ephemeral_container_name = getattr(conversation, "ephemeral_container_name", "") if conversation else "",
                task_secrets   = dict(secrets),
                continuation_id = continuation_id,
            )
            if platform_run_id:
                platform_record = self.workspace_dir / 'platform' / 'runs' / platform_run_id / 'run.json'
                if platform_record.exists() and json.loads(platform_record.read_text()).get('state') == 'cancelled':
                    raise ValueError('平台请求已取消，未启动 Task')
            self._assert_sdk_workspace_available(task)
            task.save(self.tasks_dir)
            if conversation:
                self._touch_submitted_conversation(conversation.id,task)
            if dag_pipeline:
                self._register_task_in_pipeline(task_id, dag_pipeline)
            if card_id:
                self.add_task_to_board_card(card_id, task_id)

            if task.status != TaskStatus.running:
                log_path.parent.mkdir(parents=True, exist_ok=True)
                log_path.write_text("", encoding="utf-8")
                if task.status == TaskStatus.pending:
                    asyncio.create_task(self.schedule_next_tasks())
                return task

            self._write_log_header(log_path, task, acc)
            bg = asyncio.create_task(
                self._run_ephemeral_task(
                    task, acc, log_path, auto, conversation,
                    session_dir, output_dir, dict(secrets), images,
                    project=selected_project,
                ),
                name=f"task-{task_id}",
            )
            self._running[task_id] = bg
            return task

        # ── 持久容器路径（原有逻辑） ──────────────────────────────
        task_project = self.resolve_task_project(acc, prefer_project)
        selected_project = selected_project or self.find_project_for_path(task_project, acc.name)
        if selected_project is None:
            raise ValueError(f"项目 '{task_project}' 未配置")
        container_name = selected_project.container_name(acc.type)
        container_workdir = self.container_workdir_for_project(selected_project, task_project)

        if not docker_mgr.is_container_running(container_name):
            raise RuntimeError(f"容器 {container_name} 未运行")

        if conversation is None and conversation_name:
            conversation = self._create_conversation(conversation_name, acc, selected_project, task_project)
            if conversation_auto_title:
                self.titles.enable(conversation.id)

        # 创建任务记录
        task_id  = self.new_task_id()

        # ── DAG 字段 ──
        dag_parent   = parent_task_id or ""
        dag_depends  = list(depends_on)
        dag_pipeline = pipeline_id or ""

        # ── 处理定时任务 ──
        if scheduled_execute_at:
            task = Task(
                id           = task_id,
                status       = TaskStatus.scheduled,
                account      = acc.name,
                type         = acc.type,
                execution_backend = acc.claude_backend,
                sdk_options = options,
                sdk_action = dict(sdk_action or {}),
                execution_runtime = acc.runtime.value,
                prompt       = prompt,
                project      = task_project,
                project_name = selected_project.name,
                conversation_id = conversation.id if conversation else "",
                native_session_id = conversation.native_session_id if conversation else "",
                auto         = auto,
                images       = images,
                model        = selected_model,
                execute_at   = scheduled_execute_at,
                parent_task_id = dag_parent,
                depends_on     = dag_depends,
                pipeline_id    = dag_pipeline,
                board_card_id  = card_id,
                execution_mode = "persistent",
                continuation_id = continuation_id,
            )
            self._assert_sdk_workspace_available(task)
            task.save(self.tasks_dir)
            if conversation:
                self._touch_submitted_conversation(conversation.id,task)
            if dag_pipeline:
                self._register_task_in_pipeline(task_id, dag_pipeline)
            if card_id:
                self.add_task_to_board_card(card_id, task_id)

            # 写入空日志文件防 SSE 404
            log_path = self.get_log_path(task_id)
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_path.write_text("", encoding="utf-8")

            return task

        # ── 处理排队任务 ──
        if is_pending:
            task = Task(
                id           = task_id,
                status       = TaskStatus.pending,
                account      = acc.name,
                type         = acc.type,
                execution_backend = acc.claude_backend,
                sdk_options = options,
                sdk_action = dict(sdk_action or {}),
                execution_runtime = acc.runtime.value,
                prompt       = prompt,
                project      = task_project,
                project_name = selected_project.name,
                conversation_id = conversation.id if conversation else "",
                native_session_id = conversation.native_session_id if conversation else "",
                auto         = auto,
                images       = images,
                model        = selected_model,
                parent_task_id = dag_parent,
                depends_on     = dag_depends,
                pipeline_id    = dag_pipeline,
                board_card_id  = card_id,
                execution_mode = "persistent",
                continuation_id = continuation_id,
            )
            self._assert_sdk_workspace_available(task)
            task.save(self.tasks_dir)
            if conversation:
                self._touch_submitted_conversation(conversation.id,task)
            if dag_pipeline:
                self._register_task_in_pipeline(task_id, dag_pipeline)
            if card_id:
                self.add_task_to_board_card(card_id, task_id)

            # 写入空日志文件防 SSE 404
            log_path = self.get_log_path(task_id)
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_path.write_text("", encoding="utf-8")

            # 立即触发一次调度检查
            asyncio.create_task(self.schedule_next_tasks())
            return task

        # ── 立即执行任务 ──
        log_path = self.get_log_path(task_id)
        task = Task(
            id           = task_id,
            status       = TaskStatus.running,
            account      = acc.name,
            type         = acc.type,
            execution_backend = acc.claude_backend,
                sdk_options = options,
                sdk_action = dict(sdk_action or {}),
            execution_runtime = acc.runtime.value,
            prompt       = prompt,
            project      = task_project,
            project_name = selected_project.name,
            conversation_id = conversation.id if conversation else "",
            native_session_id = conversation.native_session_id if conversation else "",
            auto         = auto,
            images       = images,
            model        = selected_model,
            parent_task_id = dag_parent,
            depends_on     = dag_depends,
            pipeline_id    = dag_pipeline,
            board_card_id  = card_id,
            execution_mode = "persistent",
            continuation_id = continuation_id,
        )
        self._assert_sdk_workspace_available(task)
        task.save(self.tasks_dir)
        if conversation:
            self._touch_submitted_conversation(conversation.id,task)
        if dag_pipeline:
            self._register_task_in_pipeline(task_id, dag_pipeline)
        if card_id:
            self.add_task_to_board_card(card_id, task_id)

        # 写日志头
        self._write_log_header(log_path, task, acc, container_workdir, container_name)

        # 异步后台执行
        bg = asyncio.create_task(
            self._run(task, acc, log_path, auto, conversation, container_workdir, container_name, images),
            name=f"task-{task_id}",
        )
        self._running[task_id] = bg

        return task

    # ── 从已有任务创建任务链 ──────────────────────────────

    def _claude_transcript(self, account_name: str, session_id: str) -> Path:
        # Validate before interpolating an identifier into a glob.
        uuid.UUID(session_id)
        account = next((a for a in self.get_accounts() if a.name == account_name), None)
        if account is None:
            raise ValueError("来源账号不存在")
        root = (self.local_auth_dir(account)
                if account.runtime == AccountRuntime.local
                else self.workspace_dir / "accounts" / account_name)
        paths = list((root / "projects").glob(f"*/{session_id}.jsonl"))
        if len(paths) != 1:
            raise ValueError("原生会话记录不存在或不唯一，无法安全恢复")
        return paths[0]

    def conversation_fork_point(self, conversation_id: str, task_id: str) -> dict:
        from coderfleet.server.conversation_forks import completed_turn_checkpoint, validate_source
        conversation = self.get_conversation(conversation_id)
        task = self.get_task(task_id)
        if conversation is None or task is None:
            raise ValueError("来源会话或任务不存在")
        validate_source(conversation, task)
        checkpoint = completed_turn_checkpoint(task, self.get_log_path(task_id))
        transcript = self._claude_transcript(task.account, task.native_session_id)
        found = False
        with transcript.open(encoding="utf-8") as stream:
            for line in stream:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if isinstance(entry, dict) and entry.get("uuid") == checkpoint:
                    found = True
                    break
        if not found:
            raise ValueError("消息 UUID 不在原生会话记录中，无法定位分叉点")
        return {"task_id": task.id, "message_uuid": checkpoint,
                "source_session_id": task.native_session_id}

    def fork_conversation(self, conversation_id: str, task_id: str, name: str = "") -> Conversation:
        point = self.conversation_fork_point(conversation_id, task_id)
        source = self.get_conversation(conversation_id)
        task = self.get_task(task_id)
        assert source is not None and task is not None
        own_tasks = sorted(
            (t for t in Task.load_all(self.tasks_dir) if t.conversation_id == source.id),
            key=lambda t: (parse_iso(t.finished or t.created), parse_iso(t.created), t.id),
        )
        inherited = list(source.fork.inherited_task_ids) if source.fork else []
        for item in own_tasks:
            if item.status not in (TaskStatus.done, TaskStatus.failed, TaskStatus.killed):
                continue
            inherited.append(item.id)
            if item.id == task_id:
                break
        child = Conversation(
            id=self.new_conversation_id(), name=name.strip() or f"{source.name} · 分叉",
            account=source.account, type=source.type, project=source.project,
            project_name=source.project_name,
            sdk_options=task.sdk_options,
            fork=ConversationFork(
                source_conversation_id=source.id, source_task_id=task_id,
                source_session_id=point["source_session_id"], message_uuid=point["message_uuid"],
                target_session_id=str(uuid.uuid4()), inherited_task_ids=inherited, model=task.model,
            ),
        )
        child.save(self.conversations_dir)
        return child

    def _conversation_for_launch(self, conversation: Optional[Conversation]) -> Optional[Conversation]:
        if conversation is None:
            return None
        current = self.get_conversation(conversation.id) or conversation
        if current.fork and not current.native_session_id:
            # A crash can happen after Claude creates the fork but before stdout is
            # captured. The predetermined ID lets us recover instead of forking twice.
            try:
                self._claude_transcript(current.account, current.fork.target_session_id)
            except ValueError:
                pass
            else:
                self.update_conversation_native_session(
                    current.id, current.fork.target_session_id, current.last_task_id,
                )
                current = self.get_conversation(current.id) or current
        return current

    def create_conversation_from_task(
        self,
        name: str,
        task_id: str,
    ) -> Conversation:
        """
        从已有任务（需有 native_session_id）创建任务链。
        之后可通过 conversation_id 续接该会话上下文。
        """
        task = self.get_task(task_id)
        if task is None:
            raise ValueError(f"任务 '{task_id}' 不存在")
        if not task.native_session_id:
            raise ValueError(
                f"任务 '{task_id}' 没有 native_session_id，"
                "可能是较早的任务（未开启流式 JSON 输出模式）"
            )
        acc = next((a for a in self.get_accounts() if a.name == task.account), None)
        if acc is None:
            raise ValueError(f"账号 '{task.account}' 不存在")
        project = self.find_project_for_path(task.project, task.account)
        if project is None:
            raise ValueError(f"项目路径 '{task.project}' 未配置")

        conversation = Conversation(
            id               = self.new_conversation_id(),
            name             = name,
            account          = acc.name,
            type             = acc.type,
            project          = task.project,
            project_name     = project.name,
            native_session_id = task.native_session_id,
            sdk_options = task.sdk_options,
            last_task_id     = task_id,
        )
        conversation.save(self.conversations_dir)
        return conversation

    def create_terminal_conversation(
        self,
        name: str,
        project_name: str,
    ) -> Conversation:
        """
        Create a Conversation with mode=terminal backed by a named tmux session.
        The tmux session is not started here — it is created lazily on first WS connect.
        """
        project = self.find_project_by_name(project_name)
        if project is None:
            raise ValueError(f"项目 '{project_name}' 不存在")
        acc = next((a for a in self.get_accounts() if a.name == project.account), None)
        if acc is None:
            raise ValueError(f"账号 '{project.account}' 不存在")
        if not docker_mgr.is_container_running(project.container_name(acc.type)):
            raise RuntimeError(f"容器 {project.container_name(acc.type)} 未运行")

        conv_id      = self.new_conversation_id()
        # Use last 8 chars of conv_id for a short, unique tmux session name
        tmux_session = f"cf-{conv_id[-9:]}"
        conversation = Conversation(
            id           = conv_id,
            name         = name.strip() or f"Terminal {datetime.now().strftime('%m/%d %H:%M')}",
            account      = acc.name,
            type         = acc.type,
            project      = project.path,
            project_name = project.name,
            mode         = ConversationMode.terminal,
            tmux_session = tmux_session,
        )
        conversation.save(self.conversations_dir)
        return conversation

    def get_terminal_log_path(self, project_root: Path, conv_id: str) -> Path:
        return project_root / ".coderfleet-terminals" / f"{conv_id}.log"

    def _write_log_header(self, log_path: Path, task: Task, acc: Account, container_workdir: str = "", container_name: str = "") -> None:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as f:
            f.write("=== CoderFleet Task Log ===\n")
            f.write(f"id:      {task.id}\n")
            f.write(f"account: {acc.name} ({acc.type.value})\n")
            f.write(f"project: {task.project}\n")
            if container_name:
                f.write(f"container: {container_name}\n")
            if container_workdir:
                f.write(f"container cwd: {container_workdir}\n")
            if task.conversation_id:
                f.write(f"conversation: {task.conversation_id}\n")
                if task.native_session_id:
                    f.write(f"native session: {task.native_session_id}\n")
            escaped_prompt = task.prompt.replace('\r\n', '\\n').replace('\n', '\\n') if task.prompt else ""
            f.write(f"prompt:  {escaped_prompt}\n")
            f.write(f"started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write("=" * 38 + "\n\n")

    async def _stream_container_log(
        self,
        task: Task,
        acc: Account,
        log_path: Path,
        host_log: Path,
        host_exit: Path,
        conversation: Optional[Conversation] = None,
        start_offset: int = 0,
    ) -> int:
        """
        宿主机侧日志轮询：将容器写入 host_log 的新内容同步到 log_path，
        检测到 host_exit 文件出现后退出，返回 exit code。
        CancelledError 不在此处捕获，由调用方处理 kill 逻辑。
        """
        import aiofiles
        last_size = start_offset
        captured_session_id = ""
        container_name = self._get_task_container(task) or ""
        # 跨轮次缓冲还没见到换行符的尾巴——见下方 async with 内的说明。
        pending = b""
        liveness_tick = 0
        worker_dead_since: Optional[float] = None

        async with aiofiles.open(log_path, mode="a", encoding="utf-8") as f:
            async def _write_chunk(chunk: bytes) -> None:
                nonlocal captured_session_id
                if not chunk:
                    return
                text = chunk.decode("utf-8", errors="replace")
                await f.write(text)
                await f.flush()
                if task.execution_backend == "sdk":
                    self._record_sdk_progress(
                        task, text, source_offset=last_size - len(pending),
                        log_size=log_path.stat().st_size,
                    )
                if not captured_session_id:
                    sid = self.extract_native_session_id(acc.type, text)
                    if sid:
                        captured_session_id = sid
                        if task.execution_backend == "sdk":
                            current = self.get_task(task.id) or task
                            current.native_session_id = sid
                            current.save(self.tasks_dir)
                            task.native_session_id = sid
                            task.status = current.status
                            task.finished = current.finished
                        else:
                            task.native_session_id = sid
                            task.save(self.tasks_dir)
                        if conversation:
                            self.update_conversation_native_session(conversation.id, sid, task.id)

            while True:
                await asyncio.sleep(0.3)
                is_done = host_exit.exists()

                if host_log.exists():
                    cur_size = host_log.stat().st_size
                    if cur_size > last_size:
                        async with aiofiles.open(host_log, mode="rb") as hf:
                            await hf.seek(last_size)
                            new_bytes = await hf.read()
                        # read() 可能读到 stat 后追加的数据，游标按实际读取量推进。
                        last_size += len(new_bytes)
                        pending += new_bytes

                        # 每 0.3s 轮询一次 host_log 的字节增量，和容器进程实际把一行
                        # JSON 写完之间没有任何同步——轮询边界随时可能落在一行写到一半
                        # 的地方。之前这里不管三七二十一把读到的字节原样落盘，一行大的
                        # JSON（比如现在 tool_use_result 明显变大之后的 Edit/Grep 结果）
                        # 就可能被从中间截断，永久拆成 log_path 里两条不相关的"行"，
                        # 前端按行解析 JSON 时自然连不起来，只能整段退化成裸文本展示。
                        # split_complete_lines 只把落到完整换行处的部分交出来落盘，
                        # 不满一行的尾巴留在 pending 里，和下一轮新读到的字节拼起来
                        # 再判断——这样落盘的永远是完整行，也顺带避免了多字节 UTF-8
                        # 字符被从中间切开。
                        complete, pending = split_complete_lines(pending)
                        await _write_chunk(complete)

                if task.execution_backend == "sdk":
                    liveness_tick += 1
                    if is_done or liveness_tick % 10 == 0:
                        try:
                            alive = await self._control_sdk_task(task, "probe_worker")
                        except RuntimeError:
                            # A durable exit record is still evidence; an observation
                            # failure alone must never be treated as a dead worker.
                            logger.warning("SDK worker liveness unavailable [task=%s]", task.id)
                        else:
                            if alive:
                                worker_dead_since = None
                                is_done = False  # A live worker wins over stale exit data.
                            elif task.id not in self._sdk_launching:
                                # The shell publishes .exit after the worker exits.
                                # Allow that atomic publication before inferring a crash.
                                now = asyncio.get_running_loop().time()
                                if worker_dead_since is None:
                                    worker_dead_since = now
                                is_done = is_done or now - worker_dead_since >= 3

                if is_done:
                    if task.execution_backend == "sdk":
                        await self._drain_sdk_task(task)
                    # A probe can suspend while the worker publishes its final
                    # bytes. Drain once more after observing its termination.
                    if task.execution_backend == "sdk" and host_log.exists():
                        async with aiofiles.open(host_log, mode="rb") as hf:
                            await hf.seek(last_size)
                            remaining = await hf.read()
                        last_size += len(remaining)
                        pending += remaining
                    # 容器已退出：不管 pending 里还有没有换行符都强制落盘，
                    # 否则最后一行不以换行结尾的输出会永远留在内存里、从不落盘。
                    tail, pending = pending, b""
                    await _write_chunk(tail)
                    break

        rc = -1
        if host_exit.exists():
            try:
                rc = int(host_exit.read_text().strip())
            except (ValueError, OSError):
                rc = -1

        if task.execution_backend == "sdk" and conversation:
            conversation = self.get_conversation(conversation.id)

        if rc == 0:
            if conversation:
                if not conversation.native_session_id and captured_session_id:
                    self.update_conversation_native_session(conversation.id, captured_session_id, task.id)
                else:
                    conversation.touch(self.conversations_dir, last_task_id=task.id)
            if task.execution_backend == "sdk":
                task = self._finish_sdk_task(task, TaskStatus.done)
            else:
                task.update_status(TaskStatus.done, self.tasks_dir)
            self._sync_board_card_for_task(task)
            await self._append_usage_status(log_path, acc, container_name)
            self._append_log_footer(log_path, task.status.value if task.execution_backend == "sdk" else "done")
        else:
            if conversation:
                conversation.touch(self.conversations_dir, last_task_id=task.id)
            if task.execution_backend == "sdk":
                target = TaskStatus.killed if rc in (-2, -15, 130, 143) else TaskStatus.failed
                task = self._finish_sdk_task(task, target)
            else:
                task.update_status(TaskStatus.failed, self.tasks_dir)
            self._sync_board_card_for_task(task)
            await self._append_usage_status(log_path, acc, container_name)
            label = task.status.value if task.execution_backend == "sdk" else "failed"
            self._append_log_footer(log_path, f"{label} (exit={rc})")

        self._extract_and_save_token_usage(task, log_path)
        retried = await self._maybe_auto_retry(task, log_path) if rc != 0 else None
        if retried is None:
            asyncio.create_task(self._notify(task))
        return rc

    # ── Ephemeral task helpers ────────────────────────────────

    def _get_session_dir(self, conversation_id: str) -> Path:
        """Return (and create) the session workspace dir for a conversation."""
        d = self.sessions_dir / conversation_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    @staticmethod
    def _normalize_ephemeral_retention(value: Optional[str]) -> str:
        retention = (value or "release_on_finish").strip()
        if retention not in {"release_on_finish", "keep_until_ttl", "keep_until_manual_close"}:
            return "release_on_finish"
        return retention

    @staticmethod
    def _normalize_ephemeral_ttl(value: Optional[int]) -> int:
        try:
            ttl = int(value or 120)
        except (TypeError, ValueError):
            ttl = 120
        return max(1, min(ttl, 24 * 60))

    @staticmethod
    def _ephemeral_expires_at(ttl_minutes: int) -> str:
        return (utc_now() + timedelta(minutes=ttl_minutes)).isoformat(timespec="seconds")

    def _docker_container_running(self, container_name: str) -> bool:
        if not container_name:
            return False
        try:
            return self.runtime.is_running(container_name)
        except Exception:
            return False

    def close_ephemeral_conversation(self, conversation_id: str) -> bool:
        conversation = self.get_conversation(conversation_id)
        if conversation is None or not getattr(conversation, "ephemeral", False):
            return False
        container_name = getattr(conversation, "ephemeral_container_name", "")
        if container_name:
            subprocess.run(
                ["docker", "rm", "-f", container_name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        conversation.ephemeral_container_name = ""
        conversation.ephemeral_expires_at = ""
        conversation.ephemeral_retention = "release_on_finish"
        conversation.save(self.conversations_dir)
        return True

    async def _cleanup_expired_ephemeral_sessions(self) -> None:
        now = utc_now()
        for conversation in self.list_conversations(include_archived=True):
            if not getattr(conversation, "ephemeral", False):
                continue
            if getattr(conversation, "ephemeral_retention", "release_on_finish") != "keep_until_ttl":
                continue
            expires_at = getattr(conversation, "ephemeral_expires_at", "")
            if not expires_at:
                continue
            try:
                if parse_iso(expires_at) > now:
                    continue
            except ValueError:
                continue
            self.close_ephemeral_conversation(conversation.id)

    def delete_session(self, conversation_id: str) -> bool:
        """Delete the session workspace dir for a conversation. Returns True if it existed."""
        import shutil
        d = self.sessions_dir / conversation_id
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
            return True
        return False

    def _get_ephemeral_network(self, acc: Account) -> Optional[str]:
        """
        Detect the coderfleet internal docker network for proxy-relay accounts.
        Inspects the coderfleet-proxy-relay container to find the intnet network.
        Returns None for proxy=off accounts (use default bridge).
        """
        from coderfleet.server.models import AccountProxy
        if acc.proxy == AccountProxy.off:
            return None
        try:
            result = subprocess.run(
                [
                    "docker", "inspect", "coderfleet-proxy-relay",
                    "--format",
                    "{{range $k,$v := .NetworkSettings.Networks}}{{$k}}\n{{end}}",
                ],
                capture_output=True, text=True, timeout=5,
            )
            for net in result.stdout.splitlines():
                net = net.strip()
                if net and "intnet" in net:
                    return net
        except Exception:
            pass
        return None

    def _apply_runtime_proxy(self, acc: Account, env: dict[str,str], network: Optional[str]) -> None:
        cfg = load_config(self.workspace_dir)
        is_local = acc.runtime == AccountRuntime.local
        proxy_active = (acc.proxy != AccountProxy.off) if is_local else bool(network)
        if proxy_active:
            relay_ip   = cfg.get("RELAY_IP",           "172.21.0.2")
            relay_port = cfg.get("RELAY_LISTEN_PORT",  "7890")
            proxy_url  = f"http://{relay_ip}:{relay_port}"
            no_proxy   = cfg.get("NO_PROXY", "localhost,127.0.0.1")
            for ev in ("ALL_PROXY", "all_proxy", "HTTPS_PROXY", "https_proxy",
                       "HTTP_PROXY", "http_proxy"):
                env[ev] = proxy_url
            env["NO_PROXY"] = no_proxy
            env["no_proxy"] = no_proxy
            env["CODERFLEET_RELAY_IP"] = relay_ip
            env["CODERFLEET_RELAY_PORT"] = relay_port


    def _runtime_for(self, acc: Account) -> "ContainerRuntime":
        """按账号选 runtime —— 一个 Scheduler 实例里 local 账号和 container 账号可以并存。"""
        return self._local_runtime if acc.runtime == AccountRuntime.local else self.runtime

    def check_local_sandbox_gate(self, acc: Account, auto: bool) -> str:
        """local 账号 + auto=True 且未确认已开启 OS 级沙箱时拒绝，不静默放行。

        auto 模式会使用假设"外部已经隔离好"的旗标 ——
        _build_claude 的 --dangerously-skip-permissions、_build_codex 的
        --dangerously-bypass-approvals-and-sandbox，后者自己的 --help 原文是
        "Intended solely for running in environments that are externally sandboxed"。
        容器场景下 Docker 本身就是那个"外部沙箱"；local 场景没有，必须由账号自己显式
        确认已经手工开启 CLI 自带的 OS 级沙箱（Claude Code 的
        sandbox.enabled+failIfUnavailable / Codex 的 --sandbox），门禁才放行。
        返回非空字符串表示拒绝（内容即错误信息）；空字符串表示允许。
        """
        if acc.runtime == AccountRuntime.local and auto and not acc.sandbox_confirmed:
            return (
                f"账号 '{acc.name}'（runtime=local）不能提交 auto 任务：本地执行没有容器兜底，"
                "而 auto 模式会使用假设已有外部沙箱的旗标（Claude 的 "
                "--dangerously-skip-permissions / Codex 的 "
                "--dangerously-bypass-approvals-and-sandbox）。请先手工确认已经开启该 CLI "
                "自带的 OS 级沙箱（Claude Code: sandbox.enabled + failIfUnavailable；"
                "Codex: --sandbox），再用 --sandbox-confirmed 标记该账号已确认。"
            )
        return ""

    @staticmethod
    def _running_as_root() -> bool:
        """CoderFleet 自身进程是否以 root 身份运行 —— 这是宿主机部署方式的属性，不是账号/
        任务的属性：LocalRuntime 起的子进程直接继承 coderfleet server 自己的 UID，没有像
        Docker 那样在容器内切到非 root 用户（镜像里跑的是固定的 byclaw 用户）这一层。
        """
        return hasattr(os, "geteuid") and os.geteuid() == 0

    def check_local_root_gate(self, acc: Account, auto: bool) -> str:
        """local + auto + Claude + coderfleet server 本身以 root 运行时拒绝。

        这不是 CoderFleet 自己的限制，是 Claude Code 自己的：它的 --dangerously-skip-
        permissions 启动时会检测有效 UID，root/sudo 下直接拒绝启动（"cannot be used with
        root/sudo privileges for security reasons"，实测原文）。container 场景不会撞上这个——
        镜像里跑的是非 root 的 byclaw 用户；local 场景的子进程直接继承 coderfleet server
        自己的 UID，如果 server 本身是用 root 启动的，每一次 auto=True 的 Claude 调用都会
        带着这个旗标一起被拒绝。不尝试静默去掉 --dangerously-skip-permissions 退化成非 auto
        模式——那样任务会卡在等一个不存在的人工审批上（进程还在但读不到任何审批输入），
        比在提交阶段就明确拒绝更糟；也不去改 sandbox_confirmed 语义，root 和"有没有沙箱"
        是两个独立的失败原因，即使已经确认过沙箱，Claude 仍然会在启动时因为 root 被拒绝。
        返回非空字符串表示拒绝；空字符串表示允许。
        """
        if (
            acc.runtime == AccountRuntime.local
            and auto
            and acc.type == AccountType.claude
            and self._running_as_root()
        ):
            return (
                f"无法为账号 '{acc.name}' 提交 auto 任务：Claude Code 自己拒绝在 root/sudo "
                "权限下使用 --dangerously-skip-permissions（官方安全限制，不是 CoderFleet 能"
                "绕过或应该绕过的）。当前 coderfleet server 进程本身是以 root 身份运行的，"
                "local 账号的子进程会直接继承这个身份。请改用非 root 用户启动 "
                "coderfleet server（例如新建一个专门的系统用户），而不是尝试绕过这个限制。"
            )
        return ""

    def local_auth_dir(self, acc: Account) -> Path:
        """local 账号在宿主机上的 CODEX_HOME/CLAUDE_CONFIG_DIR 根目录。

        复用 accounts/<name>/ —— 这个目录今天已经是 container 场景的挂载源
        （见 _run_ephemeral_task 里的 auth_src），local 场景直接把它当宿主机路径用，
        不新增存储位置。容器场景下所有账号共用同一个容器内固定路径隔离靠容器边界；
        local 场景没有容器边界，隔离必须靠每个账号拿到不同的宿主机目录。
        """
        sub = "codex" if acc.type == AccountType.codex else "claude"
        path = self.workspace_dir / "accounts" / acc.name / f".{sub}"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _get_account_image(self, acc: Account, project: Optional["Project"] = None) -> str:
        """Return the docker image to use for ephemeral containers."""
        from coderfleet.config import load_config
        # Project-level IMAGE override (highest priority)
        if project and project.image:
            return project.image
        # Fall back to any ephemeral project for this account that has IMAGE set
        for p in self.get_projects():
            if p.account == acc.name and p.ephemeral and p.image:
                return p.image
        # Global config: IMAGE_NAME:IMAGE_TAG (same logic as compose.py)
        cfg = load_config(self.workspace_dir)
        name = cfg.get("IMAGE_NAME", "coderfleet")
        tag  = cfg.get("IMAGE_TAG",  "latest")
        return f"{name}:{tag}"

    async def _run_ephemeral_task(
        self,
        task: Task,
        acc: Account,
        log_path: Path,
        auto: bool,
        conversation: Optional[Conversation] = None,
        session_dir: Optional[Path] = None,
        output_dir: str = "",
        task_secrets: Optional[dict] = None,
        images: list[str] = [],
        project: Optional["Project"] = None,
    ) -> None:
        """
        后台协程：用 docker run --rm 执行一次性任务，stdout 直接流入日志文件。
        不依赖持久容器，任务结束后容器自动销毁。
        """
        from coderfleet.account_type_registry import get_spec
        from coderfleet.config import container_timezone, load_config
        from coderfleet.docker_socket import docker_socket_config_for_project, resolve_docker_socket

        retention = self._normalize_ephemeral_retention(
            getattr(task, "ephemeral_retention", None)
            or (getattr(conversation, "ephemeral_retention", None) if conversation else None)
        )
        ttl_minutes = self._normalize_ephemeral_ttl(
            getattr(task, "ephemeral_ttl_minutes", None)
            or (getattr(conversation, "ephemeral_ttl_minutes", None) if conversation else None)
        )
        # local 账号没有"闲置容器可以反复 exec 进去"这个 docker 专属技巧 —— 每次任务都是
        # 一次全新的宿主机子进程调用（靠 CLI 自己的 --resume 衔接上下文），不支持会话复用。
        keep_container = bool(
            conversation and retention != "release_on_finish" and acc.runtime != AccountRuntime.local
        )
        container_name = (
            getattr(conversation, "ephemeral_container_name", "") if keep_container and conversation else ""
        ) or (
            f"coderfleet-eph-session-{conversation.id}" if keep_container and conversation
            else f"coderfleet-ephemeral-{task.id}"
        )
        proc: Optional[Process] = None

        if task.execution_backend == "sdk":
            self._sdk_launching.add(task.id)
            current = self.get_task(task.id) or task
            current.ephemeral_container_name = task.ephemeral_container_name = container_name
            current.save(self.tasks_dir)

        try:
            gate_rejection = (
                self.check_local_sandbox_gate(acc, auto)
                or self.check_local_root_gate(acc, auto)
            )
            if gate_rejection:
                raise RuntimeError(gate_rejection)

            spec = get_spec(acc.type.value)
            cfg  = load_config(self.workspace_dir)

            is_local = acc.runtime == AccountRuntime.local
            # sandbox_confirmed 只有在 local 时才有意义（见 Account.sandbox_confirmed
            # docstring）；门禁已经保证 local+auto 时 sandbox_confirmed 必为 True，这里
            # 直接读字段即可，不需要重复判断 auto。
            local_sandboxed = is_local and acc.sandbox_confirmed

            conversation = self._conversation_for_launch(conversation)
            pending_fork = conversation.fork if conversation and not conversation.native_session_id else None
            if task.execution_backend == "sdk":
                inner_cmd = ""
            else:
                inner_cmd = spec.build_inner_cmd(
                    self._expand_skill_command(task.prompt, acc.name), auto, task.id,
                    shlex.quote(Scheduler.task_process_marker(task.id)),
                    shlex.quote(task.id),
                    (pending_fork.source_session_id if pending_fork else conversation.native_session_id) if conversation else "",
                    list(images),
                    getattr(task, "model", ""),
                    local_sandboxed,
                    **({"fork_session_id": pending_fork.target_session_id,
                        "resume_session_at": pending_fork.message_uuid} if pending_fork else {}),
                )

            auth_src = self.workspace_dir / "accounts" / acc.name
            auth_dst = spec.auth_dir
            image    = self._get_account_image(acc, project)

            # 用领域词汇描述容器：环境变量、挂载、网络 —— docker argv 细节交给 runtime。
            # local 账号没有容器，mounts 对 LocalRuntime 是死字段，但留着构建不影响正确性
            # （只是没人读），不必为它单独分叉。
            env: dict[str, str] = {}
            if task.execution_backend == "sdk" and is_local:
                # LocalRuntime merges the service environment. Credentials must
                # come from this account/project/Task, never another login.
                env.update({key: "" for key in (
                    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
                )})
            mounts: list[tuple[str, str]] = [(str(auth_src), str(auth_dst))]

            if session_dir is not None:
                mounts.append((str(session_dir), "/workspace"))
                host_workspace = str(session_dir)
            else:
                # No session dir → still need /workspace for the log mechanism
                tmp_ws = self.sessions_dir / f"task-{task.id}"
                tmp_ws.mkdir(parents=True, exist_ok=True)
                mounts.append((str(tmp_ws), "/workspace"))
                host_workspace = str(tmp_ws)

            if output_dir:
                out_path = Path(output_dir).expanduser().resolve()
                out_path.mkdir(parents=True, exist_ok=True)
                mounts.append((str(out_path), "/output"))

            # docker socket 转发是「容器里跑的任务想反过来操作宿主机 docker」的机制 ——
            # local 账号本来就直接跑在宿主机上，不存在这层间接，跳过整段。
            if not is_local and not task.platform_run_id:
                project_socket_record = {}
                if project and getattr(project, "docker_socket", ""):
                    project_socket_record["DOCKER_SOCKET"] = project.docker_socket
                docker_socket = resolve_docker_socket(docker_socket_config_for_project(cfg, project_socket_record))
                if docker_socket is not None:
                    mounts.append((docker_socket.host_path, docker_socket.container_path))
                    env["DOCKER_HOST"] = docker_socket.env
                    env["CODERFLEET_DOCKER_SOCKET"] = docker_socket.container_path
                    env["CODERFLEET_HOST_WORKSPACE"] = host_workspace

            # Proxy / network —— local 账号没有 docker 网络可加入（_get_ephemeral_network 探测
            # 的是 docker 容器该不该 join 哪个网络，跟宿主机子进程完全无关），是否要设代理环境
            # 变量单看账号自己的 proxy 设置；network 变量只用来控制 ContainerSpec.network（对
            # LocalRuntime 是死字段），不再兼职当"要不要设代理"的判断依据。
            network = None if is_local else self._get_ephemeral_network(acc)
            self._apply_runtime_proxy(acc,env,network)
            if task.platform_run_id:
                snapshot = self.workspace_dir / 'platform' / 'runs' / task.platform_run_id / 'snapshot.json'
                from coderfleet.server.platform_agent import PlatformHarness
                if not snapshot.is_file() and not PlatformHarness(self).launch_config(task.platform_run_id).get('retrieval'): raise ValueError('平台活动快照缺失')
                if snapshot.is_file():mounts.append((str(snapshot),'/platform-data/snapshot.json:ro'))
                from coderfleet.server.platform_agent import PlatformHarness
                image = PlatformHarness(self).launch_config(task.platform_run_id)['image']

            # Standard env vars (matching compose.py baseline — always set for all types)
            if is_local:
                # 容器场景所有账号共用同一个容器内固定路径，靠容器边界隔离；local 场景没有
                # 容器边界，每个账号必须拿到互不相同的宿主机目录（见 local_auth_dir docstring）。
                env["CODEX_HOME"] = str(self.local_auth_dir(acc)) if acc.type == AccountType.codex else "/home/byclaw/.codex"
                env["CLAUDE_CONFIG_DIR"] = str(self.local_auth_dir(acc)) if acc.type == AccountType.claude else "/home/byclaw/.claude"
            else:
                env["CODEX_HOME"] = "/home/byclaw/.codex"
                env["CLAUDE_CONFIG_DIR"] = "/home/byclaw/.claude"
            env["TZ"] = container_timezone(cfg)
            env["CODERFLEET_ACCOUNT_NAME"] = acc.name
            env["CODERFLEET_ACCOUNT_TYPE"] = acc.type.value
            env["CODERFLEET_ACCOUNT_AUTH"] = acc.auth.value
            env["CODERFLEET_ACCOUNT_PROXY"] = acc.proxy.value

            # Account-type static env vars
            env.update(spec.env_vars)

            # Project-level env (if project_name set)
            if task.project_name:
                try:
                    env.update(self.get_project_env(task.project_name))
                except Exception:
                    pass

            # Account env (for env-auth accounts, API keys, etc.)
            try:
                env.update(self.get_account_env(acc.name))
            except Exception:
                pass

            # Task-level secrets (highest priority, override everything)
            env.update(task_secrets or {})
            if task.platform_run_id:
                env['CODERFLEET_MCP_BRIDGE_PORT']=(cfg.get('MCP_BRIDGE_RELAY_PORT','8766') if network else os.environ.get('CODERFLEET_PORT',cfg.get('CODERFLEET_PORT','8765')))
                relay_host=env.get('CODERFLEET_RELAY_IP',cfg.get('RELAY_IP','172.21.0.2')) if network else 'host.docker.internal'
                env['CODERFLEET_RELAY_IP']=relay_host
                bypass=env.get('NO_PROXY','localhost,127.0.0.1')
                env['NO_PROXY']=bypass+','+relay_host
                env['no_proxy']=env['NO_PROXY']
                for key in ('DOCKER_HOST','CODERFLEET_DOCKER_SOCKET','CODERFLEET_HOST_WORKSPACE'):
                    env.pop(key,None)

            if task.execution_backend == "sdk":
                root = host_workspace if is_local else "/workspace"
                inner_cmd = self._prepare_sdk_launch(
                    task, acc, Path(host_workspace), root, root, conversation,
                    self._expand_skill_command(task.prompt, acc.name), list(images),
                )
                diagnostic = str(Path(root) / ".coderfleet-tasks" / f"{task.id}.sdk-diagnostic.log")
                inner_cmd = f"{inner_cmd} 2>> {shlex.quote(diagnostic)}"

            # Wrap inner_cmd in explicit subshell so exec -a replaces the subshell,
            # not the outer bash (which must stay alive to propagate the exit code).
            # Use bash -c (not -lc) and set PATH explicitly to avoid login-profile issues.
            # 这几个路径是 CoderFleet 镜像里固定的容器内布局（container 场景的 byclaw 用户），
            # 跟宿主机真实用户的 claude/codex 安装位置无关 —— local 场景不覆盖 PATH，直接继承
            # LocalRuntime 传下去的宿主机环境变量（探测阶段 shutil.which 找到的就是这份 PATH）。
            if is_local:
                path_prefix = ""
            else:
                path_prefix = (
                    "export PATH=/home/byclaw/.local/bin:/usr/local/bin"
                    ":/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:$PATH && "
                )
            if task.execution_backend == "sdk":
                wrapped_cmd = path_prefix + inner_cmd
            else:
                wrapped_cmd = path_prefix + f"( {inner_cmd} )"

            if keep_container:
                if not self._docker_container_running(container_name):
                    try:
                        await self.runtime.remove(container_name)
                    except Exception:
                        pass
                    start_proc = await self.runtime.run(ContainerSpec(
                        image=image,
                        command=["tail", "-f", "/dev/null"],
                        env=env,
                        mounts=mounts,
                        network=network,
                        name=container_name,
                        detached=True,
                    ))
                    start_out, _ = await start_proc.communicate()
                    if start_proc.returncode != 0:
                        msg = start_out.decode("utf-8", errors="replace") if start_out else "unknown error"
                        raise RuntimeError(f"启动临时会话容器失败：{msg}")
                    if conversation:
                        conversation.ephemeral_container_name = container_name
                        conversation.ephemeral_retention = retention
                        conversation.ephemeral_ttl_minutes = ttl_minutes
                        if retention == "keep_until_ttl":
                            conversation.ephemeral_expires_at = self._ephemeral_expires_at(ttl_minutes)
                        conversation.save(self.conversations_dir)

                task.ephemeral_container_name = container_name
                task.save(self.tasks_dir)

                # 只有 keep-container（session 复用）场景才探测：一次性容器
                # （release_on_finish，默认档）走的是下面 else 分支的单次
                # runtime.run()，容器启动和任务命令在同一次调用里一起执行，
                # 没有独立的"容器已启动、任务未执行"窗口可插入探测 exec，
                # 因此即使有 project 也不探测，跟 keep-container 场景的判定
                # 标准不同（issue #87 讨论过的范围收窄）。
                if project is not None:
                    git_branch, git_worktree, diff_added, diff_removed = await self._probe_git_context(
                        container_name, "/workspace",
                    )
                    if git_branch:
                        self._record_git_context(task.id, git_branch, git_worktree, diff_added, diff_removed)
                        # 同步本地对象：下面这个函数后续还会用同一个 task 变量多次
                        # save()（pid/native_session_id/status…），不更新本地字段的话
                        # 那些后续 save 会拿着内存里的旧空值把刚落盘的分支信息覆盖掉。
                        task.git_branch = git_branch
                        task.git_worktree = git_worktree
                        task.git_diff_added = diff_added
                        task.git_diff_removed = diff_removed

                proc = await self.runtime.exec(
                    container_name, ["bash", "-c", wrapped_cmd], env=env, workdir="/workspace",
                )
            else:
                # image/mounts/network/remove 对 LocalRuntime 都是死字段（它只看
                # command/env/workdir）——local 账号不需要单独拼一份 spec，只需要把
                # workdir 从容器路径 "/workspace" 换成真实的宿主机目录。
                proc = await self._runtime_for(acc).run(ContainerSpec(
                    image=image,
                    command=["bash", "-c", wrapped_cmd],
                    workdir=host_workspace if is_local else "/workspace",
                    env=env,
                    mounts=mounts,
                    network=network,
                    name=container_name,
                    remove=True,
                ))

            if task.execution_backend == "sdk":
                current = self.get_task(task.id) or task
                current.pid = task.pid = str(proc.pid)
                current.ephemeral_container_name = task.ephemeral_container_name = container_name
                current.save(self.tasks_dir)
                if current.status == TaskStatus.killed:
                    raise asyncio.CancelledError()
            else:
                task.pid = str(proc.pid)
                task.ephemeral_container_name = container_name
                task.save(self.tasks_dir)

            self._sdk_launching.discard(task.id)

            captured_session_id = ""
            session_scan_buffer = ""
            sdk_event_buffer = ""
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            import aiofiles
            async with aiofiles.open(log_path, mode="a", encoding="utf-8") as f:
                while proc.stdout is not None:
                    if task.execution_backend == "sdk":
                        try:
                            raw_chunk = await asyncio.wait_for(proc.stdout.read(8192), timeout=3)
                        except asyncio.TimeoutError:
                            try:
                                worker_alive = await self._control_sdk_task(task, "probe_worker")
                            except RuntimeError:
                                logger.warning("SDK worker liveness unavailable [task=%s]", task.id)
                                continue
                            if not worker_alive:
                                await self._drain_sdk_task(task)
                            continue
                    else:
                        raw_chunk = await proc.stdout.read(8192)
                    if not raw_chunk:
                        break
                    text = decoder.decode(raw_chunk)
                    if text:
                        await f.write(text)
                        await f.flush()
                        if task.execution_backend == "sdk":
                            sdk_event_buffer += text
                            complete, separator, remaining = sdk_event_buffer.rpartition("\n")
                            if separator:
                                self._record_sdk_progress(task, complete + "\n")
                                sdk_event_buffer = remaining
                        if not captured_session_id:
                            session_scan_buffer = (session_scan_buffer + text)[-65536:]
                            captured_session_id = self.extract_native_session_id(
                                acc.type, session_scan_buffer
                            )
                            if captured_session_id:
                                current = self.get_task(task.id) or task
                                current.native_session_id = captured_session_id
                                current.save(self.tasks_dir)
                                task.native_session_id = captured_session_id
                                task.sdk_version = current.sdk_version
                                task.cli_version = current.cli_version
                                task.status = current.status
                                task.finished = current.finished
                                if conversation:
                                    self.update_conversation_native_session(
                                        conversation.id, captured_session_id, task.id
                                    )
                final_text = decoder.decode(b"", final=True)
                if final_text:
                    await f.write(final_text)
                    await f.flush()
                if task.execution_backend == "sdk" and (sdk_event_buffer or final_text):
                    self._record_sdk_progress(task, sdk_event_buffer + final_text)

            await proc.wait()
            rc = proc.returncode if proc.returncode is not None else -1

            if task.execution_backend == "sdk":
                await self._drain_sdk_task(task)
                task = self.get_task(task.id) or task
                if task.status == TaskStatus.killed:
                    self._append_log_footer(log_path, "killed")
                    return
                if conversation:
                    conversation = self.get_conversation(conversation.id)

            if rc == 0:
                if conversation:
                    if not conversation.native_session_id and captured_session_id:
                        self.update_conversation_native_session(
                            conversation.id, captured_session_id, task.id
                        )
                    else:
                        conversation.touch(self.conversations_dir, last_task_id=task.id)
                    if keep_container:
                        conversation = self.get_conversation(conversation.id) or conversation
                        conversation.ephemeral_container_name = container_name
                        conversation.ephemeral_retention = retention
                        conversation.ephemeral_ttl_minutes = ttl_minutes
                        if retention == "keep_until_ttl":
                            conversation.ephemeral_expires_at = self._ephemeral_expires_at(ttl_minutes)
                        conversation.save(self.conversations_dir)
                if task.execution_backend == "sdk":
                    task = self._finish_sdk_task(task, TaskStatus.done)
                else:
                    task.update_status(TaskStatus.done, self.tasks_dir)
                self._sync_board_card_for_task(task)
                self._append_log_footer(log_path, "done")
            else:
                if conversation:
                    conversation.touch(self.conversations_dir, last_task_id=task.id)
                if task.execution_backend == "sdk":
                    target = TaskStatus.killed if rc in (-2, -15, 130, 143) else TaskStatus.failed
                    task = self._finish_sdk_task(task, target)
                else:
                    task.update_status(TaskStatus.failed, self.tasks_dir)
                self._sync_board_card_for_task(task)
                label = task.status.value if task.execution_backend == "sdk" else "failed"
                self._append_log_footer(log_path, f"{label} (exit={rc})")

            self._extract_and_save_token_usage(task, log_path)
            retried = await self._maybe_auto_retry(task, log_path) if rc != 0 else None
            if retried is None:
                asyncio.create_task(self._notify(task))

        except asyncio.CancelledError:
            self._sdk_launching.discard(task.id)
            if task.execution_backend == "sdk":
                current = self.get_task(task.id) or task
                if current.status not in (TaskStatus.killed, TaskStatus.done, TaskStatus.failed):
                    try:
                        await self._drain_sdk_task(current)
                    except RuntimeError as error:
                        self._append_log_footer(log_path, f"SDK cleanup could not be verified: {error}")
                        return
                if is_local:
                    await self._local_runtime.remove(container_name)
                elif not keep_container:
                    await self.runtime.remove(container_name)
                if proc is not None and hasattr(proc, "wait"):
                    try:
                        await asyncio.wait_for(proc.wait(), timeout=2)
                    except (asyncio.TimeoutError, ProcessLookupError):
                        logger.warning("SDK launcher cleanup timed out [task=%s]", task.id)
                target = TaskStatus.killed if current.status == TaskStatus.killed else TaskStatus.failed
                task = self._finish_sdk_task(task, target)
            elif proc is not None:
                if keep_container:
                    subprocess.run(
                        ["docker", "exec", container_name, "pkill", "-f", task.id],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    )
                else:
                    subprocess.run(
                        ["docker", "rm", "-f", container_name],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    )
            if task.execution_backend != "sdk":
                task.update_status(TaskStatus.killed, self.tasks_dir)
            self._sync_board_card_for_task(task)
            self._append_log_footer(log_path, "killed")
            asyncio.create_task(self._notify(task))
        except Exception as e:
            if task.execution_backend == "sdk":
                if proc is not None:
                    try:
                        await self._drain_sdk_task(task)
                    except RuntimeError:
                        logger.exception("SDK task failed; worker exit is unverified [task=%s]", task.id)
                        return
                task = self._finish_sdk_task(task, TaskStatus.failed)
            else:
                task.update_status(TaskStatus.failed, self.tasks_dir)
            self._sync_board_card_for_task(task)
            try:
                with log_path.open("a", encoding="utf-8") as f:
                    f.write(f"\n任务运行异常：{e}\n")
            except Exception:
                pass
            self._append_log_footer(log_path, f"failed: {e}")
            asyncio.create_task(self._notify(task))
        finally:
            self._sdk_launching.discard(task.id)
            self._running.pop(task.id, None)
            asyncio.create_task(self.schedule_next_tasks())

    _SHORTSTAT_INSERTIONS_RE = re.compile(r"(\d+) insertions?\(\+\)")
    _SHORTSTAT_DELETIONS_RE = re.compile(r"(\d+) deletions?\(-\)")

    async def _probe_git_context(self, container_name: str, container_workdir: str) -> tuple[str, bool, int, int]:
        """探测 container_workdir 当前的 git 分支、是否为 linked worktree（git-dir 含
        /worktrees/），以及相对上一次提交的未提交改动行数（issue #88 后续：`git diff
        --shortstat HEAD`，不是相对默认分支的累计改动——不需要判断默认分支叫什么，
        代价是代理一旦提交就会归零；这是有意选择的 MVP 范围，不是遗漏）。

        detached HEAD 时 --abbrev-ref 只会给出字面量 "HEAD"，退化用短 SHA 代替，避免把
        "HEAD" 这个非分支值当分支名展示。纯展示性附加信息，不是任务执行的前置条件：任何
        失败（非 git 目录、git 未安装、exec 报错等）一律返回空结果，绝不抛异常、不影响
        调用方的任务状态机。workdir 通过 runtime.exec 自身的 workdir 参数传入（seam 已支持
        docker exec -w），不用 `git -C` 重新实现路径定位。
        """
        probe_cmd = (
            "git rev-parse --abbrev-ref HEAD 2>/dev/null && "
            "git rev-parse --short HEAD 2>/dev/null && "
            "git rev-parse --git-dir 2>/dev/null && "
            "git diff --shortstat HEAD 2>/dev/null"
        )
        try:
            proc = await self.runtime.exec(
                container_name, ["bash", "-c", probe_cmd], workdir=container_workdir,
            )
            out, _ = await proc.communicate()
        except Exception:
            return "", False, 0, 0
        if proc.returncode != 0:
            return "", False, 0, 0
        lines = out.decode("utf-8", errors="replace").strip().splitlines()
        if len(lines) < 3 or not lines[0].strip():
            return "", False, 0, 0
        abbrev_ref, short_sha, git_dir = (l.strip() for l in lines[:3])
        branch = short_sha if abbrev_ref == "HEAD" else abbrev_ref
        if not branch:
            return "", False, 0, 0
        # 第 4 行（--shortstat）在"无未提交改动"时本来就是空输出，不代表探测失败。
        shortstat = lines[3] if len(lines) > 3 else ""
        ins_m = self._SHORTSTAT_INSERTIONS_RE.search(shortstat)
        del_m = self._SHORTSTAT_DELETIONS_RE.search(shortstat)
        added = int(ins_m.group(1)) if ins_m else 0
        removed = int(del_m.group(1)) if del_m else 0
        return branch, "/worktrees/" in git_dir, added, removed

    def _record_git_context(
        self, task_id: str, git_branch: str, git_worktree: bool,
        diff_added: int = 0, diff_removed: int = 0,
    ) -> None:
        """单次同步 read-modify-write：探测跨越一次 await，写回前重新从磁盘加载最新任务记录，
        避免覆盖 kill_task 等并发操作在探测期间写入的状态（CLAUDE.md 状态文件读改写不变式）。
        """
        fresh = self.get_task(task_id)
        if fresh is None:
            return
        fresh.git_branch = git_branch
        fresh.git_worktree = git_worktree
        fresh.git_diff_added = diff_added
        fresh.git_diff_removed = diff_removed
        fresh.save(self.tasks_dir)

    @staticmethod
    def _write_sdk_artifact(path: Path, content: bytes, *, private: bool = False) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_bytes(content)
            temporary.chmod(0o600 if private else 0o644)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)

    def _prepare_sdk_launch(
        self, task: Task, acc: Account, project_root: Path, execution_root: str,
        cwd: str, conversation: Optional[Conversation], prompt: str,
        images: list[str],
    ) -> str:
        from coderfleet.claude_sdk import build_worker_command, control_source, worker_source, features_source
        from coderfleet.account_type_registry import _CF_SEND_SYSTEM_HINT, claude_mcp_options

        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task.id):
            raise ValueError("无效的 SDK Task 标识")
        source = worker_source()
        filename = f"sdk-worker-{hashlib.sha256(source).hexdigest()[:16]}.py"
        artifact_dir = project_root / ".coderfleet-tasks"
        runtime_dir = Path(execution_root) / ".coderfleet-tasks"
        self._write_sdk_artifact(artifact_dir / filename, source)
        protocol_source = control_source()
        protocol_name = f"sdk-control-{hashlib.sha256(protocol_source).hexdigest()[:16]}.py"
        self._write_sdk_artifact(artifact_dir / protocol_name, protocol_source)
        feature_source = features_source()
        feature_name = f"sdk-features-{hashlib.sha256(feature_source).hexdigest()[:16]}.py"
        self._write_sdk_artifact(artifact_dir / feature_name, feature_source)
        current = self.get_task(task.id) or task
        if not current.sdk_control_token:
            current.sdk_control_token = secrets.token_hex(32)
        current.sdk_control_ready = False
        current.save(self.tasks_dir)
        task.sdk_control_token = current.sdk_control_token
        task.sdk_control_ready = False
        pending_fork = conversation.fork if conversation and not conversation.native_session_id else None
        owner = self.find_project_for_path(task.project,acc.name) if acc.runtime == AccountRuntime.local else None
        scope_root = owner.path if owner else execution_root
        interactive = not task.auto and task.sdk_options.get('permission_mode') != 'dontAsk'
        request = {
            "task_id": task.id, "prompt": prompt, "cwd": cwd,
            "model": task.model, "auto": task.auto, "images": images,
            "session_id": (pending_fork.source_session_id if pending_fork else conversation.native_session_id) if conversation else "",
            "fork_session_id": pending_fork.target_session_id if pending_fork else "",
            "resume_session_at": pending_fork.message_uuid if pending_fork else "",
            "append_system_prompt": _CF_SEND_SYSTEM_HINT + (
                '\nWhen you need to ask the operator a question, prefer native AskUserQuestion; its callback is connected to CoderFleet.'
                if interactive else ''),
            "mcp_options": claude_mcp_options(allow_ask_user=interactive),
            "diagnostic_path": str(runtime_dir / f"{task.id}.sdk-diagnostic.log"),
            "state_path": str(runtime_dir / f"{task.id}.sdk-state.json"),
            "control_directory": str(runtime_dir / f"{task.id}.control"),
            "control_token": task.sdk_control_token,
            "control_module": str(runtime_dir / protocol_name),
            "features_module": str(runtime_dir / feature_name),
            "attachment_root": str(Path(scope_root) / ".coderfleet-uploads"),
            "project_root": scope_root,
            "sdk_options": task.sdk_options,
            "sdk_action": task.sdk_action,
            "question_timeout_seconds": DEFAULT_INTERVENTION_TIMEOUT_SECONDS,
        }
        if task.platform_run_id:
            from importlib import resources
            from coderfleet.server.platform_agent import PlatformHarness
            source = resources.files('coderfleet.data').joinpath('scripts/coderfleet_platform_tools.py').read_bytes()
            name = 'platform-tools-' + hashlib.sha256(source).hexdigest()[:16] + '.py'
            self._write_sdk_artifact(artifact_dir / name,source)
            retrieval=PlatformHarness(self).launch_config(task.platform_run_id).get('retrieval',False)
            request.update(platform_snapshot='' if retrieval else '/platform-data/snapshot.json',platform_tools_module=str(runtime_dir / name),
                           control_directory='',control_token='',session_id='',append_system_prompt='',
                           mcp_options={'mcp_servers':PlatformHarness(self).connections(task.platform_run_id),'allowed_tools':[],'disallowed_tools':[]})
        self._write_sdk_artifact(
            artifact_dir / f"{task.id}.sdk.json",
            json.dumps(request, ensure_ascii=False).encode("utf-8"),
            private=acc.runtime == AccountRuntime.local,
        )
        command = build_worker_command(
            runtime_dir / f"{task.id}.sdk.json", runtime_dir / filename,
            self.task_process_marker(task.id), local=acc.runtime == AccountRuntime.local,
        )
        return f"export CODERFLEET_TASK_ID={shlex.quote(task.id)}; {command}"

    def _record_sdk_progress(
        self, task: Task, text: str, *, source_offset: Optional[int] = None,
        log_size: Optional[int] = None,
    ) -> None:
        from coderfleet.claude_sdk import extract_sdk_metadata
        metadata = extract_sdk_metadata(text, task_id=task.id)
        current = self.get_task(task.id)
        if current is None:
            return
        for name, value in metadata.items():
            setattr(current, name, value)
            setattr(task, name, value)
        for line in text.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if (not isinstance(event, dict) or event.get('type') != 'system'
                    or event.get('task_id') != task.id or current.status != TaskStatus.running):
                continue
            if event.get('subtype') == 'coderfleet_checkpoint':
                identifier = event.get('user_message_id')
                if isinstance(identifier,str) and identifier not in current.sdk_checkpoints:
                    current.sdk_checkpoints = task.sdk_checkpoints = [*current.sdk_checkpoints,identifier]
            elif event.get('subtype') == 'coderfleet_control_ready':
                current.sdk_control_ready = task.sdk_control_ready = True
                capabilities = event.get('capabilities', [])
                if isinstance(capabilities,list) and all(isinstance(value,str) for value in capabilities):
                    current.sdk_capabilities = task.sdk_capabilities = capabilities
                current.sdk_permission_mode = task.sdk_permission_mode = event.get('permission_mode','')
            elif event.get('subtype') == 'coderfleet_control_applied':
                arguments = event.get('arguments', {})
                if event.get('operation') == 'set_model' and 'model' in arguments:
                    current.model = task.model = arguments['model'] or ''
                elif event.get('operation') == 'set_permission_mode' and 'mode' in arguments:
                    current.sdk_permission_mode = task.sdk_permission_mode = arguments['mode']
            elif event.get('subtype') == 'coderfleet_interrupted':
                current.interrupted = task.interrupted = True
                current.sdk_control_ready = task.sdk_control_ready = False
                current.pending_intervention = task.pending_intervention = None
            elif event.get('subtype') == 'coderfleet_message_accepted':
                message = event.get('text')
                request_id = event.get('request_id')
                if isinstance(message, str) and isinstance(request_id, str):
                    self.titles.observe_message(current, message, request_id)
            elif event.get('subtype') == 'coderfleet_question_pending':
                previous = current.pending_intervention
                try:
                    current.pending_intervention = PendingIntervention(
                        kind='native', tool_call_id=event['tool_call_id'], questions=event['questions'],
                        deadline=event['deadline'], token=(previous.token if previous and
                            previous.tool_call_id == event['tool_call_id'] else uuid.uuid4().hex),
                    )
                except (KeyError, ValueError):
                    logger.warning('Invalid SDK question event for Task %s', task.id)
                task.pending_intervention = current.pending_intervention
            elif event.get('subtype') == 'coderfleet_permission_pending':
                previous = current.pending_intervention
                try:
                    current.pending_intervention = PendingIntervention(
                        kind='permission', tool_call_id=event['tool_call_id'], tool_name=event['tool_name'],
                        tool_input=event['tool_input'], decision_reason=event.get('decision_reason', ''),
                        deadline=event['deadline'], token=(previous.token if previous and previous.kind == 'permission' and
                            previous.tool_call_id == event['tool_call_id'] else uuid.uuid4().hex),
                    )
                    task.pending_intervention = current.pending_intervention
                except (KeyError, ValueError):
                    logger.warning('Invalid SDK permission event for Task %s', task.id)
            elif event.get('subtype') in {'coderfleet_question_closed', 'coderfleet_permission_closed'}:
                if current.pending_intervention and current.pending_intervention.tool_call_id == event.get('tool_call_id'):
                    current.pending_intervention = task.pending_intervention = None
        if source_offset is not None:
            current.sdk_source_offset = task.sdk_source_offset = source_offset
        if log_size is not None:
            current.sdk_log_size = task.sdk_log_size = log_size
        current.save(self.tasks_dir)

    def _finish_sdk_task(self, task: Task, status: TaskStatus) -> Task:
        current = self.get_task(task.id) or task
        current.sdk_control_ready = False
        current.pending_intervention = None
        if current.status not in (TaskStatus.done, TaskStatus.failed, TaskStatus.killed):
            current.update_status(status, self.tasks_dir)
        else:
            current.save(self.tasks_dir)
        return current

    def _sdk_control_directory(self, task: Task) -> Path:
        root: Optional[Path]
        if task.ephemeral:
            root = Path(task.project) if task.project != 'ephemeral' else self.sessions_dir / f'task-{task.id}'
        else:
            root = self._get_project_root(task)
        if root is None:
            raise RuntimeError('SDK Task working directory is unavailable')
        return root / '.coderfleet-tasks' / f'{task.id}.control'

    async def sdk_command(
        self, task_id: str, kind: Literal['ping', 'answer', 'interrupt', 'message', 'approval', 'control'], payload: dict,
        request_id: Optional[str] = None, *, timeout: float = 8,
    ) -> dict:
        """Deliver a command to this exact worker run and await its durable receipt."""
        from coderfleet.data.scripts.coderfleet_sdk_control import ControlError, ControlMailbox

        task = self.get_task(task_id)
        if task is None:
            raise ValueError(f"任务 '{task_id}' 不存在")
        if task.execution_backend != 'sdk' or not task.sdk_control_token:
            raise RuntimeError('当前任务尚不支持运行中交互，请等待就绪或提交新的 SDK 任务')
        mailbox = ControlMailbox(self._sdk_control_directory(task), task.id, task.sdk_control_token)
        if request_id and mailbox.has_command(request_id):
            mailbox.submit(request_id, kind, payload, timeout=timeout)  # Verify identical retry input.
            reply = mailbox.reply(request_id)
            if reply:
                if reply['status'] == 'accepted':
                    return reply
                raise ControlError(reply.get('error') or 'SDK command was rejected')
            if task.status != TaskStatus.running or not task.sdk_control_ready:
                raise TimeoutError(f'命令 {request_id} 已投递但没有回执，结果未知；不会自动重放')
        if task.status != TaskStatus.running or not task.sdk_control_ready:
            raise RuntimeError('当前任务尚不支持运行中交互，请等待就绪或提交新的 SDK 任务')
        if kind == 'message' and payload.get('images') and 'multimodal_input' not in task.sdk_capabilities:
            raise RuntimeError('当前 worker 不支持附件插话，请选择排队发送或启动新的 SDK Task')
        identifier = mailbox.submit(request_id or uuid.uuid4().hex, kind, payload, timeout=timeout)
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            reply = mailbox.reply(identifier)
            if reply:
                if reply['status'] != 'accepted':
                    raise ControlError(reply.get('error') or 'SDK command was rejected')
                return reply
            current = self.get_task(task.id)
            if current is None or current.status != TaskStatus.running:
                raise TimeoutError(f'任务已结束，命令 {identifier} 未确认送达；不会自动重放')
            if asyncio.get_running_loop().time() >= deadline:
                raise TimeoutError(f'命令 {identifier} 尚未收到回执，结果未知；请使用同一请求 ID 查询或重试')
            await asyncio.sleep(0.03)

    async def sdk_control(self, task_id: str, operation: str, arguments: dict, request_id: str) -> dict:
        from coderfleet.data.scripts.coderfleet_sdk_control import validate_control
        arguments = validate_control(operation, arguments)
        task = self.get_task(task_id)
        if task is None:
            raise ValueError(f"任务 '{task_id}' 不存在")
        if 'control' not in task.sdk_capabilities:
            raise RuntimeError('当前 worker 不支持这些控制，请启动新的 SDK Task')
        if operation == 'rewind_files' and (not task.sdk_options.get('enable_file_checkpointing') or arguments['user_message_id'] not in task.sdk_checkpoints):
            raise RuntimeError('请选择本 Task 记录的文件检查点')
        from coderfleet.data.scripts.coderfleet_sdk_control import ControlMailbox
        mailbox = ControlMailbox(self._sdk_control_directory(task),task.id,task.sdk_control_token)
        if not mailbox.has_command(request_id) and operation == 'set_permission_mode' and arguments['mode'] in {'auto', 'bypassPermissions'}:
            account = next((item for item in self.get_accounts() if item.name == task.account), None)
            if account is None:
                raise RuntimeError('任务账号不可用')
            if task.execution_runtime:
                account = account.model_copy(update={'runtime':AccountRuntime(task.execution_runtime)})
            gate = self.check_local_sandbox_gate(account, True) or self.check_local_root_gate(account, True)
            if gate:
                raise RuntimeError(gate)
        return await self.sdk_command(task_id, 'control', {'operation':operation,'arguments':arguments}, request_id)

    def _sdk_workspace_busy(self, key: tuple[str,str]) -> bool:
        lease = Path(key[1])/'.coderfleet-tasks/sdk-session-lease.json'
        if lease.exists():
            try:
                record = json.loads(lease.read_text())
                source = self.get_task(record['task_id'])
                if source is None: return True
                from coderfleet.data.scripts.coderfleet_sdk_control import ControlMailbox
                mailbox = ControlMailbox(lease.parent/f'{source.id}.sessions',source.id,source.sdk_control_token)
                identifier = ControlMailbox._identifier(record['request_id'])
                if mailbox.reply(identifier) or (mailbox.directory/(identifier+'.finished.json')).is_file():
                    lease.unlink()
                    self._sdk_native_busy.discard(key)
                else: return True
            except (OSError,ValueError,KeyError,TypeError): return True
        return key in self._sdk_native_busy

    def _assert_sdk_workspace_available(self, task: Task) -> None:
        key = self._sdk_workspace_key(task)
        if self._sdk_workspace_busy(key): raise RuntimeError('原生会话修改尚未结束，请稍后提交')
        if any(t.id != task.id and t.sdk_action and self._task_is_active(t)
               and self._sdk_workspace_key(t)[1] == key[1] for t in Task.load_all(self.tasks_dir)):
            raise RuntimeError('此项目正在恢复文件，请等待恢复完成')

    def _touch_submitted_conversation(self, conversation_id: str, task: Task) -> None:
        def change(current: Conversation) -> None:
            if not task.sdk_action:
                current.sdk_options = task.sdk_options
            current.last_task_id = task.id
            current.updated = now_iso()
        Conversation.mutate(self.conversations_dir, conversation_id, change)
        self.titles.observe(task)

    def _sdk_workspace_key(self, task: Task) -> tuple[str,str]:
        if task.ephemeral:
            root = Path(task.project) if task.project != 'ephemeral' else self.sessions_dir / f'task-{task.id}'
        else:
            root = self._get_project_root(task) or Path(task.project)
        return task.account,str(root.resolve())

    async def rewind_sdk_files(self, task_id: str, checkpoint: str, request_id: str) -> Task:
        from coderfleet.data.scripts.coderfleet_sdk_control import ControlMailbox
        ControlMailbox._identifier(request_id)
        source = self.get_task(task_id)
        if source is None: raise ValueError('来源 Task 不存在')
        if source.execution_backend != 'sdk' or not source.sdk_options.get('enable_file_checkpointing'):
            raise RuntimeError('来源 Task 未启用文件检查点')
        if checkpoint not in source.sdk_checkpoints or not source.native_session_id:
            raise RuntimeError('检查点不属于来源 Task')
        action = {'operation':'rewind_files','source_session_id':source.native_session_id,
                  'user_message_id':checkpoint,'request_id':request_id,'source_task_id':source.id}
        tasks = Task.load_all(self.tasks_dir)
        for existing in tasks:
            if existing.sdk_action.get('request_id') == request_id and existing.account == source.account:
                if existing.sdk_action != action or self._sdk_workspace_key(existing) != self._sdk_workspace_key(source):
                    raise RuntimeError('恢复请求 ID 已用于其他操作')
                return existing
        key = self._sdk_workspace_key(source)
        if self._sdk_workspace_busy(key) or any(self._task_is_active(t) and self._sdk_workspace_key(t)[1] == key[1] for t in tasks):
            raise RuntimeError('请先停止此账号在该项目中的任务，再恢复文件')
        acc = next((a for a in self.get_accounts() if a.name == source.account),None)
        if acc is None or acc.claude_backend != 'sdk' or acc.runtime.value != source.execution_runtime:
            raise RuntimeError('来源账号的 SDK 运行位置已改变，无法安全恢复')
        project = self.find_project_by_name(source.project_name) if source.project_name else None
        conv = self.get_conversation(source.conversation_id) if source.conversation_id else None
        local_normal = (acc.runtime == AccountRuntime.local and source.project != 'ephemeral'
                        and project is not None and not project.ephemeral and not (conv and conv.ephemeral))
        return await self.submit('[恢复文件检查点] ' + checkpoint,account_name=source.account,
            project_name=source.project_name or None,prefer_project=source.project,
            conversation_id=source.conversation_id or None,
            sdk_options={'enable_file_checkpointing':True,'permission_mode':'dontAsk'},sdk_action=action,
            ephemeral=False if local_normal else source.ephemeral,execution_mode="persistent" if local_normal else source.execution_mode,
            ephemeral_retention=source.ephemeral_retention,ephemeral_ttl_minutes=source.ephemeral_ttl_minutes)

    async def sdk_session(self, task_id: str, operation: str, arguments: dict, request_id: str) -> dict:
        """Scope native transcript helpers to one Task's account and workspace."""
        from coderfleet.claude_sdk import _command, features_source, control_source
        from coderfleet.data.scripts.coderfleet_sdk_features import SESSION_SCHEMAS, SESSION_MUTATIONS, validate
        from coderfleet.data.scripts.coderfleet_sdk_control import ControlMailbox
        if operation not in SESSION_SCHEMAS: raise ValueError('未知原生会话操作')
        validate(arguments,SESSION_SCHEMAS[operation],'arguments')
        source = self.get_task(task_id)
        if source is None: raise ValueError('来源 Task 不存在')
        if source.type.value != 'claude' or not source.native_session_id:
            raise RuntimeError('Task 没有 Claude 原生会话')
        account = next((a for a in self.get_accounts() if a.name == source.account),None)
        if account is None: raise RuntimeError('来源账号不存在')
        if source.execution_runtime and source.execution_runtime != account.runtime.value:
            raise RuntimeError('来源账号运行位置已改变')
        if not source.sdk_control_token:
            source.sdk_control_token = secrets.token_hex(32)
            source.save(self.tasks_dir)
        root = self._sdk_control_directory(source).parent.parent
        key = self._sdk_workspace_key(source)
        mailbox = ControlMailbox(root / '.coderfleet-tasks' / f'{task_id}.sessions',task_id,source.sdk_control_token)
        is_new = not mailbox.has_command(request_id)
        tasks = Task.load_all(self.tasks_dir)
        mutating = operation in SESSION_MUTATIONS
        if is_new and mutating:
            if operation == 'fork':
                parent = self.get_conversation(source.conversation_id) if source.conversation_id else None
                project = self.find_project_by_name(source.project_name) if source.project_name else None
                local_normal = account.runtime == AccountRuntime.local and project is not None and not project.ephemeral and source.project != 'ephemeral'
                if (parent and parent.ephemeral) or (source.ephemeral and not local_normal):
                    raise RuntimeError('原生分叉需要普通项目工作区；临时工作区不会被静默替换或复制')
            if self._sdk_workspace_busy(key) or any(self._task_is_active(t) and self._sdk_workspace_key(t) == key for t in tasks):
                raise RuntimeError('请先停止此项目的任务，再修改原生会话')
            if operation == 'delete':
                if arguments['confirm_session_id'] != source.native_session_id: raise ValueError('删除确认的 session ID 不匹配')
                references = [t for t in tasks if t.account == source.account and t.native_session_id == source.native_session_id]
                conversations = [c for c in self.list_conversations(include_archived=True) if c.account == source.account and c.native_session_id == source.native_session_id]
                if any(not t.archived for t in references) or any(c.status != ConversationStatus.archived for c in conversations):
                    raise RuntimeError('原生记录仍被未归档的任务或会话引用；归档后才能明确删除')
            self._sdk_native_busy.add(key)
            self._write_sdk_artifact(root/'.coderfleet-tasks/sdk-session-lease.json',
                json.dumps({'task_id':task_id,'request_id':request_id}).encode())
        process_name = 'coderfleet-sdk-session-' + uuid.uuid4().hex[:12]
        runtime = self._runtime_for(account)
        launched = False
        try:
            mailbox.publish('accepting')
            mailbox.submit(request_id,'session',{'operation':operation,'arguments':arguments},timeout=60)
            prior = mailbox.reply(request_id)
            if prior: return self._sdk_session_result(source,operation,arguments,request_id,prior)
            if not is_new: raise TimeoutError('原生操作结果未知，请使用相同 ID 查询，不能自动重放')
            local = account.runtime == AccountRuntime.local
            project = self.find_project_for_path(source.project,source.account)
            cwd = source.project if local else (self.container_workdir_for_project(project,source.project) if project and not source.ephemeral else '/workspace')
            target_root = str(root) if local else '/workspace'
            artifact = root / '.coderfleet-tasks'
            protocol = control_source(); feature = features_source()
            protocol_name = 'sdk-control-' + hashlib.sha256(protocol).hexdigest()[:16] + '.py'
            feature_name = 'sdk-features-' + hashlib.sha256(feature).hexdigest()[:16] + '.py'
            self._write_sdk_artifact(artifact/protocol_name,protocol)
            self._write_sdk_artifact(artifact/feature_name,feature)
            owned_ids = {t.native_session_id for t in tasks if t.native_session_id and self._sdk_workspace_key(t) == key}
            owned_ids.update(c.native_session_id for c in self.list_conversations(include_archived=True)
                if c.native_session_id and c.account == source.account and (c.project == source.project or c.project_name and c.project_name == source.project_name))
            request = {'task_id':task_id,'operation':operation,'arguments':arguments,'request_id':request_id,
                'cwd':cwd,'project_root':project.path if local and project else target_root,
                'session_id':source.native_session_id,'sdk_options':source.sdk_options,
                'allowed_session_ids':sorted(owned_ids),
                'control_token':source.sdk_control_token,
                'control_directory':str(Path(target_root)/'.coderfleet-tasks'/f'{task_id}.sessions'),
                'protocol_module':str(Path(target_root)/'.coderfleet-tasks'/protocol_name)}
            request_name = f'{task_id}.session-{request_id}.json'
            self._write_sdk_artifact(artifact/request_name,json.dumps(request,ensure_ascii=False).encode(),private=local)
            command = _command(Path(target_root)/'.coderfleet-tasks'/feature_name,[str(Path(target_root)/'.coderfleet-tasks'/request_name)],local=local)
            network = None if local else self._get_ephemeral_network(account)
            if not local and account.proxy != AccountProxy.off and not network:
                raise RuntimeError('无法确认账号 relay 网络，不能启动外部存储 helper')
            env = {name:'' for name in ('ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN')} if local else {}
            self._apply_runtime_proxy(account,env,network)
            if project: env.update(self.get_project_env(project.name))
            env.update(self.get_account_env(account.name))
            env.update(source.task_secrets)
            env['CLAUDE_CONFIG_DIR'] = str(self.local_auth_dir(account)) if local else '/home/byclaw/.claude'
            if local:
                proc = await runtime.run(ContainerSpec(image='',command=['bash','-c',command],env=env,workdir=cwd,name=process_name))
            else:
                # External stores use the same account network/proxy as model Tasks.
                proc = await runtime.run(ContainerSpec(image=self._get_account_image(account,project),
                    command=['bash','-c',command],env=env,workdir=cwd,name=process_name,network=network,remove=True,
                    mounts=[(str(root),'/workspace'),(str(self.workspace_dir/'accounts'/account.name),'/home/byclaw/.claude')]))
            launched = True
            await asyncio.wait_for(proc.communicate(),timeout=45)
            result = mailbox.reply(request_id)
            if not result: raise TimeoutError('原生操作结果尚未确认，请保留原请求 ID 查询')
            return self._sdk_session_result(source,operation,arguments,request_id,result)
        finally:
            if launched:
                await asyncio.wait_for(runtime.remove(process_name),timeout=5)
                await asyncio.wait_for(proc.wait(),timeout=5)
            if mutating and is_new:
                # A receipt or helper completion marker proves the mutation has
                # returned. Unknown termination stays excluded, even after cleanup.
                finished = mailbox.directory / (request_id + '.finished.json')
                if not launched or mailbox.reply(request_id) or finished.is_file():
                    self._sdk_native_busy.discard(key)
                    (root/'.coderfleet-tasks/sdk-session-lease.json').unlink(missing_ok=True)

    def _sdk_session_result(self, source: Task, operation: str, arguments: dict, request_id: str, result: dict) -> dict:
        if operation == 'fork' and result.get('status') == 'accepted':
            session = result.get('result',{}).get('value',{}).get('session_id')
            if not isinstance(session,str): raise RuntimeError('SDK 分叉未返回会话 ID')
            conv_id = 'conv-sdk-' + source.id + '-' + request_id
            conv = self.get_conversation(conv_id)
            if conv is None:
                parent = self.get_conversation(source.conversation_id) if source.conversation_id else None
                project = self.find_project_by_name(source.project_name) if source.project_name else None
                account = next((a for a in self.get_accounts() if a.name == source.account),None)
                semantic_ephemeral = (parent.ephemeral if parent else source.ephemeral and not (account and account.runtime == AccountRuntime.local and project and not project.ephemeral and source.project != 'ephemeral'))
                conv = Conversation(id=conv_id,name=arguments.get('title') or '原生分叉',account=source.account,
                    type=source.type,project=source.project,project_name=source.project_name,native_session_id=session,
                    ephemeral=semantic_ephemeral,ephemeral_retention=source.ephemeral_retention,sdk_options=source.sdk_options)
                conv.save(self.conversations_dir)
            return {**result,'conversation_id':conv.id}
        return result

    def sdk_command_status(self, task_id: str, request_id: str) -> dict:
        from coderfleet.data.scripts.coderfleet_sdk_control import ControlMailbox
        task = self.get_task(task_id)
        if task is None:
            raise ValueError(f"任务 '{task_id}' 不存在")
        if not task.sdk_control_token:
            raise RuntimeError('当前任务不支持 SDK 交互')
        mailbox = ControlMailbox(self._sdk_control_directory(task), task.id, task.sdk_control_token)
        return mailbox.reply(request_id) or {'id':request_id, 'status':'unconfirmed'}

    async def _run(
        self,
        task: Task,
        acc: Account,
        log_path: Path,
        auto: bool,
        conversation: Optional[Conversation] = None,
        container_workdir: str = "",
        container_name: str = "",
        images: list[str] = [],
    ) -> None:
        """后台协程：以 detached 方式启动容器任务，再轮询宿主机日志文件跟踪进度。"""
        detached = False
        launch_attempted = False
        try:
            if container_name and container_workdir:
                git_branch, git_worktree, diff_added, diff_removed = await self._probe_git_context(
                    container_name, container_workdir,
                )
                if git_branch:
                    self._record_git_context(task.id, git_branch, git_worktree, diff_added, diff_removed)
                    # 同步本地对象：_stream_container_log/失败处理分支后续还会用同一个
                    # task 变量 save()，不更新本地字段就会被内存里的旧空值覆盖掉。
                    task.git_branch = git_branch
                    task.git_worktree = git_worktree
                    task.git_diff_added = diff_added
                    task.git_diff_removed = diff_removed

            if task.execution_backend == "sdk":
                current = self.get_task(task.id)
                if current is None or current.status != TaskStatus.running:
                    return

            cli_prompt = self._expand_skill_command(task.prompt, acc.name)
            conversation = self._conversation_for_launch(conversation)
            pending_fork = conversation.fork if conversation and not conversation.native_session_id else None
            if task.execution_backend == "sdk":
                project_root = self._get_project_root(task)
                if project_root is None:
                    raise RuntimeError("找不到 SDK Task 对应的项目根目录")
                inner = self._prepare_sdk_launch(
                    task, acc, project_root, "/workspace", container_workdir or "/workspace",
                    conversation, cli_prompt, images,
                )
                diagnostic = shlex.quote(f"/workspace/.coderfleet-tasks/{task.id}.sdk-diagnostic.log")
                target_log = shlex.quote(f"/workspace/.coderfleet-tasks/{task.id}.log")
                target_exit = shlex.quote(f"/workspace/.coderfleet-tasks/{task.id}.exit")
                body = f"( {inner} ) >> {target_log} 2>> {diagnostic}; cf_sdk_rc=$?; echo $cf_sdk_rc > {target_exit}.tmp; mv {target_exit}.tmp {target_exit}"
                cmd = f"mkdir -p /workspace/.coderfleet-tasks && setsid bash -c {shlex.quote(body)} &"
                self._record_sdk_progress(task, "", log_size=log_path.stat().st_size)
            else:
                cmd = self.build_cli_command(
                    acc.type, cli_prompt, auto, task.id,
                    native_session_id=(pending_fork.source_session_id if pending_fork else conversation.native_session_id) if conversation else "",
                    container_workdir=container_workdir, images=images,
                    model=getattr(task, "model", ""), fork=pending_fork,
                )

            project_env = {}
            if task.project_name:
                try:
                    project_env = self.get_project_env(task.project_name)
                except Exception:
                    pass

            if task.execution_backend == "sdk":
                # Existing containers retain their creation-time environment.
                # Match ephemeral/doctor launches for the account SDK runtime
                # without injecting unrelated account credentials or restarting.
                sdk_python = self.get_account_env(acc.name).get('CODERFLEET_CLAUDE_SDK_PYTHON')
                if sdk_python:
                    project_env['CODERFLEET_CLAUDE_SDK_PYTHON'] = sdk_python
                self._sdk_launching.add(task.id)
                launch_attempted = True
            try:
                proc = await self.runtime.exec(
                    container_name, ["bash", "-c", cmd], env=project_env,
                )
                await proc.wait()
            finally:
                self._sdk_launching.discard(task.id)

            if proc.returncode != 0:
                err = (await proc.stdout.read()).decode("utf-8", errors="replace") if proc.stdout else ""
                raise RuntimeError(f"docker exec failed (exit={proc.returncode}): {err.strip()}")

            project_root = self._get_project_root(task)
            if project_root is None:
                raise RuntimeError(f"找不到任务 {task.id} 对应的项目根目录")

            host_log  = self._host_task_log(project_root, task.id)
            host_exit = self._host_task_exit(project_root, task.id)

            await self._stream_container_log(
                task, acc, log_path, host_log, host_exit, conversation
            )

        except asyncio.CancelledError:
            current = self.get_task(task.id)
            if task.execution_backend == "sdk" and current and current.status == TaskStatus.running:
                detached = True  # Server shutdown detaches the watcher; explicit kill marks killed first.
                return
            self.kill_task_process(task)
            if task.execution_backend == "sdk":
                task = self._finish_sdk_task(task, TaskStatus.killed)
            else:
                task.update_status(TaskStatus.killed, self.tasks_dir)
            self._sync_board_card_for_task(task)
            self._append_log_footer(log_path, "killed")
            asyncio.create_task(self._notify(task))
            return
        except Exception as e:
            if task.execution_backend == "sdk":
                if launch_attempted:
                    try:
                        await self._drain_sdk_task(task)
                    except RuntimeError:
                        detached = True
                        logger.exception("SDK watcher failed; worker exit is unverified [task=%s]", task.id)
                        return
                task = self._finish_sdk_task(task, TaskStatus.failed)
            else:
                task.update_status(TaskStatus.failed, self.tasks_dir)
            self._sync_board_card_for_task(task)
            await self._append_usage_status(log_path, acc, container_name)
            self._append_log_footer(log_path, f"failed: {e}")
            asyncio.create_task(self._notify(task))
            return
        finally:
            self._running.pop(task.id, None)
            if not detached:
                self._cleanup_container_task_files(task)
                asyncio.create_task(self.schedule_next_tasks())

    async def _reattach(self, task: Task) -> None:
        """重新 attach 到一个在 Python 重启后仍存活的容器进程，继续跟踪其日志。"""
        log_path = self.get_log_path(task.id)

        acc = next((a for a in self.get_accounts() if a.name == task.account), None)
        if acc is None:
            task.update_status(TaskStatus.failed, self.tasks_dir)
            self._sync_board_card_for_task(task)
            self._append_log_footer(log_path, "failed: account not found on reattach")
            return

        project_root = self._get_project_root(task)
        if project_root is None:
            task.update_status(TaskStatus.failed, self.tasks_dir)
            self._sync_board_card_for_task(task)
            self._append_log_footer(log_path, "failed: project root not found on reattach")
            return

        host_log  = self._host_task_log(project_root, task.id)
        host_exit = self._host_task_exit(project_root, task.id)
        conversation = self.get_conversation(task.conversation_id) if task.conversation_id else None
        detached = False
        if task.execution_backend == "sdk":
            start_offset = task.sdk_source_offset
            if task.sdk_log_size and log_path.exists():
                with log_path.open("r+b") as destination:
                    destination.truncate(task.sdk_log_size)
        else:
            start_offset = host_log.stat().st_size if host_log.exists() else 0

        try:
            if task.execution_backend != "sdk":
                self._append_log_footer(log_path, "reattached after server restart")
            await self._stream_container_log(
                task, acc, log_path, host_log, host_exit, conversation,
                start_offset=start_offset,
            )
        except asyncio.CancelledError:
            current = self.get_task(task.id)
            if task.execution_backend == "sdk" and current and current.status == TaskStatus.running:
                detached = True
                return
            self.kill_task_process(task)
            if task.execution_backend == "sdk":
                task = self._finish_sdk_task(task, TaskStatus.killed)
            else:
                task.update_status(TaskStatus.killed, self.tasks_dir)
            self._sync_board_card_for_task(task)
            self._append_log_footer(log_path, "killed")
            asyncio.create_task(self._notify(task))
            return
        except Exception as e:
            if task.execution_backend == "sdk":
                try:
                    await self._drain_sdk_task(task)
                except RuntimeError:
                    detached = True
                    logger.exception("SDK reattachment failed; worker exit is unverified [task=%s]", task.id)
                    return
                task = self._finish_sdk_task(task, TaskStatus.failed)
            else:
                task.update_status(TaskStatus.failed, self.tasks_dir)
            self._sync_board_card_for_task(task)
            self._append_log_footer(log_path, f"failed during reattach: {e}")
            asyncio.create_task(self._notify(task))
            return
        finally:
            self._running.pop(task.id, None)
            if not detached:
                self._cleanup_container_task_files(task)
                asyncio.create_task(self.schedule_next_tasks())

    async def _append_usage_status(self, log_path: Path, acc: Account, container_name: str) -> None:
        cmd = self.build_usage_status_command(acc.type)
        if not cmd or not container_name:
            return

        try:
            with log_path.open("a", encoding="utf-8") as f:
                f.write("\n" + "=" * 38 + "\n")
                f.write("usage status:\n")

            proc = await self.runtime.exec(container_name, ["bash", "-lc", cmd])
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=45)
            text = stdout.decode("utf-8", errors="replace").strip()
            if not text:
                text = "未获取到用量信息"
        except Exception as e:
            text = f"用量检查失败：{e}"

        try:
            with log_path.open("a", encoding="utf-8") as f:
                f.write(text + "\n")
        except Exception:
            pass

    def _append_log_footer(self, log_path: Path, result: str) -> None:
        try:
            with log_path.open("a", encoding="utf-8") as f:
                f.write("\n" + "=" * 38 + "\n")
                f.write(f"finished: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} [{result}]\n")
        except Exception:
            pass

    def _extract_and_save_token_usage(self, task: Task, log_path: Path) -> None:
        """Parse completed task log to extract token usage and persist it in the Task JSON."""
        try:
            from coderfleet.server.log_parser import parse_log
            log_text = log_path.read_text(encoding="utf-8", errors="ignore")
            data = parse_log(log_text, task.type.value)
            if data.tokens_input or data.tokens_output or data.cost_usd:
                current = (self.get_task(task.id) or task) if task.execution_backend == "sdk" else task
                current.tokens_input = data.tokens_input
                current.tokens_output = data.tokens_output
                current.cost_usd = data.cost_usd
                current.save(self.tasks_dir)
                task.tokens_input  = data.tokens_input
                task.tokens_output = data.tokens_output
                task.cost_usd      = data.cost_usd
        except Exception:
            pass

    async def _get_hermes_session_id(self, container_name: str) -> str:
        """Query the most recently updated hermes session ID from inside the container."""
        try:
            proc = await self.runtime.exec(
                container_name,
                ["bash", "-lc", "/opt/hermes-venv/bin/hermes sessions export 2>/dev/null | tail -1"],
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
            text = stdout.decode("utf-8", errors="replace").strip()
            if text:
                data = json.loads(text)
                return str(data.get("id", ""))
        except Exception:
            pass
        return ""

    def _get_task_container(self, task: Task) -> Optional[str]:
        """通过任务记录的 project 路径找到对应项目，推导容器名。"""
        project = self.find_project_for_path(task.project, task.account)
        if project is None:
            return None
        return project.container_name(task.type)

    def _get_project_root(self, task: Task) -> Optional[Path]:
        """返回任务所属项目在宿主机的根目录（/workspace 在容器内挂载的目标）。"""
        project = self.find_project_for_path(task.project, task.account)
        if project is None:
            return None
        return Path(project.path)

    def _get_project_root_by_name(self, project_name: str) -> Path:
        """返回按名称查找的项目在宿主机的根目录（不存在时返回临时路径，不抛出异常）。"""
        project = self.find_project_by_name(project_name)
        if project is None:
            return Path("/tmp")
        return Path(project.path)

    @staticmethod
    def _host_task_log(project_root: Path, task_id: str) -> Path:
        return project_root / ".coderfleet-tasks" / f"{task_id}.log"

    @staticmethod
    def _host_task_exit(project_root: Path, task_id: str) -> Path:
        return project_root / ".coderfleet-tasks" / f"{task_id}.exit"

    def _cleanup_container_task_files(self, task: Task) -> None:
        project_root = self._get_project_root(task)
        if project_root is None:
            return
        self._host_task_log(project_root, task.id).unlink(missing_ok=True)
        self._host_task_exit(project_root, task.id).unlink(missing_ok=True)

    def is_task_process_alive(self, task: Task) -> bool:
        container = self._get_task_container(task)
        if container is None:
            return False
        marker = shlex.quote(self.task_process_marker(task.id))
        result = subprocess.run(
            [
                "docker",
                "exec",
                container,
                "bash",
                "-lc",
                f"pgrep -af {marker} >/dev/null",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return result.returncode == 0

    def kill_task_process(self, task: Task) -> None:
        if task.execution_backend == "sdk":
            return  # SDK shutdown uses the owning runtime and its exact worker state.
        container = self._get_task_container(task)
        if container is None:
            return
        marker = shlex.quote(self.task_process_marker(task.id))
        subprocess.run(
            [
                "docker",
                "exec",
                container,
                "bash",
                "-lc",
                f"pkill -TERM -f {marker} || true",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )

    async def _control_sdk_task(self, task: Task, action: Literal["probe", "probe_worker", "term", "kill"] = "probe") -> bool:
        from coderfleet.server.sdk_process import control_sdk_process
        account = next((item for item in self.get_accounts() if item.name == task.account), None)
        local = (task.execution_runtime == "local" if task.execution_runtime else
                 bool(account and account.runtime == AccountRuntime.local))
        root = Path("/workspace")
        if local:
            root = (self.sessions_dir / f"task-{task.id}" if task.project == "ephemeral"
                    else Path(task.project))
        container = "" if local else (task.ephemeral_container_name or self._get_task_container(task) or "")
        return await control_sdk_process(
            self._local_runtime if local else self.runtime,
            container=container, state_path=str(root / ".coderfleet-tasks" / f"{task.id}.sdk-state.json"),
            task_id=task.id, action=action, local=local,
            known_pid=int(task.pid or "0") if local else 0,
        )

    async def _drain_sdk_task(self, task: Task) -> None:
        """Do not release a Conversation until the worker has verifiably exited."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 4

        async def observe(action: Literal["probe", "term", "kill"]) -> bool:
            try:
                return await self._control_sdk_task(task, action)
            except RuntimeError:
                # A container exiting can kill its own in-flight observer. A
                # fresh observation must prove absence; the error itself cannot.
                await asyncio.sleep(0.05)
                return await self._control_sdk_task(task, action)

        while True:
            try:
                alive = await observe("term")
                break
            except RuntimeError:
                if task.id not in self._sdk_launching or loop.time() >= deadline:
                    raise
                await asyncio.sleep(0.05)
        while (alive or task.id in self._sdk_launching) and loop.time() < deadline:
            await asyncio.sleep(0.05)
            alive = await observe("term" if task.id in self._sdk_launching else "probe")
        if task.id in self._sdk_launching:
            raise RuntimeError("SDK 启动尚未确认，无法确认停止；任务不会被自动重放")
        if alive:
            alive = await observe("kill")
            for _ in range(3):
                if not alive:
                    break
                await asyncio.sleep(0.1)
                alive = await observe("probe")
        if alive:
            raise RuntimeError("SDK worker 尚未退出；任务继续占用会话以防止重复执行")

    async def reconcile_running_tasks(self) -> int:
        """
        服务启动时调用：对状态仍为 running 的任务做恢复处理。
        - 容器进程仍存活 → 重新 attach，任务继续执行
        - 容器进程已消亡 → 读 exit 文件恢复最终状态，或标记 failed
        """
        reconciled = 0
        for task in Task.load_all(self.tasks_dir):
            if task.status != TaskStatus.running:
                continue

            if task.execution_backend == "sdk":
                acc = next((account for account in self.get_accounts() if account.name == task.account), None)
                local = (task.execution_runtime == "local" if task.execution_runtime else
                         bool(acc and acc.runtime == AccountRuntime.local))
                if not local and not task.ephemeral:
                    bg = asyncio.create_task(self._reattach(task), name=f"task-{task.id}")
                    self._running[task.id] = bg
                else:
                    # These paths have no durable stdout attachment. Never replay them.
                    try:
                        await self._drain_sdk_task(task)
                    except RuntimeError:
                        logger.exception("SDK recovery could not verify worker exit; Task remains running [task=%s]", task.id)
                        continue
                    if local:
                        await self._local_runtime.remove(task.ephemeral_container_name)
                    elif task.ephemeral_container_name:
                        await self.runtime.remove(task.ephemeral_container_name)
                    task = self._finish_sdk_task(task, TaskStatus.failed)
                    self._append_log_footer(self.get_log_path(task.id), "failed: server restarted; SDK output cannot be reattached for this runtime")
                reconciled += 1
                continue

            if self.is_task_process_alive(task):
                bg = asyncio.create_task(
                    self._reattach(task),
                    name=f"task-{task.id}",
                )
                self._running[task.id] = bg
                reconciled += 1
                continue

            # 进程已消亡：尝试从 exit 文件恢复状态
            project_root = self._get_project_root(task)
            if project_root is not None:
                exit_file = self._host_task_exit(project_root, task.id)
                if exit_file.exists():
                    try:
                        rc = int(exit_file.read_text().strip())
                        status = TaskStatus.done if rc == 0 else TaskStatus.failed
                        result = "done" if rc == 0 else f"failed (exit={rc})"
                    except (ValueError, OSError):
                        status = TaskStatus.failed
                        result = "failed: server restarted; could not read exit code"
                else:
                    status = TaskStatus.failed
                    result = "failed: server restarted; no container process or exit file found"
            else:
                status = TaskStatus.failed
                result = "failed: server restarted; project root not found"

            task.update_status(status, self.tasks_dir)
            self._sync_board_card_for_task(task)
            self._append_log_footer(self.get_log_path(task.id), result)
            self._cleanup_container_task_files(task)
            reconciled += 1

        return reconciled

    # ── 终止任务 ──────────────────────────────────────────

    async def kill_task(self, task_id: str) -> Task:
        task = self.get_task(task_id)
        if task is None:
            raise ValueError(f"任务 '{task_id}' 不存在")
        if task.status not in (TaskStatus.running, TaskStatus.pending, TaskStatus.scheduled):
            raise RuntimeError(f"任务状态为 '{task.status.value}'，只能终止 running、pending 或 scheduled 状态的任务")

        if task.status in (TaskStatus.pending, TaskStatus.scheduled):
            old_status = task.status
            task.update_status(TaskStatus.killed, self.tasks_dir)
            self._sync_board_card_for_task(task)
            reason = "killed by user (cancelled schedule)" if old_status == TaskStatus.scheduled else "killed by user (while pending)"
            self._append_log_footer(self.get_log_path(task_id), reason)
            # 异步触发一次调度，确保释放该队列的后续处理（以防万一）
            asyncio.create_task(self.schedule_next_tasks())
            return task

        if task.execution_backend == "sdk":
            await self._drain_sdk_task(task)
            current = self.get_task(task_id) or task
            if current.status in (TaskStatus.done, TaskStatus.failed, TaskStatus.killed):
                await self._notify(current)
                return current
            task = self._finish_sdk_task(task, TaskStatus.killed)
            bg = self._running.get(task_id)
            if bg and not bg.done():
                bg.cancel()
                try:
                    await asyncio.wait_for(asyncio.shield(bg), timeout=3)
                except (asyncio.CancelledError, asyncio.TimeoutError):
                    pass
            else:
                self._append_log_footer(self.get_log_path(task_id), task.status.value)
            await self._notify(task)
            asyncio.create_task(self.schedule_next_tasks())
            return self.get_task(task_id) or task

        # 先更新状态防止并发写入
        task.update_status(TaskStatus.killed, self.tasks_dir)
        self._sync_board_card_for_task(task)
        self.kill_task_process(task)
        bg = self._running.pop(task_id, None)
        if bg and not bg.done():
            bg.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(bg), timeout=3)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

        self._append_log_footer(self.get_log_path(task_id), "killed by user")
        # 触发下一次调度
        asyncio.create_task(self.schedule_next_tasks())
        return task

    def delete_task(self, task_id: str) -> None:
        task = self.get_task(task_id)
        if task and task.status == TaskStatus.running:
            raise RuntimeError(f"任务 '{task_id}' 正在运行，无法删除")
        json_path = self.tasks_dir / f"{task_id}.json"
        log_path  = self.tasks_dir / f"{task_id}.log"
        if not json_path.exists():
            raise ValueError(f"任务 '{task_id}' 不存在")
        json_path.unlink(missing_ok=True)
        log_path.unlink(missing_ok=True)

    def archive_task(self, task_id: str, archived: bool) -> Task:
        task = self.get_task(task_id)
        if task is None:
            raise ValueError(f"任务 '{task_id}' 不存在")
        task.archived = archived
        task.save(self.tasks_dir)
        return task

    def update_task_prompt(self, task_id: str, new_prompt: str) -> Task:
        task = self.get_task(task_id)
        if task is None:
            raise ValueError(f"任务 '{task_id}' 不存在")
        if task.status not in (TaskStatus.pending, TaskStatus.scheduled):
            raise RuntimeError(f"只能修改 pending/scheduled 状态的任务，当前状态：{task.status.value}")
        task.prompt = new_prompt.strip()
        task.save(self.tasks_dir)
        return task

    def _register_task_in_pipeline(self, task_id: str, pipeline_id: str) -> None:
        """将任务 ID 注册到 pipeline 的 task_ids 列表（幂等）。"""
        try:
            pipeline = self.get_pipeline(pipeline_id)
            if pipeline and task_id not in pipeline.task_ids:
                pipeline.task_ids.append(task_id)
                pipeline.touch(self.pipelines_dir)
        except Exception:
            pass

    # ── 清理旧记录 ────────────────────────────────────────

    def clean_tasks(self, keep: int = 30) -> int:
        all_tasks = Task.load_all(self.tasks_dir)
        if len(all_tasks) <= keep:
            return 0
        cleaned = 0
        for task in all_tasks[keep:]:
            if task.status == TaskStatus.running:
                continue
            json_path = self.tasks_dir / f"{task.id}.json"
            log_path  = self.tasks_dir / f"{task.id}.log"
            json_path.unlink(missing_ok=True)
            log_path.unlink(missing_ok=True)
            cleaned += 1
        return cleaned

    # ── Pipeline CRUD ─────────────────────────────────────

    @staticmethod
    def new_pipeline_id() -> str:
        ts   = datetime.now().strftime("%Y%m%d%H%M%S")
        rand = random.randint(0, 9999)
        return f"pipe-{ts}-{rand:04d}"

    @staticmethod
    def new_workflow_run_id() -> str:
        ts   = datetime.now().strftime("%Y%m%d%H%M%S")
        rand = random.randint(0, 9999)
        return f"run-{ts}-{rand:04d}"

    def list_pipelines(self) -> list[Pipeline]:
        return Pipeline.load_all(self.pipelines_dir)

    def get_pipeline(self, pipeline_id: str) -> Optional[Pipeline]:
        path = self.pipelines_dir / f"{pipeline_id}.json"
        if not path.exists():
            return None
        return Pipeline.load(path)

    def _migrate_pipelines_to_workflow_runs(self) -> None:
        """
        一次性 backfill（幂等）：为每个缺少对应 WorkflowRun 的历史 Pipeline
        （含无模板的手动流水线）持久化一份 WorkflowRun，使全部历史运行都能经
        /api/workflow-runs 持久查看。执行引擎脱离 Pipeline 的工作见 #28。
        """
        if self._pipeline_migration_done:
            return
        self._pipeline_migration_done = True
        if not self.pipelines_dir.exists():
            return
        existing = {
            r.legacy_pipeline_id
            for r in WorkflowRun.load_all(self.workflow_runs_dir)
            if r.legacy_pipeline_id
        }
        for pipeline in self.list_pipelines():
            if pipeline.id in existing:
                continue
            try:
                self._workflow_run_from_pipeline(pipeline).save(self.workflow_runs_dir)
            except Exception:
                continue

    def list_workflow_runs(self) -> list[WorkflowRun]:
        self._migrate_pipelines_to_workflow_runs()
        runs = WorkflowRun.load_all(self.workflow_runs_dir)
        known_legacy_ids = {r.legacy_pipeline_id for r in runs if r.legacy_pipeline_id}
        for pipeline in self.list_pipelines():
            if pipeline.template_id and pipeline.id not in known_legacy_ids:
                runs.append(self._workflow_run_from_pipeline(pipeline))
        return sorted(runs, key=lambda r: parse_iso(r.updated) if r.updated else utc_now(), reverse=True)

    def _find_workflow_run_by_legacy_pipeline_id(self, pipeline_id: str) -> Optional[WorkflowRun]:
        """按 legacy_pipeline_id 查找 WorkflowRun：先查内存索引，未命中才扫一遍
        workflow_runs/ 目录——扫描顺带把遇到的映射关系记进索引，下次同样的
        （或别的）legacy id 查找不必再扫一遍全量目录。"""
        cached_run_id = self._legacy_pipeline_run_ids.get(pipeline_id)
        if cached_run_id:
            cached_path = self.workflow_runs_dir / f"{cached_run_id}.json"
            if cached_path.exists():
                return WorkflowRun.load(cached_path)
            self._legacy_pipeline_run_ids.pop(pipeline_id, None)

        found: Optional[WorkflowRun] = None
        for run in WorkflowRun.load_all(self.workflow_runs_dir):
            if run.legacy_pipeline_id:
                self._legacy_pipeline_run_ids[run.legacy_pipeline_id] = run.id
            if run.legacy_pipeline_id == pipeline_id:
                found = run
        return found

    def get_workflow_run(self, run_id: str) -> Optional[WorkflowRun]:
        path = self.workflow_runs_dir / f"{run_id}.json"
        if path.exists():
            return WorkflowRun.load(path)
        pipeline = self.get_pipeline(run_id)
        if pipeline and pipeline.template_id:
            return self._workflow_run_from_pipeline(pipeline)
        return self._find_workflow_run_by_legacy_pipeline_id(run_id)

    def get_workflow_run_by_legacy_pipeline_id(self, pipeline_id: str) -> Optional[WorkflowRun]:
        run = self._find_workflow_run_by_legacy_pipeline_id(pipeline_id)
        if run:
            return run
        pipeline = self.get_pipeline(pipeline_id)
        if pipeline and pipeline.template_id:
            return self._workflow_run_from_pipeline(pipeline)
        return None

    def delete_workflow_run(self, run_id: str) -> None:
        run = self.get_workflow_run(run_id)
        if run is None:
            raise ValueError(f"工作流运行 '{run_id}' 不存在")
        path = self.workflow_runs_dir / f"{run.id}.json"
        if path.exists():
            path.unlink()
        if run.legacy_pipeline_id:
            legacy_path = self.pipelines_dir / f"{run.legacy_pipeline_id}.json"
            if legacy_path.exists():
                legacy_path.unlink()

    async def cancel_workflow_run(self, run_id: str) -> WorkflowRun:
        """取消整个工作流运行：终止后台协程、杀所有子任务、更新状态。"""
        run = self.get_workflow_run(run_id)
        if run is None:
            raise ValueError(f"工作流运行 '{run_id}' 不存在")
        if run.status not in ("running", "waiting_approval"):
            raise RuntimeError(f"工作流状态为 '{run.status}'，只能取消 running 状态的工作流")

        # 取消后台 pipeline 协程（按 asyncio.Task 名称匹配）
        pipeline_id = run.legacy_pipeline_id or run_id
        target_names = {f"pipeline-{pipeline_id}", f"pipeline-resume-{pipeline_id}"}
        for task_obj in asyncio.all_tasks():
            if task_obj.get_name() in target_names:
                task_obj.cancel()

        # 终止所有 running / pending 子任务
        for ne in run.node_executions:
            if ne.task_id and ne.state in (WorkflowNodeState.running, WorkflowNodeState.pending):
                try:
                    await self.kill_task(ne.task_id)
                except Exception:
                    pass
            if ne.state in (WorkflowNodeState.running, WorkflowNodeState.pending, WorkflowNodeState.waiting_deps):
                ne.state = WorkflowNodeState.cancelled

        # 更新 Pipeline 持久状态（兼容旧模型）
        if run.legacy_pipeline_id:
            pipeline = self.get_pipeline(run.legacy_pipeline_id)
            if pipeline:
                pipeline.status = "failed"
                pipeline.last_error = "用户取消"
                pipeline.touch(self.pipelines_dir)

        run.status = "cancelled"
        run.updated = now_iso()
        # WorkflowRun 只有 legacy pipeline bridge 会在 workflow_runs_dir 有文件；
        # 纯 legacy run 不在 workflow_runs_dir，无需 save
        path = self.workflow_runs_dir / f"{run.id}.json"
        if path.exists():
            run.save(self.workflow_runs_dir)
        return run

    def _workflow_run_from_pipeline(self, pipeline: Pipeline) -> WorkflowRun:
        task_map = {t.id: t for t in self.list_tasks()}
        node_executions: list[NodeExecution] = []
        for nr in pipeline.node_runs:
            task = task_map.get(nr.task_id)
            state = WorkflowNodeState.pending
            started_at = ""
            finished_at = ""
            error_message = ""
            if task:
                started_at = task.created
                finished_at = task.finished or ""
                if task.status == TaskStatus.running:
                    state = WorkflowNodeState.running
                elif task.status == TaskStatus.done:
                    state = WorkflowNodeState.succeeded
                elif task.status == TaskStatus.killed:
                    state = WorkflowNodeState.cancelled
                    error_message = "任务已终止"
                elif task.status == TaskStatus.failed:
                    state = WorkflowNodeState.failed
                    error_message = pipeline.last_error
                else:
                    state = WorkflowNodeState.pending
            node_executions.append(NodeExecution(
                node_id          = nr.node_id,
                name             = nr.node_name,
                state            = state,
                target_mode      = nr.target_mode,
                project_name     = nr.project_name,
                project_role     = nr.project_role,
                account          = getattr(nr, "account", ""),
                execution_mode   = getattr(nr, "execution_mode", "inherit"),
                output_dir       = getattr(nr, "output_dir", ""),
                ephemeral_retention = getattr(nr, "ephemeral_retention", "release_on_finish"),
                ephemeral_ttl_minutes = getattr(nr, "ephemeral_ttl_minutes", 120),
                task_id          = nr.task_id,
                attempt_count    = 1 if nr.task_id else 0,
                resolved_project = nr.resolved_project,
                actual_prompt    = nr.actual_prompt,
                started_at       = started_at,
                finished_at      = finished_at,
                error_message    = error_message,
            ))
        return WorkflowRun(
            id                 = pipeline.id,
            template_id        = pipeline.template_id,
            name               = pipeline.name,
            trigger_input      = pipeline.trigger_input,
            status             = self._workflow_status_from_pipeline_status(pipeline.status),
            node_executions    = node_executions,
            created            = pipeline.created,
            updated            = pipeline.updated,
            legacy_pipeline_id = pipeline.id,
            project_map        = pipeline.project_map,
            default_account    = getattr(pipeline, "default_account", ""),
            workspace_policy   = getattr(pipeline, "workspace_policy", "isolated"),
            shared_conversation_id = getattr(pipeline, "shared_conversation_id", ""),
            artifact_dir       = getattr(pipeline, "artifact_dir", ""),
        )

    @staticmethod
    def _workflow_status_from_pipeline_status(status: str) -> str:
        if status == "succeeded":
            return "succeeded"
        if status == "partial":
            return "partial"
        if status == "failed":
            return "failed"
        return "running"

    def _create_workflow_run_for_pipeline(
        self,
        pipeline: Pipeline,
        tpl: WorkflowTemplate,
        sorted_nodes: list[TemplateNode],
        resolved_projects: dict[str, str],
    ) -> WorkflowRun:
        now = now_iso()
        node_executions = [
            NodeExecution(
                node_id          = node.node_id,
                name             = node.name or node.node_id,
                state            = WorkflowNodeState.waiting_deps if node.depends_on else WorkflowNodeState.pending,
                depends_on       = list(node.depends_on or []),
                target_mode      = getattr(node, "target_mode", "default") or "default",
                project_name     = getattr(node, "project_name", ""),
                project_role     = getattr(node, "project_role", ""),
                account          = getattr(node, "account", ""),
                execution_mode   = getattr(node, "execution_mode", "inherit") or "inherit",
                output_dir       = getattr(node, "output_dir", "") or "",
                ephemeral_retention = getattr(node, "ephemeral_retention", "release_on_finish") or "release_on_finish",
                ephemeral_ttl_minutes = getattr(node, "ephemeral_ttl_minutes", 120) or 120,
                resolved_project = resolved_projects.get(node.node_id, ""),
            )
            for node in sorted_nodes
        ]
        run = WorkflowRun(
            id                 = self.new_workflow_run_id(),
            template_id        = tpl.id,
            name               = pipeline.name,
            trigger_input      = pipeline.trigger_input,
            status             = "running",
            node_executions    = node_executions,
            created            = now,
            updated            = now,
            legacy_pipeline_id = pipeline.id,
            project_map        = dict(pipeline.project_map),
            default_account    = getattr(pipeline, "default_account", ""),
            workspace_policy   = getattr(pipeline, "workspace_policy", "isolated"),
            shared_conversation_id = getattr(pipeline, "shared_conversation_id", ""),
            artifact_dir       = getattr(pipeline, "artifact_dir", ""),
        )
        run.save(self.workflow_runs_dir)
        return run

    def _update_workflow_node(
        self,
        pipeline_id: str,
        node_id: str,
        **updates,
    ) -> None:
        run = self.get_workflow_run_by_legacy_pipeline_id(pipeline_id)
        if run is None or run.legacy_pipeline_id != pipeline_id:
            return
        # append_attempt 追加一条尝试记录（不覆盖），用于前端展示重试历史
        attempt = updates.pop("append_attempt", None)
        for node in run.node_executions:
            if node.node_id == node_id:
                for key, value in updates.items():
                    setattr(node, key, value)
                if attempt is not None:
                    node.attempts.append(attempt)
                break
        run.updated = now_iso()
        run.save(self.workflow_runs_dir)

    def _update_workflow_run_from_pipeline(self, pipeline: Pipeline) -> None:
        run = self.get_workflow_run_by_legacy_pipeline_id(pipeline.id)
        if run is None or run.legacy_pipeline_id != pipeline.id:
            return
        run.status = self._workflow_status_from_pipeline_status(pipeline.status)
        run.updated = pipeline.updated
        run.save(self.workflow_runs_dir)

    def create_pipeline(self, name: str, task_ids: list[str] = [], project_name: str = "") -> Pipeline:
        pipeline = Pipeline(
            id           = self.new_pipeline_id(),
            name         = name,
            project_name = project_name,
            task_ids     = list(task_ids),
        )
        pipeline.save(self.pipelines_dir)
        # 反向更新已有任务的 pipeline_id
        for tid in task_ids:
            task = self.get_task(tid)
            if task and not task.pipeline_id:
                task.pipeline_id = pipeline.id
                task.save(self.tasks_dir)
        return pipeline

    def add_task_to_pipeline(self, pipeline_id: str, task_id: str) -> Pipeline:
        pipeline = self.get_pipeline(pipeline_id)
        if pipeline is None:
            raise ValueError(f"工作流 '{pipeline_id}' 不存在")
        if task_id not in pipeline.task_ids:
            pipeline.task_ids.append(task_id)
        pipeline.touch(self.pipelines_dir)
        # 更新任务记录
        task = self.get_task(task_id)
        if task and not task.pipeline_id:
            task.pipeline_id = pipeline_id
            task.save(self.tasks_dir)
        return pipeline

    def delete_pipeline(self, pipeline_id: str) -> None:
        path = self.pipelines_dir / f"{pipeline_id}.json"
        if not path.exists():
            raise ValueError(f"工作流 '{pipeline_id}' 不存在")
        path.unlink()

    async def resume_pipeline(self, pipeline_id: str) -> "Pipeline":
        """
        从上次失败/中断的节点恢复执行。
        已成功的节点不重跑，使用其历史输出继续向下游传递。
        """
        from coderfleet.server.log_parser import parse_log

        pipeline = self.get_pipeline(pipeline_id)
        if pipeline is None:
            raise ValueError(f"工作流 '{pipeline_id}' 不存在")
        if not pipeline.template_id:
            raise ValueError("此工作流没有关联模板，无法 resume")

        tpl = self.get_template(pipeline.template_id)
        if tpl is None:
            raise ValueError(f"源模板 '{pipeline.template_id}' 不存在")

        sorted_nodes = self._topo_sort_nodes(tpl.nodes)

        # ── 重建已成功节点的输出 ─────────────────────────────
        node_outputs: dict[str, str] = {}
        succeeded_node_ids: set[str] = set()
        skipped_node_ids:   set[str] = set()
        task_map = {t.id: t for t in self.list_tasks()}

        # 1) 从 pipeline.node_runs 恢复已完成的 task 节点
        for nr in pipeline.node_runs:
            task = task_map.get(nr.task_id)
            if task and task.status == TaskStatus.done:
                log_path = self.get_log_path(nr.task_id)
                if log_path.exists():
                    log_text = log_path.read_text(encoding="utf-8", errors="ignore")
                    data = parse_log(log_text, task.type.value)
                    node_outputs[nr.node_id] = data.text
                else:
                    node_outputs[nr.node_id] = ""
                succeeded_node_ids.add(nr.node_id)

        # 2) 从 WorkflowRun.node_executions 恢复非 task 节点（condition/delay/approval/skipped）
        wf_run = self.get_workflow_run_by_legacy_pipeline_id(pipeline_id)
        if wf_run:
            for ne in wf_run.node_executions:
                if ne.state == WorkflowNodeState.succeeded and ne.node_id not in succeeded_node_ids:
                    node_outputs[ne.node_id] = (ne.outputs or {}).get("text", "")
                    succeeded_node_ids.add(ne.node_id)
                elif ne.state == WorkflowNodeState.skipped:
                    node_outputs[ne.node_id] = ""
                    skipped_node_ids.add(ne.node_id)

        # ── 确定需要重跑的节点 ───────────────────────────────
        terminal_ids   = succeeded_node_ids | skipped_node_ids
        failed_node_ids = {n.node_id for n in sorted_nodes} - terminal_ids

        if not failed_node_ids:
            pipeline.status = "succeeded"
            pipeline.touch(self.pipelines_dir)
            return pipeline

        # ── 重建 resolved_projects（优先用存储的 project_map / default_project）──
        project_map     = dict(pipeline.project_map)
        default_project = pipeline.default_project
        default_account = getattr(pipeline, "default_account", "")
        resolved_projects: dict[str, str] = {}
        for node in sorted_nodes:
            node_type = getattr(node, "node_type", NodeType.task)

            # 非 task 节点（condition/delay/approval）不需要项目
            if node_type != NodeType.task:
                resolved_projects[node.node_id] = ""
                continue

            if node.node_id in succeeded_node_ids:
                # 已成功任务节点：从 node_runs 取已解析的项目（保持一致）
                nr = next((r for r in pipeline.node_runs if r.node_id == node.node_id), None)
                resolved_projects[node.node_id] = nr.resolved_project if nr else ""
            elif node.node_id in skipped_node_ids:
                resolved_projects[node.node_id] = ""
            else:
                target_mode = getattr(node, "target_mode", "default") or "default"
                execution_mode = getattr(node, "execution_mode", "inherit") or "inherit"
                if target_mode == "fixed_project":
                    resolved_projects[node.node_id] = node.project_name
                elif target_mode == "runtime_role":
                    resolved_projects[node.node_id] = project_map.get(node.project_role) or project_map.get(node.node_id) or ""
                else:
                    resolved_projects[node.node_id] = project_map.get(node.node_id) or default_project
                if not resolved_projects[node.node_id]:
                    if execution_mode == "ephemeral" and (getattr(node, "account", "") or default_account):
                        continue
                    raise ValueError(f"节点「{node.name or node.node_id}」无法解析执行项目，请重新运行模板")

        # ── 构建仅含待执行节点的 level_groups ────────────────
        from collections import defaultdict
        dep_levels: dict[str, int] = {}
        for node in sorted_nodes:
            level = max((dep_levels.get(d, -1) for d in (node.depends_on or [])), default=-1) + 1
            dep_levels[node.node_id] = level

        # 条件节点的 branches.next_nodes 视为隐式依赖（保持和 run_template 一致）
        _changed = True
        while _changed:
            _changed = False
            for node in sorted_nodes:
                if getattr(node, "node_type", "task") == NodeType.condition:
                    cond_level = dep_levels[node.node_id]
                    for branch in (node.branches or []):
                        for nid in (branch.next_nodes or []):
                            if dep_levels.get(nid, -1) <= cond_level:
                                dep_levels[nid] = cond_level + 1
                                _changed = True

        level_groups: dict[int, list] = defaultdict(list)
        for node in sorted_nodes:
            if node.node_id in failed_node_ids:
                level_groups[dep_levels[node.node_id]].append(node)

        # ── 重置状态并在后台重跑 ────────────────────────────
        pipeline.status = "running"
        pipeline.touch(self.pipelines_dir)

        asyncio.create_task(
            self._execute_pipeline_levels(
                pipeline.id, tpl, level_groups, resolved_projects,
                pipeline.trigger_input, initial_node_outputs=node_outputs,
                initial_succeeded=succeeded_node_ids,
                initial_skipped=skipped_node_ids,
            ),
            name=f"pipeline-resume-{pipeline.id}",
        )

        return pipeline

    # ── 工作流模板 CRUD ───────────────────────────────────

    @staticmethod
    def new_template_id() -> str:
        import random
        return "tpl-" + datetime.now().strftime("%Y%m%d%H%M%S") + f"-{random.randint(1000,9999)}"

    def list_templates(self) -> list[WorkflowTemplate]:
        return WorkflowTemplate.load_all(self.templates_dir)

    def get_template(self, template_id: str) -> Optional[WorkflowTemplate]:
        path = self.templates_dir / f"{template_id}.json"
        return WorkflowTemplate.load(path) if path.exists() else None

    def create_template(self, name: str, description: str, nodes: list[TemplateNode]) -> WorkflowTemplate:
        tpl = WorkflowTemplate(id=self.new_template_id(), name=name, description=description, nodes=nodes)
        tpl.save(self.templates_dir)
        return tpl

    def update_template(self, template_id: str, name: str, description: str, nodes: list[TemplateNode]) -> WorkflowTemplate:
        tpl = self.get_template(template_id)
        if tpl is None:
            raise ValueError(f"模板 '{template_id}' 不存在")
        tpl.name = name
        tpl.description = description
        tpl.nodes = nodes
        tpl.touch(self.templates_dir)
        return tpl

    def delete_template(self, template_id: str) -> None:
        path = self.templates_dir / f"{template_id}.json"
        if not path.exists():
            raise ValueError(f"模板 '{template_id}' 不存在")
        path.unlink()

    # ── 模板执行（触发一次运行） ──────────────────────────

    @staticmethod
    def _topo_sort_nodes(nodes: list[TemplateNode]) -> list[TemplateNode]:
        node_map  = {n.node_id: n for n in nodes}
        visited:  set[str] = set()
        result:   list[TemplateNode] = []

        def visit(nid: str) -> None:
            if nid in visited:
                return
            visited.add(nid)
            node = node_map.get(nid)
            if node:
                for dep in node.depends_on:
                    visit(dep)
                result.append(node)

        for node in nodes:
            visit(node.node_id)
        return result

    def _create_shared_workflow_conversation(
        self,
        pipeline: Pipeline,
        sorted_nodes: list[TemplateNode],
        resolved_projects: dict[str, str],
    ) -> Conversation:
        account_names: set[str] = set()
        ttl_minutes = 120
        for node in sorted_nodes:
            if getattr(node, "node_type", NodeType.task) != NodeType.task:
                continue
            if (getattr(node, "execution_mode", "inherit") or "inherit") != "ephemeral":
                continue
            ttl_minutes = max(ttl_minutes, self._normalize_ephemeral_ttl(getattr(node, "ephemeral_ttl_minutes", None)))
            project_name = resolved_projects.get(node.node_id, "")
            if project_name:
                project = self.find_project_by_name(project_name)
                if project:
                    account_names.add(project.account)
            else:
                node_account = getattr(node, "account", "") or getattr(pipeline, "default_account", "")
                if node_account:
                    account_names.add(node_account)

        if not account_names:
            raise ValueError("共享临时沙箱需要至少一个 execution_mode=ephemeral 且能解析账号的任务节点")
        if len(account_names) > 1:
            raise ValueError(f"共享临时沙箱要求所有临时节点使用同一个账号，当前为：{', '.join(sorted(account_names))}")

        account_name = next(iter(account_names))
        acc = next((a for a in self.get_accounts() if a.name == account_name), None)
        if acc is None:
            raise ValueError(f"账号 '{account_name}' 不存在")

        conv_id = self.new_conversation_id()
        conversation = Conversation(
            id           = conv_id,
            name         = f"workflow:{pipeline.id}:shared",
            account      = acc.name,
            type         = acc.type,
            project      = "ephemeral",
            project_name = "",
            ephemeral    = True,
            ephemeral_retention = "keep_until_ttl",
            ephemeral_ttl_minutes = ttl_minutes,
            ephemeral_expires_at = self._ephemeral_expires_at(ttl_minutes),
        )
        conversation.save(self.conversations_dir)
        self._get_session_dir(conversation.id)
        return conversation

    async def run_template(
        self,
        template_id:     str,
        input_str:       str,
        project_map:     dict[str, str],  # role/node_id → project_name
        default_project: str = "",
        default_account: str = "",
        workspace_policy: str = "isolated",
    ) -> Pipeline:
        tpl = self.get_template(template_id)
        if tpl is None:
            raise ValueError(f"模板 '{template_id}' 不存在")
        if not tpl.nodes:
            raise ValueError("模板没有任何节点，无法执行")

        sorted_nodes = self._topo_sort_nodes(tpl.nodes)
        workspace_policy = (workspace_policy or "isolated").strip()
        # artifact_sync 已下线（从未实现真正的目录同步，见 #20）；legacy 值回退为 isolated
        if workspace_policy not in {"isolated", "shared_ephemeral"}:
            workspace_policy = "isolated"
        resolved_projects: dict[str, str] = {}
        for node in sorted_nodes:
            node_type = getattr(node, "node_type", NodeType.task)
            if node_type != NodeType.task:
                # condition / delay / approval 节点不需要项目
                resolved_projects[node.node_id] = ""
                continue

            target_mode = getattr(node, "target_mode", "default") or "default"
            execution_mode = getattr(node, "execution_mode", "inherit") or "inherit"
            node_account = getattr(node, "account", "") or default_account or ""
            if target_mode == "fixed_project":
                project_name = node.project_name
            elif target_mode == "runtime_role":
                project_name = project_map.get(node.project_role) or project_map.get(node.node_id) or ""
            else:
                project_name = project_map.get(node.node_id) or default_project

            if not project_name:
                if execution_mode == "ephemeral" and node_account:
                    resolved_projects[node.node_id] = ""
                    continue
                label = node.name or node.node_id
                raise ValueError(f"节点「{label}」未指定执行项目")
            if self.find_project_by_name(project_name) is None:
                label = node.name or node.node_id
                raise ValueError(f"节点「{label}」配置的项目 '{project_name}' 不存在")
            resolved_projects[node.node_id] = project_name

        # 按拓扑层级分组（同层节点并发，跨层串行并传递输出）
        from collections import defaultdict
        dep_levels: dict[str, int] = {}
        # 先计算所有节点的基础 level（根据显式 depends_on）
        for node in sorted_nodes:
            level = max((dep_levels.get(d, -1) for d in (node.depends_on or [])), default=-1) + 1
            dep_levels[node.node_id] = level

        # 条件节点的 branches.next_nodes 视为隐式依赖：
        # 确保 next_node 的 level >= condition_level + 1，
        # 即便用户没有画显式连线也保证正确顺序。
        changed = True
        while changed:
            changed = False
            for node in sorted_nodes:
                if getattr(node, "node_type", "task") == NodeType.condition:
                    cond_level = dep_levels[node.node_id]
                    for branch in (node.branches or []):
                        for nid in (branch.next_nodes or []):
                            if dep_levels.get(nid, -1) <= cond_level:
                                dep_levels[nid] = cond_level + 1
                                changed = True

        level_groups: dict[int, list[TemplateNode]] = defaultdict(list)
        for node in sorted_nodes:
            level_groups[dep_levels[node.node_id]].append(node)

        # 创建此次运行的 Pipeline（只含元数据，task_ids 由后台协程逐步追加）
        run_name = f"{tpl.name} · {input_str[:30]}" if input_str else tpl.name
        pipeline = Pipeline(
            id              = self.new_pipeline_id(),
            name            = run_name,
            template_id     = tpl.id,
            trigger_input   = input_str,
            status          = "running",
            project_map     = dict(project_map),
            default_project = default_project,
            default_account = default_account,
            workspace_policy = workspace_policy,
        )
        if workspace_policy == "shared_ephemeral":
            shared_conv = self._create_shared_workflow_conversation(pipeline, sorted_nodes, resolved_projects)
            pipeline.shared_conversation_id = shared_conv.id
        pipeline.save(self.pipelines_dir)
        self._create_workflow_run_for_pipeline(pipeline, tpl, sorted_nodes, resolved_projects)

        # 后台协程按层推进：等待上层完成 → 提取输出 → 插值提交下层
        asyncio.create_task(
            self._execute_pipeline_levels(
                pipeline.id, tpl, level_groups, resolved_projects, input_str
            ),
            name=f"pipeline-{pipeline.id}",
        )

        return pipeline

    # ── 模板执行辅助 ──────────────────────────────────────────────

    @staticmethod
    def _extract_step_references(prompt_tpl: str) -> list[str]:
        """Return all node IDs referenced via {{steps.<id>.outputs.text}}."""
        return re.findall(r"\{\{steps\.([^}]+)\.outputs\.text\}\}", prompt_tpl)

    @staticmethod
    def _render_prompt(prompt_tpl: str, input_str: str, node_outputs: dict[str, str]) -> str:
        """
        Replace {{input}} and {{steps.<node_id>.outputs.text}} placeholders.
        Caller must have validated that referenced outputs are available.
        """
        result = prompt_tpl.replace("{{input}}", input_str)
        result = re.sub(
            r"\{\{steps\.([^}]+)\.outputs\.text\}\}",
            lambda m: node_outputs.get(m.group(1), ""),
            result,
        )
        return result

    def _validate_step_references(
        self, node: "TemplateNode", node_outputs: dict[str, str]
    ) -> None:
        """
        检查 prompt_tpl 中引用的上游节点输出是否可用。
        若任意引用的输出不存在或为空，抛出 ValueError，阻止该节点提交。
        """
        refs = self._extract_step_references(node.prompt_tpl)
        if not refs:
            return
        problems: list[str] = []
        for ref_id in refs:
            if ref_id not in node_outputs:
                problems.append(f"节点「{ref_id}」的输出尚未采集（日志可能未落盘）")
            elif not node_outputs[ref_id].strip():
                problems.append(f"节点「{ref_id}」执行成功但输出为空，无法作为上游数据")
        if problems:
            label = node.name or node.node_id
            raise ValueError(
                f"节点「{label}」依赖的上游输出无效，已阻止执行：\n" + "\n".join(f"  · {p}" for p in problems)
            )

    async def _wait_for_task_done(
        self,
        task_id: str,
        poll_interval: float = 2.0,
        timeout: float = 7200.0,
    ) -> "TaskStatus":
        """Poll until the task reaches a terminal state; return that status."""
        elapsed = 0.0
        while elapsed < timeout:
            await asyncio.sleep(poll_interval)
            elapsed += poll_interval
            task = self.get_task(task_id)
            if task is None:
                return TaskStatus.failed
            if task.status in (TaskStatus.done, TaskStatus.failed, TaskStatus.killed):
                return task.status
        return TaskStatus.failed

    async def _submit_pipeline_node(
        self,
        node: "TemplateNode",
        pipeline_id: str,
        resolved_projects: dict[str, str],
        input_str: str,
        node_outputs: dict[str, str],
    ) -> "Task":
        """Submit a single node's task and register it in the pipeline."""
        # 校验上游输出：引用了 {{steps.X.outputs.text}} 而 X 输出为空时直接报错，阻止提交
        self._validate_step_references(node, node_outputs)
        actual_prompt = self._render_prompt(node.prompt_tpl, input_str, node_outputs)
        pname = resolved_projects[node.node_id]
        pipeline = self.get_pipeline(pipeline_id)
        node_account = getattr(node, "account", "") or (getattr(pipeline, "default_account", "") if pipeline else "") or ""
        node_execution_mode = getattr(node, "execution_mode", "inherit") or "inherit"
        node_output_dir = getattr(node, "output_dir", "") or ""
        node_retention = self._normalize_ephemeral_retention(getattr(node, "ephemeral_retention", None))
        node_ttl = self._normalize_ephemeral_ttl(getattr(node, "ephemeral_ttl_minutes", None))
        self._update_workflow_node(
            pipeline_id,
            node.node_id,
            state=WorkflowNodeState.running,
            resolved_project=pname,
            actual_prompt=actual_prompt,
            account=node_account,
            execution_mode=node_execution_mode,
            output_dir=node_output_dir,
            ephemeral_retention=node_retention,
            ephemeral_ttl_minutes=node_ttl,
            started_at=now_iso(),
        )

        task = await self.submit(
            prompt       = actual_prompt,
            project_name = pname,
            account_name = node_account or None,
            auto         = True,
            pipeline_id  = pipeline_id,
            execution_mode = node_execution_mode,
            output_dir     = node_output_dir,
            conversation_id = self._workflow_node_conversation_id(pipeline_id, node, node_retention),
            conversation_name = self._workflow_node_conversation_name(pipeline_id, node, node_retention),
            ephemeral_retention = node_retention,
            ephemeral_ttl_minutes = node_ttl,
        )

        # Update pipeline: add task_id + node_run record
        if pipeline:
            if task.id not in pipeline.task_ids:
                pipeline.task_ids.append(task.id)
            # Replace any previous node_run for this node (retry case)
            pipeline.node_runs = [r for r in pipeline.node_runs if r.node_id != node.node_id]
            pipeline.node_runs.append(PipelineNodeRun(
                node_id          = node.node_id,
                node_name        = node.name,
                task_id          = task.id,
                target_mode      = getattr(node, "target_mode", "default") or "default",
                project_name     = getattr(node, "project_name", ""),
                project_role     = getattr(node, "project_role", ""),
                account          = node_account,
                resolved_project = pname,
                actual_prompt    = actual_prompt,
                execution_mode   = node_execution_mode,
                output_dir       = node_output_dir,
                ephemeral_retention = node_retention,
                ephemeral_ttl_minutes = node_ttl,
            ))
            pipeline.touch(self.pipelines_dir)
            self._update_workflow_node(
                pipeline_id,
                node.node_id,
                task_id=task.id,
                attempt_count=1,
                resolved_project=pname,
                actual_prompt=actual_prompt,
                account=node_account,
                execution_mode=node_execution_mode,
                output_dir=node_output_dir,
                ephemeral_retention=node_retention,
                ephemeral_ttl_minutes=node_ttl,
            )

        return task

    def _workflow_node_conversation_id(
        self,
        pipeline_id: str,
        node: "TemplateNode",
        retention: str,
    ) -> Optional[str]:
        is_ephemeral = (getattr(node, "execution_mode", "inherit") or "inherit") == "ephemeral"
        if is_ephemeral:
            pipeline = self.get_pipeline(pipeline_id)
            if pipeline and getattr(pipeline, "workspace_policy", "isolated") == "shared_ephemeral":
                return getattr(pipeline, "shared_conversation_id", "") or None
            if retention == "release_on_finish":
                return None
        # persistent/inherit 节点（默认、绝大多数工作流场景）也按节点粒度挂一条
        # Conversation，命名规则与 ephemeral 节点一致，使工作流产出的对话能在聊天
        # 界面里原生续链（原生 --resume），不必先手动"升级"成会话（issue #39）。
        name = f"workflow:{pipeline_id}:{node.node_id}"
        return next(
            (
                c.id for c in self.list_conversations(include_archived=True)
                if getattr(c, "ephemeral", False) == is_ephemeral and c.name == name
            ),
            None,
        )

    def _workflow_node_conversation_name(
        self,
        pipeline_id: str,
        node: "TemplateNode",
        retention: str,
    ) -> Optional[str]:
        is_ephemeral = (getattr(node, "execution_mode", "inherit") or "inherit") == "ephemeral"
        if is_ephemeral:
            pipeline = self.get_pipeline(pipeline_id)
            if pipeline and getattr(pipeline, "workspace_policy", "isolated") == "shared_ephemeral":
                return None
            if retention == "release_on_finish":
                return None
        name = f"workflow:{pipeline_id}:{node.node_id}"
        existing = self._workflow_node_conversation_id(pipeline_id, node, retention)
        return None if existing else name

    async def _execute_pipeline_levels(
        self,
        pipeline_id:            str,
        tpl:                    "WorkflowTemplate",
        level_groups:           dict,
        resolved_projects:      dict[str, str],
        input_str:              str,
        initial_node_outputs:   dict[str, str] | None = None,
        initial_succeeded:      set[str] | None       = None,
        initial_skipped:        set[str] | None       = None,
    ) -> None:
        """
        Background coroutine: execute workflow levels sequentially.

        For each level:
          1. Submit all nodes in the level concurrently.
          2. Wait for every node to reach a terminal state (with retry support).
          3. Extract each node's text output.
          4. Proceed to the next level, injecting outputs into prompts via
             {{steps.<node_id>.outputs.text}}.

        initial_node_outputs / initial_succeeded / initial_skipped allow resume
        to seed prior results and skip already-skipped condition-branch nodes.
        """
        try:
            await self._execute_pipeline_levels_inner(
                pipeline_id, tpl, level_groups, resolved_projects,
                input_str, initial_node_outputs, initial_succeeded, initial_skipped,
            )
        except Exception as exc:
            import traceback
            tb = traceback.format_exc()
            print(f"[pipeline {pipeline_id}] UNHANDLED exception in pipeline executor:\n{tb}")
            # Record the error and mark pipeline as failed so the UI can surface it
            try:
                pipeline = self.get_pipeline(pipeline_id)
                if pipeline:
                    pipeline.status     = "failed"
                    pipeline.last_error = str(exc)
                    pipeline.touch(self.pipelines_dir)
                    self._update_workflow_run_from_pipeline(pipeline)
            except Exception:
                pass

    async def _execute_pipeline_levels_inner(
        self,
        pipeline_id:            str,
        tpl:                    "WorkflowTemplate",
        level_groups:           dict,
        resolved_projects:      dict[str, str],
        input_str:              str,
        initial_node_outputs:   dict[str, str] | None = None,
        initial_succeeded:      set[str] | None       = None,
        initial_skipped:        set[str] | None       = None,
    ) -> None:
        from coderfleet.server.log_parser import parse_log

        node_outputs:    dict[str, str] = dict(initial_node_outputs or {})
        pipeline_failed: bool           = False
        node_error:      str            = ""
        succeeded_nodes: set[str]       = set(initial_succeeded or set())
        skipped_nodes:   set[str]       = set(initial_skipped or set())   # 条件分支未命中的节点

        for level in sorted(level_groups.keys()):
            if pipeline_failed:
                break

            nodes: list[TemplateNode] = level_groups[level]

            # ── 先处理特殊节点（条件/延迟/审批），再批量提交任务节点 ──
            # 在同一 level 内，condition 节点必须先于 task 节点求值，
            # 否则 skip 传播检查会在 condition 还未执行时提前通过。
            _type_priority = {"condition": 0, "delay": 1, "approval": 2}
            nodes = sorted(
                nodes,
                key=lambda n: _type_priority.get(getattr(n, "node_type", "task") or "task", 3),
            )

            task_nodes: list[TemplateNode] = []
            for node in nodes:
                # 传播 skip：依赖中有被跳过的节点则本节点也跳过
                _deps = node.depends_on or []
                if node.node_id in skipped_nodes or (_deps and all(d in skipped_nodes for d in _deps)):
                    skipped_nodes.add(node.node_id)
                    node_outputs[node.node_id] = ""
                    self._update_workflow_node(
                        pipeline_id, node.node_id,
                        state=WorkflowNodeState.skipped,
                        finished_at=now_iso(),
                        error_message="未命中条件分支（跳过）",
                    )
                    continue

                node_type = getattr(node, "node_type", NodeType.task)

                if node_type == NodeType.condition:
                    activated = self._eval_condition_branches(node, node_outputs)
                    all_next  = {nid for b in (node.branches or []) for nid in b.next_nodes}
                    skipped_nodes.update(all_next - set(activated))
                    node_outputs[node.node_id] = ""
                    succeeded_nodes.add(node.node_id)
                    self._update_workflow_node(
                        pipeline_id, node.node_id,
                        state=WorkflowNodeState.succeeded,
                        finished_at=now_iso(),
                        error_message="",
                    )
                    print(f"[pipeline {pipeline_id}] condition node {node.node_id}: activated={activated}, skipped={all_next - set(activated)}")

                elif node_type == NodeType.delay:
                    delay_sec = getattr(node, "delay_seconds", 0) or 0
                    print(f"[pipeline {pipeline_id}] delay node {node.node_id}: sleeping {delay_sec}s")
                    self._update_workflow_node(pipeline_id, node.node_id, state=WorkflowNodeState.running)
                    if delay_sec > 0:
                        await asyncio.sleep(delay_sec)
                    node_outputs[node.node_id] = ""
                    succeeded_nodes.add(node.node_id)
                    self._update_workflow_node(
                        pipeline_id, node.node_id,
                        state=WorkflowNodeState.succeeded,
                        finished_at=now_iso(),
                        error_message="",
                    )

                elif node_type == NodeType.approval:
                    approved = await self._wait_for_approval(pipeline_id, node)
                    if approved:
                        node_outputs[node.node_id] = ""
                        succeeded_nodes.add(node.node_id)
                        self._update_workflow_node(
                            pipeline_id, node.node_id,
                            state=WorkflowNodeState.succeeded,
                            finished_at=now_iso(),
                            error_message="",
                        )
                    else:
                        # 被取消（工作流取消时 _wait_for_approval 返回 False）
                        node_error = node_error or f"节点「{node.name or node.node_id}」审批取消"
                        pipeline_failed = True

                else:
                    task_nodes.append(node)

            if pipeline_failed or not task_nodes:
                continue

            # ── 批量提交 task 节点（并发） ──────────────────────
            submit_results = await asyncio.gather(
                *[
                    self._submit_pipeline_node(
                        node, pipeline_id, resolved_projects, input_str, node_outputs
                    )
                    for node in task_nodes
                ],
                return_exceptions=True,
            )

            for node, submit_result in zip(task_nodes, submit_results):
                if isinstance(submit_result, Exception):
                    err_msg = f"节点「{node.name or node.node_id}」提交失败: {submit_result}"
                    print(f"[pipeline {pipeline_id}] node {node.node_id} submit error: {submit_result}")
                    self._update_workflow_node(
                        pipeline_id, node.node_id,
                        state=WorkflowNodeState.failed,
                        finished_at=now_iso(),
                        error_message=str(submit_result),
                    )
                    node_error = node_error or err_msg
                    pipeline_failed = True
                    continue

                task: Task       = submit_result
                max_retries      = getattr(node, "max_retries", 0) or 0
                retry_delay      = getattr(node, "retry_delay_seconds", 30) or 30
                _timeout_attr    = getattr(node, "timeout_minutes", None)
                timeout_min      = _timeout_attr if _timeout_attr is not None else 120
                # 0 = no limit; use 10 years as sentinel for asyncio timeout
                node_timeout_sec = timeout_min * 60 if timeout_min > 0 else 86400 * 365
                attempt          = 0

                while True:
                    final_status  = await self._wait_for_task_done(task.id, timeout=node_timeout_sec)
                    was_timeout   = False

                    # 超时检测：_wait_for_task_done 返回 failed 但任务仍在运行 → 超时
                    if final_status == TaskStatus.failed:
                        live_task = self.get_task(task.id)
                        if live_task and live_task.status == TaskStatus.running:
                            was_timeout = True
                            print(f"[pipeline {pipeline_id}] node {node.node_id} timed out after {timeout_min}min, killing")
                            try:
                                await self.kill_task(task.id)
                            except Exception:
                                pass
                            final_status = TaskStatus.killed  # fall through to retry logic

                    if final_status == TaskStatus.done:
                        log_path = self.get_log_path(task.id)
                        if log_path.exists():
                            log_text = log_path.read_text(encoding="utf-8", errors="ignore")
                            data = parse_log(log_text, task.type.value)
                            node_outputs[node.node_id] = data.text
                            node_output = data.text
                        else:
                            node_outputs[node.node_id] = ""
                            node_output = ""
                        succeeded_nodes.add(node.node_id)
                        _now = now_iso()
                        self._update_workflow_node(
                            pipeline_id, node.node_id,
                            state=WorkflowNodeState.succeeded,
                            outputs={"text": node_output},
                            finished_at=_now,
                            error_message="",
                            append_attempt={"task_id": task.id, "state": "succeeded", "finished_at": _now},
                        )
                        break

                    # Task failed / killed — 记录本次失败尝试后再决定是否重试
                    self._update_workflow_node(
                        pipeline_id, node.node_id,
                        append_attempt={
                            "task_id": task.id,
                            "state": final_status.value,
                            "finished_at": now_iso(),
                        },
                    )
                    if attempt < max_retries:
                        attempt += 1
                        print(
                            f"[pipeline {pipeline_id}] node {node.node_id} "
                            f"failed (attempt {attempt}/{max_retries + 1}), "
                            f"retrying in {retry_delay}s"
                        )
                        await asyncio.sleep(retry_delay)
                        try:
                            task = await self._submit_pipeline_node(
                                node, pipeline_id, resolved_projects, input_str, node_outputs
                            )
                            self._update_workflow_node(
                                pipeline_id, node.node_id,
                                attempt_count=attempt + 1,
                                task_id=task.id,
                            )
                        except Exception as e:
                            print(f"[pipeline {pipeline_id}] node {node.node_id} retry submit failed: {e}")
                            pipeline_failed = True
                            break
                    else:
                        _err_msg = (
                            f"节点超时（>{timeout_min}min）" if was_timeout
                            else f"任务 {task.id} 结束状态: {final_status.value}"
                        )
                        print(
                            f"[pipeline {pipeline_id}] node {node.node_id} "
                            f"permanently failed after {attempt + 1} attempt(s): {_err_msg}"
                        )
                        self._update_workflow_node(
                            pipeline_id, node.node_id,
                            state=WorkflowNodeState.failed,
                            finished_at=now_iso(),
                            error_message=_err_msg,
                        )
                        node_error = node_error or f"节点「{node.name or node.node_id}」{_err_msg}"
                        pipeline_failed = True
                        break

        # ── 更新 Pipeline 最终状态 ──────────────────────────────
        pipeline = self.get_pipeline(pipeline_id)
        if pipeline:
            total_nodes = sum(len(nodes) for nodes in level_groups.values())
            if not pipeline_failed:
                pipeline.status     = "succeeded"
                pipeline.last_error = ""
            elif succeeded_nodes:
                pipeline.status     = "partial"
                pipeline.last_error = node_error
            else:
                pipeline.status     = "failed"
                pipeline.last_error = node_error
            pipeline.touch(self.pipelines_dir)
            self._update_workflow_run_from_pipeline(pipeline)
            print(
                f"[pipeline {pipeline_id}] finished with status={pipeline.status} "
                f"({len(succeeded_nodes)}/{total_nodes} nodes succeeded, "
                f"{len(skipped_nodes)} skipped)"
            )

    async def _wait_for_approval(
        self,
        pipeline_id: str,
        node: "TemplateNode",
        poll_interval: float = 3.0,
    ) -> bool:
        """
        暂停工作流，等待用户通过 /api/workflow-runs/{run_id}/approve 批准。
        返回 True=已批准，False=被取消（工作流被终止或超时）。
        """
        import uuid as _uuid
        token    = _uuid.uuid4().hex
        run      = self.get_workflow_run_by_legacy_pipeline_id(pipeline_id)
        run_id   = run.id if run else pipeline_id

        self._update_workflow_node(
            pipeline_id, node.node_id,
            state=WorkflowNodeState.waiting_approval,
            started_at=now_iso(),
        )

        # 将审批 token 写入 WorkflowRun
        run_path = self.workflow_runs_dir / f"{run_id}.json"
        if run_path.exists():
            run = self.get_workflow_run(run_id)
            if run:
                run.pending_approval_node_id = node.node_id
                run.approval_token           = token
                run.status                   = "waiting_approval"
                run.save(self.workflow_runs_dir)

        # 推送通知
        if self._push_manager:
            label = node.name or node.node_id
            try:
                await self._push_manager.send_all("⏸️ 工作流等待审批", f"节点「{label}」需要您审批后继续执行")
            except Exception:
                pass

        print(f"[pipeline {pipeline_id}] approval node {node.node_id} waiting, token={token}")

        while True:
            await asyncio.sleep(poll_interval)
            run_check = self.get_workflow_run(run_id)
            if run_check is None:
                return False
            if run_check.status == "cancelled":
                return False
            # 审批完成：pending_approval_node_id 被清空
            if not run_check.pending_approval_node_id:
                return True

    async def approve_workflow_run(self, run_id: str, token: str) -> WorkflowRun:
        """用户批准审批节点，工作流继续执行。"""
        run = self.get_workflow_run(run_id)
        if run is None:
            raise ValueError(f"工作流运行 '{run_id}' 不存在")
        if run.status != "waiting_approval":
            raise RuntimeError(f"工作流状态为 '{run.status}'，不在等待审批状态")
        if run.approval_token != token:
            raise ValueError("审批 token 不匹配")
        run.pending_approval_node_id = ""
        run.approval_token           = ""
        run.status                   = "running"
        run.updated                  = now_iso()
        run.save(self.workflow_runs_dir)
        return run

    # ── Intervention：非 auto 任务 CLI 主动暂停问人（issue #69） ──────────
    #
    # 跟 _wait_for_approval/approve_workflow_run 是同一类"暂停等人"机制，但等待方
    # 不一样：_wait_for_approval 是调度器自己的协程等调度器自己的磁盘状态，轮询没问题；
    # 这里真正在等的是（未来接入的）MCP 请求处理协程本身，答案由另一个请求
    # （resolve_intervention）直接塞进同一个 asyncio.Future，轮询只会白白增加延迟。

    async def wait_for_intervention_answer(
        self,
        task_id: str,
        questions: list[dict],
        timeout_seconds: float = DEFAULT_INTERVENTION_TIMEOUT_SECONDS,
        tool_call_id: str | None = None,
    ) -> dict:
        """
        在指定 Task 上登记一个待回答的问题，推送通知，阻塞直到人工作答或超时。

        返回值：正常作答时是提交的 answers dict；超时则是 {"timed_out": True}——
        调用方（未来的 MCP 工具 handler）据此构造"用户未及时回应，请自行判断"这样的
        tool_result，而不是让 CLI 端挂死或报错。

        tool_call_id：调用方（mcp_bridge.py）应该尽量传入 CC 自己这次 MCP 工具调用的
        tool_use id（从 MCP 请求的 `_meta` 里取，真实存在过的 bug：Web UI 的问答卡片
        是按 CC 自己的 tool_use.id 认领的，如果这里另外发一个随机 id，两边永远对不上，
        人工提交答案时 GET 到的 pending_intervention.tool_call_id 永远不等于卡片自己的
        id，每次提交都会被判定成"问题已经不再等待回答"，不是超时/竞态才触发，是必现。
        传不进来（比如某个 MCP 客户端没有对应的 _meta 字段）就退化成随机 id，至少这次
        请求内部自洽，只是前端没法精确对上卡片。
        """
        task = self.get_task(task_id)
        if task is None:
            raise ValueError(f"任务 '{task_id}' 不存在")

        tool_call_id = tool_call_id or uuid.uuid4().hex
        token = uuid.uuid4().hex
        deadline = (utc_now() + timedelta(seconds=timeout_seconds)).isoformat(timespec="seconds")

        intervention = PendingIntervention(
            tool_call_id=tool_call_id,
            questions=[q if isinstance(q, dict) else dict(q) for q in questions],
            token=token,
            deadline=deadline,
        )
        task.pending_intervention = intervention
        task.save(self.tasks_dir)

        key = f"{task_id}:{tool_call_id}"
        future: "asyncio.Future" = asyncio.get_running_loop().create_future()
        self._pending_intervention_futures[key] = future

        if self._push_manager:
            try:
                q_count = len(intervention.questions)
                await self._push_manager.send_all(
                    "❓ 任务等待您的回答",
                    f"任务 {task_id} 有 {q_count} 个问题等待回答",
                )
            except Exception as exc:
                logger.warning("Intervention 推送通知失败 [task=%s]: %s", task_id, exc)

        try:
            answers = await asyncio.wait_for(future, timeout=timeout_seconds)
            logger.info("Intervention 已回答 [task=%s, tool_call_id=%s]", task_id, tool_call_id)
        except asyncio.TimeoutError:
            answers = {"timed_out": True}
            # 目前只落进程日志，不是持久化历史——一个 Intervention 超时/被答后不会
            # 在 Task 记录上留下任何痕迹，只是清空 pending_intervention。完整的可
            # 审计历史（PRD story 5/23）计划由 Web UI 的时间线 pill 承担（issue #69
            # 的 Slice 3），这里先给个最小的、非阻塞的兜底信号。
            logger.info("Intervention 超时未回答 [task=%s, tool_call_id=%s]", task_id, tool_call_id)
        finally:
            # 故意不从 _pending_intervention_futures 里 pop——一个已完成（resolved/
            # timed-out）的 Future 的 done()==True 就是 resolve_intervention() 区分
            # "从没存在过"(404) 和 "存在过但已经处理完"(409/迟到应答) 的唯一依据。
            # Task.pending_intervention 才是"当前是否还在等"的准绳，这里清空它；
            # Future 本身留在内存字典里（每个 Intervention 一条，随进程生命周期，
            # 调度器重启即清空——量级上可接受，见 issue #69 的 restart 边界说明）。
            #
            # 原子读改写：重新加载，只在这条 intervention 仍然是当前这条时才清空——
            # 避免覆盖掉这段等待期间可能发生的其他并发写入。
            t2 = self.get_task(task_id)
            if (
                t2 is not None
                and t2.pending_intervention is not None
                and t2.pending_intervention.tool_call_id == tool_call_id
            ):
                t2.pending_intervention = None
                t2.save(self.tasks_dir)

        return answers

    async def answer_intervention(self, task_id: str, tool_call_id: str, token: str, answers: dict) -> None:
        await self._resolve_sdk_intervention(task_id, tool_call_id, token,
            {'tool_call_id':tool_call_id, 'answers':answers}, kind='native', command='answer')

    async def approve_intervention(
        self, task_id: str, tool_call_id: str, token: str, decision: Literal['allow', 'deny'],
        message: str = '', updated_input: Optional[dict] = None,
    ) -> None:
        payload: dict = {'tool_call_id':tool_call_id, 'decision':decision, 'message':message}
        if updated_input is not None:
            payload['updated_input'] = updated_input
        await self._resolve_sdk_intervention(task_id, tool_call_id, token, payload,
                                              kind='permission', command='approval')

    async def _resolve_sdk_intervention(
        self, task_id: str, tool_call_id: str, token: str, payload: dict,
        *, kind: Literal['native', 'permission'], command: Literal['answer', 'approval'],
    ) -> None:
        from coderfleet.data.scripts.coderfleet_sdk_control import ControlMailbox, MAX_COMMANDS

        task = self.get_task(task_id)
        pending = task.pending_intervention if task else None
        identifier = command + '-' + token
        existing_delivery = False
        if task and task.execution_backend == 'sdk' and task.sdk_control_token:
            mailbox = ControlMailbox(self._sdk_control_directory(task), task.id, task.sdk_control_token)
            for attempt in range(1, MAX_COMMANDS + 1):
                identifier = command + '-' + token + (f'-{attempt}' if attempt > 1 else '')
                if not mailbox.has_command(identifier):
                    break
                receipt = mailbox.reply(identifier)
                if not receipt or receipt['status'] != 'rejected':
                    # An accepted or unknown attempt must keep its immutable payload,
                    # including after question closure or Task completion.
                    existing_delivery = True
                    break
                if not pending or pending.kind != kind or pending.token != token:
                    raise RuntimeError('这个问题已经被回答过或已超时')
            else:
                raise RuntimeError('当前问题的回答尝试次数已达上限')
        if not existing_delivery:
            if pending is None or pending.kind != kind:
                if kind == 'native':
                    self.resolve_intervention(task_id, tool_call_id, token, payload['answers'])
                    return
                raise RuntimeError('当前工具已经不在等待批准')
            if pending.tool_call_id != tool_call_id or pending.token != token:
                raise RuntimeError('问题或 token 不匹配')
        await self.sdk_command(task_id, command, payload,
                               request_id=identifier)
        current = self.get_task(task_id)
        if current and current.pending_intervention and current.pending_intervention.token == token:
            current.pending_intervention = None
            current.save(self.tasks_dir)

    def resolve_intervention(
        self, task_id: str, tool_call_id: str, token: str, answers: dict,
    ) -> None:
        """人工提交答案，解锁对应的 wait_for_intervention_answer() 调用。

        token 校验失败在这里用 RuntimeError（main.py 里映射成 409），跟
        approve_workflow_run 对同一类"token 不匹配"用 ValueError（映射成 400）不是
        同一个约定——这是有意的，不是抄漏了：issue #69 的 PRD 明确把"token 不匹配"
        和"这个问题已经被回答过/已超时"归成同一类"409 冲突"语义（都是"这个操作曾经
        有效，但现在提交晚了/提交错了"），而不是"400 请求本身有问题"。
        """
        if self.get_task(task_id) is None:
            raise ValueError(f"任务 '{task_id}' 不存在")

        key = f"{task_id}:{tool_call_id}"
        future = self._pending_intervention_futures.get(key)
        if future is None:
            raise ValueError(f"任务 '{task_id}' 当前没有待回答的问题")
        if future.done():
            raise RuntimeError("这个问题已经被回答过或已超时")

        task = self.get_task(task_id)
        if task is None or task.pending_intervention is None or task.pending_intervention.token != token:
            raise RuntimeError("token 不匹配")

        future.set_result(answers)

    @staticmethod
    def _eval_condition_branches(node: "TemplateNode", node_outputs: dict[str, str]) -> list[str]:
        """
        求值 condition 节点的各分支，返回命中分支的 next_nodes 列表。
        支持表达式格式：
          "{{steps.X.outputs.text}} contains 'value'"
          "{{steps.X.outputs.text}} not_contains 'value'"
          "{{steps.X.outputs.text}} equals 'value'"
          "else"  （fallback 分支，总为真）
        只取第一个命中的分支。
        """
        import re as _re
        _EXPR_RE = _re.compile(
            r"\{\{steps\.([^}]+)\.outputs\.text\}\}\s+(contains|not_contains|equals)\s+'([^']*)'",
        )
        for branch in (node.branches or []):
            expr = (branch.condition or "").strip()
            if expr == "else":
                return list(branch.next_nodes)
            m = _EXPR_RE.match(expr)
            if not m:
                continue
            ref_id, op, value = m.groups()
            text = node_outputs.get(ref_id, "")
            matched = False
            if op == "contains":
                matched = value in text
            elif op == "not_contains":
                matched = value not in text
            elif op == "equals":
                matched = text.strip() == value
            if matched:
                return list(branch.next_nodes)
        return []

    # ── 逻辑项目（按 path 分组） ──────────────────────────

    def get_logical_projects(self) -> list[LogicalProject]:
        projects = self.get_projects()
        accounts = self.get_accounts()
        acc_map  = {a.name: a for a in accounts}

        groups: dict[str, list[Project]] = {}
        for p in projects:
            canonical = str(Path(p.path).expanduser().resolve())
            groups.setdefault(canonical, []).append(p)

        result = []
        for canonical_path, projs in groups.items():
            entries = [
                LogicalProjectEntry(
                    name    = p.name,
                    account = p.account,
                    type    = acc_map[p.account].type.value if p.account in acc_map else "unknown",
                )
                for p in projs
            ]
            result.append(LogicalProject(
                path         = canonical_path,
                display_name = projs[0].name,
                projects     = entries,
            ))
        return result

    # ── 派生子任务 ────────────────────────────────────────

    async def spawn_subtask(
        self,
        parent_task_id: str,
        prompt:         str,
        project_name:   str,
        auto:           bool         = True,
        wait_for_parent: bool        = True,
        pipeline_id:    Optional[str] = None,
        images:         list[str]    = [],
    ) -> Task:
        parent = self.get_task(parent_task_id)
        if parent is None:
            raise ValueError(f"父任务 '{parent_task_id}' 不存在")

        depends_on = [parent_task_id] if wait_for_parent else []

        # 如果未指定 pipeline，继承父任务的 pipeline
        effective_pipeline_id = pipeline_id or parent.pipeline_id or None

        task = await self.submit(
            prompt         = prompt,
            project_name   = project_name,
            auto           = auto,
            images         = images,
            parent_task_id = parent_task_id,
            depends_on     = depends_on,
            pipeline_id    = effective_pipeline_id,
        )
        return task

    def update_pipeline_node_task(self, pipeline_id: str, old_task_id: str, new_task_id: str) -> None:
        """将 pipeline 中的旧 task_id 替换为重试后的新 task_id（用于 retry 流程）。"""
        pipeline = self.get_pipeline(pipeline_id)
        if pipeline is None:
            return
        if old_task_id in pipeline.task_ids:
            idx = pipeline.task_ids.index(old_task_id)
            pipeline.task_ids[idx] = new_task_id
        for nr in pipeline.node_runs:
            if nr.task_id == old_task_id:
                nr.task_id = new_task_id
        pipeline.touch(self.pipelines_dir)
