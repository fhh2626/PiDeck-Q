import { lazy, Suspense, type ComponentProps } from "react";
const SettingsModal = lazy(() => import("../app/SettingsModal").then((module) => ({ default: module.SettingsModal })));
import { ConfirmDialog } from "./OverlayParts";

export type SessionActionOverlaysProps = {
	settings?: { open: boolean; props: ComponentProps<typeof SettingsModal> };
	confirm?: { open: boolean; props: ComponentProps<typeof ConfirmDialog> };
};

export function SessionActionOverlays({ settings, confirm }: SessionActionOverlaysProps) {
	return <>
		{settings?.open && <Suspense fallback={null}><SettingsModal {...settings.props} /></Suspense>}
		{confirm?.open && <ConfirmDialog {...confirm.props} />}
	</>;
}
