// lib/pipeline-runner/local-current-stage.ts — worker 端「這張 bug 票此刻正在
// 跑哪個 stage／哪位 agent」即時推定（2026-09-04 新增，task 2：worker-agent.ts
// 的 GET /jobs/:ticket/current-stage 用）。
//
// 背景：tg-monitor/lib/ingest.ts 的 inferCurrentBugStage() 靠 pipeline
// `claude -p` session 的 transcript（~/.claude/projects/-Users-user-aladdin/
// <session>.jsonl）推定 manager 此刻派工中的 agent——這是唯一即時的「正在跑
// 哪一步」訊號，但 transcript 只存在於執行機本地檔案系統。worker 執行的票，
// head 天生讀不到那份 transcript。
//
// 本檔是 inferCurrentBugStage() 這段邏輯在 telegram-dispatcher repo 內的對等
// 複本（比照 local-stage-files.ts／local-trace-read.ts 檔頭「兩個 repo 各自
// 獨立宣告、沒有 import 關係」的既定模式）：worker 用它算出「目前在跑哪個
// agent／哪個 stage」，透過新端點回給 head，head 端 tg-monitor 的
// computeBugStages() 改用這份結果組裝 running 那一列，不再對 worker 執行的
// 票整段跳過（見 tg-monitor/lib/ingest.ts computeBugStages 的
// remoteCurrentStage 參數）。
//
// 邏輯與常數表**逐字比照** tg-monitor/lib/ingest.ts 的
// findPipelineTranscript／scanTranscriptState／inferCurrentBugStage 與
// BUG_AGENT_STAGE／BUG_STAGE_ORDER／REVIEW_AGENTS／FINAL_REVIEW_AGENT——
// 改動任一邊都要同步，否則兩邊對「正在跑哪一步」的判斷會不一致。

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

const TRANSCRIPT_DIR = '/Users/user/.claude/projects/-Users-user-aladdin' // pipeline cwd=/Users/user/aladdin 的固定 slug

const BUG_AGENT_STAGE: Record<string, string> = {
  'bug-report-and-spec-analyst': 'analytics',
  'cqa-grounder': 'grounding',
  'bug-tracer': 'analysis-notes',
  'bug-tracer-with-callgraph': 'analysis-notes',
  'bug-fixer': 'fixer',
  'bug-fixer-with-tests': 'fixer',
  'solution-reviewer': 'review',
  'adversarial-solution-reviewer': 'review',
  'tdd-fidelity-reviewer': 'review',
  'final-adversarial-reviewer': 'final-review',
  'drive-uploader': 'solution',
  'drive-uploader-mr': 'solution',
  'mr-pusher': 'exit',
}
const BUG_STAGE_ORDER = ['analytics', 'grounding', 'analysis-notes', 'worktree', 'fixer', 'review', 'final-review', 'solution', 'exit']

export type CurrentBugStage = { stageKey: string; agent: string; since: string; reviewRound?: number }

// Step 6 三重平行審查的三位 reviewer——語意與輪次計算規則見 tg-monitor 對應
// 常數的完整註解，這裡不重複。
const REVIEW_AGENTS = new Set(['solution-reviewer', 'adversarial-solution-reviewer', 'tdd-fidelity-reviewer'])

/** 精確完整輪次：REVIEW_AGENTS 全員計數的 min（缺席=0）。 */
function fullReviewRounds(counts: Map<string, number>): number {
  let min = Infinity
  for (const a of REVIEW_AGENTS) min = Math.min(min, counts.get(a) ?? 0)
  return Number.isFinite(min) ? min : 0
}
const FINAL_REVIEW_AGENT = 'final-adversarial-reviewer'

// path 找到才快取（找不到不快取：spawn 後 transcript 建檔可能比第一次查詢晚幾秒）
const transcriptPathCache = new Map<string, string>()

type TranscriptScanState = {
  offset: number
  carry: string
  pending: Map<string, { agent: string; ts: string }>
  reviewCounts: Map<string, number>
  finalReviewCount: number
}
const transcriptScanState = new Map<string, TranscriptScanState>()

function findPipelineTranscript(ticket: string, runStartedAt: string): string | null {
  const cacheKey = `${ticket}|${runStartedAt}`
  const hit = transcriptPathCache.get(cacheKey)
  if (hit) return hit
  try {
    const runStart = Date.parse(runStartedAt)
    // 同一張票短時間內兩條 run 會有兩份 prompt 相同、mtime 都 >= runStart 的
    // transcript——收集全部命中後取 mtime 最新的（比照 tg-monitor 對應邏輯）。
    let best: { path: string; mtimeMs: number } | null = null
    for (const f of readdirSync(TRANSCRIPT_DIR)) {
      if (!f.endsWith('.jsonl')) continue
      const p = join(TRANSCRIPT_DIR, f)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.mtime.getTime() < runStart) continue // 這次 run 開始後就沒寫過的檔案必不是本 run
      const fd = openSync(p, 'r')
      let head = ''
      try {
        const buf = Buffer.alloc(2048)
        head = buf.toString('utf8', 0, readSync(fd, buf, 0, 2048, 0))
      } finally {
        closeSync(fd)
      }
      if (head.includes(`/create-mr:create-mr ${ticket}`) && (!best || st.mtime.getTime() > best.mtimeMs)) {
        best = { path: p, mtimeMs: st.mtime.getTime() }
      }
    }
    if (best) {
      transcriptPathCache.set(cacheKey, best.path)
      return best.path
    }
  } catch {}
  return null
}

