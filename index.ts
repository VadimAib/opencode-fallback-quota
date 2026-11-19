/**
 * Free models for OpenCode subagent sessions.
 *
 * A subagent is a child session. It starts on the model its parent selected,
 * which is usually the paid model a human chose. This plugin moves it to a free
 * model before its first request, tries the next free model when one reaches
 * its daily limit, and returns the child to the model it started on when every
 * free model is used up.
 *
 * The main session is never changed.
 */

type Ref = { providerID: string; id: string; variant?: string }
type ModelInfo = {
  providerID: string
  id: string
  enabled?: boolean
  cost?: Array<{ input?: number }>
  capabilities?: { tools?: boolean }
  variants?: Array<{ id: string }>
}
type Verdict = { quota: boolean; hard: boolean }

/** A model is free when OpenCode serves it without an input price. */
const FREE_PROVIDERS = new Set(["opencode", "opencode-go"])

/** Error types the host assigns to an account or free-tier cap. */
const CAP_TYPES = new Set(["provider.quota", "provider.free-limit", "provider.chatgpt-limit"])

/** Wording that means a daily or free allowance is used up, not a short burst. */
const CAP_TEXT = [
  /too many tokens(?: per day)?, please wait/i,
  /free (?:usage|tier|daily) limit/i,
  /daily (?:token|request|usage) limit/i,
  /(?:token|request|usage) limit (?:reached|exceeded)/i,
  /quota (?:exceeded|exhausted)/i,
  /insufficient[-_\s]?quota/i,
  /spend limit/i,
  /budget exceeded/i,
]

const THROTTLE_TEXT = [/rate.?limit/i, /too many requests/i, /throttling error/i]

export function parseRef(value: unknown): Ref | undefined {
  if (typeof value !== "string") return
  const input = value.trim()
  const slash = input.indexOf("/")
  if (slash <= 0) return
  const hash = input.indexOf("#", slash + 1)
  const id = input.slice(slash + 1, hash === -1 ? undefined : hash)
  const variant = hash === -1 ? undefined : input.slice(hash + 1)
  if (!id || variant === "") return
  return { providerID: input.slice(0, slash), id, ...(variant ? { variant } : {}) }
}

export function toRef(model: unknown): Ref | undefined {
  if (!model || typeof model !== "object") return
  const value = model as { providerID?: unknown; id?: unknown; variant?: unknown }
  if (typeof value.providerID !== "string" || typeof value.id !== "string") return
  return {
    providerID: value.providerID,
    id: value.id,
    // OpenCode reports "default" as a pseudo-variant; it is not a switchable one.
    ...(typeof value.variant === "string" && value.variant !== "default" ? { variant: value.variant } : {}),
  }
}

export function keyOf(ref: Ref): string {
  return `${ref.providerID}/${ref.id}`
}

export function formatRef(ref: Ref): string {
  return `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`
}

/** Same model; a variant never makes a different model for this plugin. */
export function sameModel(left: Ref | undefined, right: Ref | undefined): boolean {
  return Boolean(left && right && left.providerID === right.providerID && left.id === right.id)
}

/** Strips control characters and caps provider-supplied text. */
export function clean(value: unknown): string {
  return String(value === undefined || value === null ? "" : value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, 200)
}

export function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const value = error as Record<string, unknown>
  const nested = (key: string) =>
    value[key] && typeof value[key] === "object" ? (value[key] as Record<string, unknown>) : undefined
  for (const candidate of [value.status, nested("data")?.status, nested("response")?.status, nested("cause")?.status]) {
    if (typeof candidate === "number") return candidate
  }
  return undefined
}

export function classify(error: unknown): Verdict {
  const status = statusOf(error)
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {}
  const type = typeof record.type === "string" ? record.type : undefined
  const message = typeof record.message === "string" ? record.message : ""

  if (status !== undefined && (status >= 500 || status === 401 || status === 403 || status === 408)) {
    return { quota: false, hard: false }
  }

  const hard = status === 402 || (type !== undefined && CAP_TYPES.has(type)) || CAP_TEXT.some((p) => p.test(message))
  const quota =
    hard ||
    type === "provider.rate-limit" ||
    status === 429 ||
    THROTTLE_TEXT.some((p) => p.test(message))
  return { quota, hard }
}

/** OpenCode's definition of a free model: an OpenCode provider and no input price. */
export function isAutoFree(info: ModelInfo): boolean {
  if (info.enabled === false) return false
  if (!FREE_PROVIDERS.has(info.providerID)) return false
  if (info.capabilities && info.capabilities.tools === false) return false
  const tiers = Array.isArray(info.cost) ? info.cost : []
  return tiers.every((tier) => !tier || (tier.input ?? 0) === 0)
}

/** Parses the optional `freeModels` order, dropping entries that are not provider/model. */
export function parseFreeModels(value: unknown): { refs: Ref[]; invalid: string[] } {
  if (!Array.isArray(value)) return { refs: [], invalid: [] }
  const seen = new Set<string>()
  const refs: Ref[] = []
  const invalid: string[] = []
  for (const entry of value) {
    const ref = parseRef(entry)
    if (!ref) {
      invalid.push(clean(entry))
      continue
    }
    const key = keyOf(ref)
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }
  return { refs, invalid }
}

