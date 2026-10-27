import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import test from 'node:test';
import {
	probeShellDetails,
	toRetentionAvailability,
	toKnownHostShells,
	classifyConfiguredShellKind,
	defaultInspectShellPath,
} from '../shellProbe.ts';

test('non-C ProgramFiles Git installation is discovered as available', () => {
	const host = {
		platform: 'win32',
		env: {
			ProgramFiles: 'D:\\Program Files',
			Path: 'C:\\Windows\\System32',
		},
		exists: (file) => file === 'D:\\Program Files\\Git\\bin\\bash.exe',
	};

	const details = probeShellDetails(host);
	assert.equal(details.bash.status, 'available');
	assert.equal(details.bash.source, 'environment');
	assert.equal(details.bash.candidate, 'D:\\Program Files\\Git\\bin\\bash.exe');
});

test('stale registry root where bash.exe does not exist degrades to missing or unknown', () => {
	const host = {
		platform: 'win32',
		env: { Path: 'C:\\Windows\\System32' },
		exists: () => false,
	};
	const discovery = {
		roots: ['E:\\OldGit'],
		status: 'complete',
	};

	const details = probeShellDetails(host, undefined, discovery);
	assert.equal(details.bash.status, 'missing');
	assert.equal(details.bash.reason, 'no-candidate');
	assert.equal(toRetentionAvailability(details).bash, false);
});

test('candidate deduplication is case-insensitive on Windows and preserves preferred source', () => {
	const host = {
		platform: 'win32',
		env: {
			ProgramFiles: 'c:\\program files',
			Path: 'C:\\Program Files\\Git\\bin',
		},
		exists: (file) => file.toLowerCase() === 'c:\\program files\\git\\bin\\bash.exe',
	};

	const details = probeShellDetails(host);
	assert.equal(details.bash.status, 'available');
	assert.equal(details.bash.source, 'environment');
});

test('PATH with quoted entries and spaces parses cleanly', () => {
	const host = {
		platform: 'win32',
		env: {
			Path: '"D:\\Custom Tools\\Git\\bin";C:\\Windows\\System32',
		},
		exists: (file) => file === 'D:\\Custom Tools\\Git\\bin\\bash.exe',
	};

	const details = probeShellDetails(host);
	assert.equal(details.bash.status, 'available');
	assert.equal(details.bash.source, 'path');
	assert.equal(details.bash.candidate, 'D:\\Custom Tools\\Git\\bin\\bash.exe');
});

test('candidate that is a directory is rejected and not available', () => {
	const host = {
		platform: 'win32',
		env: {
			Path: 'C:\\Windows\\System32',
		},
		exists: (file) => file === 'C:\\Program Files\\Git\\bin\\bash.exe',
		inspectShellPath: (file) => {
			if (file === 'C:\\Program Files\\Git\\bin\\bash.exe') {
				return { kind: 'not-file' };
			}
			return { kind: 'missing' };
		},
	};

	const details = probeShellDetails(host);
	assert.equal(details.bash.status, 'missing');
});

test('permission error produces unknown status', () => {
	const host = {
		platform: 'win32',
		env: {
			Path: 'C:\\Windows\\System32',
		},
		exists: () => true,
		inspectShellPath: () => ({ kind: 'unknown', reason: 'access-denied' }),
	};

	const details = probeShellDetails(host);
	assert.equal(details.bash.status, 'unknown');
	assert.equal(details.bash.reason, 'access-denied');
});

test('concrete Git candidate takes precedence over uncertain WindowsApps alias', () => {
	const host = {
		platform: 'win32',
		env: {
			LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
			Path: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps;D:\\Git\\bin',
		},
		exists: (file) => file === 'D:\\Git\\bin\\bash.exe',
		inspectShellPath: (file) => {
			if (file.toLowerCase().includes('windowsapps')) {
				return { kind: 'unknown', reason: 'windows-app-alias' };
			}
			if (file.toLowerCase() === 'd:\\git\\bin\\bash.exe') {
				return { kind: 'file' };
			}
			return { kind: 'missing' };
		},
	};

	const details = probeShellDetails(host);
	// D:\Git\bin\bash.exe is concrete file, so overall bash status is available
	assert.equal(details.bash.status, 'available');
	assert.equal(details.bash.candidate, 'D:\\Git\\bin\\bash.exe');
});

