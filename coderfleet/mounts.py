"""Extra host-directory mount configuration helpers.

Lets a project bind-mount additional host directories into its container,
beyond the implicit project-path mount (`/workspace`) and the account-auth
mount that `compose.py` always generates. Mirrors `docker_socket.py`'s
shape (parse → dataclass with `.volume` → append to `svc["volumes"]`) so the
two optional-mount features stay consistent.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ExtraMount:
    host_path: str
    container_path: str
    read_only: bool = False

    @property
    def volume(self) -> str:
        suffix = ":ro" if self.read_only else ""
        return f"{self.host_path}:{self.container_path}{suffix}"


def parse_mount_spec(spec: str) -> ExtraMount:
    """Parse one `HOST_PATH:CONTAINER_PATH[:ro|:rw]` token.

    Raises ValueError with a message safe to surface directly to the user
    (CLI ClickException / HTTP 400) on malformed input.
    """
    spec = spec.strip()
    if not spec:
        raise ValueError("挂载配置不能为空")

    parts = spec.split(":")
    if len(parts) == 2:
        host, container = parts
        read_only = False
    elif len(parts) == 3 and parts[2] in ("ro", "rw"):
        host, container, mode = parts
        read_only = mode == "ro"
    else:
        raise ValueError(f"挂载格式错误：{spec!r}，应为 HOST_PATH:CONTAINER_PATH[:ro]")

    host = host.strip()
    container = container.strip()
    if not host:
        raise ValueError(f"挂载格式错误：{spec!r}，宿主机路径不能为空")
    if not container.startswith("/"):
        raise ValueError(f"挂载格式错误：{spec!r}，容器路径必须是绝对路径")

    host = str(Path(host).expanduser())
    return ExtraMount(host_path=host, container_path=container, read_only=read_only)


def parse_mounts(raw: str) -> list[ExtraMount]:
    """Parse a comma-separated `EXTRA_MOUNTS` conf value into `ExtraMount`s."""
    return [parse_mount_spec(token) for token in raw.split(",") if token.strip()]
