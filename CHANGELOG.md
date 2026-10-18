# Changelog

All notable changes to RocketeerBot are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Changes land on `main` and are listed under `Unreleased` until a release is cut:
at that point the section is dated and moved under a version heading, then
tagged and published as a GitHub Release - see RELEASING.md. Entries are written
for the people running the bot rather than as a list of commits.

## [Unreleased]

### Added

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
