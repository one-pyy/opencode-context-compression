/** @jsxImportSource @opentui/solid */

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Message, AssistantMessage } from "@opencode-ai/sdk"
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ID = "opencode-context-compression:tui"

// 本文件位于 <repo>/src/tui.tsx；state 目录与服务端压缩插件共用同一插件仓库。
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

interface CompressionStats {
  protectedTokenCount: number
  deletableTokenCount: number
  compressibleTokenCount: number
  reasoningTokenCount: number
}

function toNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

function readStats(sessionId: string): CompressionStats | undefined {
  try {
    const raw = readFileSync(
      resolve(REPO_ROOT, "state", `${sessionId}.stats.json`),
      "utf8",
    )
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      protectedTokenCount: toNumber(parsed.protectedTokenCount),
      deletableTokenCount: toNumber(parsed.deletableTokenCount),
      compressibleTokenCount: toNumber(parsed.compressibleTokenCount),
      reasoningTokenCount: toNumber(parsed.reasoningTokenCount),
    }
  } catch {
    return undefined
  }
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 10_000) return (n / 1_000).toFixed(1) + "K"
  return String(n)
}

function average(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  return values.reduce((sum, v) => sum + v, 0) / values.length
}


// ── cache spark（移植自 opencode-cache-spark）──
const BLOCKS = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"]
const RATE_STOPS = [35, 60, 75, 85, 90, 94, 97, 99]

// 与原 opencode-cache-spark 一致的 Morandi 配色。原插件按 string 读取主题色，而主题值
// 实际是 RGBA 对象，于是每次都走 fallback；这里显式固定同款颜色以保持原有观感。
const CACHE_FALLBACK = {
  muted: "#8A8A8A",
  success: "#9CAF8B",
  warning: "#C2B280",
  error: "#B08A8A",
}

// 每 BUCKET_GROUP 个 bucket 之间插一根竖线，方便数格子。
const BUCKET_GROUP = 5
const GROUP_SEPARATOR = "\u2502"

function cacheRates(api: TuiPluginApi, sessionId: string, count: number): number[] {
  const msgs = api.state.session.messages(sessionId) as Message[]
  const out: number[] = []
  for (let i = msgs.length - 1; i >= 0 && out.length < count; i--) {
    const m = msgs[i]
    if (m.role !== "assistant") continue
    const tk = (m as AssistantMessage).tokens
    if (!tk) continue
    const total = toNumber(tk.input) + toNumber(tk.cache?.read) + toNumber(tk.cache?.write)
    if (total <= 0) continue
    out.push((toNumber(tk.cache?.read) / total) * 100)
  }
  return out.reverse()
}

function cacheGlyph(rate: number): string {
  const r = Math.max(0, rate)
  if (r < RATE_STOPS[0]) return " "
  let idx = 0
  for (let i = 1; i < RATE_STOPS.length; i++) {
    if (r < RATE_STOPS[i]) break
    idx = i
  }
  return BLOCKS[idx]
}

// ── tool spark（移植自 opencode-tool-spark）──
const TOOL_MAX = 5

function toolLevel(count: number): string {
  const capped = Math.min(Math.max(count, 0), TOOL_MAX)
  if (capped === 0) return " "
  return BLOCKS[Math.round((capped / TOOL_MAX) * (BLOCKS.length - 1))]
}

function countTools(api: TuiPluginApi, messageId: string): number {
  let parts: ReadonlyArray<{ type: string }>
  try {
    parts = api.state.part(messageId)
  } catch {
    parts = []
  }
  let n = 0
  for (const p of parts) if (p.type === "tool") n++
  return n
}

function toolCounts(api: TuiPluginApi, sessionId: string, buckets: number): number[] {
  const msgs = api.state.session.messages(sessionId) as Message[]
  const out: number[] = []
  for (let i = msgs.length - 1; i >= 0 && out.length < buckets; i--) {
    const m = msgs[i]
    if (m.role !== "assistant") continue
    out.push(Math.min(countTools(api, m.id), TOOL_MAX))
  }
  return out.reverse()
}

function useTick(api: TuiPluginApi) {
  const [tick, setTick] = createSignal(0)
  onMount(() => {
    const offs = [
      api.event.on("message.updated", () => setTick((v) => v + 1)),
      api.event.on("message.part.updated", () => setTick((v) => v + 1)),
      api.event.on("session.updated", () => setTick((v) => v + 1)),
    ]
    const timer = setInterval(() => setTick((v) => v + 1), 1000)
    onCleanup(() => {
      for (const off of offs) off()
      clearInterval(timer)
    })
  })
  return tick
}

