import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { SavedRoleDetail } from "./SavedRoleDetail";

export function RoleDetailDrawer({
  recordKey,
  running,
  onClose,
}: {
  recordKey: string;
  running: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      element.close();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className="role-drawer"
      aria-labelledby="role-drawer-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <header className="drawer-header">
        <div>
          <span className="drawer-eyebrow">已采集资料</span>
          <h2 id="role-drawer-title">角色详情</h2>
        </div>
        <button autoFocus className="drawer-close" aria-label="关闭角色详情" onClick={onClose}>
          关闭 <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="drawer-body">
        <SavedRoleDetail key={recordKey} recordKey={recordKey} running={running} />
      </div>
    </dialog>,
    document.body,
  );
}
