#!/usr/bin/env bash
# The whole script is one { ... } block so bash reads all of it before running
# anything: with `curl ... | bash` a cut-off download cannot run half a script,
# and no command can swallow the rest of the script from stdin.
{
set -euo pipefail

REPO_OWNER="mmaxx45"
REPO_NAME="rocketeer-bot"
PACKAGE_NAME="rocketeerbot"
DEFAULT_DIR="/opt/rocketeer"
DEFAULT_SERVICE="rocketeerbot"
MIN_NODE_MAJOR=20
# Installed when Node.js is missing or older than MIN_NODE_MAJOR (current LTS).
NODE_INSTALL_MAJOR=22

DIR=""
SERVICE=""
SERVICE_USER=""
REF=""
USE_LOCAL=0
WITH_SERVICE=1
WITH_CLI=1
DEPLOY_COMMANDS=1
INTERACTIVE=1
INSTALL_NODE=1
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
  --no-install-node       Fail instead of installing Node.js when it is missing
  --postgres <mode>       Database: none (default), docker, or creds
  -h, --help              Show this help

Environment: ROCKETEER_SYSTEMD_DIR, ROCKETEER_CONFIG_DIR, PGHOST, PGPORT,
PGDATABASE, PGUSER, PGPASSWORD, DATABASE_URL
EOF
}

need_value() {
  [ $# -ge 2 ] && [ -n "$2" ] && [ "${2#--}" = "$2" ] || die "missing value for $1"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) need_value "$@"; DIR="$2"; shift 2 ;;
    --service-name) need_value "$@"; SERVICE="$2"; shift 2 ;;
    --user) need_value "$@"; SERVICE_USER="$2"; shift 2 ;;
    --ref) need_value "$@"; REF="$2"; shift 2 ;;
    --local) USE_LOCAL=1; shift ;;
    --no-service) WITH_SERVICE=0; shift ;;
    --no-cli) WITH_CLI=0; shift ;;
    --no-deploy-commands) DEPLOY_COMMANDS=0; shift ;;
    --non-interactive) INTERACTIVE=0; shift ;;
    --install-node) INSTALL_NODE=1; shift ;;
    --no-install-node) INSTALL_NODE=0; shift ;;
    --postgres) need_value "$@"; POSTGRES="$2"; shift 2 ;;
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

# Prompts come from stdin when it is a terminal. With curl | bash stdin is the
# script itself, so read the answers from the controlling terminal instead.
PROMPT_IN=""
if [ -t 0 ]; then
  PROMPT_IN=/dev/stdin
elif (exec </dev/tty) 2>/dev/null; then
  PROMPT_IN=/dev/tty
fi

