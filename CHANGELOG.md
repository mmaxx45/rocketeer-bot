# Changelog

All notable changes to RocketeerBot are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Changes land on `main` and are listed under `Unreleased` until a release is cut:
at that point the section is dated and moved under a version heading, then
tagged and published as a GitHub Release - see RELEASING.md. Entries are written
for the people running the bot rather than as a list of commits.

## [Unreleased]

### Fixed

- Installing Node.js no longer prints `WARNING: apt does not have a stable CLI
  interface` (from the NodeSource setup script) or other package manager noise; the
  output of those steps is only shown when one of them fails.

## [1.2.0] - 2026-10-19

### Added

- `rocketeer setup` asks for the Discord bot token, client ID, client secret and the
  dashboard URL and writes them to `.env` (the token and secret are not shown while
  typing; the OAuth callback URL follows the dashboard URL). `rocketeer start` and
  `restart` run it automatically when the credentials are still placeholders, so a
  fresh install only needs `rocketeer start`; without a terminal they refuse instead
  of starting a bot that cannot log in.

### Changed

- `install.sh` installs Node.js 22 (LTS) when Node.js 20 or newer is missing, using
  apt, dnf, yum, apk or pacman (root or sudo needed); `--no-install-node` turns this
  off. It used to stop and ask for `--install-node`, and then only supported apt.
- The installer's prompts now work through `curl ... | bash`: they read from your
  terminal instead of the piped script.

### Fixed

- `curl ... | bash` printed `BASH_SOURCE[0]: unbound variable`: the installer
  assumed it was running from a file.
- The installer is read completely before it runs, so a cut-off download cannot run
  half of it, and no command it starts can consume the rest of a piped script.
- The installer's closing hint no longer suggests `rocketeer start` when no systemd
  service was set up.

## [1.1.0] - 2026-10-19

### Upgrade notes

- The database migrates to schema version 27 on first start (dashboard sessions
  table, and at most one open modmail thread per user; duplicate open threads left by
  an earlier bug are closed, keeping the newest).
- The bot now refuses to start when `SESSION_SECRET` is the example value from
  `.env.example` or shorter than 16 characters. `rocketeer update` replaces such a
  secret for you (dashboard users are logged out once); if you run the bot another
  way, set one yourself: `openssl rand -hex 32`.
- `DATABASE_CLIENT` and `DATABASE_SSL` are validated: anything other than
  `sqlite`/`postgres` (`postgresql` and `pg` are accepted too) or
  `true`/`false`/`no-verify` stops the bot with an error instead of silently falling
  back to SQLite. `DATABASE_SSL=true` now verifies the server certificate; use
  `no-verify` for hosts with self-signed certificates.
- The session cookie is marked secure when `DASHBOARD_URL` starts with `https://`
  (it used to follow `NODE_ENV`), and with an https `DASHBOARD_URL` the reverse proxy
  is trusted automatically unless `TRUST_PROXY=false`. If dashboard login loops after
  updating, check that `DASHBOARD_URL` matches the address you open.
- `discord.js` 14.25 or newer is required (installs use the pinned version).

### Security

- The dashboard was open to stored cross-site scripting: a giveaway host could put
  markup in a giveaway title that ran in an admin's session, and a role name could
  break out of the script block on the settings page. All dashboard output is now
  escaped for its context.
- A user with Manage Server could add a role with Administrator (or any other
  moderation permission) to a self-role panel and click it to grant it to
  themselves. Self-roles must now sit below both the bot's and the requesting user's
  highest role and may not carry Administrator, Manage Server/Roles/Channels/
  Messages/Webhooks, Ban, Kick, Timeout or Mention Everyone; existing panel buttons
  refuse such roles too.
- The API's CSRF check accepted cross-site form posts (multipart or crafted
  `text/plain` bodies). State-changing API requests must now be JSON from the
  dashboard's own origin.
- `install.sh` used to leave the example `SESSION_SECRET` in place when run through
  `curl ... | bash`, letting anyone forge a dashboard session.
- Errors are no longer sent to the browser with stack traces or database messages.

### Added

- PostgreSQL support: set `DATABASE_CLIENT=postgres` with `DATABASE_URL` or the `PG*`
  values, or let `install.sh` ask - it can start Postgres in Docker (writing a
  `docker-compose.yml`) or take credentials you provide, then verifies the connection
  and creates the schema. SQLite remains the default.