test('configured shellPath classification distinguishes bash and powershell', () => {
	const host = {
		platform: 'win32',
		env: { USERPROFILE: 'C:\\Users\\me' },
		exists: (file) => ['C:\\Users\\me\\pwsh.exe', 'C:\\Users\\me\\bash.exe'].includes(file),
	};

	assert.equal(classifyConfiguredShellKind(host, 'C:\\Users\\me\\pwsh.exe'), 'powershell');
	assert.equal(classifyConfiguredShellKind(host, 'C:\\Users\\me\\bash.exe'), 'bash');
	assert.equal(classifyConfiguredShellKind(host, 'C:\\Users\\me\\cmd.exe'), undefined);

	// Configured pwsh does not make bash available
	const pwshDetails = probeShellDetails(host, 'C:\\Users\\me\\pwsh.exe');
	assert.equal(pwshDetails.bash.status, 'missing');
	assert.equal(pwshDetails.powershell.status, 'available');
});

test('configured shellPath with alias not on PATH evaluates to unknown regardless of exists() divergence', () => {
	const configured = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe';
	const aliasEvidence = { kind: 'unknown', reason: 'windows-app-alias' };

	const hostA = {
		platform: 'win32',
		env: { Path: '', USERPROFILE: 'C:\\Users\\me' },
		exists: () => false,
		inspectShellPath: (p) => (p.toLowerCase() === configured.toLowerCase() ? aliasEvidence : { kind: 'missing' }),
	};
	const hostB = {
		platform: 'win32',
		env: { Path: '', USERPROFILE: 'C:\\Users\\me' },
		exists: () => true,
		inspectShellPath: (p) => (p.toLowerCase() === configured.toLowerCase() ? aliasEvidence : { kind: 'missing' }),
	};
	const discovery = { roots: [], status: 'complete' };

	const detailsA = probeShellDetails(hostA, configured, discovery);
	const detailsB = probeShellDetails(hostB, configured, discovery);

	assert.equal(detailsA.bash.status, 'unknown');
	assert.equal(detailsA.bash.reason, 'windows-app-alias');
	assert.equal(detailsA.bash.source, 'configured');
	assert.equal(detailsA.bash.candidate, configured);

	assert.deepEqual(detailsA.bash, detailsB.bash);
	assert.equal(toRetentionAvailability(detailsA).bash, true);
	assert.equal(toRetentionAvailability(detailsB).bash, true);
});

test('configured shellPath with access-denied produces unknown reason access-denied', () => {
	const configured = 'D:\\PrivateTools\\bash.exe';
	const host = {
		platform: 'win32',
		env: { Path: '' },
		exists: () => false,
		inspectShellPath: (p) => (p === configured ? { kind: 'unknown', reason: 'access-denied' } : { kind: 'missing' }),
	};
	const details = probeShellDetails(host, configured, { roots: [], status: 'complete' });
	assert.equal(details.bash.status, 'unknown');
	assert.equal(details.bash.source, 'configured');
	assert.equal(details.bash.reason, 'access-denied');
});

test('configured PowerShell shellPath with access-denied produces unknown for powershell', () => {
	const configured = 'D:\\PrivateTools\\pwsh.exe';
	const host = {
		platform: 'win32',
		env: { Path: '' },
		exists: () => false,
		inspectShellPath: (p) => (p === configured ? { kind: 'unknown', reason: 'access-denied' } : { kind: 'missing' }),
	};
	const details = probeShellDetails(host, configured, { roots: [], status: 'complete' });
	assert.equal(details.powershell.status, 'unknown');
	assert.equal(details.powershell.source, 'configured');
	assert.equal(details.powershell.reason, 'access-denied');
});

test('configured shellPath explicitly missing produces missing status', () => {
	const configured = 'D:\\NonExistent\\bash.exe';
	const host = {
		platform: 'win32',
		env: { Path: '' },
		exists: () => false,
		inspectShellPath: () => ({ kind: 'missing' }),
	};
	const details = probeShellDetails(host, configured, { roots: [], status: 'complete' });
	assert.equal(details.bash.status, 'missing');
	assert.equal(details.bash.reason, 'no-candidate');
	assert.equal(toRetentionAvailability(details).bash, false);
});

test('boolean projections maintain retention vs child allowlist contract', () => {
	const bothAvailable = {
		bash: { status: 'available', reason: 'static-candidate' },
		powershell: { status: 'available', reason: 'static-candidate' },
	};
	assert.deepEqual(toRetentionAvailability(bothAvailable), { bash: true, powershell: true });
	assert.deepEqual(toKnownHostShells(bothAvailable), { bash: true, powershell: true });

	const bashUnknownPwshAvailable = {
		bash: { status: 'unknown', reason: 'windows-app-alias' },
		powershell: { status: 'available', reason: 'static-candidate' },
	};
	// Retention (fail-open for pruning existing tools): retains bash
	assert.deepEqual(toRetentionAvailability(bashUnknownPwshAvailable), { bash: true, powershell: true });
	// Known host shells for child allowlist rewrite: undefined (do not rewrite or expand!)
	assert.equal(toKnownHostShells(bashUnknownPwshAvailable), undefined);

	const bashMissingPwshAvailable = {
		bash: { status: 'missing', reason: 'no-candidate' },
		powershell: { status: 'available', reason: 'static-candidate' },
	};
	assert.deepEqual(toRetentionAvailability(bashMissingPwshAvailable), { bash: false, powershell: true });
	assert.deepEqual(toKnownHostShells(bashMissingPwshAvailable), { bash: false, powershell: true });
});

