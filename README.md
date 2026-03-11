# RocketeerBot

A feature-rich Discord moderation bot with crosspost detection, a warning/ban system, modmail, file upload blocking, and a full web dashboard.

Built with discord.js v14, better-sqlite3, Express, and EJS.

---

## Features

### Crosspost Detection
- Detects when users post the same (or similar) message across multiple channels using Levenshtein distance
- First offense: deletes duplicates and sends a warning message
- Repeat offense: automatically issues a formal warning
- Auto-kick after configurable number of incidents within a time window
- All thresholds, time windows, and messages are configurable per guild

### Warning System
- `/warn <user> <reason> [timeout]` — issue a warning with optional timeout
- Right-click any message → **Warn User** (context menu)
- Timeout supports human-readable durations: `30s`, `5m`, `1h`, `2d`, `1w`, `1mo`
- When warning threshold is reached, moderators are prompted to ban or continue
- Custom autocomplete warning reasons (configurable per guild)
- Warning log channel with rich embeds
- `/warnings <user>` — view a user's warning history
- `/mywarnings` — users can view their own warnings
- `/clearwarning <user> <number|all>` — remove warnings

### Ban System
- `/ban <user> [reason] [delete_messages_days]` — ban with confirmation dialog showing warning history
- Ban log channel support
- `/banreason <user_id>` — look up why a user was banned

### Modmail
- Users DM the bot to open a private support thread
- Creates a channel in a configured category with mod-only access
- Bidirectional relay: mod replies in thread go to DM, user replies go to thread
- `/modmail setup`, `/modmail close`, `/modmail threads`

### File Upload Blocking
- Blocks uploads of files with dangerous extensions (exe, bat, ps1, jar, etc.)
- 37 default blocked extensions, fully customizable per guild
- Moderators and admins are exempt
- `/blockedfiles` — view current blocked extensions

### Mod Accountability
- `/modactions <user>` — view a moderator's action history (warns, bans, timeouts, kicks)
- Paginated with navigation buttons
- Role-based access control

### Web Dashboard
- Discord OAuth login
- Guild settings configuration with modern dark-themed UI
- Sidebar navigation with scroll-spy
- Warning management (view, delete, paginated)
- Statistics page with charts and leaderboards
- All bot features are toggleable from the dashboard

### Statistics Dashboard
- Total warnings, bans, crosspost incidents, active moderators
- Warnings over time (8-week bar chart)
- Most warned users (top 10)
- Most active moderators (top 10)
- Warning reasons breakdown
- Recent mod activity feed

---

## Requirements

- **Node.js** 18+
- **npm**
- A **Discord bot application** with:
  - Bot token
  - OAuth2 client ID and secret
  - Redirect URL configured

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/mmaxx45/rocketeer-bot.git
cd rocketeer-bot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
# Required
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_client_id
DISCORD_CLIENT_SECRET=your_client_secret
DISCORD_CALLBACK_URL=http://localhost:3000/auth/discord/callback
SESSION_SECRET=a_random_secret_string

# Optional
PORT=3000
DATABASE_PATH=./data/rocketeerbot.db
NODE_ENV=production
DEV_GUILD_ID=                    # Set for dev: registers commands to one guild instantly
TRUST_PROXY=false                # Set to true if behind nginx/Cloudflare
LOG_LEVEL=info                   # debug, info, warn, error
```

### 3. Enable privileged intents

In the [Discord Developer Portal](https://discord.com/developers/applications), go to your bot's settings → **Bot** tab and enable:

- **Message Content Intent** — required for crosspost detection
- **Server Members Intent** — required for member lookups
- **Presence Intent** — not required, can leave off

### 4. Set bot permissions

When generating an invite link, include these permissions:

| Permission | Reason |
|---|---|
| Send Messages | Warnings, notifications, modmail |
| Manage Messages | Deleting crossposts and blocked files |
| Ban Members | `/ban` and auto-ban at threshold |
| Kick Members | Auto-kick on repeated crossposts |
| Moderate Members | Timeout on `/warn` |
| Manage Channels | Creating modmail thread channels |
| Read Message History | Reading messages for crosspost detection |
| Embed Links | Rich embeds in log channels |
| View Channels | General access |

**Recommended invite permission integer:** `1376537725014`

Or use this URL pattern:
```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=1376537725014&scope=bot%20applications.commands
```

### 5. Register slash commands

```bash
npm run deploy-commands
```

This registers commands globally (takes up to 1 hour to propagate). For instant registration during development, set `DEV_GUILD_ID` in `.env`.

### 6. Configure OAuth2 redirect

In the Discord Developer Portal → **OAuth2** tab:
- Add redirect URL: `http://yourdomain.com:3000/auth/discord/callback`
- (Or `http://localhost:3000/auth/discord/callback` for local dev)

### 7. Start the bot

```bash
# Development (auto-reload)
npm run dev

# Production
npm start
```

---

## Deployment with PM2

### Initial deployment

```bash
# Install PM2 globally
npm install -g pm2

# Start the bot
pm2 start src/index.js --name rocketeerbot

# Save the process list (auto-start on reboot)
pm2 save

# Set up PM2 to start on system boot
pm2 startup
```

