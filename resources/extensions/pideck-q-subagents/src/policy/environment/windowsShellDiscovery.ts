/**
 * Windows GitForWindows registry install path discovery.
 * Uses bounded async Windows PowerShell script calling Microsoft.Win32.RegistryKey.
 * No user input or dynamic paths are interpolated into the command.
 */
import { execFile } from 'node:child_process';
import { win32 as win32Path } from 'node:path';

export interface WindowsGitDiscovery {
	roots: readonly string[];
	status: 'complete' | 'unknown';
}

export type WindowsGitDiscoveryProvider = () => Promise<WindowsGitDiscovery>;

export interface WindowsGitDiscoveryOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	exec?: (
		file: string,
		args: string[],
		options: { shell: boolean; windowsHide: boolean; timeout: number; maxBuffer: number },
	) => Promise<{ stdout: string; stderr: string }>;
	now?: () => number;
	ttlMs?: number;
}

const REGISTRY_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$status = 'complete'
$roots = [System.Collections.Generic.List[string]]::new()
$hives = @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)
$views = @([Microsoft.Win32.RegistryView]::Registry32)
if ([System.Environment]::Is64BitOperatingSystem) {
    $views += [Microsoft.Win32.RegistryView]::Registry64
}

foreach ($hive in $hives) {
    foreach ($view in $views) {
        $baseKey = $null
        $subKey = $null
        try {
            $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
            $subKey = $baseKey.OpenSubKey('Software\\GitForWindows', $false)
            if ($null -ne $subKey) {
                $raw = $subKey.GetValue('InstallPath', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                if ($null -ne $raw) {
                    if ($raw -is [string]) {
                        $roots.Add($raw)
                    } else {
                        $status = 'unknown'
                    }
                }
            }
        } catch {
            $status = 'unknown'
        } finally {
            if ($null -ne $subKey) { $subKey.Dispose() }
            if ($null -ne $baseKey) { $baseKey.Dispose() }
        }
    }
}

[PSCustomObject]@{
    roots = $roots
    status = $status
} | ConvertTo-Json -Compress
`.trim();

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_BUFFER = 65_536;

function defaultExec(
	file: string,
	args: string[],
	options: { shell: boolean; windowsHide: boolean; timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(file, args, options, (error, stdout, stderr) => {
			if (error) {
				reject(error);
				return;
			}
			resolve({ stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidAbsoluteRoot(cleanPath: string): boolean {
	// cleanPath is already trimmed, normalized with win32Path.normalize, and verified free of control characters.
	// Only accept standard drive letter root (e.g. D:\Git) or full UNC path (\\\\server\\share\\Git)
	// Reject device namespaces \\?\ and \\.\
	if (cleanPath.startsWith('\\\\?\\') || cleanPath.startsWith('\\\\.\\')) return false;
	if (/^[A-Za-z]:\\/.test(cleanPath)) return true;
	if (/^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(cleanPath)) return true;
	return false;
}

function normalizeRoots(rawRoots: readonly unknown[]): { roots: string[]; invalid: boolean } {
	const seen = new Set<string>();
	const validRoots: string[] = [];
	let invalid = false;

	for (const item of rawRoots) {
		if (typeof item !== 'string') {
			invalid = true;
			continue;
		}

		// 2. 在 trim 之前检查原始字符串：包含 % 或控制字符 / 行分隔符
		if (item.includes('%') || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(item)) {
			invalid = true;
			continue;
		}

		// 3. 调用 trim，保留正常外围空格兼容
		const trimmed = item.trim();

		// 4. 空字符串则 invalid
		if (!trimmed) {
			invalid = true;
			continue;
		}

		// 5. win32Path.normalize 得到统一 Windows 分隔符的 clean
		let clean = win32Path.normalize(trimmed);

		// 6. 对 clean 校验：拒绝设备命名空间，仅接受盘符绝对路径或完整 UNC
		if (!isValidAbsoluteRoot(clean)) {
			invalid = true;
			continue;
		}

		// 7. 去除非根目录的末尾分隔符，保留根目录语义 (例如 D:\ 或 \\server\share\)
		const rootLength = win32Path.parse(clean).root.length;
		if (clean.length > rootLength && clean.endsWith('\\')) {
			clean = clean.slice(0, -1);
		}

		const lowerKey = clean.toLowerCase();
		if (!seen.has(lowerKey)) {
			seen.add(lowerKey);
			validRoots.push(clean);
		}
	}

	return { roots: validRoots, invalid };
}

export function createWindowsGitDiscoveryProvider(
	options: WindowsGitDiscoveryOptions = {},
): WindowsGitDiscoveryProvider {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const exec = options.exec ?? defaultExec;
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

	if (platform !== 'win32') {
		return async () => ({ roots: [], status: 'complete' });
	}

	let cachedResult: WindowsGitDiscovery | null = null;
	let cachedAt = 0;
	let inFlight: Promise<WindowsGitDiscovery> | null = null;

	const resolvePowerShellExe = (): string | null => {
		const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR;
		if (systemRoot && win32Path.isAbsolute(systemRoot)) {
			return win32Path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
		}
		return 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
	};

	const executeQuery = async (): Promise<WindowsGitDiscovery> => {
		const powershellExe = resolvePowerShellExe();
		if (!powershellExe) {
			return { roots: [], status: 'unknown' };
		}

		try {
			const { stdout } = await exec(
				powershellExe,
				['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', REGISTRY_SCRIPT],
				{
					shell: false,
					windowsHide: true,
					timeout: DEFAULT_TIMEOUT_MS,
					maxBuffer: DEFAULT_MAX_BUFFER,
				},
			);

			const parsed: unknown = JSON.parse(stdout.trim());
			if (!isRecord(parsed)) {
				return { roots: [], status: 'unknown' };
			}
			if (!Array.isArray(parsed.roots)) {
				return { roots: [], status: 'unknown' };
			}
			if (parsed.status !== 'complete' && parsed.status !== 'unknown') {
				return { roots: [], status: 'unknown' };
			}

			const { roots, invalid } = normalizeRoots(parsed.roots);
			const status = (parsed.status === 'complete' && !invalid) ? 'complete' : 'unknown';

			return {
				roots,
				status,
			};
		} catch {
			return { roots: [], status: 'unknown' };
		}
	};

	return async (): Promise<WindowsGitDiscovery> => {
		const current = now();
		if (cachedResult && current - cachedAt < ttlMs) {
			return cachedResult;
		}
		if (inFlight) {
			return inFlight;
		}

		inFlight = executeQuery()
			.then((res) => {
				cachedResult = res;
				cachedAt = now();
				inFlight = null;
				return res;
			})
			.catch(() => {
				const fallback: WindowsGitDiscovery = { roots: [], status: 'unknown' };
				cachedResult = fallback;
				cachedAt = now();
				inFlight = null;
				return fallback;
			});

		return inFlight;
	};
}
