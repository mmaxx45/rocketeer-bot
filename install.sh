#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="mmaxx45"
REPO_NAME="rocketeer-bot"
PACKAGE_NAME="rocketeerbot"
DEFAULT_DIR="/opt/rocketeer"
DEFAULT_SERVICE="rocketeerbot"
MIN_NODE_MAJOR=20

DIR=""
SERVICE=""
SERVICE_USER=""
REF=""
USE_LOCAL=0
WITH_SERVICE=1
WITH_CLI=1
DEPLOY_COMMANDS=1
INTERACTIVE=1
INSTALL_NODE=0
POSTGRES=""
SYSTEMD_DIR="${ROCKETEER_SYSTEMD_DIR:-/etc/systemd/system}"
CONFIG_DIR="${ROCKETEER_CONFIG_DIR:-/etc/rocketeer}"

step() { printf '==> %s\n' "$1"; }
warn() { printf 'warning: %s\n' "$1" >&2; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }

usage() {
  cat <<'EOF'
Rocketeer installer

Usage: install.sh [options]

Options:
  --dir <path>            Install directory (default /opt/rocketeer)
  --service-name <name>   systemd unit name (default rocketeerbot)
  --user <name>           User that runs the bot (default: the invoking user)
  --ref <ref>             Release tag or branch to install (default: latest release)
  --local                 Install from this checkout instead of downloading
  --no-service            Do not create or start a systemd unit
  --no-cli                Do not install the global "rocketeer" command
  --no-deploy-commands    Do not register slash commands
  --non-interactive       Do not prompt; create .env from .env.example
  --install-node          Install Node.js from NodeSource when it is missing
  --postgres <mode>       Database: none (default), docker, or creds
  -h, --help              Show this help

Environment: ROCKETEER_SYSTEMD_DIR, ROCKETEER_CONFIG_DIR, PGHOST, PGPORT,
PGDATABASE, PGUSER, PGPASSWORD, DATABASE_URL
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:-}"; shift 2 ;;
    --service-name) SERVICE="${2:-}"; shift 2 ;;
    --user) SERVICE_USER="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --local) USE_LOCAL=1; shift ;;
    --no-service) WITH_SERVICE=0; shift ;;
    --no-cli) WITH_CLI=0; shift ;;
    --no-deploy-commands) DEPLOY_COMMANDS=0; shift ;;
    --non-interactive) INTERACTIVE=0; shift ;;
    --install-node) INSTALL_NODE=1; shift ;;
    --postgres) POSTGRES="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

IS_ROOT=0
if [ "$(id -u)" -eq 0 ]; then IS_ROOT=1; fi
AS_ROOT=()
if [ "$IS_ROOT" -eq 0 ] && command -v sudo >/dev/null 2>&1; then
  AS_ROOT=(sudo)
fi

require_root() {
  if [ "$IS_ROOT" -eq 1 ]; then
    "$@"
  elif [ "${#AS_ROOT[@]}" -gt 0 ]; then
    "${AS_ROOT[@]}" "$@"
  else
    return 127
  fi
}

