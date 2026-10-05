/**
 * The durable list of video and audio tasks, one file per task under
 * `<state dir>/tasks/`, so harness processes sharing a home never overwrite
 * each other's tasks. A task is recorded before it is submitted, under the id
 * that doubles as its `Idempotency-Key`: a submission cut short is resent under
 * the same key (the gateway returns the original task instead of creating a
 * second one), and a task still running when the host restarts is followed to
 * the end. A claim file names the process following a task, so two processes
 * never poll and download the same one.
 * @module dsh-vibedev/tasks/store
 */

import { open, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../util/files.js'

/** What a task produces. */
export type TaskKind = 'video' | 'audio'

/**
 * `submitting`: recorded, not yet confirmed by the gateway. `pending`: the
 * gateway accepted it. `lost`: given up on (too old, or the gateway forgot it).
 */
export type TaskStatus = 'submitting' | 'pending' | 'completed' | 'failed' | 'lost'

/** One produced file. */
export interface TaskOutput {
  /** Position in the gateway's outputs. */
  readonly index?: number
  /** Where it was saved; absent when the download failed. */
  readonly path?: string
  /** The gateway's link to the file (valid for about 30 days). */
  readonly url?: string
  readonly contentType?: string
  readonly bytes?: number
  readonly title?: string
  readonly durationSeconds?: number
}

/** One task. */
export interface TaskRecord {
  /** Local id; also the `Idempotency-Key` of the submission. */
  readonly id: string
  readonly kind: TaskKind
  readonly model: string
  /** A short description for listings (a prompt excerpt). */
  readonly label: string
  readonly createdAt: number
  readonly updatedAt: number
  /** The session that asked for it. */
  readonly owner?: string
  /** Absolute directory the outputs are saved in. */
  readonly outputDir: string
  /** File-name stem for the outputs. */
  readonly stem: string
  /** The submission, kept so an unconfirmed one can be resent unchanged. */
  readonly endpoint: string
  readonly body: Readonly<Record<string, unknown>>
  readonly gatewayId?: string
  readonly status: TaskStatus
  readonly progress?: string
  /** Outputs saved so far; a finished task lists every output. */
  readonly outputs?: readonly TaskOutput[]
  readonly error?: { readonly code: string; readonly message: string }
  readonly estimatedCny?: string
  readonly chargedCny?: string
  readonly finishedAt?: number
}

/** Terminal tasks kept for listings; live ones are always kept. */
const KEEP_FINISHED = 100

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'lost'])
const SAFE_ID = /^[\w-]{1,80}$/

/**
 * Whether a task has ended.
 * @param record - the task.
 * @returns true for completed, failed and lost tasks.
 */
export function isFinished(record: Pick<TaskRecord, 'status'>): boolean {
  return TERMINAL.has(record.status)
}

