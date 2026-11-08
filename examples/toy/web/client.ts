// Status API client: submit a parcel, read a job, release a held one, wait for it to settle.
import { Accepted, JobState, JobView, Refused, TERMINAL } from "./status";

declare const process: { env: Record<string, string | undefined> };

const POLL_LIMIT = Number(process.env.POLL_LIMIT ?? "20");
const POLL_GAP_MS = 1000;
const FETCH_TRIES = 3;

export class PollTimeout extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class StatusClient {
  constructor(
    private base: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  // Server errors are retried a fixed number of times, then thrown.
  private async call(path: string, init?: RequestInit): Promise<Response> {
    let last: Response | null = null;
    for (let attempt = 1; attempt <= FETCH_TRIES; attempt++) {
      last = await this.fetchImpl(this.base + path, init);
      if (last.status < 500) return last;
      await sleep(100 * 2 ** attempt);
    }
    throw new Error(`server error ${last?.status} for ${path}`);
  }

  async submit(parcel: Record<string, unknown>): Promise<Accepted | Refused> {
    const res = await this.call("/api/parcels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parcel),
    });
    return (await res.json()) as Accepted | Refused;
  }

  async getJob(id: string): Promise<JobView | null> {
    const res = await this.call(`/api/jobs/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`status ${res.status}`);
    return (await res.json()) as JobView;
  }

  async release(id: string, customsCleared: boolean): Promise<boolean> {
    const res = await this.call(`/api/jobs/${encodeURIComponent(id)}/release`, {
      method: "POST",
      body: JSON.stringify({ customsCleared }),
    });
    return res.ok;
  }

  // A held job is not terminal here: it stays held until someone sends a release.
  async waitForTerminal(id: string): Promise<JobView> {
    for (let poll = 0; poll < POLL_LIMIT; poll++) {
      const job = await this.getJob(id);
      if (job && TERMINAL.has(job.state)) return job;
      await sleep(POLL_GAP_MS);
    }
    throw new PollTimeout(`${id} did not settle in ${POLL_LIMIT} polls`);
  }
}

export function describe(job: JobView): string {
  switch (job.state) {
    case JobState.Done:
      return `delivered with label ${job.label ?? "none (fast lane)"}`;
    case JobState.Failed:
      return `failed after ${job.attempts} attempts: ${job.lastError ?? "no error recorded"}`;
    case JobState.Hold:
      return `on hold (${job.holdReason}), waiting for a release request`;
    case JobState.Leased:
      return "being worked on";
    default:
      return job.attempts > 0 ? `waiting to retry (attempt ${job.attempts} failed)` : "waiting in line";
  }
}