as_owner() {
  if [ -w "$DIR" ]; then "$@"; else require_root "$@"; fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${DIR:-$DEFAULT_DIR}"
SERVICE="${SERVICE:-$DEFAULT_SERVICE}"
SERVICE_USER="${SERVICE_USER:-${SUDO_USER:-$(id -un)}}"

node_major() {
  command -v node >/dev/null 2>&1 || return 1
  node -p 'process.versions.node.split(".")[0]'
}

step "Checking Node.js"
if NODE_MAJOR="$(node_major)"; then
  if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
    if [ "$INSTALL_NODE" -eq 0 ]; then
      die "Node.js $MIN_NODE_MAJOR or newer is required (found $(node -v)). Re-run with --install-node, or upgrade Node yourself."
    fi
    step "Installing Node.js $MIN_NODE_MAJOR from NodeSource"
    curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | "${AS_ROOT[@]}" bash -
    "${AS_ROOT[@]}" apt-get install -y nodejs
  fi
else
  [ "$INSTALL_NODE" -eq 1 ] || die "Node.js $MIN_NODE_MAJOR or newer is required. Re-run with --install-node."
  step "Installing Node.js $MIN_NODE_MAJOR from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | "${AS_ROOT[@]}" bash -
  "${AS_ROOT[@]}" apt-get install -y nodejs
fi
printf '    node %s\n' "$(node -v)"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

RESOLVED_REF="$REF"
if [ "$USE_LOCAL" -eq 1 ]; then
  if [ -f "$SCRIPT_DIR/package.json" ]; then
    SOURCE_DIR="$SCRIPT_DIR"
  else
    SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  fi
  step "Using the local checkout at $SOURCE_DIR"
else
  if [ -z "$RESOLVED_REF" ]; then
    step "Looking up the latest release"
    RESOLVED_REF="$(curl -fsSL "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/releases/latest" 2>/dev/null \
      | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 \
      | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"//; s/"$//')" || true
    if [ -z "$RESOLVED_REF" ]; then
      warn "no published release found, falling back to the main branch"
      RESOLVED_REF="main"
    fi
  fi
  step "Downloading $REPO_NAME $RESOLVED_REF"
  curl -fsSL "https://codeload.github.com/$REPO_OWNER/$REPO_NAME/tar.gz/$RESOLVED_REF" -o "$TMP_DIR/release.tar.gz"
  tar -xzf "$TMP_DIR/release.tar.gz" -C "$TMP_DIR"
  SOURCE_DIR="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n1)"
fi

[ -f "$SOURCE_DIR/package.json" ] || die "no package.json in $SOURCE_DIR"
PACKAGE="$(cd "$SOURCE_DIR" && node -p "require('./package.json').name" 2>/dev/null || true)"
[ "$PACKAGE" = "$PACKAGE_NAME" ] || die "expected $PACKAGE_NAME, found ${PACKAGE:-nothing} in $SOURCE_DIR"

step "Installing files into $DIR"
if ! mkdir -p "$DIR" 2>/dev/null; then
  require_root mkdir -p "$DIR" || die "cannot create $DIR - run as root, or choose a writable --dir"
fi
if [ "$(cd "$SOURCE_DIR" && pwd)" != "$(cd "$DIR" && pwd)" ]; then
  if [ -w "$DIR" ]; then
    (cd "$SOURCE_DIR" && tar --exclude='./node_modules' --exclude='./.git' -cf - .) | tar -xf - -C "$DIR"
  else
    (cd "$SOURCE_DIR" && tar --exclude='./node_modules' --exclude='./.git' -cf - .) | require_root tar -xf - -C "$DIR"
  fi
fi

if [ ! -f "$DIR/.env" ]; then
  step "Creating $DIR/.env from .env.example"
  as_owner cp "$DIR/.env.example" "$DIR/.env"
fi
as_owner chmod 600 "$DIR/.env"

set_env() {
  local key="$1" value="$2"
  as_owner sed -i "s|^${key}=.*|${key}=${value}|" "$DIR/.env"
}

if [ "$INTERACTIVE" -eq 1 ] && [ -t 0 ]; then
  step "Configuring $DIR/.env (press Enter to keep the current value)"
  ask() {
    local key="$1" label="$2" secret="${3:-0}" current answer
    current="$(grep -E "^${key}=" "$DIR/.env" | head -n1 | cut -d= -f2-)"
    if [ "$secret" -eq 1 ]; then
      read -r -s -p "    $label [$key]: " answer || answer=""
      printf '\n'
    else
      read -r -p "    $label [$key]: " answer || answer=""
    fi
    if [ -n "$answer" ]; then set_env "$key" "$answer"; fi
  }
  ask DISCORD_TOKEN "Bot token" 1
  ask DISCORD_CLIENT_ID "Application (client) ID"
  ask DISCORD_CLIENT_SECRET "OAuth client secret" 1
  ask PORT "Dashboard port"
  ask DASHBOARD_URL "Public dashboard URL"
  if grep -q '^SESSION_SECRET=random_session_secret' "$DIR/.env"; then
    set_env SESSION_SECRET "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    printf '    generated a SESSION_SECRET\n'
  fi
elif [ "$INTERACTIVE" -eq 1 ]; then
  warn "no terminal attached, leaving $DIR/.env as copied from .env.example"
fi

as_owner mkdir -p "$DIR/data"
step "Installing dependencies"
(cd "$DIR" && as_owner npm ci --omit=dev --no-audit --no-fund)

set_env_raw() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$DIR/.env"; then
    as_owner sed -i "s|^${key}=.*|${key}=${value}|" "$DIR/.env"
  else
    as_owner sh -c "printf '%s=%s\\n' '${key}' '${value}' >> '$DIR/.env'"
  fi
}