### Updating the bot

```bash
# Pull latest changes
cd /path/to/rocketeer-bot
git pull

# Install any new dependencies
npm install

# Re-register slash commands (if commands changed)
npm run deploy-commands

# Restart the bot
pm2 restart rocketeerbot
```

### PM2 commands

```bash
pm2 status                    # View running processes
pm2 logs rocketeerbot         # View live logs
pm2 logs rocketeerbot --lines 100  # View last 100 log lines
pm2 restart rocketeerbot      # Restart
pm2 stop rocketeerbot         # Stop
pm2 delete rocketeerbot       # Remove from PM2
pm2 monit                     # Real-time monitoring dashboard
```

### Running behind a reverse proxy (nginx)

If you put the dashboard behind nginx, set `TRUST_PROXY=true` in `.env` and update `DISCORD_CALLBACK_URL` to your public domain.

Example nginx config:

```nginx
server {
    listen 80;
    server_name bot.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Configuration

All settings are configurable per guild via the web dashboard at `/dashboard`.

### Roles
| Setting | Description |
|---|---|
| Moderator Role | Exempt from crosspost detection; can warn and ban |
| Warn Role | Trial mod — can issue warnings but cannot ban |
| Ban Role | Can use `/ban` without needing Ban Members permission |
| Mod Actions Role | Can view moderator action history |
| Ban Reason Role | Can use `/banreason` to look up ban reasons |

### Crosspost Detection
| Setting | Range | Default |
|---|---|---|
| Similarity Threshold | 1-100% | 80% |
| Detection Window | 5-3600 seconds | 30s |
| Repeat Offense Window | 1-168 hours | 48h |
| Auto-Kick Incident Count | 1-50 | 3 |
| Auto-Kick Time Window | 1-10080 minutes | 60min |

### Warning System
| Setting | Range | Default |
|---|---|---|
| Warning Threshold | 1-50 | 3 |
| Custom Warning Reasons | One per line | 10 defaults |

### Channels
- **Warn Log Channel** — receives detailed warning embeds
- **Ban Log Channel** — receives ban notifications
- **Exempt Channels** — channels where crosspost detection is disabled

### Modmail
- **Enable/Disable** toggle
- **Category** — where thread channels are created

### File Blocking
- **Enable/Disable** toggle
- **Blocked Extensions** — comma-separated list (37 defaults)

### Custom Messages
All messages support `{user}` and `{count}` variables:
- First Crosspost Message
- Repeat Crosspost Message
- Public Warning Message

---

## Commands Reference

| Command | Description | Permission |
|---|---|---|
| `/warn <user> <reason> [timeout]` | Issue a warning with optional timeout | Moderator / Warn Role |
| `/warnings <user>` | View a user's warnings | Moderator |
| `/mywarnings` | View your own warnings | Everyone |
| `/clearwarning <user> <number\|all>` | Remove warning(s) | Moderator |
| `/ban <user> [reason] [delete_days]` | Ban a user | Ban Members / Ban Role |
| `/banreason <user_id>` | Look up ban reason | Moderator / Ban Reason Role |
| `/modactions <user> [page]` | View mod action history | Moderator / Mod Actions Role |
| `/modmail setup` | Configure modmail | Moderator |
| `/modmail close` | Close current modmail thread | Moderator |
| `/modmail threads` | List open modmail threads | Moderator |
| `/blockedfiles` | View blocked file extensions | Moderator |
| **Warn User** (right-click message) | Warn via context menu | Moderator |

---

## Database

Uses SQLite (via better-sqlite3) with WAL mode. The database is created automatically on first run with all migrations applied.

Default location: `./data/rocketeerbot.db`

The database auto-migrates through 8 schema versions. No manual migration steps are needed.

### Backup

```bash
# Simple file copy (safe with WAL mode when bot is running)
cp data/rocketeerbot.db data/rocketeerbot.db.backup
```

---

## Project Structure

```
rocketeer-bot/
├── src/
│   ├── index.js                  # Entry point
│   ├── logger.js                 # Winston logger config
│   ├── bot/
│   │   ├── client.js             # Discord.js client setup & intents
│   │   ├── commands/             # Slash commands (warn, ban, modmail, etc.)
│   │   ├── events/               # Event handlers (messageCreate, interactionCreate)
│   │   └── utils/                # Shared utilities (permissions, embeds, etc.)
│   ├── database/
│   │   ├── db.js                 # SQLite connection & migrations
│   │   ├── settings.js           # Guild settings CRUD
│   │   ├── warnings.js           # Warning operations
│   │   ├── messages.js           # In-memory message cache
│   │   ├── modactions.js         # Mod action audit log
│   │   └── modmail.js            # Modmail thread tracking
│   └── web/
│       ├── server.js             # Express setup, OAuth, session
│       ├── routes/               # Dashboard & API routes
│       └── views/                # EJS templates
├── public/
│   ├── css/style.css             # Dashboard styles (dark theme)
│   └── js/dashboard.js           # Client-side dashboard JS
├── deploy-commands.js            # Slash command registration script
├── .env.example                  # Environment variable template
└── package.json
```

---

## License

ISC
