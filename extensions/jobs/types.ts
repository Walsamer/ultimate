/**
 * Jobs in the browser: a job the `background` tool keeps running past its call, the card its end writes to its
 * conversation, and the ledger the server keeps of both. Browser-safe.
 */

/** One job: its command, where it runs, its process group's pid and how it ended. */
export type Job = {
  /** `J1`, `J2`, … from the ledger's `next`. */
  id: string
  command: string
  cwd: string
  /** The conversation that started it; its finish card goes there. */
  conversation: number
  pid?: number
  startedAt: number
  state: 'running' | 'exited' | 'stopped'
  exitCode?: number
  endedAt?: number
  /** Adopted after a restart: it runs, but nobody watched how it ends. */
  adopted?: true
  /** Its finish card was written; a second finish writes nothing. */
  reported?: true
  label?: string
}

/** The server's job ledger, one per instance: its jobs by id, and the job each tool call started. */
export type Ledger = {
  next: number
  jobs: Record<string, Job>
  /** Tool call id → job id, so a replayed `start` answers with the job it already started. */
  calls: Record<string, string>
}

/** The kind of the passive entry a job's end writes to its conversation, whose data is a `JobCard`. */
export const JOB_CARD = 'jobs.finished'

/** What a job's finish card shows: how it ended, where its log sits, and whether anyone watched it end. */
export type JobCard = {
  id: string
  label?: string
  command: string
  cwd: string
  conversation: number
  pid?: number
  startedAt: number
  endedAt: number
  exitCode?: number
  state: Job['state']
  /** Its output log. */
  log: string
  /** Nobody watched its completion: it was adopted running and its end was found on the next open. */
  unknown?: true
}
