export const ACTIVITY_TTL_MS = 15000;
export const ACTIVITY_PROGRESS_MS = 180000;
const identifier = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

/** Local host authority, independent of the service heartbeat and page messages. */
export class ActivityAuthority {
  constructor(clock = () => Date.now()) {
    this.clock = clock;
    this.current = null;
    this.highestEpoch = 0;
    this.lastWall = clock();
    this.credited = new Set();
  }
  now() {
    const wall = this.clock();
    if (!Number.isFinite(wall) || wall < this.lastWall) throw new Error("activity-clock-anomaly");
    this.lastWall = wall;
    return wall;
  }
  validate(lease, authority) {
    const now = this.now();
    if (
      !lease ||
      !identifier(lease.activityId) ||
      !Number.isSafeInteger(lease.authorizationEpoch) ||
      lease.authorizationEpoch < 1 ||
      lease.stopEpoch !== authority.stopEpoch ||
      lease.browserSessionEpoch !== authority.sessionEpoch ||
      !Number.isSafeInteger(lease.expiresAt) ||
      lease.expiresAt <= now ||
      lease.expiresAt > now + ACTIVITY_TTL_MS ||
      !Number.isSafeInteger(lease.progressExpiresAt) ||
      lease.progressExpiresAt <= now ||
      lease.progressExpiresAt > now + ACTIVITY_PROGRESS_MS ||
      !Number.isSafeInteger(lease.progressSequence) ||
      lease.progressSequence < 0
    )
      throw new Error("invalid-native-activity");
    return now;
  }
  begin(lease, authority) {
    this.validate(lease, authority);
    if (authority.stopped || this.current || lease.authorizationEpoch <= this.highestEpoch)
      throw new Error("stale-or-busy-native-activity");
    this.highestEpoch = lease.authorizationEpoch;
    this.credited.clear();
    this.current = { lease: { ...lease }, generation: authority.generation, granted: false };
  }
  granted(lease, authority) {
    if (!this.same(lease, authority) || this.expired())
      throw new Error("stale-native-activity-grant");
    this.current.granted = true;
  }
  same(lease, authority) {
    return (
      !!this.current &&
      lease?.activityId === this.current.lease.activityId &&
      lease.authorizationEpoch === this.current.lease.authorizationEpoch &&
      lease.stopEpoch === authority.stopEpoch &&
      lease.browserSessionEpoch === authority.sessionEpoch &&
      this.current.generation === authority.generation
    );
  }
  renew(lease, authority, completedActionId) {
    const now = this.validate(lease, authority);
    const current = this.current;
    if (
      !this.same(lease, authority) ||
      !current.granted ||
      this.expired(now) ||
      lease.progressSequence < current.lease.progressSequence
    )
      throw new Error("stale-native-activity-renewal");
    if (lease.progressSequence === current.lease.progressSequence) {
      if (lease.progressExpiresAt !== current.lease.progressExpiresAt)
        throw new Error("heartbeat-cannot-extend-progress");
    } else {
      if (
        lease.progressSequence !== current.lease.progressSequence + 1 ||
        !identifier(lease.progressActionId) ||
        lease.progressActionId !== completedActionId ||
        this.credited.has(lease.progressActionId)
      )
        throw new Error("unverified-native-activity-progress");
      this.credited.add(lease.progressActionId);
    }
    current.lease = { ...lease };
  }
  expired(now = this.now()) {
    return (
      !!this.current &&
      (now >= this.current.lease.expiresAt || now >= this.current.lease.progressExpiresAt)
    );
  }
  accepts(lease, authority) {
    return (
      !authority.stopped && this.same(lease, authority) && this.current.granted && !this.expired()
    );
  }
  end(lease, authority) {
    if (!this.same(lease, authority)) throw new Error("stale-native-activity-end");
    this.current = null;
    this.credited.clear();
  }
  stop() {
    this.current = null;
    this.credited.clear();
  }
}