function findModel(catalog: ModelInfo[], ref: Ref): ModelInfo | undefined {
  return catalog.find((model) => model.providerID === ref.providerID && model.id === ref.id)
}

function isEnabled(model: ModelInfo | undefined, ref: Ref): boolean {
  if (!model || model.enabled === false) return false
  return !ref.variant || (model.variants || []).some((variant) => variant.id === ref.variant)
}

/** A listed model is free by the user's choice; otherwise the catalog decides. */
export function isFreeRef(ref: Ref, catalog: ModelInfo[], explicit: Set<string>): boolean {
  if (explicit.has(keyOf(ref))) return true
  const info = findModel(catalog, ref)
  return info ? isAutoFree(info) : false
}

export function freeTargets(catalog: ModelInfo[], preferred: Ref[]): Ref[] {
  if (preferred.length === 0) {
    return catalog.filter(isAutoFree).map((info) => ({ providerID: info.providerID, id: info.id }))
  }
  return preferred.filter((ref) => isEnabled(findModel(catalog, ref), ref))
}

/** True when a free model is not the one already in use and has not hit its limit today. */
export function pickFree(
  targets: Ref[],
  current: Ref | undefined,
  exhausted: (ref: Ref) => boolean,
): Ref | undefined {
  return targets.find((ref) => !exhausted(ref) && !sameModel(ref, current))
}

