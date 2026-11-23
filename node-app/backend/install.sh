#!/bin/sh
# Installs or upgrades the CoderFleet backend for the current user and starts it
# as a service. Run from the unpacked bundle; the desktop App does this over SSH.
# The last line of output is `CODERFLEET_INSTALL_RESULT {json}`.
set -eu

home_dir="${CODERFLEET_BACKEND_HOME:-$HOME/.coderfleet-backend}"
source_dir="$(cd "$(dirname "$0")" && pwd)"
version="$(cat "$source_dir/VERSION")"
service=coderfleet-backend

say() { printf '%s\n' "$*"; }
fail() { say "ERROR: $*" >&2; exit 1; }

say "安装 CoderFleet 后端 $version 到 $home_dir"
command -v docker >/dev/null 2>&1 || fail "这台机器上找不到 docker 命令，请先安装 Docker"
docker_version="$(docker version --format '{{.Server.Version}}' 2>/dev/null)" \
  || fail "当前用户 $(id -un) 无法使用 Docker：请把它加入 docker 组，或使用 root 登录"
say "Docker $docker_version"

mkdir -p "$home_dir/versions"
chmod 700 "$home_dir"
target="$home_dir/versions/$version"
staging="$target.installing.$$"
rm -rf "$staging"
cp -R "$source_dir" "$staging"
rm -rf "$target"
mv "$staging" "$target"
ln -sfn "versions/$version" "$home_dir/current.new"
mv -T "$home_dir/current.new" "$home_dir/current" 2>/dev/null || { rm -f "$home_dir/current"; mv "$home_dir/current.new" "$home_dir/current"; }
bin="$home_dir/current/bin/coderfleet-backend"
# Keep the current version and the one before it.
ls -1dt "$home_dir"/versions/*/ 2>/dev/null | tail -n +3 | while read -r old; do
  [ "$(cd "$old" && pwd)" = "$(cd "$target" && pwd)" ] || rm -rf "$old"
done
chmod 755 "$bin" "$home_dir/current/node/node"

CODERFLEET_BACKEND_HOME="$home_dir" "$bin" init >/dev/null
say "配置：$home_dir/config.json"

stop_process() {
  if [ -f "$home_dir/backend.pid" ]; then
    pid="$(cat "$home_dir/backend.pid")"
    if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; sleep 1; fi
    rm -f "$home_dir/backend.pid"
  fi
}

unit_body() {
  cat <<UNIT
[Unit]
Description=CoderFleet backend
After=network-online.target docker.service

[Service]
Environment=CODERFLEET_BACKEND_HOME=$home_dir
Environment=PATH=$PATH
${DOCKER_HOST:+Environment=DOCKER_HOST=$DOCKER_HOST}
ExecStart=$home_dir/current/bin/coderfleet-backend serve
Restart=always
RestartSec=2

[Install]
WantedBy=$1
UNIT
}

mode=process
if [ "${CODERFLEET_BACKEND_NO_SYSTEMD:-}" != 1 ] && [ "$(id -u)" = 0 ] && systemctl show-environment >/dev/null 2>&1; then
  stop_process
  unit_body multi-user.target > "/etc/systemd/system/$service.service"
  systemctl daemon-reload
  systemctl enable "$service" >/dev/null 2>&1
  systemctl restart "$service"
  mode=systemd
elif [ "${CODERFLEET_BACKEND_NO_SYSTEMD:-}" != 1 ] && systemctl --user show-environment >/dev/null 2>&1; then
  stop_process
  mkdir -p "$HOME/.config/systemd/user"
  unit_body default.target > "$HOME/.config/systemd/user/$service.service"
  systemctl --user daemon-reload
  systemctl --user enable "$service" >/dev/null 2>&1
  systemctl --user restart "$service"
  # Keep the user service running without a login session.
  loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || say "提示：无法开启 linger，退出登录后服务可能停止（可用 root 执行 loginctl enable-linger $(id -un)）"
  mode=systemd-user
else
  say "没有可用的 systemd，以后台进程运行（重启机器后需要在 App 里重新安装）"
  stop_process
  CODERFLEET_BACKEND_HOME="$home_dir" nohup "$bin" serve >> "$home_dir/backend.log" 2>&1 < /dev/null &
  echo $! > "$home_dir/backend.pid"
fi

i=0
until CODERFLEET_BACKEND_HOME="$home_dir" "$bin" status >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -le 60 ] || fail "服务没有启动，请查看 $home_dir/backend.log 或 journalctl --user -u $service"
  sleep 0.5
done
say "服务已启动（$mode）"
result="$(CODERFLEET_BACKEND_HOME="$home_dir" "$bin" init)"
printf 'CODERFLEET_INSTALL_RESULT %s\n' "$(printf '%s' "$result" | sed "s/}\$/,\"mode\":\"$mode\",\"docker\":\"$docker_version\"}/")"