start_postgres_docker() {
  local password="$1"
  command -v docker >/dev/null 2>&1 || die "docker was not found - choose the credentials option instead (--postgres creds)"
  if ! docker compose version >/dev/null 2>&1; then
    die "docker compose v2 is required for the docker option (or use --postgres creds)"
  fi
  step "Writing $DIR/docker-compose.yml"
  as_owner tee "$DIR/docker-compose.yml" >/dev/null <<EOF
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: rocketeerbot
      POSTGRES_USER: rocketeerbot
      POSTGRES_PASSWORD: $password
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - rocketeerbot-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U rocketeerbot -d rocketeerbot"]
      interval: 5s
      timeout: 5s
      retries: 12

volumes:
  rocketeerbot-pgdata:
EOF
  step "Starting Postgres in Docker"
  (cd "$DIR" && docker compose up -d)
  step "Waiting for Postgres to accept connections"
  local tries=0
  until (cd "$DIR" && docker compose exec -T postgres pg_isready -U rocketeerbot -d rocketeerbot >/dev/null 2>&1); do
    tries=$((tries + 1))
    if [ "$tries" -gt 30 ]; then
      die "Postgres did not become ready - check 'docker compose logs postgres' in $DIR"
    fi
    sleep 2
  done
}

verify_postgres() {
  step "Verifying the database connection and schema"
  if ! (cd "$DIR" && node -e "const {db}=require('./src/database/db');db.runMigrations().then(()=>{console.log('schema ready ('+db.client+')')}).catch(e=>{console.error(e.message);process.exit(1)})"); then
    warn "could not reach Postgres - fix DATABASE_URL/PG* in $DIR/.env, then start the bot"
    return 1
  fi
  return 0
}

PG_PASSWORD_VALUE=""
if [ -z "$POSTGRES" ]; then
  if [ "$INTERACTIVE" -eq 1 ] && [ -t 0 ]; then
    read -r -p "    Use PostgreSQL instead of SQLite? [y/N]: " use_pg || use_pg=""
    case "$use_pg" in
      [Yy]*) POSTGRES="ask" ;;
      *) POSTGRES="none" ;;
    esac
  else
    POSTGRES="none"
  fi
fi

if [ "$POSTGRES" = "ask" ]; then
  read -r -p "    Set up Postgres with Docker, or enter existing credentials? [docker/creds]: " pg_mode || pg_mode=""
  case "$pg_mode" in
    [Cc]*) POSTGRES="creds" ;;
    *) POSTGRES="docker" ;;
  esac
fi

if [ "$POSTGRES" = "docker" ]; then
  PG_PASSWORD_VALUE="${PGPASSWORD:-$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
  start_postgres_docker "$PG_PASSWORD_VALUE"
  set_env_raw DATABASE_CLIENT postgres
  set_env_raw DATABASE_URL "postgres://rocketeerbot:${PG_PASSWORD_VALUE}@127.0.0.1:5432/rocketeerbot"
  set_env_raw DATABASE_SSL false
elif [ "$POSTGRES" = "creds" ]; then
  step "PostgreSQL connection details"
  pg_host="${PGHOST:-}"; pg_port="${PGPORT:-}"; pg_name="${PGDATABASE:-}"; pg_user="${PGUSER:-}"; pg_password="${PGPASSWORD:-}"
  if [ "$INTERACTIVE" -eq 1 ] && [ -t 0 ]; then
    [ -n "$pg_host" ] || read -r -p "    Host [localhost]: " pg_host || pg_host=""
    [ -n "$pg_port" ] || read -r -p "    Port [5432]: " pg_port || pg_port=""
    [ -n "$pg_name" ] || read -r -p "    Database [rocketeerbot]: " pg_name || pg_name=""
    [ -n "$pg_user" ] || read -r -p "    User [rocketeerbot]: " pg_user || pg_user=""
    if [ -z "$pg_password" ]; then
      read -r -s -p "    Password: " pg_password || pg_password=""
      printf '\n'
    fi
  fi
  pg_host="${pg_host:-localhost}"; pg_port="${pg_port:-5432}"; pg_name="${pg_name:-rocketeerbot}"; pg_user="${pg_user:-rocketeerbot}"
  case "$pg_password" in
    *'|'*) die "the password must not contain the | character (it breaks the .env rewrite)" ;;
  esac
  set_env_raw DATABASE_CLIENT postgres
  set_env_raw PGHOST "$pg_host"
  set_env_raw PGPORT "$pg_port"
  set_env_raw PGDATABASE "$pg_name"
  set_env_raw PGUSER "$pg_user"
  set_env_raw PGPASSWORD "$pg_password"
  set_env_raw DATABASE_URL ""
