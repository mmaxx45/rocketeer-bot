#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const https = require('https');
const readline = require('readline');

const REPO_OWNER = 'mmaxx45';
const REPO_NAME = 'rocketeer-bot';
const PACKAGE_NAME = 'rocketeerbot';
const DEFAULT_SERVICE = 'rocketeerbot';
const DEFAULT_DIR = '/opt/rocketeer';
const KEEP_BACKUPS = 3;
const KEEP_PATHS = ['.env', 'data'];

const API_BASE = (process.env.ROCKETEER_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
const CODELOAD_BASE = (process.env.ROCKETEER_CODELOAD_BASE || 'https://codeload.github.com').replace(/\/+$/, '');
const CLI_VERSION = require('../package.json').version;

const BOOLEAN_FLAGS = [
  'dry-run', 'no-restart', 'no-service', 'no-cli', 'no-deploy-commands', 'no-backup',
  'non-interactive', 'local', 'install-node', 'force', 'follow', 'help', 'version', 'prerelease',
];

function out(message) {
  process.stdout.write(message + '\n');
}

function step(message) {
  process.stdout.write('==> ' + message + '\n');
}

function warn(message) {
  process.stderr.write('warning: ' + message + '\n');
}

function die(message) {
  process.stderr.write('error: ' + message + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') { flags.help = true; continue; }
    if (arg === '-v' || arg === '--version') { flags.version = true; continue; }
    if (arg === '-f') { flags.follow = true; continue; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const name = arg.slice(2);
        if (BOOLEAN_FLAGS.includes(name)) {
          flags[name] = true;
        } else {
          const value = argv[i + 1];
          if (value === undefined || value.startsWith('--')) die('missing value for --' + name);
          flags[name] = value;
          i++;
        }
      }
      continue;
    }
    positional.push(arg);
  }
  return { flags, positional };
}

function readConfigFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function loadConfig() {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const candidates = [
    process.env.ROCKETEER_CONFIG,
    '/etc/rocketeer/config.json',
    path.join(xdg, 'rocketeer', 'config.json'),
  ].filter(Boolean);
  const config = {};
  for (const file of candidates.slice().reverse()) {
    Object.assign(config, readConfigFile(file));
  }
  return config;
}

function cliPackageRoot() {
  return path.resolve(__dirname, '..');
}

function resolveDir(flags, config) {
  const candidates = [
    flags.dir,
    process.env.ROCKETEER_DIR,
    config.dir,
    fs.existsSync(path.join(DEFAULT_DIR, 'package.json')) ? DEFAULT_DIR : null,
    cliPackageRoot(),
  ];
  const found = candidates.find(candidate => candidate && fs.existsSync(path.join(candidate, 'package.json')));
  if (!found) die('could not find the Rocketeer installation; pass --dir <path>');
  return path.resolve(found);
}

function resolveService(flags, config) {
  return flags.service || process.env.ROCKETEER_SERVICE || config.service || DEFAULT_SERVICE;
}

const IS_WINDOWS = process.platform === 'win32';

function spawnOptions(options = {}) {
  return {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  };
}

