import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const values = new Set(['project', 'config', 'import', 'only', 'state-dir', 'host', 'java', 'minimum-functions', 'storage-bucket', 'firestore-websocket-port', 'logging-port', 'eventarc-port', 'tasks-port']);
const switches = new Set(['resume-state', 'help']);
export function parseOptions(argv) {
  const options = {'storage-bucket': []};
  let command;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { command = argv.slice(i + 1); break; }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument ${arg}; put test commands after --.`);
    const equals = arg.indexOf('=');
    const name = arg.slice(2, equals < 0 ? undefined : equals);
    let value = equals < 0 ? undefined : arg.slice(equals + 1);
    if (switches.has(name)) {
      if (value !== undefined) throw new Error(`--${name} does not take a value`);
      value = true;
    } else if (values.has(name) || name === 'export-on-exit') {
      if (value === undefined && argv[i + 1] && !argv[i + 1].startsWith('--')) value = argv[++i];
      if (value === undefined && name === 'export-on-exit') value = true;
      if (value === undefined || value === '') throw new Error(`--${name} requires a value`);
    } else throw new Error(`Unsupported option --${name}; no option is silently ignored.`);
    if (name === 'storage-bucket') options[name].push(value);
    else {
      if (Object.hasOwn(options, name)) throw new Error(`Duplicate --${name}`);
      options[name] = value;
    }
  }
  return {options, command};
}

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
// Resolve existing parent symlinks even for a destination that does not exist.
export function canonical(path) {
  path = resolve(path);
  if (existsSync(path)) return realpathSync(path);
  return resolve(canonical(dirname(path)), path.slice(dirname(path).length + 1));
}
const contains = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
export function loadProject(options, cwd = process.cwd()) {
  const config = resolve(cwd, options.config || 'firebase.json');
  const directory = dirname(config);
  const data = readJson(config);
  const rc = resolve(directory, '.firebaserc');
  const aliases = existsSync(rc) ? readJson(rc).projects || {} : {};
  const selection = options.project || aliases.default;
  const project = aliases[selection] || selection;
  if (typeof project !== 'string' || !/^demo-[a-z0-9][a-z0-9-]*$/.test(project)) {
    throw new Error('This preview CLI requires a demo-* project ID. Use --project demo-my-app; it does not log into or fall back to cloud Firebase.');
  }
  const core = ['firestore', 'auth', 'storage', 'functions', 'pubsub'];
  const controls = ['hub', 'ui', 'logging', 'eventarc', 'tasks', 'singleProjectMode'];
  const emulators = data.emulators || {};
  for (const name of Object.keys(emulators)) {
    if (![...core, ...controls].includes(name)) throw new Error(`Unsupported configured emulator: ${name}. Use the official CLI for this profile.`);
  }
  // The existing native suite is all-or-nothing. Never silently start extra
  // services when --only asks for a subset; that needs a separate engine change.
  const requested = options.only ? options.only.split(',').sort() : core.filter(name => Object.hasOwn(emulators, name)).sort();
  if (JSON.stringify(requested) !== JSON.stringify([...core].sort())) {
    throw new Error(`This preview supports the complete ${core.join(',')} profile only. Partial service selection is not implemented.`);
  }
  if (emulators.ui?.enabled === false) throw new Error('Disabling the UI is not supported by this native suite profile yet.');
  if (emulators.singleProjectMode === false) throw new Error('Multi-project mode is not supported by this preview.');
  if (Array.isArray(data.firestore)) throw new Error('Multiple configured Firestore databases are not supported by this preview.');
  if (!data.functions || !data.firestore || !data.storage) throw new Error('The complete suite requires functions, firestore and storage configuration.');
  if (!Array.isArray(data.storage)) throw new Error('This preview requires storage to be an array of target/rules entries, as in the accepted suite configuration.');
  for (const entry of data.storage) if (!entry.target || !entry.rules) throw new Error('Each Storage entry needs target and rules.');
  const host = options.host || emulators.firestore?.host || '127.0.0.1';
  if (!['localhost', '127.0.0.1'].includes(host)) throw new Error('This preview binds loopback only; public network exposure is not supported.');
  const defaults = {firestore:8080, auth:9099, storage:9199, functions:5001, pubsub:8085, hub:4400, ui:4000, logging:21007, eventarc:21008, tasks:21009, 'firestore-websocket':9150};
  const ports = {};
  for (const name of [...core, 'hub', 'ui', 'logging', 'eventarc', 'tasks', 'firestore-websocket']) {
    const entry = emulators[name];
    if (entry?.host && entry.host !== host && !(['localhost','127.0.0.1'].includes(entry.host))) throw new Error(`Unsupported host for ${name}`);
    const override = options[`${name}-port`];
    const value = override ?? (name === 'firestore-websocket' ? emulators.firestore?.websocketPort : entry?.port) ?? defaults[name];
    if (value !== undefined) {
      if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) throw new Error(`Invalid port for ${name}`);
      ports[name] = Number(value);
    }
  }
  if (new Set(Object.values(ports)).size !== Object.keys(ports).length) throw new Error('Emulator ports must be distinct');
  const imported = options.import ? canonical(resolve(cwd, options.import)) : undefined;
  let exported = options['export-on-exit'];
  if (exported === true) exported = imported;
  if (options['export-on-exit'] && !exported) throw new Error('--export-on-exit requires --import or an explicit destination');
  if (exported) {
    exported = canonical(resolve(cwd, exported));
    if (contains(exported, canonical(cwd)) || contains(exported, canonical(directory))) throw new Error('Export destination must not be the project directory or an ancestor');
  }
  const state = options['state-dir'] ? canonical(resolve(cwd, options['state-dir'])) : undefined;
  if (state && existsSync(state) && !options['resume-state'] && readdirSync(state).length) throw new Error('Existing nonempty state requires explicit --resume-state; never silently reimport or reset it');
  if (options['minimum-functions'] && !/^\d+$/.test(options['minimum-functions'])) throw new Error('--minimum-functions must be a nonnegative integer');
  if (state && [imported, exported, canonical(directory)].filter(Boolean).some(path => contains(state, path) || (path !== canonical(directory) && contains(path, state)))) {
    throw new Error('State must be separate from seed/export directories and must not contain the project');
  }
  if (options['resume-state'] && (!imported || !state)) throw new Error('--resume-state requires explicit --state-dir and --import');
  if (options['resume-state'] && exported && (contains(imported, exported) || contains(exported, imported))) throw new Error('Resume exports must be separate from the immutable seed');
  return {config, directory, rc, data, project, host, ports, imported, exported, state};
}
