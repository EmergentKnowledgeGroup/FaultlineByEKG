// Types shared by the status client. Mirrors the job states the queue stores.
export enum JobState {
  Pending = "pending",
  Leased = "leased",
  Done = "done",
  Failed = "failed",
  Hold = "hold",
}

export interface JobView {
  id: string;
  state: JobState;
  attempts: number;
  holdReason: string | null;
  lastError: string | null;
  label: string | null;
}

export interface Refused {
  ok: false;
  refused: string;
  message: string;
}

export interface Accepted {
  ok: true;
  id: string;
  lane: "normal" | "fast";
}

// A client stops waiting when the job is in one of these.
export const TERMINAL: ReadonlySet<JobState> = new Set([JobState.Done, JobState.Failed]);