function quoteArg(value) {
  const text = String(value);
  return /[\s"&|<>^()]/.test(text) ? '"' + text.replace(/"/g, '\\"') + '"' : text;
}

function spawn(command, args, options = {}) {
  if (IS_WINDOWS) {
    return spawnSync([command, ...args].map(quoteArg).join(' '), { ...spawnOptions(options), shell: true });
  }
  return spawnSync(command, args, { ...spawnOptions(options), shell: false });
}

function run(command, args, options = {}) {
  const result = spawn(command, args, options);
  if (result.error && !options.allowFail) {
    throw new Error(`failed to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0 && !options.allowFail) {
    const detail = options.quiet && result.stderr ? ': ' + String(result.stderr).trim().split('\n').slice(-3).join(' | ') : '';
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}${detail}`);
  }
  return result;
}

function haveCommand(command) {
  const probe = IS_WINDOWS
    ? spawnSync('where ' + quoteArg(command), { stdio: 'ignore', shell: true })
    : spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
  return probe.status === 0;
}

let warnedNoSystemctl = false;

// Run `command args` as root: directly when we already are root, through sudo
// otherwise. sudo has to be the command itself, not an argument to it.
function asRoot(command, args) {
  const needsRoot = typeof process.getuid === 'function' && process.getuid() !== 0;
  if (needsRoot && haveCommand('sudo')) return ['sudo', [command, ...args]];
  return [command, args];
}

function serviceCommand(verb, service, options = {}) {
  if (!haveCommand('systemctl')) {
    if (options.required) die('systemctl was not found; this command needs a systemd host');
    if (!warnedNoSystemctl) {
      warn('systemctl was not found, skipping service management (pass --no-restart to silence this)');
      warnedNoSystemctl = true;
    }
    return { status: 127 };
  }
  const [command, args] = asRoot('systemctl', [verb, service]);
  return run(command, args, options);
}

// is-active is readable by any user, so it never needs sudo.
function serviceIsActive(service) {
  if (!haveCommand('systemctl')) return null;
  const result = spawn('systemctl', ['is-active', service], { quiet: true });
  return (result.stdout || '').trim();
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A Type=simple unit reports "active" the moment it is started, even if the
// bot crashes a second later. Watch it for a few seconds and only call it
// healthy when it is still active at the end.
function waitForHealthyService(service, seconds = 8) {
  let state = serviceIsActive(service);
  for (let i = 0; i < seconds; i++) {
    sleep(1000);
    state = serviceIsActive(service);
    if (state === 'failed') break;
  }
  return state;
}

function request(url, options = {}, redirects = 0) {
  const transport = url.startsWith('http:') ? require('http') : https;
  return new Promise((resolve, reject) => {
    const req = transport.get(url, { headers: { 'User-Agent': 'rocketeer-cli', Accept: 'application/vnd.github+json', ...options.headers } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= 5) return reject(new Error('too many redirects for ' + url));
        return resolve(request(res.headers.location, options, redirects + 1));
      }
      if (res.statusCode === 404) {
        res.resume();
        const err = new Error('not found: ' + url);
        err.statusCode = 404;
        return resolve({ statusCode: 404, body: '' });
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('request failed with status ' + res.statusCode + ': ' + url));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: 200, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('request timed out: ' + url)));
  });
}

async function requestJson(url) {
  const res = await request(url);
  if (res.statusCode === 404) return null;
  return JSON.parse(res.body.toString('utf8'));
}

async function download(url, destination) {
  const res = await request(url);
  if (res.statusCode !== 200) throw new Error('download failed: ' + url);
  fs.writeFileSync(destination, res.body);
  return destination;
}

async function resolveTarget(flags) {
  if (flags.ref) {
    return { ref: flags.ref, release: null, channel: 'ref' };
  }
  if (flags.prerelease) {
    const releases = await requestJson(`${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=30`);
    const newest = Array.isArray(releases) ? releases.find(release => !release.draft) : null;
    if (!newest) {
      die('no published release found. Cut a release, or update to a ref: rocketeer update --ref main');
    }
    return { ref: newest.tag_name, release: newest, channel: 'prerelease' };
  }
  const release = await requestJson(`${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`);
  if (!release) {
    die('no stable release found. For a beta use --prerelease, or update to a ref: rocketeer update --ref main');
  }
  return { ref: release.tag_name, release, channel: 'stable' };
}

function tarballUrl(ref) {
  return `${CODELOAD_BASE}/${REPO_OWNER}/${REPO_NAME}/tar.gz/${encodeURIComponent(ref)}`;
}

function extractTarball(workDir, archiveName, destinationName) {
  const destination = path.join(workDir, destinationName);
  fs.mkdirSync(destination, { recursive: true });
  if (!haveCommand('tar')) die('the tar command is required to apply an update');
  run('tar', ['-xzf', archiveName, '-C', destinationName], { cwd: workDir, quiet: true });
  const entries = fs.readdirSync(destination).filter(name => !name.startsWith('.'));
  if (entries.length === 0) die('the downloaded archive was empty');
  const root = fs.existsSync(path.join(destination, 'package.json')) ? destination : path.join(destination, entries[0]);
  const manifest = path.join(root, 'package.json');
  if (!fs.existsSync(manifest)) die('the downloaded archive does not look like a release of ' + PACKAGE_NAME);
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (pkg.name !== PACKAGE_NAME) die(`the downloaded archive is for "${pkg.name}", not ${PACKAGE_NAME}`);
  return { root, version: pkg.version };
}

