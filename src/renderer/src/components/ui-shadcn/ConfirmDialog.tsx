import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";
import { t } from "../../i18n";

/**
 * 全站统一的确认弹框（UI 2.0 / issue #115）：基于 shadcn AlertDialog，
 * 替代此前散落在 config-modal 体系里的两套同构实现。
 * 危险操作（删除/丢弃/重置）传 danger，按钮使用 destructive 配色。
 *
 * 使用约定：调用方仍按条件渲染（{show && <ConfirmDialog/>}），
 * 因此组件挂载即打开；ESC/遮罩关闭统一回调 onCancel。
 */
export function ConfirmDialog(props: {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  danger?: boolean;
  /** 透传给 AlertDialogDescription 的样式（如长 URL 换行 break-all）。 */
  messageClassName?: string;
}) {
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) props.onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription className={props.messageClassName}>{props.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={props.onCancel}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={props.onConfirm}
            className={props.danger
              ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
              : undefined}
          >
            {props.confirmLabel ?? t("common.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
