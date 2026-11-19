export const NATIVE_ACTIVITY_TTL_MS = 15000;
export const NATIVE_ACTIVITY_HEARTBEAT_MS = 3000;
export const NATIVE_ACTIVITY_PROGRESS_MS = 180000;

export interface NativeActivityLease {
  activityId: string;
  authorizationEpoch: number;
  stopEpoch: number;
  browserSessionEpoch: string;
  expiresAt: number;
  progressExpiresAt: number;
  progressSequence: number;
  progressActionId?: string;
}
export interface NativeActivityHandle {
  readonly lease: NativeActivityLease;
  readonly signal: AbortSignal;
  close(): Promise<void>;
}
export interface NativeActivityDriver {
  begin(signal: AbortSignal): Promise<NativeActivityHandle>;
}
