import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../src/store.mjs';
import { fileURLToPath } from 'node:url';

const windows = { skip: process.platform !== 'win32' ? 'Windows cmd.exe required' : false };
const source = fileURLToPath(new URL('../agent.cmd', import.meta.url));

async function setup(t) {
  const parent = path.join(DATA_DIR, 'test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'launcher '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project with spaces');
  await mkdir(path.join(project, 'src'), { recursive: true });
  const launcher = path.join(project, 'agent.cmd');
  await copyFile(source, launcher);
  await writeFile(path.join(project, 'src', 'cli.mjs'), `
console.log(JSON.stringify({ argv: process.argv.slice(2), executable: process.execPath }));
if (process.argv.includes('fail')) process.exitCode = 13;
`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (['path', 'pathext', 'programfiles', 'programfiles(x86)', 'localappdata', 'skai_node_exe'].includes(key.toLowerCase())) delete env[key];
  }
  Object.assign(env, {
    SKAI_NODE_EXE: '',
    PATH: path.join(process.env.SystemRoot, 'System32'),
    PATHEXT: '.EXE;.COM;.BAT;.CMD',
    ProgramFiles: path.join(root, 'Program Files'),
    'ProgramFiles(x86)': path.join(root, 'Program Files x86'),
    LOCALAPPDATA: path.join(root, 'Local AppData'),
  });
  const putNode = async target => {
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(process.execPath, target);
    return target;
  };
  const invoke = (args = 'doctor') => new Promise((resolve, reject) => {
    // Test-owned fixed arguments, fully quoted cmd command line; no shell
    // interpolation of task goals. Production launches still use native Node.
    execFile(process.env.ComSpec || path.join(process.env.SystemRoot, 'System32', 'cmd.exe'),
      ['/d', '/s', '/c', `""${launcher}" ${args}"`],
      { cwd: project, env, windowsHide: true, windowsVerbatimArguments: true, timeout: 10_000, maxBuffer: 65_536 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') return reject(error);
        resolve({ code: error?.code ?? 0, stdout, stderr });
      });
  });
  return { root, env, putNode, invoke };
}

function success(result) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('launcher runs Node from PATH and forwards quoted arguments', windows, async t => {
  const { root, env, putNode, invoke } = await setup(t);
  const node = await putNode(path.join(root, 'Path Node', 'node.exe'));
  env.PATH = path.dirname(node) + path.delimiter + env.PATH;
  const result = success(await invoke('doctor "two words"'));
  assert.equal(result.executable, node);
  assert.deepEqual(result.argv, ['doctor', 'two words']);
});

test('launcher finds a standard Node install when it is missing from PATH', windows, async t => {
  const { env, putNode, invoke } = await setup(t);
  const node = await putNode(path.join(env.ProgramFiles, 'nodejs', 'node.exe'));
  assert.equal(success(await invoke()).executable, node);
});

test('launcher finds a Codex MSIX runtime with an underscore before the version', windows, async t => {
  const { env, putNode, invoke } = await setup(t);
  const node = await putNode(path.join(env.ProgramFiles, 'WindowsApps',
    'OpenAI.CodexPrimaryRuntime_1.0.0_x64__fixture', 'dependencies', 'node', 'bin', 'node.exe'));
  assert.equal(success(await invoke()).executable, node);
});

test('launcher honors an explicit runtime path containing spaces and ampersand', windows, async t => {
  const { root, env, putNode, invoke } = await setup(t);
  const node = await putNode(path.join(root, 'Explicit Node & tools', 'node.exe'));
  env.SKAI_NODE_EXE = node;
  assert.equal(success(await invoke()).executable, node);
});

test('missing Node produces installation guidance without attempting installation', windows, async t => {
  const { invoke } = await setup(t);
  const result = await invoke();
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Node.js was not found/);
  assert.match(result.stdout, /winget install --id OpenJS.NodeJS.LTS/);
  assert.match(result.stdout, /SKAI_NODE_EXE/);
});

test('invalid explicit runtime fails clearly instead of silently choosing another', windows, async t => {
  const { root, env, invoke } = await setup(t);
  env.SKAI_NODE_EXE = path.join(root, 'missing node.exe');
  const result = await invoke();
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /SKAI_NODE_EXE does not point/);
});

test('launcher preserves the CLI exit status', windows, async t => {
  const { root, env, putNode, invoke } = await setup(t);
  env.SKAI_NODE_EXE = await putNode(path.join(root, 'Explicit Node', 'node.exe'));
  const result = await invoke('fail');
  assert.equal(result.code, 13, result.stdout + result.stderr);
});
