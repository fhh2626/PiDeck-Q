import type { ModelConfigurationScope } from "../../../shared/types";

/** Unknown WSL identities match only another unknown identity, never every distro or user. */
export function modelConfigurationScopeKey(scope: Partial<ModelConfigurationScope>): string {
	if (scope.environment !== "wsl") return "native";
	const distro = scope.wslDistro?.trim().toLowerCase() ?? "";
	const user = scope.wslUser?.trim() ?? "";
	return distro || user ? JSON.stringify(["wsl", distro, user]) : "wsl";
}