test('defaultInspectShellPath: WindowsApps alias scenarios with mock filesystem', () => {
	const env = {
		LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
	};
	const aliasPath = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe';

	// 1. Standard WindowsApps candidate, F_OK succeeds -> unknown / windows-app-alias
	const fsSuccess = {
		stat: () => { throw new Error('stat should not be called'); },
		access: () => undefined,
	};
	assert.deepEqual(
		defaultInspectShellPath('win32', env, aliasPath, fsSuccess),
		{ kind: 'unknown', reason: 'windows-app-alias' },
	);

	// 2. F_OK throws ENOENT -> missing
	const fsEnoent = {
		stat: () => { throw new Error('stat should not be called'); },
		access: () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); },
	};
	assert.deepEqual(
		defaultInspectShellPath('win32', env, aliasPath, fsEnoent),
		{ kind: 'missing' },
	);

	// 3. F_OK throws ENOTDIR -> missing
	const fsEnotdir = {
		stat: () => { throw new Error('stat should not be called'); },
		access: () => { throw Object.assign(new Error('not dir'), { code: 'ENOTDIR' }); },
	};
	assert.deepEqual(
		defaultInspectShellPath('win32', env, aliasPath, fsEnotdir),
		{ kind: 'missing' },
	);

	// 4. F_OK throws EACCES -> unknown / access-denied
	let capturedAccessMode = null;
	let capturedAccessPath = null;
	const fsEacces = {
		stat: () => { throw new Error('stat should not be called'); },
		access: (p, mode) => {
			capturedAccessPath = p;
			capturedAccessMode = mode;
			throw Object.assign(new Error('denied'), { code: 'EACCES' });
		},
	};
	assert.deepEqual(
		defaultInspectShellPath('win32', env, aliasPath, fsEacces),
		{ kind: 'unknown', reason: 'access-denied' },
	);
	assert.equal(capturedAccessPath, aliasPath);
	assert.equal(capturedAccessMode, constants.F_OK, 'WindowsApps alias must check F_OK');

	// 4b. F_OK throws EPERM -> unknown / access-denied
	const fsEperm = {
		stat: () => { throw new Error('stat should not be called'); },
		access: (p, mode) => {
			capturedAccessMode = mode;
			throw Object.assign(new Error('denied'), { code: 'EPERM' });
		},
	};
	assert.deepEqual(
		defaultInspectShellPath('win32', env, aliasPath, fsEperm),
		{ kind: 'unknown', reason: 'access-denied' },
	);
	assert.equal(capturedAccessMode, constants.F_OK);

	// 5. F_OK throws other error -> unknown / io-error
	const fsIoErr = {
		stat: () => { throw new Error('stat should not be called'); },
		access: () => { throw Object.assign(new Error('io error'), { code: 'EIO' }); },
	};
	assert.deepEqual(
		defaultInspectShellPath('win32', env, aliasPath, fsIoErr),
		{ kind: 'unknown', reason: 'io-error' },
	);

	// 6. Microsoft\\WindowsAppsBackup\\bash.exe -> stat is normal file -> file (not alias)
	const backupPath = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsAppsBackup\\bash.exe';
	const fsFile = {
		stat: () => ({ isFile: () => true }),
		access: () => undefined,
	};
	assert.deepEqual(
		defaultInspectShellPath('win32', env, backupPath, fsFile),
		{ kind: 'file' },
	);

	// 7. LOCALAPPDATA missing, but path has standard Microsoft\\WindowsApps structure
	assert.deepEqual(
		defaultInspectShellPath('win32', {}, 'D:\\SomeDir\\Microsoft\\WindowsApps\\bash.exe', fsSuccess),
		{ kind: 'unknown', reason: 'windows-app-alias' },
	);

	// 8. Case-insensitive and forward-slash WindowsApps path
	assert.deepEqual(
		defaultInspectShellPath('win32', env, 'c:/users/me/appdata/local/microsoft/windowsapps/bash.exe', fsSuccess),
		{ kind: 'unknown', reason: 'windows-app-alias' },
	);

	// 9. Normal Windows path where stat is directory -> not-file
	const fsDir = {
		stat: () => ({ isFile: () => false }),
		access: () => undefined,
	};
	assert.deepEqual(
		defaultInspectShellPath('win32', env, 'C:\\Program Files\\Git', fsDir),
		{ kind: 'not-file' },
	);

	// 10. Normal Windows path where stat throws EPERM/EACCES -> unknown / access-denied
	const fsStatDenied = {
		stat: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); },
		access: () => undefined,
	};
	assert.deepEqual(
		defaultInspectShellPath('win32', env, 'C:\\Program Files\\Git\\bin\\bash.exe', fsStatDenied),
		{ kind: 'unknown', reason: 'access-denied' },
	);

	// 11. POSIX normal file where X_OK succeeds -> file
	let capturedPosixMode = null;
	let capturedPosixPath = null;
	const fsPosixOk = {
		stat: () => ({ isFile: () => true }),
		access: (p, mode) => {
			capturedPosixPath = p;
			capturedPosixMode = mode;
			return undefined;
		},
	};
	assert.deepEqual(
		defaultInspectShellPath('linux', {}, '/bin/bash', fsPosixOk),
		{ kind: 'file' },
	);
	assert.equal(capturedPosixPath, '/bin/bash');
	assert.equal(capturedPosixMode, constants.X_OK, 'POSIX file inspection must check X_OK');

	// 12. POSIX normal file where X_OK throws EACCES -> unknown / access-denied
	const fsPosixDenied = {
		stat: () => ({ isFile: () => true }),
		access: (p, mode) => {
			capturedPosixMode = mode;
			throw Object.assign(new Error('denied'), { code: 'EACCES' });
		},
	};
	assert.deepEqual(
		defaultInspectShellPath('linux', {}, '/bin/bash', fsPosixDenied),
		{ kind: 'unknown', reason: 'access-denied' },
	);
	assert.equal(capturedPosixMode, constants.X_OK);
});

