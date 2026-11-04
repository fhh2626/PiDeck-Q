import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowsGitDiscoveryProvider } from '../windowsShellDiscovery.ts';
import { probeShellDetails, toRetentionAvailability, toKnownHostShells } from '../shellProbe.ts';

test('non-Windows platforms do not execute helper process and return complete with empty roots', async () => {
	let executed = false;
	const provider = createWindowsGitDiscoveryProvider({
		platform: 'linux',
		exec: async () => {
			executed = true;
			return { stdout: '{}', stderr: '' };
		},
	});
	const result = await provider();
	assert.equal(executed, false);
	assert.deepEqual(result, { roots: [], status: 'complete' });
});

test('successful Windows registry query with all valid roots normalizes, deduplicates, and validates root paths', async () => {
	const calls = [];
	const fakeJson = JSON.stringify({
		roots: [
			'D:\\Program Files\\Git\\',
			'D:/Program Files/Git',
			'  E:\\Git  ',
			'\\\\server\\share\\Git',
		],
		status: 'complete',
	});

	const provider = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		env: { SystemRoot: 'C:\\Windows' },
		exec: async (file, args, options) => {
			calls.push({ file, args, options });
			return { stdout: fakeJson, stderr: '' };
		},
	});

	const result = await provider();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
	assert.equal(calls[0].options.shell, false);
	assert.equal(calls[0].options.windowsHide, true);
	assert.equal(calls[0].options.timeout, 2000);
	assert.equal(calls[0].options.maxBuffer, 65536);

	// Normalization & deduplication: D:\Program Files\Git (case-insensitive deduplication, trailing slash stripped), E:\Git, \\server\share\Git
	assert.equal(result.status, 'complete');
	assert.deepEqual(result.roots, ['D:\\Program Files\\Git', 'E:\\Git', '\\\\server\\share\\Git']);
});

test('mixing invalid root entries degrades discovery status to unknown while retaining valid roots', async () => {
	const fakeJson = JSON.stringify({
		roots: [
			'D:\\Program Files\\Git\\',
			'relative\\path',
			'',
			123,
			'D:RelativeDrivePath',
			'\\RootRelativeWithoutDrive',
			'%PROGRAMFILES%\\Git',
		],
		status: 'complete',
	});

	const provider = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		exec: async () => ({ stdout: fakeJson, stderr: '' }),
	});

	const result = await provider();
	assert.equal(result.status, 'unknown');
	assert.deepEqual(result.roots, ['D:\\Program Files\\Git']);
});

test('strict top-level structure validation degrades corrupt shapes to empty unknown', async () => {
	const testCases = [
		'{ "roots": [], "status": "complete" }', // valid empty
		'{ "roots": "D:\\\\Git", "status": "complete" }', // roots is string
		'{ "status": "complete" }', // roots missing
		'{ "roots": ["D:\\\\Git"] }', // status missing
		'{ "roots": ["D:\\\\Git"], "status": "invalid-status" }', // status invalid
		'[ { "roots": ["D:\\\\Git"], "status": "complete" } ]', // array root
		'null', // null root
		'{ "roots": ["relative\\\\only"], "status": "complete" }', // relative only
		'{ "roots": ["%VAR%\\\\Git"], "status": "complete" }', // %VAR% only
		'{ "roots": ["D:\\\\Git"], "status": "unknown" }', // original status unknown with valid root
	];

	// 1. Valid empty roots
	const p0 = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		exec: async () => ({ stdout: testCases[0], stderr: '' }),
	});
	assert.deepEqual(await p0(), { roots: [], status: 'complete' });

	// 2. roots is string -> empty roots, unknown
	const p1 = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		exec: async () => ({ stdout: testCases[1], stderr: '' }),
	});
	assert.deepEqual(await p1(), { roots: [], status: 'unknown' });

	// 3. roots missing -> empty roots, unknown
	const p2 = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		exec: async () => ({ stdout: testCases[2], stderr: '' }),
	});
	assert.deepEqual(await p2(), { roots: [], status: 'unknown' });

	// 4. status missing -> empty roots, unknown
	const p3 = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		exec: async () => ({ stdout: testCases[3], stderr: '' }),
	});
	assert.deepEqual(await p3(), { roots: [], status: 'unknown' });

	// 5. status invalid -> empty roots, unknown
	const p4 = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		exec: async () => ({ stdout: testCases[4], stderr: '' }),
	});
	assert.deepEqual(await p4(), { roots: [], status: 'unknown' });

	// 6. top-level array -> empty roots, unknown
	const p5 = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		exec: async () => ({ stdout: testCases[5], stderr: '' }),
	});
	assert.deepEqual(await p5(), { roots: [], status: 'unknown' });

	// 7. top-level null -> empty roots, unknown
	const p6 = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		exec: async () => ({ stdout: testCases[6], stderr: '' }),
	});
	assert.deepEqual(await p6(), { roots: [], status: 'unknown' });

	// 8. only relative path -> empty roots, unknown
	const p7 = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		exec: async () => ({ stdout: testCases[7], stderr: '' }),
	});
	assert.deepEqual(await p7(), { roots: [], status: 'unknown' });

	// 9. %VAR% path -> empty roots, unknown (not expanded)
	const p8 = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		exec: async () => ({ stdout: testCases[8], stderr: '' }),
	});
	assert.deepEqual(await p8(), { roots: [], status: 'unknown' });

	// 10. original status unknown with valid root -> retains valid root, status unknown
	const p9 = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		exec: async () => ({ stdout: testCases[9], stderr: '' }),
	});
	assert.deepEqual(await p9(), { roots: ['D:\\Git'], status: 'unknown' });
});

