# RocketeerBot Bug Review

Deep review of the entire codebase. Findings listed by severity.

---

## Fixed

### Crosspost detail embed leaked to public channel
**Files:** `src/bot/events/messageCreate.js` (lines 499-504, 593-597)

The detailed crosspost embed (original message content, channel names, similarity score) was being sent publicly in-channel alongside the warning text. This forensic information should only go to the warn log channel for moderators. The in-channel message should just be a simple warning (matching how manual `/warn` works).

Both the first-offense notification and repeat-offense warning were affected. The embeds were removed from the `message.channel.send()` calls — they already get sent to the warn log channel via `sendToWarnLogChannel()`.

---

## High Severity

### 1. Message cache TTL is shorter than the max configurable detection window
**Files:** `src/database/messages.js:13`, `src/web/routes/api.js:49-53`

The in-memory message cache purges entries after 300 seconds (5 minutes):
```js
const DEFAULT_MAX_AGE_SECONDS = 300;
```

But the dashboard allows `crosspost_detection_seconds` up to 3600 (1 hour):
```js
if (val >= 5 && val <= 3600) {
  updateSetting(guildId, 'crosspost_detection_seconds', val);
}
```

Any detection window over 5 minutes silently fails — messages get purged from cache before the window expires, so crossposts go undetected with no error or warning.

**Fix options:**
- Cap the API validation at 300 to match the cache TTL, or
- Make the cache max age dynamic, driven by the largest configured detection window

### 2. `ban_user` button omits the actual reason from Discord audit log
**File:** `src/bot/events/interactionCreate.js:65`

When banning via the "Ban instead" button on the warn threshold prompt:
```js
await member.ban({ reason: `Banned by ${interaction.user.tag}: accumulated warnings` });
```

The specific reason from `pending.reason` is not included. Compare with the `/ban` command's `confirm_ban` handler (line 250) which correctly includes it:
```js
await member.ban({ reason: `Banned by ${interaction.user.tag}: ${pending.reason}` });
```

The mod_actions database log does record the reason (line 70), but Discord's audit log — what admins typically check — just says "accumulated warnings."

---

## Medium Severity

### 3. Bot status is per-guild setting but global in effect
**Files:** `src/web/routes/api.js:132-148`, `src/bot/events/ready.js:34-43`

Each guild can set `bot_status_message` via the dashboard, which immediately calls `client.user.setPresence()`. But a Discord bot only has one presence globally — the last guild to save wins. On startup, the bot arbitrarily picks whichever guild row comes first:
```js
const row = db.prepare('SELECT bot_status_message FROM guild_settings WHERE bot_status_message IS NOT NULL LIMIT 1').get();
```

Multi-guild setups will have admins unknowingly overwriting each other's status.

### 4. Session-cached guild permissions never refresh
**File:** `src/web/routes/auth.js:18-19`

```js
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));
```

The full user profile (including guild list and permissions) is serialized into the session and never refreshed. A user who loses "Manage Guild" permission can still access and modify dashboard settings until their session expires (24 hours).

### 5. `buildCrosspostEmbed` accepts but ignores `crosspostContent` parameter
**File:** `src/bot/events/messageCreate.js:38-47`

```js
function buildCrosspostEmbed(originalContent, originalChannelId, crosspostContent, crosspostChannelId, ...) {
```

The `crosspostContent` parameter is passed in all 4 call sites but never used in the function body. Only the original message is shown. When similarity is at the 80% threshold, 20% of the content differs — mods in the warn log have no way to compare the two versions.

---

## Low Severity

### 6. `clearwarning.js` comment says DESC but query is ASC
**File:** `src/bot/commands/clearwarning.js:90`

```js
const warning = warnings[number - 1]; // warnings are DESC by created_at, matching /warnings display
```

`getWarnings()` in `warnings.js:9` uses `ORDER BY created_at ASC`. The behavior is actually consistent between `/warnings` and `/clearwarning` (both use ASC, so #1 = oldest), but the misleading comment could cause incorrect assumptions during future edits.

### 7. Crosspost notification only goes to the duplicate channel
**File:** `src/bot/events/messageCreate.js:499, 593`

When crosspost is detected, both messages are deleted (original in channel 1, duplicate in channel 2). The notification is sent only to channel 2 (`message.channel`). Users in channel 1 see a message vanish with no explanation. Sending a brief notice to the original channel would improve transparency.

### 8. `cancel_action` button has no permission check
**File:** `src/bot/events/interactionCreate.js:325-333`

The `cancel_action` handler deletes the pending action without verifying `interaction.user.id === pending.moderatorId`. The `cancel_ban` handler (line 312) does check. Not exploitable in practice since these buttons are in ephemeral messages, but inconsistent.

### 9. Modmail channel rename can grow infinitely
**Files:** `src/bot/commands/modmail.js:103`, `src/bot/events/interactionCreate.js:380`

When closing a modmail thread:
```js
await interaction.channel.setName(`closed-${interaction.channel.name}`);
```

If the close flow runs more than once (race condition, retry), the name grows: `closed-closed-closed-modmail-user`. Should check for the prefix first or use a fixed name pattern.