function copyInto(source, destination, options = {}) {
  fs.cpSync(source, destination, {
    recursive: true,
    force: true,
    filter: options.filter,
  });
}

function moveDir(source, destination) {
  try {
    fs.renameSync(source, destination);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    // Copy everything, node_modules included: a backup without dependencies
    // could not be rolled back to.
    copyInto(source, destination);
    fs.rmSync(source, { recursive: true, force: true });
  }
}

function pruneBackups(dir) {
  const parent = path.dirname(dir);
  const base = path.basename(dir) + '.bak-';
  let backups;
  try {
    backups = fs.readdirSync(parent).filter(name => name.startsWith(base)).sort();
  } catch {
    return;
  }
  for (const stale of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
    fs.rmSync(path.join(parent, stale), { recursive: true, force: true });
  }
}

function installDependencies(dir) {
  if (!haveCommand(IS_WINDOWS ? 'npm.cmd' : 'npm')) throw new Error('npm was not found on PATH');
  // Output (deprecation notices, package counts) only matters when it fails,
  // and then run() includes the last lines in the error.
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir, quiet: true });
}

// The global `rocketeer` command is a symlink into the installation. npm makes
// the bin files executable when it links them, but an update replaces them
// with the release's files, which must stay executable or the command breaks
// ("Permission denied").
function ensureExecutableBins(dir) {
  if (IS_WINDOWS) return;
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin || {});
  for (const bin of bins) {
    const file = path.join(dir, bin);
    if (fs.existsSync(file)) fs.chmodSync(file, 0o755);
  }
}

// When updating as root, hand the new files back to whoever owned the old
// installation (the service user), unless --user / ROCKETEER_USER says
// otherwise. Without this a `sudo rocketeer update` leaves data/ owned by root
// and the bot can no longer write its database.
function fixOwnership(dir, flags, previousOwner) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const user = flags.user || process.env.ROCKETEER_USER;
  let owner = null;
  if (user) owner = `${user}:`;
  else if (previousOwner && previousOwner.uid !== 0) owner = `${previousOwner.uid}:${previousOwner.gid}`;
  if (!owner) return;
  run('chown', ['-R', owner, dir], { quiet: true });
}