test('timeout errors degrade gracefully and are cached for TTL then refreshed', async () => {
	let currentTime = 1000;
	let execCount = 0;

	const provider = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		now: () => currentTime,
		ttlMs: 60_000,
		exec: async () => {
			execCount++;
			if (execCount === 1) {
				const err = new Error('timed out');
				err.killed = true;
				err.signal = 'SIGTERM';
				throw err;
			}
			return { stdout: JSON.stringify({ roots: ['D:\\GitRecovered'], status: 'complete' }), stderr: '' };
		},
	});

	const res1 = await provider();
	assert.deepEqual(res1, { roots: [], status: 'unknown' });
	assert.equal(execCount, 1);

	// Within 60s TTL: failure is cached
	currentTime += 30_000;
	const res2 = await provider();
	assert.deepEqual(res2, { roots: [], status: 'unknown' });
	assert.equal(execCount, 1);

	// Past 60s TTL: retries and recovers successfully
	currentTime += 31_000;
	const res3 = await provider();
	assert.deepEqual(res3, { roots: ['D:\\GitRecovered'], status: 'complete' });
	assert.equal(execCount, 2);
});

test('maxBuffer errors degrade gracefully to empty unknown and are cached for TTL', async () => {
	let currentTime = 1000;
	let execCount = 0;

	const provider = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		now: () => currentTime,
		ttlMs: 60_000,
		exec: async () => {
			execCount++;
			if (execCount === 1) {
				const err = Object.assign(new Error('fixture maxBuffer exceeded'), {
					code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
				});
				throw err;
			}
			return { stdout: JSON.stringify({ roots: ['D:\\GitRecovered'], status: 'complete' }), stderr: '' };
		},
	});

	const res1 = await provider();
	assert.deepEqual(res1, { roots: [], status: 'unknown' });
	assert.equal(execCount, 1);

	// Within 60s TTL: failure is cached
	currentTime += 30_000;
	const res2 = await provider();
	assert.deepEqual(res2, { roots: [], status: 'unknown' });
	assert.equal(execCount, 1);

	// Past 60s TTL: retries and recovers successfully
	currentTime += 31_000;
	const res3 = await provider();
	assert.deepEqual(res3, { roots: ['D:\\GitRecovered'], status: 'complete' });
	assert.equal(execCount, 2);
});

test('partial success result (status unknown with roots) is cached for default 60s TTL', async () => {
	let currentTime = 1000;
	let execCount = 0;

	const provider = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		now: () => currentTime,
		// Notice: ttlMs is omitted to verify default 60_000ms TTL!
		exec: async () => {
			execCount++;
			if (execCount === 1) {
				return { stdout: JSON.stringify({ roots: ['D:\\Git'], status: 'unknown' }), stderr: 'Access denied on HKLM' };
			}
			return { stdout: JSON.stringify({ roots: ['D:\\GitNew'], status: 'complete' }), stderr: '' };
		},
	});

	const res1 = await provider();
	assert.equal(res1.status, 'unknown');
	assert.deepEqual(res1.roots, ['D:\\Git']);
	assert.equal(execCount, 1);

	// Within 60s TTL (at 30s): result is cached
	currentTime += 30_000;
	const res2 = await provider();
	assert.equal(res2.status, 'unknown');
	assert.deepEqual(res2.roots, ['D:\\Git']);
	assert.equal(execCount, 1);

	// Past 60s TTL (at 61s): refreshed
	currentTime += 31_000;
	const res3 = await provider();
	assert.equal(res3.status, 'complete');
	assert.deepEqual(res3.roots, ['D:\\GitNew']);
	assert.equal(execCount, 2);
});

