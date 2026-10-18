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
  -h, --help              Show this help

Environment: ROCKETEER_SYSTEMD_DIR, ROCKETEER_CONFIG_DIR
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
elif [ "$INTERACTIVE" -eq 1 ]; then
  warn "no terminal attached (curl | bash), leaving the Discord values in $DIR/.env as placeholders"
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
    require_root systemctl daemon-reload
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
if [ "$WITH_SERVICE" -eq 1 ]; then
  printf '  service    : systemctl status %s\n' "$SERVICE"
  printf '  logs       : journalctl -u %s -f\n' "$SERVICE"
fi
printf '  edit env   : %s/.env\n' "$DIR"
printf '  update     : rocketeer update\n'
if token_is_placeholder; then
  printf '\nNext: put your real Discord values in %s, then start the bot' "$DIR/.env"
  if [ "$WITH_SERVICE" -eq 1 ]; then printf ' (rocketeer start)'; fi
  printf '.\n'
fi