// Since 1.1.0 the bot refuses to start with the example SESSION_SECRET from
// .env.example (anyone could forge a dashboard session with it). Older
// installs made with `curl | bash` still have it, so replace it here rather
// than let the updated bot fail to start. This only logs dashboard users out.
function ensureSessionSecret(envFile) {
  if (!fs.existsSync(envFile)) return;
  const text = fs.readFileSync(envFile, 'utf8');
  const match = text.match(/^SESSION_SECRET=(.*)$/m);
  const value = match ? match[1].trim().replace(/^['"`]|['"`]$/g, '') : '';
  if (match && value !== 'random_session_secret' && value.length >= 16) return;
  const line = `SESSION_SECRET=${require('crypto').randomBytes(32).toString('hex')}`;
  fs.writeFileSync(envFile, match ? text.replace(/^SESSION_SECRET=.*$/m, line) : text.replace(/\n?$/, '\n') + line + '\n');
  step('Generated a new SESSION_SECRET (the old one was the example value or too short)');
}

// Replacing the installation renames it to a sibling backup, which needs write
// access to the parent directory. Check up front, before anything is stopped.
function assertCanReplace(dir) {
  const parent = path.dirname(dir);
  try {
    fs.accessSync(parent, fs.constants.W_OK);
  } catch {
    die(`cannot write to ${parent}, which the update needs for the backup of ${dir}. Re-run with sudo.`);
  }
}

function printReleaseNotes(target, fromVersion, toVersion) {
  const release = target.release;
  out('');
  if (release && release.body) {
    out(`${release.name || release.tag_name} (${fromVersion} -> ${toVersion})`);
    out('');
    out(String(release.body).trim());
  } else {
    out(`Updated ${fromVersion} -> ${toVersion} (ref ${target.ref})`);
  }
}

async function cmdUpdate(flags, config) {
  const dir = resolveDir(flags, config);
  const service = resolveService(flags, config);
  const currentPkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

  step(`Checking for updates (installed ${currentPkg.version} in ${dir})`);
  const target = await resolveTarget(flags);

  if (target.release && target.release.tag_name === `v${currentPkg.version}`) {
    out(`Already on the latest release (${target.release.tag_name})`);
    return;
  }
  if (flags['dry-run']) {
    out('');
    out('Dry run, nothing changed:');
    out(`  install dir : ${dir}`);
    out(`  service     : ${service}`);
    out(`  channel     : ${target.channel}`);
    out(`  target      : ${target.ref}`);
    out(`  download    : ${tarballUrl(target.ref)}`);
    out(`  steps       : download, extract, stop service, replace files, npm ci --omit=dev, start service`);
    out(`  preserved   : ${KEEP_PATHS.join(', ')}`);
    return;
  }

  assertCanReplace(dir);
  const previousOwner = fs.statSync(dir);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketeer-update-'));
  const archive = path.join(work, 'release.tar.gz');
  step(`Downloading ${target.ref}`);
  await download(tarballUrl(target.ref), archive);

  step('Extracting');
  const { root, version: newVersion } = extractTarball(work, 'release.tar.gz', 'src');

  const backup = `${dir}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  const restart = !flags['no-restart'];
  let stopped = false;
  let movedToBackup = false;

  try {
    if (restart) {
      step(`Stopping ${service}`);
      const result = serviceCommand('stop', service, { allowFail: true });
      // 127 means there is no systemctl at all (already warned). Any other
      // failure means the bot may still be running: never swap files under it.
      if (result.status !== 0 && result.status !== 127) {
        throw new Error(`could not stop ${service} (use --no-restart if the bot is not run by systemd)`);
      }
      stopped = result.status === 0;
    }

    step(`Replacing ${dir} (backup: ${path.basename(backup)})`);
    moveDir(dir, backup);
    movedToBackup = true;
    fs.mkdirSync(dir, { recursive: true });
    copyInto(root, dir);

    for (const keep of KEEP_PATHS) {
      const source = path.join(backup, keep);
      if (!fs.existsSync(source)) continue;
      fs.rmSync(path.join(dir, keep), { recursive: true, force: true });
      copyInto(source, path.join(dir, keep));
    }
    ensureSessionSecret(path.join(dir, '.env'));

    step('Installing dependencies');
    installDependencies(dir);
    ensureExecutableBins(dir);
    fixOwnership(dir, flags, previousOwner);

    if (stopped) {
      step(`Starting ${service}`);
      serviceCommand('start', service, { allowFail: true });
      const state = waitForHealthyService(service);
      if (state && state !== 'active') {
        throw new Error(`${service} is ${state} after the update`);
      }
    }
  } catch (err) {
    warn(`update failed: ${err.message}`);
    // Only touch the installation directory once it has actually been moved
    // aside; before that point it is still the live install and holds .env and
    // the database.
    if (movedToBackup) {
      warn(`rolling back to ${currentPkg.version}`);
      try {
        if (stopped) serviceCommand('stop', service, { allowFail: true });
        fs.rmSync(dir, { recursive: true, force: true });
        moveDir(backup, dir);
      } catch (restoreErr) {
        die(`rollback failed: ${restoreErr.message} (your previous install is in ${backup})`);
      }
    }
    if (stopped) serviceCommand('start', service, { allowFail: true });
    die(movedToBackup
      ? `the update was rolled back to ${currentPkg.version}`
      : `nothing was changed; ${dir} is untouched`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  pruneBackups(dir);
  if (flags['no-backup']) fs.rmSync(backup, { recursive: true, force: true });
  printReleaseNotes(target, currentPkg.version, newVersion);
}

// ---------- .env and first-run setup ----------

const ENV_PLACEHOLDERS = {
  DISCORD_TOKEN: 'your_bot_token',
  DISCORD_CLIENT_ID: 'your_client_id',
  DISCORD_CLIENT_SECRET: 'your_client_secret',
};
const DEFAULT_CALLBACK = 'http://localhost:3000/auth/discord/callback';

function unquoteEnv(raw) {
  const value = raw.trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'" || quote === '`') && value.endsWith(quote) && value.length >= 2) return value.slice(1, -1);
  return value.replace(/\s+#.*$/, '');
}

// Quoted the way dotenv reads it back, like install.sh does.
function quoteEnv(value) {
  if (!/[\s#"'`\\]/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('`')) return '`' + value + '`';
  throw new Error('a value cannot contain both \' and `');
}

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = unquoteEnv(match[2]);
  }
  return values;
}

// Replaces or appends KEY=value lines; writing in place keeps the file's
// owner and mode.
function writeEnv(file, updates) {
  const eol = fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n';
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${quoteEnv(value)}`;
    const at = lines.findIndex(l => l.startsWith(`${key}=`));
    if (at !== -1) lines[at] = line;
    else if (lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, line);
    else lines.push(line);
  }
  fs.writeFileSync(file, lines.join(eol));
}

function missingCredentials(values) {
  return Object.keys(ENV_PLACEHOLDERS).filter(key => !values[key] || values[key] === ENV_PLACEHOLDERS[key]);
}

function readEnvOrDie(envFile) {
  try {
    const text = fs.readFileSync(envFile, 'utf8');
    fs.accessSync(envFile, fs.constants.W_OK);
    return text;
  } catch (err) {
    if (err.code === 'ENOENT') die(`${envFile} does not exist; re-run install.sh`);
    if (err.code === 'EACCES' || err.code === 'EPERM') die(`cannot read and write ${envFile}; re-run with sudo`);
    throw err;
  }
}

// One readline interface for a whole series of questions: lines that arrive
// together (pasted, typed ahead) are queued instead of being lost between
// interfaces. While a secret is typed nothing is echoed, not even on redraw.
// ask() resolves to null when the input ends.
function createPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Echo is off between questions too: a line typed ahead may be the answer to
  // a secret question that has not been asked yet.
  let muted = true;
  rl._writeToOutput = text => {
    if (!muted) rl.output.write(text);
  };
  const queued = [];
  let waiting = null;
  let closed = false;
  rl.on('line', line => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      queued.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(null);
    }
  });
  return {
    ask(question, { secret = false } = {}) {
      return new Promise(resolve => {
        const finish = answer => {
          if (muted || answer === null) process.stdout.write('\n');
          muted = true;
          resolve(answer === null ? null : answer.trim());
        };
        muted = false;
        rl.setPrompt(question);
        rl.prompt();
        muted = secret;
        if (queued.length > 0) {
          // Typed ahead, so it was not echoed: show it now unless it is secret.
          const answer = queued.shift();
          if (!secret) {
            process.stdout.write(answer);
            muted = true;
          }
          finish(answer);
        } else if (closed) {
          finish(null);
        } else {
          waiting = finish;
        }
      });
    },
    close() {
      rl.close();
    },
  };
}

// Pasting into a terminal can bring extras that are invisible in hidden input:
// bracketed-paste markers, other escape sequences, control characters,
// surrounding quotes or spaces.
function cleanAnswer(value) {
  return value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .replace(/^(["'`])(.*)\1$/, '$2')
    .trim();
}