test('PowerShell command arguments and fixed script contract match static expectations', async () => {
	let capturedFile = '';
	let capturedArgs = [];
	let capturedOptions = null;

	const provider = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		env: { SystemRoot: 'C:\\Windows' },
		exec: async (file, args, options) => {
			capturedFile = file;
			capturedArgs = args;
			capturedOptions = options;
			return { stdout: JSON.stringify({ roots: ['D:\\Git'], status: 'complete' }), stderr: '' };
		},
	});

	await provider();

	assert.equal(capturedFile, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
	assert.deepEqual(capturedArgs.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);

	const script = capturedArgs[4];
	assert.ok(script.includes('[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames'), 'Must use DoNotExpandEnvironmentNames');
	assert.ok(script.includes("OpenSubKey('Software\\GitForWindows', $false)"), 'Must open Software\\GitForWindows in read-only mode ($false)');
	assert.ok(script.includes('[Microsoft.Win32.RegistryHive]::CurrentUser'), 'Must query CurrentUser');
	assert.ok(script.includes('[Microsoft.Win32.RegistryHive]::LocalMachine'), 'Must query LocalMachine');
	assert.ok(script.includes('[Microsoft.Win32.RegistryView]::Registry32'), 'Must query Registry32');
	assert.ok(script.includes('[Microsoft.Win32.RegistryView]::Registry64'), 'Must query Registry64');
	assert.ok(script.includes('$subKey.Dispose()'), 'Must dispose subKey in finally');
	assert.ok(script.includes('$baseKey.Dispose()'), 'Must dispose baseKey in finally');
	assert.equal(script.includes('IsPathRooted'), false, 'Must not use IsPathRooted to silently filter paths');

	assert.equal(capturedOptions.shell, false);
	assert.equal(capturedOptions.windowsHide, true);
	assert.equal(capturedOptions.timeout, 2000);
	assert.equal(capturedOptions.maxBuffer, 65536);
});

test('partial registry failure reports unknown status while retaining discovered roots', async () => {
	const fakeJson = JSON.stringify({
		roots: ['D:\\Program Files\\Git'],
		status: 'unknown',
	});

	const provider = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		exec: async () => ({ stdout: fakeJson, stderr: 'Access is denied' }),
	});

	const result = await provider();
	assert.equal(result.status, 'unknown');
	assert.deepEqual(result.roots, ['D:\\Program Files\\Git']);
});

test('spawn error, timeout, or invalid JSON degrades gracefully to status=unknown with empty roots', async () => {
	// 1. Process spawn error
	const failProvider = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		exec: async () => {
			throw new Error('powershell.exe not found');
		},
	});
	const res1 = await failProvider();
	assert.deepEqual(res1, { roots: [], status: 'unknown' });

	// 2. Corrupt / invalid JSON
	const corruptProvider = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		exec: async () => ({ stdout: 'not valid json', stderr: '' }),
	});
	const res2 = await corruptProvider();
	assert.deepEqual(res2, { roots: [], status: 'unknown' });
});

test('concurrent calls share the same in-flight execution promise', async () => {
	let execCount = 0;
	let resolveExec;
	const provider = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		exec: () => {
			execCount++;
			return new Promise(resolve => {
				resolveExec = resolve;
			});
		},
	});

	const p1 = provider();
	const p2 = provider();
	assert.equal(execCount, 1);

	resolveExec({ stdout: JSON.stringify({ roots: ['D:\\Git'], status: 'complete' }), stderr: '' });
	const [res1, res2] = await Promise.all([p1, p2]);
	assert.deepEqual(res1, res2);
	assert.equal(execCount, 1);
});