/** 增量掃描單一 transcript 檔案，更新並回傳其累積掃描狀態（比照 tg-monitor
 * 的 scanTranscriptState）：只讀新 append 的部分，pending = 已派工未回結果的
 * tool_use；reviewCounts／finalReviewCount 累計三位 reviewer／
 * final-adversarial-reviewer 被派工次數。 */
function scanTranscriptState(path: string): TranscriptScanState | null {
  let st
  try {
    st = statSync(path)
  } catch {
    return null
  }
  if (st.size > 100 * 1024 * 1024) return null // 異常肥大就放棄推定，不拖垮輪詢
  let state = transcriptScanState.get(path)
  if (!state) {
    state = { offset: 0, carry: '', pending: new Map(), reviewCounts: new Map(), finalReviewCount: 0 }
    transcriptScanState.set(path, state)
  }
  if (st.size < state.offset) {
    // 檔案被截斷重置
    state.offset = 0
    state.carry = ''
    state.pending.clear()
    state.reviewCounts.clear()
    state.finalReviewCount = 0
  }
  if (st.size > state.offset) {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(st.size - state.offset)
      const n = readSync(fd, buf, 0, buf.length, state.offset)
      state.offset += n
      const text = state.carry + buf.toString('utf8', 0, n)
      const lastNl = text.lastIndexOf('\n')
      state.carry = lastNl >= 0 ? text.slice(lastNl + 1) : text
      for (const line of (lastNl >= 0 ? text.slice(0, lastNl) : '').split('\n')) {
        // 便宜前置過濾：絕大多數行連 parse 都不用
        if (!line || (!line.includes('"tool_use"') && !line.includes('"tool_result"'))) continue
        let e: any
        try {
          e = JSON.parse(line)
        } catch {
          continue
        }
        if (e?.isSidechain) continue
        const content = e?.message?.content
        if (!Array.isArray(content)) continue
        for (const b of content) {
          if (b?.type === 'tool_use') {
            if ((b.name === 'Agent' || b.name === 'Task') && typeof b.input?.subagent_type === 'string') {
              state.pending.set(b.id, { agent: b.input.subagent_type, ts: e.timestamp ?? '' })
              if (REVIEW_AGENTS.has(b.input.subagent_type)) {
                state.reviewCounts.set(b.input.subagent_type, (state.reviewCounts.get(b.input.subagent_type) ?? 0) + 1)
              } else if (b.input.subagent_type === FINAL_REVIEW_AGENT) {
                state.finalReviewCount += 1
              }
            } else if (b.name === 'Bash' && typeof b.input?.command === 'string' && b.input.command.includes('setup-worktree.sh')) {
              state.pending.set(b.id, { agent: 'setup-worktree.sh', ts: e.timestamp ?? '' })
            }
          } else if (b?.type === 'tool_result' && b.tool_use_id) {
            state.pending.delete(b.tool_use_id)
          }
        }
      }
    } finally {
      closeSync(fd)
    }
  }
  return state
}

/** ticket/runStartedAt 找不到匹配的 transcript，或 transcript 掃描失敗（例如
 * 異常肥大）一律回 null——呼叫端（worker-agent.ts 的 handler）據此回
 * `{ ok: true, stage: null }`，不是錯誤，只是「目前沒有可推定的即時進度」。 */
export function inferCurrentBugStage(ticket: string, runStartedAt: string): CurrentBugStage | null {
  const path = findPipelineTranscript(ticket, runStartedAt)
  if (!path) return null
  const state = scanTranscriptState(path)
  if (!state) return null
  // 未回結果的派工＝此刻正在跑；平行派工（Step 2 兩位／Step 6 三位）取
  // pipeline 順序最深的一個當代表（同屬一個階段時結果相同）。
  let best: CurrentBugStage | null = null
  for (const { agent, ts } of state.pending.values()) {
    const key = agent === 'setup-worktree.sh' ? 'worktree' : BUG_AGENT_STAGE[agent]
    if (!key) continue
    if (!best || BUG_STAGE_ORDER.indexOf(key) > BUG_STAGE_ORDER.indexOf(best.stageKey)) best = { stageKey: key, agent, since: ts || runStartedAt }
  }
  if (best?.stageKey === 'review') {
    best.reviewRound = fullReviewRounds(state.reviewCounts)
  }
  return best
}
