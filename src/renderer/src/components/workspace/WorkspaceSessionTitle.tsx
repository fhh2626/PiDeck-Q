import { useAtomValue } from "jotai";
import { sessionRecordByIdAtomFamily } from "../../atoms/session-selectors";
import { t } from "../../i18n";
import { SessionBranchBar } from "../session/SessionBranchBar";

/** The focused session owns the former tab area, including its branch navigation. */
export function WorkspaceSessionTitle(props: {
  sessionId?: string | null;
  onOpenSession: (projectId: string, sessionId: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const session = useAtomValue(sessionRecordByIdAtomFamily(props.sessionId ?? ""));
  if (!session) return null;
  const title = session.title?.trim() || t("app.chatProject");

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2" data-session-titlebar={session.id}>
      <span className="min-w-0 flex-1 truncate text-caption font-medium text-foreground" title={title}>
        {title}
      </span>
      <SessionBranchBar
        sessionId={session.id}
        compact
        onOpenSession={(sessionId) => {
          // Branches belong to the displayed session's project, even after focus
          // moves between panes from different projects.
          void props.onOpenSession(session.projectId, sessionId).catch((error: unknown) => {
            props.onError(error instanceof Error ? error.message : String(error));
          });
        }}
      />
    </div>
  );
}