test('results and failures are cached for TTL (60s) and refreshed afterwards', async () => {
	let currentTime = 1000;
	let execCount = 0;

	const provider = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		now: () => currentTime,
		ttlMs: 60_000,
		exec: async () => {
			execCount++;
			return { stdout: JSON.stringify({ roots: [`D:\\Git${execCount}`], status: 'complete' }), stderr: '' };
		},
	});

	const res1 = await provider();
	assert.equal(res1.roots[0], 'D:\\Git1');
	assert.equal(execCount, 1);

	// Within 60s TTL: returns cached
	currentTime += 30_000;
	const res2 = await provider();
	assert.equal(res2.roots[0], 'D:\\Git1');
	assert.equal(execCount, 1);

	// Past 60s TTL: triggers new execution
	currentTime += 31_000;
	const res3 = await provider();
	assert.equal(res3.roots[0], 'D:\\Git2');
	assert.equal(execCount, 2);
});

test('invalid registry roots (control chars, incomplete UNC, device paths) degrade to unknown', async () => {
	const invalidInputs = [
		'D:\\Git\n',
		'\tD:\\Git',
		'D:\\Gi\x00t',
		'\\\\server\\/',
		'\\\\?/C:\\Git',
		'\\\\./C:\\Git',
		'\\\\?\\C:\\Git',
		'\\\\.\\C:\\Git',
	];

	for (const input of invalidInputs) {
		const provider = createWindowsGitDiscoveryProvider({
			platform: 'win32',
			exec: async () => ({
				stdout: JSON.stringify({ roots: [input], status: 'complete' }),
				stderr: '',
			}),
		});

		const res = await provider();
		assert.equal(res.status, 'unknown', `Input ${JSON.stringify(input)} must degrade status to unknown`);
		assert.deepEqual(res.roots, [], `Input ${JSON.stringify(input)} must not yield any valid root`);
	}

	// Mixed valid and invalid entries
	const mixedProvider = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		exec: async () => ({
			stdout: JSON.stringify({ roots: ['D:\\Git', 'D:\\Git\n', '\\\\server\\/'], status: 'complete' }),
			stderr: '',
		}),
	});
	const mixedRes = await mixedProvider();
	assert.equal(mixedRes.status, 'unknown');
	assert.deepEqual(mixedRes.roots, ['D:\\Git']);
});

test('valid roots with drive root, slashes, whitespace, and full UNC normalize correctly', async () => {
	const validCases = [
		{ input: 'D:\\', expected: 'D:\\' },
		{ input: 'D:/Git/', expected: 'D:\\Git' },
		{ input: '  D:\\Git  ', expected: 'D:\\Git' },
		{ input: '\\\\server\\share\\Git', expected: '\\\\server\\share\\Git' },
		{ input: '//server/share/Git', expected: '\\\\server\\share\\Git' },
		{ input: '//server/share/', expected: '\\\\server\\share\\' },
	];

	for (const { input, expected } of validCases) {
		const provider = createWindowsGitDiscoveryProvider({
			platform: 'win32',
			exec: async () => ({
				stdout: JSON.stringify({ roots: [input], status: 'complete' }),
				stderr: '',
			}),
		});
		const res = await provider();
		assert.equal(res.status, 'complete', `Input ${JSON.stringify(input)} should be complete`);
		assert.deepEqual(res.roots, [expected], `Input ${JSON.stringify(input)} should normalize to ${expected}`);
	}

	// Case-insensitive deduplication preserves first
	const dedupProvider = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		exec: async () => ({
			stdout: JSON.stringify({ roots: ['D:\\Git', 'd:\\git', 'D:/GIT/'], status: 'complete' }),
			stderr: '',
		}),
	});
	const dedupRes = await dedupProvider();
	assert.equal(dedupRes.status, 'complete');
	assert.deepEqual(dedupRes.roots, ['D:\\Git']);
});

test('invalid registry output degraded to unknown chains into probeShellDetails and projections', async () => {
	const provider = createWindowsGitDiscoveryProvider({
		platform: 'win32',
		exec: async () => ({
			stdout: JSON.stringify({ roots: ['\\\\server\\/'], status: 'complete' }),
			stderr: '',
		}),
	});
	const discovery = await provider();
	assert.equal(discovery.status, 'unknown');
	assert.deepEqual(discovery.roots, []);

	const details = probeShellDetails(
		{ platform: 'win32', env: { Path: '' }, exists: () => false },
		undefined,
		discovery,
	);

	assert.equal(details.bash.status, 'unknown');
	assert.equal(details.bash.reason, 'discovery-incomplete');
	assert.equal(toRetentionAvailability(details).bash, true, 'retention availability must be true (fail-open) for unknown');
	assert.equal(toKnownHostShells(details), undefined, 'toKnownHostShells must be undefined for unknown');
});
