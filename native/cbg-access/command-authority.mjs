/** Local-only dispatch authority. Page messages never create or renew this state. */
export class CommandAuthority {
  constructor(instanceEpoch) {
    this.instanceEpoch = instanceEpoch;
    this.generation = 0;
    this.stopEpoch = -1;
    this.sessionEpoch = null;
    this.stopped = true;
    this.pending = new Map();
  }
  stop() {
    this.stopped = true;
    this.generation++;
    this.pending.clear();
  }
  resume(context) {
    if (
      !context ||
      !Number.isSafeInteger(context.stopEpoch) ||
      context.stopEpoch < this.stopEpoch ||
      typeof context.browserSessionEpoch !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(context.browserSessionEpoch)
    )
      throw new Error("invalid-local-resume-authority");
    this.generation++;
    this.pending.clear();
    this.stopEpoch = context.stopEpoch;
    this.sessionEpoch = context.browserSessionEpoch;
    this.stopped = false;
  }
  accepts(plan) {
    return (
      !this.stopped &&
      !!plan &&
      plan.stopEpoch === this.stopEpoch &&
      plan.browserSessionEpoch === this.sessionEpoch
    );
  }
  reserve(plan) {
    if (!this.accepts(plan) || this.pending.size || !/^[a-zA-Z0-9_-]{1,100}$/.test(plan.actionId))
      throw new Error("stale-or-busy-local-command");
    const record = { plan, generation: this.generation, dispatched: false };
    this.pending.set(plan.actionId, record);
    return record;
  }
  dispatch(actionId, proof) {
    const record = this.pending.get(actionId);
    if (
      !record ||
      record.dispatched ||
      record.generation !== this.generation ||
      !this.accepts(record.plan)
    )
      return null;
    if (
      !proof ||
      proof.actionId !== actionId ||
      proof.pageId !== record.plan.pageId ||
      proof.pageGeneration !== record.plan.pageGeneration ||
      JSON.stringify(proof.semantic) !== JSON.stringify(record.plan.target)
    )
      throw new Error("local-proof-plan-mismatch");
    record.dispatched = true;
    return {
      command: "execute",
      plan: record.plan,
      proof,
      hostGeneration: this.generation,
      hostInstanceEpoch: this.instanceEpoch,
    };
  }
  complete(actionId) {
    this.pending.delete(actionId);
  }
  helperResume(context, actionId) {
    return {
      command: "resume",
      actionId,
      stopEpoch: context.stopEpoch,
      browserSessionEpoch: context.browserSessionEpoch,
      hostGeneration: this.generation,
      hostInstanceEpoch: this.instanceEpoch,
    };
  }
}

/** Activation requires independent helper and extension ACKs from this exact local generation. */
export class ResumeAcknowledgement {
  constructor(generation) {
    this.generation = generation;
    this.helper = null;
    this.extension = null;
    this.finished = false;
  }
  accept(source, result, generation) {
    if (
      this.finished ||
      generation !== this.generation ||
      !["helper", "extension"].includes(source)
    )
      return null;
    if (!result || result.ok !== true) {
      this.finished = true;
      return {
        ok: false,
        error: typeof result?.error === "string" ? result.error : "resume-ack-failed",
      };
    }
    this[source] = result;
    if (this.helper && this.extension) {
      this.finished = true;
      return { ok: true };
    }
    return null;
  }
}