function parse(text: string): TaskRecord | undefined {
  try {
    const value = JSON.parse(text) as TaskRecord
    return typeof value === 'object' && value !== null && typeof value.id === 'string' && typeof value.status === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/** Task records under `<state dir>/tasks/`. */
export class TaskStore {
  private readonly chains = new Map<string, Promise<unknown>>()

  /**
   * @param directory - the plugin state directory.
   * @param now - clock.
   */
  constructor(private readonly directory: string, private readonly now: () => number = Date.now) {}

  private get dir(): string {
    return join(this.directory, 'tasks')
  }

  private file(id: string, suffix = 'json'): string {
    if (!SAFE_ID.test(id)) throw new Error(`invalid task id ${JSON.stringify(id)}`)
    return join(this.dir, `${id}.${suffix}`)
  }

  /** Run one change to a task after the previous change to it in this process. */
  private serial<T>(id: string, run: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(id) ?? Promise.resolve()).then(run, run)
    const settled = next.catch(() => undefined)
    this.chains.set(id, settled)
    void settled.then(() => { if (this.chains.get(id) === settled) this.chains.delete(id) })
    return next
  }

  /** All tasks, newest first, as they are on disk now (other processes' tasks included). */
  async list(): Promise<TaskRecord[]> {
    const names = await readdir(this.dir).catch(() => [] as string[])
    const records = await Promise.all(names.filter(name => name.endsWith('.json'))
      .map(name => readFile(join(this.dir, name), 'utf8').then(parse, () => undefined)))
    return records.filter((record): record is TaskRecord => record !== undefined).sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * One task.
   * @param id - its local id.
   * @returns the task, or undefined.
   */
  async get(id: string): Promise<TaskRecord | undefined> {
    return readFile(this.file(id), 'utf8').then(parse, () => undefined)
  }

  /**
   * Record a new task.
   * @param record - the task.
   * @returns the stored task.
   */
  add(record: TaskRecord): Promise<TaskRecord> {
    return this.serial(record.id, async () => {
      await writeFileAtomic(this.file(record.id), new TextEncoder().encode(JSON.stringify(record, null, 2)))
      await this.prune().catch(() => undefined)
      return record
    })
  }

  /**
   * Change a task.
   * @param id - its local id.
   * @param patch - the fields to replace.
   * @returns the updated task, or undefined when it is unknown.
   */
  update(id: string, patch: Partial<Omit<TaskRecord, 'id' | 'kind' | 'createdAt'>>): Promise<TaskRecord | undefined> {
    return this.serial(id, async () => {
      const current = await this.get(id)
      if (current === undefined) return undefined
      const next: TaskRecord = { ...current, ...patch, updatedAt: this.now() }
      await writeFileAtomic(this.file(id), new TextEncoder().encode(JSON.stringify(next, null, 2)))
      return next
    })
  }

  /**
   * Forget a task, such as a submission the gateway refused outright.
   * @param id - its local id.
   */
  remove(id: string): Promise<void> {
    return this.serial(id, async () => {
      await rm(this.file(id), { force: true })
      await rm(this.file(id, 'claim'), { force: true })
    })
  }

  /**
   * Claim the right to follow a task: free, already ours, or held by a process
   * that stopped renewing it for `staleMs`.
   * @param id - the task.
   * @param holder - this process's claim id.
   * @param staleMs - how old an unrenewed claim may be before it is taken over.
   * @returns whether this process now holds the claim.
   */
  async claim(id: string, holder: string, staleMs: number): Promise<boolean> {
    const path = this.file(id, 'claim')
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(path, 'wx')
        await handle.writeFile(JSON.stringify({ holder, at: this.now() }))
        await handle.close()
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false
      }
      const current = await readFile(path, 'utf8').then(text => JSON.parse(text) as { holder?: unknown; at?: unknown }, () => undefined)
      if (current?.holder === holder) {
        await this.renewClaim(id, holder)
        return true
      }
      const at = typeof current?.at === 'number' ? current.at : 0
      if (this.now() - at < staleMs) return false
      await rm(path, { force: true })
    }
    return false
  }

  /**
   * Keep a claim alive.
   * @param id - the task.
   * @param holder - this process's claim id.
   */
  async renewClaim(id: string, holder: string): Promise<void> {
    await writeFileAtomic(this.file(id, 'claim'), new TextEncoder().encode(JSON.stringify({ holder, at: this.now() })))
  }

  /**
   * Give up a claim this process holds.
   * @param id - the task.
   * @param holder - this process's claim id.
   */
  async release(id: string, holder: string): Promise<void> {
    const path = this.file(id, 'claim')
    const current = await readFile(path, 'utf8').then(text => JSON.parse(text) as { holder?: unknown }, () => undefined)
    if (current?.holder === holder) await rm(path, { force: true })
  }

  private async prune(): Promise<void> {
    const finished = (await this.list()).filter(isFinished)
    for (const record of finished.slice(KEEP_FINISHED)) {
      await rm(this.file(record.id), { force: true })
      await rm(this.file(record.id, 'claim'), { force: true })
    }
  }
}