export default {
  id: "free-subagents",
  async setup(ctx: any) {
    const options = ctx.options && typeof ctx.options === "object" ? ctx.options : {}
    const parsed = parseFreeModels(options.freeModels)
    if (options.freeModels !== undefined && !Array.isArray(options.freeModels)) {
      console.error(`free-subagents: ignored freeModels: ${clean(options.freeModels)} (expected an array of provider/model)`)
    }
    if (parsed.invalid.length > 0) {
      console.error(`free-subagents: ignored ${parsed.invalid.length} freeModels entries that are not provider/model: ${parsed.invalid.join(", ")}`)
    }

    if (!ctx.session || typeof ctx.session.hook !== "function" || typeof ctx.session.switchModel !== "function") {
      console.error("free-subagents: idle, this OpenCode has no session hooks (incompatible plugin API)")
      return
    }
    if (!ctx.model || typeof ctx.model.list !== "function") {
      console.error("free-subagents: idle, this OpenCode has no model.list (incompatible plugin API)")
      return
    }

    const preferred = parsed.refs
    const explicit = new Set(preferred.map(keyOf))
    const exhausted = new Map<string, number>()
    const paid = new Map<string, Ref>()
    const lastNotice = new Map<string, string>()
    let agentCache: Array<{ id: string; mode?: string }> | undefined
    let deadReported = false

    const notice = (sessionID: string, line: string) => {
      if (lastNotice.get(sessionID) === line) return
      lastNotice.set(sessionID, line)
      if (lastNotice.size > 200) {
        const oldest = lastNotice.keys().next()
        if (!oldest.done) lastNotice.delete(oldest.value)
      }
      console.error(line)
    }

    const rememberPaid = (sessionID: string, ref: Ref) => {
      if (paid.has(sessionID)) return
      paid.set(sessionID, ref)
      if (paid.size > 500) {
        const oldest = paid.keys().next()
        if (!oldest.done) paid.delete(oldest.value)
      }
    }

    const day = () => new Date().toDateString()
    const markExhausted = (ref: Ref) => {
      exhausted.set(keyOf(ref), Date.now())
    }
    const isExhausted = (ref: Ref) => {
      const at = exhausted.get(keyOf(ref))
      if (at === undefined) return false
      if (new Date(at).toDateString() !== day()) {
        exhausted.delete(keyOf(ref))
        return false
      }
      return true
    }

    const models = async (): Promise<ModelInfo[]> => {
      const result = await ctx.model.list()
      return Array.isArray(result?.data) ? (result.data as ModelInfo[]) : []
    }

    const sessionInfo = async (sessionID: string) => {
      try {
        return await ctx.session.get({ sessionID })
      } catch {
        return undefined
      }
    }

    const agentMode = async (agentID: unknown) => {
      if (typeof agentID !== "string" || !ctx.agent || typeof ctx.agent.list !== "function") return undefined
      try {
        if (!agentCache) {
          const result = await ctx.agent.list()
          agentCache = Array.isArray(result) ? result : result?.data
        }
        return agentCache?.find((agent) => agent.id === agentID)?.mode
      } catch {
        return undefined
      }
    }

    const freeOf = (catalog: ModelInfo[]) => {
      if (preferred.length > 0 && !deadReported && catalog.length > 0) {
        deadReported = true
        const dead = preferred.filter((ref) => !isEnabled(findModel(catalog, ref), ref)).map(formatRef)
        if (dead.length > 0) console.error(`free-subagents: not available: ${dead.map(clean).join(", ")}`)
      }
      return freeTargets(catalog, preferred)
    }

    const defaultPaid = async (catalog: ModelInfo[]): Promise<Ref | undefined> => {
      try {
        const result = await ctx.model.default()
        const ref = toRef(result?.data)
        return ref && !isFreeRef(ref, catalog, explicit) ? ref : undefined
      } catch {
        return undefined
      }
    }

    const paidFor = async (sessionID: string, catalog: ModelInfo[]): Promise<Ref | undefined> => {
      const known = paid.get(sessionID)
      if (known) {
        if (isEnabled(findModel(catalog, known), known)) return known
        paid.delete(sessionID)
      }
      let id: string | undefined = sessionID
      for (let depth = 0; depth < 12 && id; depth++) {
        const info: any = await sessionInfo(id)
        if (!info) break
        const ref = toRef(info.model)
        if (ref && !isFreeRef(ref, catalog, explicit)) {
          rememberPaid(sessionID, ref)
          return ref
        }
        id = typeof info.parentID === "string" ? info.parentID : undefined
      }
      return defaultPaid(catalog)
    }

    const switchTo = async (sessionID: string, ref: Ref, line: string) => {
      await ctx.session.switchModel({ sessionID, model: ref })
      lastNotice.delete(sessionID)
      console.error(`free-subagents: ${line}`)
      return true
    }

    /**
     * Moves a child to a free model, or back to its paid model when nothing is
     * free. `current` is the model the child uses now; a non-free one is the
     * human's earlier choice and becomes the fallback.
     */
    const ensureFree = async (sessionID: string, info: any, reason: string, catalog: ModelInfo[]) => {
      const current = toRef(info?.model)
      const currentFree = current ? isFreeRef(current, catalog, explicit) : false
      if (current && !currentFree) rememberPaid(sessionID, current)
      if (currentFree && !isExhausted(current)) return false

      const targets = freeOf(catalog)
      const next = pickFree(targets, current, isExhausted)
      if (next) return switchTo(sessionID, next, `${reason}, switching to ${formatRef(next)}`)

      if (currentFree) {
        const fallback = await paidFor(sessionID, catalog)
        if (fallback && !sameModel(fallback, current)) {
          return switchTo(sessionID, fallback, `${reason}, no free model left, returning to ${formatRef(fallback)}`)
        }
        notice(sessionID, `free-subagents: ${reason}, no free model left and no paid model to return to`)
      }
      return false
    }

    // A child session is a subagent, not a fork and not a primary session.
    const isSubagent = async (info: any) => {
      if (!info || typeof info.parentID !== "string" || !info.parentID || info.fork) return false
      return (await agentMode(info.agent)) !== "primary"
    }

    const onCreated = async (event: any) => {
      const data = event?.data ?? event?.properties ?? event
      const sessionID = data?.sessionID ?? data?.id
      if (typeof sessionID !== "string" || !sessionID) return
      if (typeof data?.parentID !== "string" || !data.parentID || data.fork) return
      if ((await agentMode(data.agent)) === "primary") return
      const info = (await sessionInfo(sessionID)) ?? data
      if (!(await isSubagent(info))) return
      try {
        const catalog = await models()
        await ensureFree(sessionID, info, `subagent ${clean(info.agent ?? data.agent ?? "?")} started`, catalog)
      } catch (error) {
        const message = error instanceof Error ? error.message : error
        console.error(`free-subagents: could not prepare subagent ${clean(sessionID)} (${clean(message)})`)
      }
    }

    // 2.2.x has no model.resolve or prompt hook. The public event stream fires
    // session.created before the child is prompted, so the first request is free.
    let stop: (() => void) | undefined
    if (ctx.event && typeof ctx.event.subscribe === "function") {
      const controller = new AbortController()
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ types: ["session.created"], signal: controller.signal })) {
            void onCreated(event).catch((error: unknown) => {
              const message = error instanceof Error ? error.message : error
              console.error(`free-subagents: could not handle a new session (${clean(message)})`)
            })
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            const message = error instanceof Error ? error.message : error
            console.error(`free-subagents: event stream stopped (${clean(message)}); subagents switch only after a free limit`)
          }
        }
      })()
      stop = () => controller.abort()
    } else {
      console.error("free-subagents: no event stream; subagents switch only after a free limit")
    }

    await ctx.session.hook("retry", async (event: any) => {
      const current = toRef(event.model)
      if (!current) return
      const verdict = classify(event.error)
      if (!verdict.quota) return

      try {
        const info: any = await sessionInfo(event.sessionID)
        if (!(await isSubagent(info))) return

        const catalog = await models()
        const currentFree = isFreeRef(current, catalog, explicit)
        if (currentFree && !verdict.hard) return

        if (currentFree) markExhausted(current)
        const why = clean(event.error && event.error.message)
        const reason = `${formatRef(current)} failed${why ? ` (${why})` : ""}`
        if (await ensureFree(event.sessionID, info, reason, catalog)) {
          event.decision = { retry: true, delay: 0 }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : error
        console.error(`free-subagents: could not switch from ${formatRef(current)} (${clean(message)})`)
      }
    })

    return stop
  },
}