const SETUP_FIELDS = [
  { key: 'DISCORD_TOKEN', label: 'Bot token', secret: true, required: true,
    clean: value => value.replace(/^bot\s+/i, ''),
    check: value => {
      if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) return true;
      // The input is hidden, so say what is wrong without showing it.
      const dots = (value.match(/\./g) || []).length;
      const odd = value.replace(/[\w.-]/g, '');
      return `that does not look like a bot token: got ${value.length} characters with ${dots} dot(s)` +
        (odd ? ` and ${odd.length} character(s) a token never contains` : '') +
        '; a bot token has three parts separated by two dots (Bot tab > Reset Token, then Copy)';
    } },
  { key: 'DISCORD_CLIENT_ID', label: 'Application (client) ID', required: true,
    check: value => /^\d{17,20}$/.test(value) || 'the client ID is a 17-20 digit number' },
  { key: 'DISCORD_CLIENT_SECRET', label: 'OAuth2 client secret', secret: true, required: true,
    check: value => !/\s/.test(value) || 'the client secret has no spaces' },
  { key: 'DASHBOARD_URL', label: 'Public dashboard URL', required: false,
    check: value => /^https?:\/\/[^\s/]+/.test(value) || 'use a full URL such as https://bot.example.com' },
];

// Prompts for the Discord credentials and the dashboard URL and writes .env.
async function cmdSetup(flags, config) {
  const dir = resolveDir(flags, config);
  const envFile = path.join(dir, '.env');
  const values = parseEnv(readEnvOrDie(envFile));
  if (!process.stdin.isTTY) die('rocketeer setup needs a terminal to ask questions on; or edit ' + envFile + ' yourself');

  out('Discord application settings - find them at https://discord.com/developers/applications');
  out('(Bot tab: token; OAuth2 tab: client ID and secret). Press Enter to keep a current value.');
  const updates = {};
  const prompter = createPrompter();
  for (const field of SETUP_FIELDS) {
    const current = values[field.key];
    const unset = !current || current === ENV_PLACEHOLDERS[field.key];
    const hint = unset ? '' : field.secret ? ' [keep current]' : ` [${current}]`;
    for (;;) {
      let answer = await prompter.ask(`  ${field.label}${hint}: `, { secret: field.secret });
      if (answer === null) die('setup cancelled; nothing was changed');
      if (!answer) {
        if (unset && field.required) {
          warn(`${field.label} is required`);
          continue;
        }
        break;
      }
      answer = cleanAnswer(answer);
      if (field.clean) answer = field.clean(answer);
      const verdict = field.check(answer);
      if (verdict !== true) {
        warn(verdict);
        continue;
      }
      updates[field.key] = field.key === 'DASHBOARD_URL' ? answer.replace(/\/+$/, '') : answer;
      break;
    }
  }
  prompter.close();

  // Keep the OAuth callback under the dashboard URL unless it was customised.
  const dashboardUrl = updates.DASHBOARD_URL || values.DASHBOARD_URL;
  const callback = values.DISCORD_CALLBACK_URL;
  const derived = previous => `${String(previous || '').replace(/\/+$/, '')}/auth/discord/callback`;
  if (updates.DASHBOARD_URL && (!callback || callback === DEFAULT_CALLBACK || callback === derived(values.DASHBOARD_URL))) {
    updates.DISCORD_CALLBACK_URL = derived(updates.DASHBOARD_URL);
  }

  if (Object.keys(updates).length > 0) writeEnv(envFile, updates);
  ensureSessionSecret(envFile);
  out('');
  out(Object.keys(updates).length > 0 ? `Saved ${envFile}.` : 'Nothing changed.');
  if (dashboardUrl) {
    out(`Make sure ${updates.DISCORD_CALLBACK_URL || callback || derived(dashboardUrl)} is listed under OAuth2 > Redirects in the developer portal.`);
  }
  return Object.keys(updates).length > 0;
}