# Empty when the script is piped into bash (curl | bash): there is no file.
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [ -n "$SCRIPT_PATH" ] && [ -f "$SCRIPT_PATH" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
fi
DIR="${DIR:-$DEFAULT_DIR}"
SERVICE="${SERVICE:-$DEFAULT_SERVICE}"
SERVICE_USER="${SERVICE_USER:-${SUDO_USER:-$(id -un)}}"

node_major() {
  command -v node >/dev/null 2>&1 || return 1
  node -p 'process.versions.node.split(".")[0]'
}

# Runs a command with its output (stdout and stderr) captured, and shows the
# output only when it fails. Package managers and the NodeSource setup script
# are noisy (e.g. "apt does not have a stable CLI interface").
quietly() {
  local log code=0
  log="$(mktemp)"
  "$@" >"$log" 2>&1 || code=$?
  if [ "$code" -ne 0 ]; then tail -n 40 "$log" >&2; fi
  rm -f "$log"
  return "$code"
}

# Downloads and runs a NodeSource repository setup script as root.
nodesource_setup() {
  local script
  script="$(mktemp)"
  curl -fsSL "$1" -o "$script" || { rm -f "$script"; die "could not download $1"; }
  quietly require_root bash "$script" || { rm -f "$script"; die "the NodeSource setup script failed (output above)"; }
  rm -f "$script"
}

install_node() {
  if [ "$IS_ROOT" -eq 0 ] && [ "${#AS_ROOT[@]}" -eq 0 ]; then
    die "Node.js $MIN_NODE_MAJOR or newer is required and installing it needs root or sudo. Install it yourself, or re-run as root."
  fi
  step "Installing Node.js $NODE_INSTALL_MAJOR"
  if command -v apt-get >/dev/null 2>&1; then
    quietly require_root env DEBIAN_FRONTEND=noninteractive apt-get update
    quietly require_root env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg
    nodesource_setup "https://deb.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x"
    quietly require_root env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    nodesource_setup "https://rpm.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x"
    quietly require_root dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    nodesource_setup "https://rpm.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x"
    quietly require_root yum install -y nodejs
  elif command -v apk >/dev/null 2>&1; then
    quietly require_root apk add --no-cache nodejs npm
  elif command -v pacman >/dev/null 2>&1; then
    quietly require_root pacman -Sy --noconfirm --needed nodejs npm
  else
    die "no supported package manager found (apt, dnf, yum, apk, pacman); install Node.js $MIN_NODE_MAJOR or newer yourself"
  fi
  hash -r
  # An older node earlier in PATH (e.g. from nvm) would still win; prefer the
  # one the package manager just installed.
  if ! NODE_MAJOR="$(node_major)" || [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
    if [ -x /usr/bin/node ]; then PATH="/usr/bin:$PATH"; export PATH; hash -r; fi
  fi
  NODE_MAJOR="$(node_major)" || die "Node.js was installed but node is not on PATH"
  [ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] || die "the installed Node.js is $(node -v); $MIN_NODE_MAJOR or newer is required"
  command -v npm >/dev/null 2>&1 || die "Node.js was installed without npm; install npm and re-run"
}

step "Checking Node.js"
if NODE_MAJOR="$(node_major)" && [ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] && command -v npm >/dev/null 2>&1; then
  :
elif [ "$INSTALL_NODE" -eq 1 ]; then
  if command -v node >/dev/null 2>&1; then
    printf '    found %s, which is too old or has no npm\n' "$(node -v)"
  fi
  install_node
else
  die "Node.js $MIN_NODE_MAJOR or newer (with npm) is required. Install it, or re-run without --no-install-node."
fi
printf '    node %s\n' "$(node -v)"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

RESOLVED_REF="$REF"
if [ "$USE_LOCAL" -eq 1 ]; then
  [ -n "$SCRIPT_DIR" ] || die "--local needs the script to be run from a checkout (bash install.sh --local), not piped"
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
# Never copy local state: with --local the checkout may hold a developer's .env
# and database, and on a re-run they would overwrite the installed ones.
COPY_EXCLUDES=(--exclude='./node_modules' --exclude='./.git' --exclude='./.env' --exclude='./data' --exclude='./docker-compose.yml')
if [ "$(cd "$SOURCE_DIR" && pwd)" != "$(cd "$DIR" && pwd)" ]; then
  if [ -w "$DIR" ]; then
    (cd "$SOURCE_DIR" && tar "${COPY_EXCLUDES[@]}" -cf - .) | tar -xf - -C "$DIR"
  else
    (cd "$SOURCE_DIR" && tar "${COPY_EXCLUDES[@]}" -cf - .) | require_root tar -xf - -C "$DIR"
  fi
fi

if [ ! -f "$DIR/.env" ]; then
  step "Creating $DIR/.env from .env.example"
  as_owner cp "$DIR/.env.example" "$DIR/.env"
fi
as_owner chmod 600 "$DIR/.env"

NODE_BIN="$(command -v node)"

# Set KEY=value in .env, replacing an existing line or appending one. Done in
# node rather than sed so that any character in the value (&, |, \, quotes, #)
# is written literally; values that need it are quoted the way dotenv reads them.
set_env() {
  as_owner env ENV_FILE="$DIR/.env" ENV_KEY="$1" ENV_VALUE="$2" "$NODE_BIN" -e '
    const fs = require("fs");
    const { ENV_FILE: file, ENV_KEY: key, ENV_VALUE: raw } = process.env;
    let value = raw;
    if (/[\s#"'"'"'`\\]/.test(raw)) {
      if (!raw.includes("'"'"'")) value = "'"'"'" + raw + "'"'"'";
      else if (!raw.includes("`")) value = "`" + raw + "`";
      else { console.error("error: the value for " + key + " cannot contain both '"'"' and `"); process.exit(1); }
    }
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const at = lines.findIndex(line => line.startsWith(key + "="));
    if (at === -1) {
      if (lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, key + "=" + value);
      else lines.push(key + "=" + value);
    } else {
      lines[at] = key + "=" + value;
    }
    fs.writeFileSync(file, lines.join("\n"));
  '
}

token_is_placeholder() {
  grep -qE '^DISCORD_TOKEN=(your_bot_token)?[[:space:]]*$' "$DIR/.env"
}

if [ "$INTERACTIVE" -eq 1 ] && [ -n "$PROMPT_IN" ]; then
  step "Configuring $DIR/.env (press Enter to keep the current value)"
  ask() {
    local key="$1" label="$2" secret="${3:-0}" current answer
    current="$(grep -E "^${key}=" "$DIR/.env" | head -n1 | cut -d= -f2-)"
    if [ "$secret" -eq 1 ]; then
      read -r -s -p "    $label [$key]: " answer <"$PROMPT_IN" || answer=""
      printf '\n'
    else
      read -r -p "    $label [$key]: " answer <"$PROMPT_IN" || answer=""
    fi
    if [ -n "$answer" ]; then set_env "$key" "$answer"; fi
  }
  ask DISCORD_TOKEN "Bot token" 1
  ask DISCORD_CLIENT_ID "Application (client) ID"
  ask DISCORD_CLIENT_SECRET "OAuth client secret" 1
  ask PORT "Dashboard port"
  ask DASHBOARD_URL "Public dashboard URL"
  # The OAuth callback lives under the dashboard URL; left on the localhost
  # default, dashboard login fails on any real host.
  dashboard_url="$(grep -E '^DASHBOARD_URL=' "$DIR/.env" | head -n1 | cut -d= -f2- | tr -d "\"'\r")"
  if grep -qE '^DISCORD_CALLBACK_URL=http://localhost:3000/auth/discord/callback[[:space:]]*$' "$DIR/.env" \
    && [ -n "$dashboard_url" ] && ! printf '%s' "$dashboard_url" | grep -q 'localhost'; then
    set_env DISCORD_CALLBACK_URL "${dashboard_url%/}/auth/discord/callback"
    printf '    set DISCORD_CALLBACK_URL to %s (add it as a redirect in the Discord developer portal)\n' "${dashboard_url%/}/auth/discord/callback"
  fi
elif [ "$INTERACTIVE" -eq 1 ]; then
  warn "no terminal to prompt on, leaving the Discord values in $DIR/.env as placeholders"
fi

# Never leave the published example secret in place: anyone could forge a
# dashboard session with it. This runs in every mode, including curl | bash.
if grep -qE '^SESSION_SECRET=(random_session_secret)?[[:space:]]*$' "$DIR/.env" || ! grep -q '^SESSION_SECRET=' "$DIR/.env"; then
  set_env SESSION_SECRET "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf '    generated a SESSION_SECRET\n'
fi

as_owner mkdir -p "$DIR/data"
step "Installing dependencies"
(cd "$DIR" && as_owner npm ci --omit=dev --no-audit --no-fund)

COMPOSE_FILE="$DIR/docker-compose.yml"

# The password a previous run put in docker-compose.yml, if any. The Postgres
# image only applies POSTGRES_PASSWORD when it initialises an empty volume, so
# a re-run must keep using the original password.
existing_docker_password() {
  [ -f "$COMPOSE_FILE" ] || return 1
  "$NODE_BIN" -e '
    const text = require("fs").readFileSync(process.argv[1], "utf8");
    const match = text.match(/POSTGRES_PASSWORD:\s*(.+)/);
    if (!match) process.exit(1);
    let value = match[1].trim();
    if (value.startsWith("\"")) value = JSON.parse(value);
    process.stdout.write(value.replace(/\$\$/g, "$"));
  ' "$COMPOSE_FILE"
}

start_postgres_docker() {
  local password="$1" host_port="$2"
  command -v docker >/dev/null 2>&1 || die "docker was not found - choose the credentials option instead (--postgres creds)"
  if ! docker compose version >/dev/null 2>&1; then
    die "docker compose v2 is required for the docker option (or use --postgres creds)"
  fi
  # JSON strings are valid YAML double-quoted scalars; $ is doubled because
  # compose interpolates it.
  local yaml_password
  yaml_password="$("$NODE_BIN" -e 'process.stdout.write(JSON.stringify(process.argv[1].replace(/\$/g, "$$$$")))' "$password")"
  step "Writing $COMPOSE_FILE"
  as_owner tee "$COMPOSE_FILE" >/dev/null <<EOF
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: rocketeerbot
      POSTGRES_USER: rocketeerbot
      POSTGRES_PASSWORD: $yaml_password
    ports:
      - "127.0.0.1:$host_port:5432"
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
  as_owner chmod 600 "$COMPOSE_FILE"
  step "Starting Postgres in Docker"
  (cd "$DIR" && docker compose up -d) || die "could not start Postgres - is port $host_port already in use? Re-run with PGPORT=<free port>"
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
  step "Verifying the database connection and creating the schema"
  if ! (cd "$DIR" && as_owner "$NODE_BIN" -e '
    const { db } = require("./src/database/db");
    db.runMigrations()
      .then(() => console.log("    schema ready (" + db.client + ")"))
      .catch(err => { console.error("    " + err.message); process.exitCode = 1; })
      .finally(() => db.close());
  '); then
    warn "could not reach Postgres - fix DATABASE_URL / PG* in $DIR/.env, then start the bot"
    return 1
  fi
  return 0
}

case "$POSTGRES" in
  ""|none|docker|creds) ;;
  *) die "--postgres must be none, docker or creds" ;;
esac

if [ -z "$POSTGRES" ]; then
  if [ "$INTERACTIVE" -eq 1 ] && [ -n "$PROMPT_IN" ]; then
    read -r -p "    Use PostgreSQL instead of SQLite? [y/N]: " use_pg <"$PROMPT_IN" || use_pg=""
    case "$use_pg" in
      [Yy]*)
        read -r -p "    Set up Postgres with Docker, or enter existing credentials? [docker/creds]: " pg_mode <"$PROMPT_IN" || pg_mode=""
        case "$pg_mode" in
          [Cc]*) POSTGRES="creds" ;;
          *) POSTGRES="docker" ;;
        esac
        ;;
      *) POSTGRES="none" ;;
    esac
  else
    POSTGRES="none"
  fi
fi

if [ "$POSTGRES" = "docker" ]; then
  pg_host_port="${PGPORT:-5432}"
  if pg_password="$(existing_docker_password)"; then
    printf '    reusing the Postgres password from %s\n' "$COMPOSE_FILE"
  else
    pg_password="${PGPASSWORD:-$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
  fi
  start_postgres_docker "$pg_password" "$pg_host_port"
  pg_url="$("$NODE_BIN" -e 'process.stdout.write("postgres://rocketeerbot:" + encodeURIComponent(process.argv[1]) + "@127.0.0.1:" + process.argv[2] + "/rocketeerbot")' "$pg_password" "$pg_host_port")"
  set_env DATABASE_CLIENT postgres
  set_env DATABASE_URL "$pg_url"
  set_env DATABASE_SSL false
elif [ "$POSTGRES" = "creds" ] && [ -n "${DATABASE_URL:-}" ]; then
  step "Using DATABASE_URL from the environment"
  set_env DATABASE_CLIENT postgres
  set_env DATABASE_URL "$DATABASE_URL"
elif [ "$POSTGRES" = "creds" ]; then
  step "PostgreSQL connection details"
  pg_host="${PGHOST:-}"; pg_port="${PGPORT:-}"; pg_name="${PGDATABASE:-}"; pg_user="${PGUSER:-}"; pg_password="${PGPASSWORD:-}"
  if [ "$INTERACTIVE" -eq 1 ] && [ -n "$PROMPT_IN" ]; then
    [ -n "$pg_host" ] || read -r -p "    Host [localhost]: " pg_host <"$PROMPT_IN" || pg_host=""
    [ -n "$pg_port" ] || read -r -p "    Port [5432]: " pg_port <"$PROMPT_IN" || pg_port=""
    [ -n "$pg_name" ] || read -r -p "    Database [rocketeerbot]: " pg_name <"$PROMPT_IN" || pg_name=""
    [ -n "$pg_user" ] || read -r -p "    User [rocketeerbot]: " pg_user <"$PROMPT_IN" || pg_user=""
    if [ -z "$pg_password" ]; then
      read -r -s -p "    Password: " pg_password <"$PROMPT_IN" || pg_password=""
      printf '\n'
    fi
  fi
  pg_host="${pg_host:-localhost}"; pg_port="${pg_port:-5432}"; pg_name="${pg_name:-rocketeerbot}"; pg_user="${pg_user:-rocketeerbot}"
  [ -n "$pg_password" ] || warn "no Postgres password given (set PGPASSWORD for --non-interactive installs)"
  set_env DATABASE_CLIENT postgres
  set_env PGHOST "$pg_host"
  set_env PGPORT "$pg_port"
  set_env PGDATABASE "$pg_name"
  set_env PGUSER "$pg_user"
  set_env PGPASSWORD "$pg_password"
  set_env DATABASE_URL ""
fi

if [ "$POSTGRES" = "docker" ] || [ "$POSTGRES" = "creds" ]; then
  verify_postgres || true
fi

if [ "$DEPLOY_COMMANDS" -eq 1 ]; then
  if token_is_placeholder; then
    warn "DISCORD_TOKEN is still a placeholder, skipping slash command registration"
  else
    step "Registering slash commands"
    (cd "$DIR" && as_owner npm run deploy-commands) || warn "slash command registration failed, run 'npm run deploy-commands' later"
  fi
fi

if [ "$IS_ROOT" -eq 1 ] || [ "${#AS_ROOT[@]}" -gt 0 ]; then
  require_root chown -R "$SERVICE_USER:" "$DIR" || warn "could not chown $DIR to $SERVICE_USER"
fi

SERVICE_INSTALLED=0
if [ "$WITH_SERVICE" -eq 1 ]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl was not found, skipping the service unit (re-run with --no-service to silence this)"
  elif [ "$IS_ROOT" -eq 0 ] && [ "${#AS_ROOT[@]}" -eq 0 ]; then
    warn "not root and sudo is unavailable, skipping the systemd unit (use --no-service to silence this)"
  else
    [ "$SERVICE_USER" != "root" ] || warn "the bot will run as root; pass --user <name> to run it as an unprivileged user"
    UNIT_AFTER="network-online.target"
    UNIT_WANTS="network-online.target"
    if [ "$POSTGRES" = "docker" ]; then
      # The database container is started by Docker; start after it on boot.
      UNIT_AFTER="$UNIT_AFTER docker.service"
      UNIT_WANTS="$UNIT_WANTS docker.service"
    fi
    step "Writing $SYSTEMD_DIR/$SERVICE.service"
    require_root mkdir -p "$SYSTEMD_DIR"
    require_root tee "$SYSTEMD_DIR/$SERVICE.service" >/dev/null <<EOF
[Unit]
Description=RocketeerBot Discord bot
After=$UNIT_AFTER
Wants=$UNIT_WANTS

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$DIR
ExecStart=$(command -v node) src/index.js
Environment=NODE_ENV=production
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
    require_root systemctl daemon-reload
    SERVICE_INSTALLED=1
    if token_is_placeholder; then
      # Starting now would only crash-loop on the placeholder token.
      step "Enabling $SERVICE (not starting it: DISCORD_TOKEN is still a placeholder)"
      require_root systemctl enable "$SERVICE"
    else
      # restart, not start: on a re-run the old version may still be running.
      step "Enabling and (re)starting $SERVICE"
      require_root systemctl enable "$SERVICE"
      require_root systemctl restart "$SERVICE"
      require_root systemctl --no-pager --lines=0 status "$SERVICE" || true
    fi
  fi
fi

if [ "$WITH_CLI" -eq 1 ]; then
  step "Installing the rocketeer command"
  if ! (cd "$DIR" && npm install -g . --no-audit --no-fund); then
    (cd "$DIR" && require_root npm install -g . --no-audit --no-fund) || warn "global install failed; run 'npm install -g .' inside $DIR later"
  fi
fi

# The CLI reads /etc/rocketeer/config.json first, and a `sudo rocketeer` does
# not see the invoking user's ~/.config, so prefer /etc (with sudo if needed)
# and fall back to the user's config directory only when that is impossible.
CONFIG_JSON="$("$NODE_BIN" -e 'process.stdout.write(JSON.stringify({ dir: process.argv[1], service: process.argv[2] }, null, 2) + "\n")' "$DIR" "$SERVICE")"
CONFIG_TARGET_DIR=""
if mkdir -p "$CONFIG_DIR" 2>/dev/null && [ -w "$CONFIG_DIR" ]; then
  printf '%s\n' "$CONFIG_JSON" > "$CONFIG_DIR/config.json" && CONFIG_TARGET_DIR="$CONFIG_DIR"
elif require_root mkdir -p "$CONFIG_DIR" 2>/dev/null \
  && printf '%s\n' "$CONFIG_JSON" | require_root tee "$CONFIG_DIR/config.json" >/dev/null; then
  CONFIG_TARGET_DIR="$CONFIG_DIR"
else
  USER_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/rocketeer"
  if mkdir -p "$USER_CONFIG_DIR" 2>/dev/null && [ -w "$USER_CONFIG_DIR" ]; then
    printf '%s\n' "$CONFIG_JSON" > "$USER_CONFIG_DIR/config.json" && CONFIG_TARGET_DIR="$USER_CONFIG_DIR"
  fi
fi

if [ -n "$CONFIG_TARGET_DIR" ]; then
  step "Wrote $CONFIG_TARGET_DIR/config.json"
else
  warn "could not write a CLI config file; pass --dir and --service to rocketeer instead"
fi

printf '\nRocketeer is installed in %s\n' "$DIR"
[ -z "$CONFIG_TARGET_DIR" ] || printf '  config     : %s\n' "$CONFIG_TARGET_DIR/config.json"
if [ "$SERVICE_INSTALLED" -eq 1 ]; then
  printf '  service    : systemctl status %s\n' "$SERVICE"
  printf '  logs       : journalctl -u %s -f\n' "$SERVICE"
fi
printf '  edit env   : %s/.env\n' "$DIR"
printf '  update     : rocketeer update\n'
if token_is_placeholder; then
  if [ "$SERVICE_INSTALLED" -eq 1 ] && command -v rocketeer >/dev/null 2>&1; then
    printf '\nNext: run "rocketeer start" - it asks for your Discord credentials, then starts the bot.\n'
  elif command -v rocketeer >/dev/null 2>&1; then
    printf '\nNext: run "rocketeer setup" to enter your Discord credentials, then "npm start" in %s.\n' "$DIR"
  else
    printf '\nNext: put your real Discord values in %s, then start the bot.\n' "$DIR/.env"
  fi
fi

exit 0
}
