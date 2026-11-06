/**
 * Durable "marked unread" set for DSH Sessions.
 *
 * One small JSON document, read once at activation and written atomically on
 * every change:
 *
 * ```json
 * { "version": 1, "updatedAt": "2026-11-06T05:00:00.000Z", "sessionIds": ["session-…"] }
 * ```
 *
 * Node core only: the plugin installs as a plain local package with no build
 * step and no runtime dependency.
 *
 * @module dsh-plugin-session-unread/lib/unread-store
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Schema version written into every document. */
export const STATE_VERSION = 1

/**
 * Resolve the harness home the state file lives below.
 *
 * Follows the same precedence as the rest of the harness: an explicit
 * `DSH_HOME`, then `~/.dsh`.
 *
 * @param env - environment to read (defaults to `process.env`).
 * @returns absolute harness home directory.
 */
export function resolveDshHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured.length > 0 ? configured : join(homedir(), '.dsh')
}

/**
 * In-memory set of marked-unread Session ids backed by one JSON file.
 *
 * Reads are synchronous against the loaded snapshot (the route handler awaits
 * {@link UnreadStore.ready} first); writes are serialized so two overlapping
 * toggles cannot interleave their temp-file renames.
 */
export class UnreadStore {
  #filePath
  #ids = new Set()
  #updatedAt = null
  #loaded = false
  #loading
  #writeChain = Promise.resolve()
  #warn

  /**
   * @param filePath - absolute path of the state document.
   * @param options - `warn` receives non-fatal read problems (default console).
   */
  constructor(filePath, options = {}) {
    this.#filePath = filePath
    this.#warn = typeof options.warn === 'function'
      ? options.warn
      : (message) => console.warn(`[session-unread] ${message}`)
    this.#loading = this.#read()
  }

  /** Absolute path of the backing document. */
  get filePath() {
    return this.#filePath
  }

  /** Whether the first read settled (successfully or not). */
  get loaded() {
    return this.#loaded
  }

  /**
   * Wait for the initial read.
   *
   * @returns settled promise; never rejects (an unreadable file is an empty set).
   */
  ready() {
    return this.#loading
  }

  /**
   * Whether one Session is currently marked unread.
   *
   * @param sessionId - Session id to test.
   * @returns the membership flag.
   */
  has(sessionId) {
    return this.#ids.has(sessionId)
  }

  /**
   * Current value, safe to serialize.
   *
   * @returns the sorted id list and the last successful write time.
   */
  snapshot() {
    return {
      sessionIds: [...this.#ids].sort(),
      updatedAt: this.#updatedAt,
    }
  }

  /**
   * Mark one Session unread or read.
   *
   * A no-op toggle (same value as the current membership) skips the write and
   * returns the unchanged snapshot.
   *
   * @param sessionId - Session id to write.
   * @param unread - next membership.
   * @returns the snapshot after the write.
   */
  async set(sessionId, unread) {
    await this.#loading
    const changed = unread ? !this.#ids.has(sessionId) : this.#ids.delete(sessionId)
    if (!changed) return this.snapshot()
    if (unread) this.#ids.add(sessionId)
    await this.#persist()
    return this.snapshot()
  }

  async #read() {
    try {
      const raw = await readFile(this.#filePath, 'utf8')
      const document = JSON.parse(raw)
      if (document !== null && typeof document === 'object' && Array.isArray(document.sessionIds)) {
        for (const id of document.sessionIds) {
          if (typeof id === 'string' && id.length > 0) this.#ids.add(id)
        }
        this.#updatedAt = typeof document.updatedAt === 'string' ? document.updatedAt : null
      }
    } catch (error) {
      // A missing file is the normal first run; anything else is reported and
      // treated as an empty set so a broken document cannot block the GUI.
      if (error?.code !== 'ENOENT') {
        this.#warn(`ignoring unreadable state file ${this.#filePath} (${error?.message ?? error})`)
      }
    } finally {
      this.#loaded = true
    }
  }

  #persist() {
    this.#updatedAt = new Date().toISOString()
    const body = `${JSON.stringify({
      version: STATE_VERSION,
      updatedAt: this.#updatedAt,
      sessionIds: [...this.#ids].sort(),
    }, null, 2)}\n`
    const write = () => this.#write(body)
    this.#writeChain = this.#writeChain.then(write, write)
    return this.#writeChain
  }

  async #write(body) {
    await mkdir(dirname(this.#filePath), { recursive: true })
    const temporary = `${this.#filePath}.${process.pid}.${Date.now().toString(36)}.tmp`
    try {
      await writeFile(temporary, body, 'utf8')
      await rename(temporary, this.#filePath)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }
}