- `npm run db:sqlite-to-postgres` copies an existing SQLite database into Postgres
  in one transaction, keeping row ids (see README, "Moving an existing SQLite install
  to Postgres").
- Dashboard logins are stored in the database, so they survive restarts and updates
  (they used to live in memory).

### Changed

- Guild settings are cached in memory and the per-message database work is down to
  a single settings read, which keeps message handling fast on a remote Postgres.
- Buttons, modals and slash commands acknowledge Discord before doing database or
  API work, so slow moments no longer end in "This interaction failed" after the
  action already happened.
- `install.sh` copies a checkout with `--local` without its `.env`, `data/` or
  `docker-compose.yml`, derives `DISCORD_CALLBACK_URL` from the dashboard URL you
  enter, orders the service after Docker when Postgres runs there, and adds basic
  systemd hardening (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`).
- The bot shuts down cleanly on SIGTERM (systemd's stop signal) as well as SIGINT.

### Fixed

- `rocketeer update` run without sudo on a default install (`/opt` owned by root)
  could delete the installation, including `.env` and the database, while trying
  to roll back a backup that was never made. It now checks up front that it can
  make the backup and asks you to re-run with sudo, and a rollback only ever
  touches the directory after it has been moved aside.
- `rocketeer` service commands (`update`, `start`, `stop`, `restart`, `status`,
  `logs`) failed for non-root users because `sudo` was passed to `systemctl` as an
  argument. `update` also no longer swaps files while the service could not be
  stopped, hands the new files back to the previous owner when run as root (a
  `sudo rocketeer update` used to leave `data/` unwritable for the bot), and
  watches the service for a few seconds before calling the update healthy.
- `rocketeer update` no longer shells out to `systemctl` on a host without it.
- `install.sh` writes `.env` values containing `&`, `|`, `\`, quotes or `#`
  correctly, no longer starts the service while `DISCORD_TOKEN` is a placeholder,
  restarts it on a re-run, keeps the Docker Postgres password on a re-run, and
  writes the CLI config to `/etc/rocketeer` with sudo when needed.
- Giveaways: ending, expiring and rerolling can no longer run twice at once and
  announce two sets of winners; winners are always DMed their claim button even when
  the giveaway message was deleted; a double-tapped Claim opens one modmail thread,
  not two; a claim racing the expiry or a reroll can no longer resurrect an old
  winner; entries are refused once a giveaway has ended; a giveaway whose message
  could not be posted is not left behind.
- Modmail: a user whose modmail channel was deleted by hand could never reach the
  moderators again (their DMs were dropped); two quick DMs no longer open two
  threads; the prize-claim thread gets the Close button.
- Ban appeals can no longer be accepted or rejected twice by two moderators at once,
  and a failed unban puts the appeal back to pending.
- An expired temporary ban is only marked done once the unban actually succeeded.
- Two warnings issued at the same moment show their own numbers instead of both
  showing the total.
- Editing a message that contains a whitelisted word no longer deletes it, and edits
  to messages sent before the last restart are checked again.
- A message deleted right after it was sent no longer makes a repost in the right
  channel count as a crosspost.
- The ban buttons show their error when a ban fails instead of leaving
  "Banning..." on screen.
- Dashboard: malformed requests get a 400 instead of hanging; invalid ids get a 404
  instead of a 500; paginated lists no longer skip or repeat entries; concurrent
  edits to list settings (exempt channels, banned domains, giveaway hosts) no longer
  lose changes; the ban appeal form's size limit is enforced.

## [1.1.0-beta] - 2026-10-18

### Added

- `install.sh` installs Rocketeer on a Linux host in one command: it fetches the
  latest GitHub release, installs production dependencies, creates `.env`,
  registers the slash commands, writes and starts a systemd unit, and records the
  installation path for the CLI. Flags cover `--dir`, `--ref`, `--local`,
  `--service-name`, `--user`, `--no-service`, `--no-cli`, `--non-interactive` and
  `--install-node`.
- A `rocketeer` CLI (`bin/rocketeer.js`, zero dependencies, installed globally by
  the installer) manages an installation: `update`, `start`, `stop`, `restart`,
  `status`, `logs`, `version`. `rocketeer update` installs the newest GitHub
  release, re-installs production dependencies, restarts the systemd service and
  prints the release notes; it preserves `.env` and `data/`, keeps the previous
  version as a backup, rolls back and restarts the old version if anything fails,
  and supports `--dry-run`, `--prerelease`, `--ref`, `--no-restart` and
  `--no-backup`.
- Giveaways can require winners to claim their prize within a set window.
  `/giveaway create` takes `claimtime` (accepts `3d`, `24h`, `5m`, `5s`, ...)
  and `claimaction` (`reroll` or `void`, default `reroll`); the dashboard
  create and edit forms expose both.
- Winners now receive a **Claim Prize** button by DM. Claiming opens a modmail
  thread with the winner, the prize and the host so the payout can be arranged,
  and pings the host in that thread. When modmail is disabled the winner is
  pinged in the giveaway channel with the host mentioned instead.
- When a claim window expires, winners who never claimed are invalidated:
  `claimaction: reroll` hands the prize to entrants who have not already
  claimed or expired, with a fresh claim window, while `claimaction: void`
  voids the win without a replacement.

### Fixed

- Giveaway winners who have left the server are no longer selected. Winner
  selection verifies that each drawn entrant is still a guild member and keeps
  drawing until enough feasible winners are found, or the entry pool runs out.
- A giveaway whose entries have all left the server now says so, instead of
  reporting that nobody entered.

### Upgrade notes

- Database schema v26 adds `claim_time`, `claim_deadline` and `claim_action` to
  `giveaways`, plus the `giveaway_claims` table. Existing databases migrate
  automatically on startup; no manual step is required.
