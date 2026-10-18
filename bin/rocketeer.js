#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const https = require('https');

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

function serviceCommand(verb, service, options = {}) {
  const needsRoot = process.getuid && process.getuid() !== 0;
  const prefix = needsRoot && haveCommand('sudo') ? ['sudo'] : [];
  return run('systemctl', [...prefix, verb, service], options);
}

function serviceIsActive(service) {
  if (!haveCommand('systemctl')) return null;
  const prefix = process.getuid && process.getuid() !== 0 && haveCommand('sudo') ? ['sudo'] : [];
  const result = spawn('systemctl', [...prefix, 'is-active', service], { quiet: true });
  return (result.stdout || '').trim();
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
    copyInto(source, destination, { filter: p => !p.includes(`${path.sep}node_modules`) });
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
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir });
}

function fixOwnership(dir, flags) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const user = flags.user || process.env.ROCKETEER_USER;
  if (!user) return;
  run('chown', ['-R', `${user}:`, dir], { allowFail: true, quiet: true });
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

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketeer-update-'));
  const archive = path.join(work, 'release.tar.gz');
  step(`Downloading ${target.ref}`);
  await download(tarballUrl(target.ref), archive);

  step('Extracting');
  const { root, version: newVersion } = extractTarball(work, 'release.tar.gz', 'src');

  const backup = `${dir}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  const restart = !flags['no-restart'];
  let stopped = false;

  try {
    if (restart) {
      step(`Stopping ${service}`);
      serviceCommand('stop', service, { allowFail: true });
      stopped = true;
    }

    step(`Replacing ${dir} (backup: ${path.basename(backup)})`);
    moveDir(dir, backup);
    fs.mkdirSync(dir, { recursive: true });
    copyInto(root, dir);

    for (const keep of KEEP_PATHS) {
      const source = path.join(backup, keep);
      if (!fs.existsSync(source)) continue;
      fs.rmSync(path.join(dir, keep), { recursive: true, force: true });
      copyInto(source, path.join(dir, keep));
    }

    step('Installing dependencies');
    installDependencies(dir);
    fixOwnership(dir, flags);

    if (restart) {
      step(`Starting ${service}`);
      serviceCommand('start', service, { allowFail: true });
      const state = serviceIsActive(service);
      if (state && state !== 'active') {
        throw new Error(`${service} is ${state} after the update`);
      }
    }
  } catch (err) {
    warn(`update failed: ${err.message}`);
    warn(`rolling back to ${currentPkg.version}`);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      moveDir(backup, dir);
      if (restart && stopped) serviceCommand('start', service, { allowFail: true });
    } catch (restoreErr) {
      die(`rollback failed: ${restoreErr.message} (your previous install is in ${backup})`);
    }
    die('the update was rolled back; the previous version is running again');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  pruneBackups(dir);
  if (flags['no-backup']) fs.rmSync(backup, { recursive: true, force: true });
  printReleaseNotes(target, currentPkg.version, newVersion);
}

function cmdServiceVerb(verb, flags, config) {
  const service = resolveService(flags, config);
  step(`${verb} ${service}`);
  serviceCommand(verb, service);
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
  run('systemctl', [...(process.getuid && process.getuid() !== 0 && haveCommand('sudo') ? ['sudo'] : []), 'status', service, '--no-pager', '--lines=5'], { allowFail: true });
  process.exit(state === 'active' ? 0 : 1);
}

function cmdLogs(flags, config) {
  const service = resolveService(flags, config);
  if (!haveCommand('journalctl')) die('journalctl was not found; this command needs a systemd host');
  const prefix = process.getuid && process.getuid() !== 0 && haveCommand('sudo') ? ['sudo'] : [];
  const args = [...prefix, '-u', service, '-n', flags.lines || '200', '--no-pager'];
  if (flags.follow) args.push('-f');
  const result = spawn('journalctl', args, {});
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
  out('  update            Install the latest GitHub release and restart the service');  out('  start             Start the systemd service');
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
