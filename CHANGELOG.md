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

- `rocketeer update` no longer shells out to `systemctl` on a host without it: it
  warns once and skips service management instead of printing shell errors.
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
- `install.sh` now generates `SESSION_SECRET` in every mode. With
  `curl ... | bash` there is no terminal, so the dashboard used to run with the
  example secret from `.env.example`, letting anyone forge a session.
- `install.sh` writes `.env` values containing `&`, `|`, `\`, quotes or `#`
  correctly, no longer starts the service while `DISCORD_TOKEN` is a placeholder
  (it only enables it), restarts the service on a re-run, and writes the CLI
  config to `/etc/rocketeer` with sudo when needed.
- A giveaway could be ended (or its claim window expired) twice at once by the
  scheduler, the End button, `/giveaway end` and the dashboard, announcing two sets
  of winners. Ending, expiring and rerolling are now serialised per giveaway.
- Claiming a giveaway prize while the server was unavailable recorded the claim
  anyway, so retrying said "already claimed". Once every winner has claimed, the
  giveaway message now updates straight away.
- Opening a modmail thread for a prize claim when the user's previous modmail
  channel had been deleted left the stale thread open in the database.

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
