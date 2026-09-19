export type LoginWorkflowStep =
  | "idle"
  | "waiting_qr"
  | "dismissing_dialog"
  | "selecting_role"
  | "entering_server"
  | "logged_in";
export type WorkflowStep =
  | "idle"
  | "connecting"
  | "logging_in"
  | "cross_server"
  | "server_age"
  | "role_search"
  | "role_list"
  | "completed"
  | "error";

export interface RoleList {
  columns: string[];
  rows: string[][];
  emptyMessage?: string;
  serverAge: "3年以上服";
}

export interface OpenCbgResult {
  connected: boolean;
  loginStatus: "unknown" | "logged_out" | "logged_in";
  title: string;
  url: string;
  serverName: string;
  isLoggedIn: boolean;
  needLogin: boolean;
  message: string;
  qrCodeUrl?: string;
  step?: LoginWorkflowStep;
  dialogDetected?: boolean;
  dialogDismissed?: boolean;
  roleDetected?: boolean;
  roleSelected?: boolean;
  selectedRoleId?: string;
  accountUrs?: string;
  nickname?: string;
  running?: boolean;
  workflowStep?: WorkflowStep;
  error?: { code: string; message: string };
  roleList?: RoleList;
}
