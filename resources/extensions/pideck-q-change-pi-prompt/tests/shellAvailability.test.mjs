import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import {
  bashAvailable,
  classifyConfiguredShellKind,
  filterUnavailableShellToolLines,
  hideUnavailableShellTools,
  parseShellPathFromSettings,
  powershellAvailable,
  probeShellAvailability,
  resolveShellPath,
} from '../shellAvailability.ts';

function host(platform, files, path = '') {
  const set = new Set(files);
  return {
    platform,
    env: platform === 'win32' ? { Path: path, USERPROFILE: 'C:\\Users\\me' } : { PATH: path, HOME: '/home/me' },
    exists: file => set.has(file),
  };
}

test('Windows Git Bash and System32 PowerShell are sufficient without PATH', () => {
  const windows = host('win32', [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ]);
  assert.deepEqual(probeShellAvailability(windows), { bash: true, powershell: true });
});

test('Windows without Git Bash still keeps powershell when pwsh.exe is on PATH', () => {
  const windows = host('win32', ['D:\\pwsh\\pwsh.exe'], 'D:\\pwsh');
  assert.equal(bashAvailable(windows), false);
  assert.equal(powershellAvailable(windows), true);
});

test('simulated Windows PATH uses semicolons even when tests run on a non-Windows host', () => {
  const windows = host(
    'win32',
    ['D:\\PowerShell\\pwsh.exe', 'E:\\Git\\bash.exe'],
    'C:\\Nothing;D:\\PowerShell;E:\\Git',
  );
  assert.equal(powershellAvailable(windows), true);
  assert.equal(bashAvailable(windows), true);
});

test('configured shellPath wins over missing Git Bash', () => {
  const windows = host('win32', ['D:\\tools\\bash.exe']);
  assert.equal(bashAvailable(windows, 'D:\\tools\\bash.exe'), true);
  assert.equal(bashAvailable(windows, 'D:\\missing\\bash.exe'), false);
});

test('a configured shellPath is classified by file name and never assumed to be bash', () => {
  const windows = host('win32', [
    'D:\\tools\\pwsh.exe',
    'D:\\tools\\powershell.exe',
    'D:\\tools\\bash.exe',
    'D:\\tools\\sh.exe',
    'C:\\Windows\\System32\\cmd.exe',
  ]);

  // pwsh.exe / powershell.exe -> powershell only
  assert.deepEqual(probeShellAvailability(windows, 'D:\\tools\\pwsh.exe'), { bash: false, powershell: true });
  assert.deepEqual(probeShellAvailability(windows, 'D:\\tools\\powershell.exe'), { bash: false, powershell: true });
  assert.equal(bashAvailable(windows, 'D:\\tools\\pwsh.exe'), false, 'pwsh.exe must not make bash available');

  // bash.exe / sh.exe -> bash only
  assert.deepEqual(probeShellAvailability(windows, 'D:\\tools\\bash.exe'), { bash: true, powershell: false });
  assert.deepEqual(probeShellAvailability(windows, 'D:\\tools\\sh.exe'), { bash: true, powershell: false });
  assert.equal(powershellAvailable(windows, 'D:\\tools\\bash.exe'), false);

  // unknown shells contribute to neither backend
  assert.equal(classifyConfiguredShellKind(windows, 'C:\\Windows\\System32\\cmd.exe'), undefined);
  assert.deepEqual(probeShellAvailability(windows, 'C:\\Windows\\System32\\cmd.exe'), { bash: false, powershell: false });

  // a missing configured path never invents a backend
  assert.deepEqual(probeShellAvailability(windows, 'D:\\tools\\missing.exe'), { bash: false, powershell: false });
});

test('a configured shellPath does not hide a real backend that is also present', () => {
  const windows = host('win32', [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'D:\\tools\\pwsh.exe',
  ]);
  assert.deepEqual(probeShellAvailability(windows, 'D:\\tools\\pwsh.exe'), { bash: true, powershell: true });
});

test('Linux keeps bash at /bin/bash and only accepts pwsh, not Windows powershell.exe', () => {
  const linux = host('linux', ['/bin/bash', '/usr/bin/pwsh']);
  assert.deepEqual(probeShellAvailability(linux), { bash: true, powershell: true });
  assert.equal(powershellAvailable(host('linux', ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'])), false);
});

test('hideUnavailableShellTools only removes missing shells and can keep a pwsh-adapter bash slot', () => {
  const hidden = hideUnavailableShellTools(['read', 'bash', 'powershell', 'edit'], { bash: false, powershell: true });
  assert.deepEqual(hidden.next, ['read', 'powershell', 'edit']);
  assert.deepEqual(hidden.hidden, ['bash']);
  const kept = hideUnavailableShellTools(['bash', 'powershell'], { bash: false, powershell: false }, { keepBash: true });
  assert.deepEqual(kept.next, ['bash']);
  assert.deepEqual(kept.hidden, ['powershell']);
});

test('filterUnavailableShellToolLines drops inactive bash/powershell rows and can collapse to (none)', () => {
  const block = 'Available tools:\n- bash: Execute a bash command\n- powershell: Execute a PowerShell command\n- read: Read file contents';
  assert.equal(
    filterUnavailableShellToolLines(block, ['powershell', 'read']),
    'Available tools:\n- powershell: Execute a PowerShell command\n- read: Read file contents',
  );
  assert.equal(filterUnavailableShellToolLines('Available tools:\n- bash: Execute a bash command', []), 'Available tools:\n(none)');
});

test('parseShellPathFromSettings ignores invalid JSON and non-absolute relative paths', () => {
  assert.equal(parseShellPathFromSettings('{"shellPath":"C:\\\\Git\\\\bin\\\\bash.exe"}'), 'C:\\Git\\bin\\bash.exe');
  assert.equal(parseShellPathFromSettings('{'), undefined);
  assert.equal(resolveShellPath('relative/bash'), undefined);
  assert.equal(resolveShellPath('~/bin/bash', '/home/me'), join('/home/me', 'bin/bash'));
});