function CacheToolsPanel(props: {
  api: TuiPluginApi
  sessionId: string
  cacheBuckets: number
  toolBuckets: number
}) {
  const tick = useTick(props.api)
  const theme = () => props.api.theme.current
  const rates = createMemo(() => {
    tick()
    return cacheRates(props.api, props.sessionId, props.cacheBuckets)
  })
  const tools = createMemo(() => {
    tick()
    return toolCounts(props.api, props.sessionId, props.toolBuckets)
  })
  const rateAvg = createMemo(() => average(rates()))
  const toolAvg = createMemo(() => average(tools()))

  return (
    <box flexDirection="column">
      <text>
        <span style={{ fg: CACHE_FALLBACK.muted }}>{"cache "}</span>
        {rates().map((rate, index) => (
          <>
            <span
              style={{
                fg:
                  rate >= 85
                    ? CACHE_FALLBACK.success
                    : rate >= 70
                      ? CACHE_FALLBACK.warning
                      : CACHE_FALLBACK.error,
              }}
            >
              {cacheGlyph(rate)}
            </span>
            {(index + 1) % BUCKET_GROUP === 0 ? (
              <span style={{ fg: CACHE_FALLBACK.muted }}>{GROUP_SEPARATOR}</span>
            ) : null}
          </>
        ))}
        {rateAvg() === undefined ? null : (
          <span style={{ fg: CACHE_FALLBACK.muted }}>{` ${Math.round(rateAvg()!)}%`}</span>
        )}
      </text>
      <text>
        <span style={{ fg: theme().textMuted }}>{"tools "}</span>
        {tools().map((c, index) => (
          <>
            <span style={{ fg: theme().secondary }}>{toolLevel(c)}</span>
            {(index + 1) % BUCKET_GROUP === 0 ? (
              <span style={{ fg: theme().textMuted }}>{GROUP_SEPARATOR}</span>
            ) : null}
          </>
        ))}
        {toolAvg() === undefined ? null : (
          <span style={{ fg: theme().textMuted }}>{` ${toolAvg()!.toFixed(1)}`}</span>
        )}
      </text>
    </box>
  )
}

function CompressionPanel(props: { api: TuiPluginApi; sessionId: string }) {
  const tick = useTick(props.api)
  const theme = () => props.api.theme.current
  const stats = createMemo(() => {
    tick()
    return readStats(props.sessionId)
  })

  return (
    <box flexDirection="column">
      <text>
        <span style={{ fg: theme().text }}>
          <b>{"Compression"}</b>
        </span>
      </text>
      {stats() === undefined ? (
        <text>
          <span style={{ fg: theme().textMuted }}>{"no data"}</span>
        </text>
      ) : (
        <>
          <text>
            <span style={{ fg: theme().textMuted }}>{"fixed "}</span>
            <span style={{ fg: theme().textMuted }}>{fmt(stats()!.protectedTokenCount)}</span>
          </text>
          <text>
            <span style={{ fg: theme().textMuted }}>{"del   "}</span>
            <span style={{ fg: theme().textMuted }}>{fmt(stats()!.deletableTokenCount)}</span>
          </text>
          <text>
            <span style={{ fg: theme().textMuted }}>{"comp  "}</span>
            <span style={{ fg: theme().textMuted }}>{fmt(stats()!.compressibleTokenCount)}</span>
          </text>
          <text>
            <span style={{ fg: theme().textMuted }}>{"think "}</span>
            <span style={{ fg: theme().textMuted }}>{fmt(stats()!.reasoningTokenCount)}</span>
          </text>
        </>
      )}
    </box>
  )
}

const tui: TuiPlugin = async (api, options) => {
  const opts = options as Record<string, unknown> | undefined
  const cacheRaw = opts?.cacheBuckets
  const toolRaw = opts?.toolBuckets
  const cacheBuckets = typeof cacheRaw === "number" && cacheRaw > 0 ? Math.floor(cacheRaw) : 10
  const toolBuckets = typeof toolRaw === "number" && toolRaw > 0 ? Math.floor(toolRaw) : 10

  // cache/tools 紧随 visual-cache（order 55）。
  api.slots.register({
    order: 60,
    slots: {
      sidebar_content(_ctx, input) {
        return (
          <CacheToolsPanel
            api={api}
            sessionId={input.session_id}
            cacheBuckets={cacheBuckets}
            toolBuckets={toolBuckets}
          />
        )
      },
    },
  })

  // Compression 段单独排在内置 context（order 100）之后。
  api.slots.register({
    order: 110,
    slots: {
      sidebar_content(_ctx, input) {
        return <CompressionPanel api={api} sessionId={input.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id: ID, tui }

export default plugin