test('defaultInspectShellPath with Node vs Bun exists divergence via ShellProbeFileSystem produces consistent alias unknown', () => {
	const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', Path: '' };
	const aliasPath = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe';
	const fsAlias = {
		stat: () => { throw Object.assign(new Error('stat error in alias'), { code: 'EIO' }); },
		access: () => undefined, // F_OK succeeds
	};

	const hostNode = {
		platform: 'win32',
		env,
		exists: () => false,
		inspectShellPath: (p) => defaultInspectShellPath('win32', env, p, fsAlias),
	};
	const hostBun = {
		platform: 'win32',
		env,
		exists: () => true,
		inspectShellPath: (p) => defaultInspectShellPath('win32', env, p, fsAlias),
	};

	const detailsNode = probeShellDetails(hostNode, aliasPath, { roots: [], status: 'complete' });
	const detailsBun = probeShellDetails(hostBun, aliasPath, { roots: [], status: 'complete' });

	assert.equal(detailsNode.bash.status, 'unknown');
	assert.equal(detailsNode.bash.reason, 'windows-app-alias');
	assert.deepEqual(detailsNode.bash, detailsBun.bash);
});

test('POSIX shell PATH preserves exact spacing and literal quotes without Windows trimming', () => {
	// PATH entry has spaces: '/opt/tool bin '
	const posixHost = {
		platform: 'linux',
		env: { PATH: '/opt/tool bin :/usr/bin' },
		exists: () => false,
		inspectShellPath: (p) => {
			if (p === '/opt/tool bin /bash') return { kind: 'file' };
			return { kind: 'missing' };
		},
	};

	const details = probeShellDetails(posixHost, undefined, { roots: [], status: 'complete' });
	assert.equal(details.bash.status, 'available');
	assert.equal(details.bash.source, 'path');
	assert.equal(details.bash.candidate, '/opt/tool bin /bash');

	// PATH entry with literal quotes: '/opt/"quoted dir"' is not unquoted on POSIX
	const quotedHost = {
		platform: 'linux',
		env: { PATH: '/opt/"quoted dir"' },
		exists: () => false,
		inspectShellPath: (p) => {
			if (p === '/opt/"quoted dir"/bash') return { kind: 'file' };
			return { kind: 'missing' };
		},
	};

	const quotedDetails = probeShellDetails(quotedHost, undefined, { roots: [], status: 'complete' });
	assert.equal(quotedDetails.bash.status, 'available');
	assert.equal(quotedDetails.bash.candidate, '/opt/"quoted dir"/bash');
});