// Before starting the bot, make sure it has credentials: ask for them on a
// terminal, refuse otherwise (it would only crash-loop on the placeholders).
async function ensureCredentials(flags, config) {
  let dir;
  try {
    dir = resolveDir(flags, config);
  } catch {
    return;
  }
  const envFile = path.join(dir, '.env');
  if (!fs.existsSync(envFile)) return;
  const missing = missingCredentials(parseEnv(readEnvOrDie(envFile)));
  if (missing.length === 0) return;
  if (!process.stdin.isTTY) {
    die(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set in ${envFile}; run "rocketeer setup" first`);
  }
  out(`The Discord credentials are not set yet (${missing.join(', ')}).`);
  await cmdSetup(flags, config);
  if (missingCredentials(parseEnv(fs.readFileSync(envFile, 'utf8'))).length > 0) die('the credentials are still missing');
  out('');
}

async function cmdServiceVerb(verb, flags, config) {
  const service = resolveService(flags, config);
  if (verb === 'start' || verb === 'restart') await ensureCredentials(flags, config);
  step(`${verb} ${service}`);
  serviceCommand(verb, service, { required: true });
  if (verb !== 'stop') {
    const state = serviceIsActive(service);
    if (state) out(`${service}: ${state}`);
  }
}

function cmdStatus(flags, config) {
  const service = resolveService(flags, config);
  const state = serviceIsActive(service);
  if (state === null) die('systemctl was not found; this command needs a systemd host');
  out(`${service}: ${state}`);
  const [command, args] = asRoot('systemctl', ['status', service, '--no-pager', '--lines=5']);
  run(command, args, { allowFail: true });
  process.exit(state === 'active' ? 0 : 1);
}

function cmdLogs(flags, config) {
  const service = resolveService(flags, config);
  if (!haveCommand('journalctl')) die('journalctl was not found; this command needs a systemd host');
  const journalArgs = ['-u', service, '-n', flags.lines || '200', '--no-pager'];
  if (flags.follow) journalArgs.push('-f');
  const [command, args] = asRoot('journalctl', journalArgs);
  const result = spawn(command, args, {});
  process.exit(result.status === null ? 1 : result.status);
}

function cmdVersion(flags, config) {
  const service = resolveService(flags, config);
  out(`rocketeer cli ${CLI_VERSION} (node ${process.version})`);
  try {
    const dir = resolveDir(flags, config);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    out(`installation: ${dir}`);
    out(`bot version : ${pkg.version}`);
  } catch {
    out('installation: not found');
  }
  const state = serviceIsActive(service);
  if (state) out(`service     : ${service} (${state})`);
}

function usage() {
  out(`rocketeer ${CLI_VERSION} - manage a Rocketeer installation`);
  out('');
  out('Usage: rocketeer <command> [options]');
  out('');
  out('Commands:');
  out('  update            Install the latest GitHub release and restart the service');
  out('  setup             Enter the Discord credentials and dashboard URL');
  out('  start             Start the systemd service (asks for credentials if unset)');
  out('  stop              Stop the systemd service');
  out('  restart           Restart the systemd service');
  out('  status            Show the service state');
  out('  logs              Show recent logs (-f to follow)');
  out('  version           Show CLI, installation and service versions');
  out('  help              Show this help');
  out('');
  out('Options:');
  out('  --dir <path>      Installation directory (default /opt/rocketeer, or the CLI package)');
  out('  --service <name>  systemd unit name (default rocketeerbot)');
  out('  --ref <ref>       Update to a tag or branch instead of the latest release');
  out('  --prerelease      Update to the newest release even if it is a prerelease');
  out('  --user <name>     Owner to chown the installation to when running as root');
  out('  --lines <n>       Log lines for "logs" (default 200)');
  out('  --dry-run         Show what update would do, change nothing');
  out('  --no-restart      Update without touching the service');
  out('  --no-backup       Do not keep the previous version as a backup');
  out('');
  out('Environment: ROCKETEER_DIR, ROCKETEER_SERVICE, ROCKETEER_USER, ROCKETEER_CONFIG');
  out('Config file: /etc/rocketeer/config.json or ~/.config/rocketeer/config.json');
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0] || (flags.help ? 'help' : 'help');
  const config = loadConfig();

  if (flags.help && !positional[0]) return usage();
  if (flags.version && !positional[0]) return cmdVersion(flags, config);

  switch (command) {
    case 'update':
      return cmdUpdate(flags, config);
    case 'setup':
      return cmdSetup(flags, config);
    case 'start':
      return cmdServiceVerb('start', flags, config);
    case 'stop':
      return cmdServiceVerb('stop', flags, config);
    case 'restart':
      return cmdServiceVerb('restart', flags, config);
    case 'status':
      return cmdStatus(flags, config);
    case 'logs':
      return cmdLogs(flags, config);
    case 'version':
      return cmdVersion(flags, config);
    case 'help':
      return usage();
    default:
      die(`unknown command "${command}". Run "rocketeer help".`);
  }
}

main().catch(err => die(err.message));
