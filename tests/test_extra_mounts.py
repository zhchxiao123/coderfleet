from __future__ import annotations

from pathlib import Path

import pytest

from coderfleet.compose import generate_compose
from coderfleet.mounts import parse_mount_spec, parse_mounts
from coderfleet.server.models import Project, ProjectResponse
from coderfleet.server.scheduler import Scheduler


def _write_minimal_workspace(ws: Path, project_path: Path) -> None:
    (ws / "accounts.conf").write_text("NAME=api-codex TYPE=codex AUTH=login\n", encoding="utf-8")
    (ws / "projects.conf").write_text(
        f"NAME=repo ACCOUNT=api-codex PATH={project_path}\n",
        encoding="utf-8",
    )


def test_parse_mount_spec_accepts_rw_by_default(tmp_path: Path) -> None:
    host = tmp_path / "data"
    mount = parse_mount_spec(f"{host}:/data")

    assert mount.host_path == str(host)
    assert mount.container_path == "/data"
    assert mount.read_only is False
    assert mount.volume == f"{host}:/data"


def test_parse_mount_spec_accepts_ro_suffix(tmp_path: Path) -> None:
    host = tmp_path / "models"
    mount = parse_mount_spec(f"{host}:/models:ro")

    assert mount.read_only is True
    assert mount.volume == f"{host}:/models:ro"


def test_parse_mount_spec_rejects_relative_container_path(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="绝对路径"):
        parse_mount_spec(f"{tmp_path}:relative")


def test_parse_mount_spec_rejects_malformed_token() -> None:
    with pytest.raises(ValueError, match="挂载格式错误"):
        parse_mount_spec("not-a-mount-spec")


def test_parse_mounts_splits_comma_separated_list(tmp_path: Path) -> None:
    a, b = tmp_path / "a", tmp_path / "b"
    mounts = parse_mounts(f"{a}:/a,{b}:/b:ro")

    assert [m.volume for m in mounts] == [f"{a}:/a", f"{b}:/b:ro"]


def test_generate_compose_appends_configured_extra_mount(tmp_path: Path) -> None:
    project_path = tmp_path / "repo"
    project_path.mkdir()
    mount_src = tmp_path / "shared-data"
    mount_src.mkdir()
    (tmp_path / "accounts.conf").write_text("NAME=api-codex TYPE=codex AUTH=login\n", encoding="utf-8")
    (tmp_path / "projects.conf").write_text(
        f"NAME=repo ACCOUNT=api-codex PATH={project_path} EXTRA_MOUNTS={mount_src}:/data:ro\n",
        encoding="utf-8",
    )

    compose = generate_compose(tmp_path)
    service = compose["services"]["codex-project-repo"]

    assert f"{mount_src}:/data:ro" in service["volumes"]


def test_generate_compose_rejects_extra_mount_missing_on_host(tmp_path: Path) -> None:
    project_path = tmp_path / "repo"
    project_path.mkdir()
    missing_src = tmp_path / "does-not-exist"
    (tmp_path / "accounts.conf").write_text("NAME=api-codex TYPE=codex AUTH=login\n", encoding="utf-8")
    (tmp_path / "projects.conf").write_text(
        f"NAME=repo ACCOUNT=api-codex PATH={project_path} EXTRA_MOUNTS={missing_src}:/data\n",
        encoding="utf-8",
    )

    with pytest.raises(Exception, match="不存在"):
        generate_compose(tmp_path)


def test_generate_compose_rejects_extra_mount_colliding_with_workspace(tmp_path: Path) -> None:
    project_path = tmp_path / "repo"
    project_path.mkdir()
    mount_src = tmp_path / "shared-data"
    mount_src.mkdir()
    (tmp_path / "accounts.conf").write_text("NAME=api-codex TYPE=codex AUTH=login\n", encoding="utf-8")
    (tmp_path / "projects.conf").write_text(
        f"NAME=repo ACCOUNT=api-codex PATH={project_path} EXTRA_MOUNTS={mount_src}:/workspace\n",
        encoding="utf-8",
    )

    with pytest.raises(Exception, match="已被项目工作区或账号认证目录占用"):
        generate_compose(tmp_path)


def test_project_response_exposes_extra_mounts() -> None:
    response = ProjectResponse.from_project(
        Project(name="repo", account="alice", path="/repo", extra_mounts=["/host:/data:ro"])
    )

    assert response.extra_mounts == ["/host:/data:ro"]


def test_scheduler_save_project_persists_extra_mounts(tmp_path: Path) -> None:
    sched = Scheduler(tmp_path)

    project = sched.save_project("repo", "alice", "/repo", extra_mounts=["/host:/data:ro"])

    assert project.extra_mounts == ["/host:/data:ro"]
    assert "EXTRA_MOUNTS=/host:/data:ro" in (tmp_path / "projects.conf").read_text(encoding="utf-8")