fi

if [ "$POSTGRES" = "docker" ] || [ "$POSTGRES" = "creds" ]; then
  verify_postgres || true
fi

if [ "$DEPLOY_COMMANDS" -eq 1 ]; then
  if grep -qE '^DISCORD_TOKEN=(your_bot_token)?$' "$DIR/.env"; then
    warn "DISCORD_TOKEN is still a placeholder, skipping slash command registration"
  else
    step "Registering slash commands"
    (cd "$DIR" && as_owner npm run deploy-commands) || warn "slash command registration failed, run 'npm run deploy-commands' later"
  fi
fi

if [ "$IS_ROOT" -eq 1 ] || [ "${#AS_ROOT[@]}" -gt 0 ]; then
  require_root chown -R "$SERVICE_USER:" "$DIR" || warn "could not chown $DIR to $SERVICE_USER"
fi

if [ "$WITH_SERVICE" -eq 1 ]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl was not found, skipping the service unit (re-run with --no-service to silence this)"
  elif [ "$IS_ROOT" -eq 0 ] && [ "${#AS_ROOT[@]}" -eq 0 ]; then
    warn "not root and sudo is unavailable, skipping the systemd unit (use --no-service to silence this)"
  else
    step "Writing $SYSTEMD_DIR/$SERVICE.service"
    require_root mkdir -p "$SYSTEMD_DIR"
    require_root tee "$SYSTEMD_DIR/$SERVICE.service" >/dev/null <<EOF
[Unit]
Description=RocketeerBot Discord bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$DIR
ExecStart=$(command -v node) src/index.js
Environment=NODE_ENV=production
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    step "Enabling and starting $SERVICE"
    require_root systemctl daemon-reload
    require_root systemctl enable --now "$SERVICE"
    require_root systemctl --no-pager --lines=0 status "$SERVICE" || true
  fi
fi

if [ "$WITH_CLI" -eq 1 ]; then
  step "Installing the rocketeer command"
  if ! (cd "$DIR" && npm install -g . --no-audit --no-fund); then
    (cd "$DIR" && require_root npm install -g . --no-audit --no-fund) || warn "global install failed; run 'npm install -g .' inside $DIR later"
  fi
fi

CONFIG_TARGET_DIR="$CONFIG_DIR"
if ! mkdir -p "$CONFIG_TARGET_DIR" 2>/dev/null; then
  CONFIG_TARGET_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/rocketeer"
  mkdir -p "$CONFIG_TARGET_DIR" 2>/dev/null || true
fi

if [ -d "$CONFIG_TARGET_DIR" ] && [ -w "$CONFIG_TARGET_DIR" ]; then
  step "Writing $CONFIG_TARGET_DIR/config.json"
  tee "$CONFIG_TARGET_DIR/config.json" >/dev/null <<EOF
{
  "dir": "$DIR",
  "service": "$SERVICE"
}
EOF
else
  warn "could not write a CLI config file; pass --dir and --service to rocketeer instead"
fi

printf '\nRocketeer is installed in %s\n' "$DIR"
printf '  config     : %s\n' "$CONFIG_TARGET_DIR/config.json"
if [ "$WITH_SERVICE" -eq 1 ]; then
  printf '  service    : systemctl status %s\n' "$SERVICE"
  printf '  logs       : journalctl -u %s -f\n' "$SERVICE"
fi
printf '  edit env   : %s/.env\n' "$DIR"
printf '  update     : rocketeer update\n'
if [ "$INTERACTIVE" -eq 1 ] && grep -qE '^DISCORD_TOKEN=(your_bot_token)?$' "$DIR/.env"; then
  printf '\nNext: put your real values in %s/.env, then start the bot.\n' "$DIR/.env"
fi
