import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnDetachedProcess } from './spawn-create-mr.ts'
import { createConcurrencyLimiter } from './concurrency-limiter.ts'
import { markPipelineActive, clearPipelineActive } from './active-pipeline-marker.ts'
import type { TechUser } from '../user-resolution/tech-user.ts'

const LOG_DIR = '/Users/user/aladdin/telegram-dispatcher/logs'
const SPAWN_ERROR_LOG = join(LOG_DIR, 'spawn-errors.log')
const RUN_DEMAND_PIPELINE_TS = '/Users/user/aladdin/telegram-dispatcher/lib/pipeline-runner/run-demand-pipeline.ts'
const BUG_LOCK_SH = '/Users/user/aladdin/scripts/bug-lock.sh'
const TG_NOTIFY_SH = '/Users/user/aladdin/scripts/tg-notify.sh'

// review 發現：run-demand-pipeline.ts 內部每個外部呼叫都各自有 timeout，
// 但整支腳本本身沒有一個外層總時限——跟 create-mr 的 WRAPPER_SCRIPT 用
// `timeout 7200` 包住整條 pipeline、且用 bash EXIT trap 保證『不管 claude -p
// 是正常結束還是被 timeout 殺，鎖都會釋放』不同，這裡原本只靠 TypeScript
// try/finally，一旦這支 Bun 腳本本身被外部機制強制終止（SIGKILL 不可被
// try/finally 攔截），鎖永遠不會釋放。已改成比照 spawn-create-mr.ts 的
// WRAPPER_SCRIPT 模式：bash 包一層 `timeout` + EXIT trap，鎖釋放交給 bash
// trap 做最後一道安全網（run-demand-pipeline.ts 內部的 try/finally release
// 仍是主要路徑，正常結束時就會執行；trap 只在它沒機會執行時補上，
// bug-lock.sh release 對已釋放的鎖是 no-op，兩邊都呼叫無害）。
const TICKET_RE = /^ALDREQ-\d+$/
const OUTER_TIMEOUT_SECONDS = 7200 // 跟 create-mr 的既有值一致，run-demand-pipeline.ts 內部各步驟 timeout 加總的最壞情況遠低於這個值

const WRAPPER_SCRIPT = `
trap '
  EC=$?
  bash ${BUG_LOCK_SH} release "$1" >/dev/null 2>&1
  if [ "$EC" -ne 0 ]; then
    bash ${TG_NOTIFY_SH} --email "$2" --text "⚠️ $1 需求 pipeline 異常終止（exit=$EC，可能是被逾時強制中止），請人工檢查 logs/demand-pipeline.log 與工作目錄 worktrees/$1/。" >/dev/null 2>&1
  fi
' EXIT
timeout ${OUTER_TIMEOUT_SECONDS} bun ${RUN_DEMAND_PIPELINE_TS} "$1" "$2"
`

// 需求 pipeline 的全域併發上限跟 Bug pipeline（T26，N=5）不共用同一個計數器，
// 用獨立的計數器。原本 2026-08-17 定案為保守值 N=2（理由：需求 pipeline 當時
// 是全新、範圍完整性還沒被充分驗證的 pipeline，T35 回溯測試已證實跨 repo
// 需求有真實遺漏風險，不該跟已穩定運作的 Bug pipeline 搶額度）。
// 2026-08-27 使用者定案調高為 N=6：明確知情此值已超過 Bug pipeline 上限，
// 仍要求調整，非因 T35 風險已解除。
export const DEMAND_CONCURRENCY_LIMIT = 6
const concurrencyLimiter = createConcurrencyLimiter(DEMAND_CONCURRENCY_LIMIT)

/**
 * T36：claim 成功後 fire-and-forget 觸發 run-demand-pipeline.ts（見該檔案
 * 檔頭註解說明完整流程），外層包一層 bash timeout + EXIT trap（見上方
 * WRAPPER_SCRIPT 註解）。介面比照 spawnCreateMr（T11/T26）：先檢查全域
 * 併發上限，通過才真的 spawn；spawn 本身失敗（磁碟/fd 用盡等）要接住，不
 * 讓已佔用的名額卡死、也不讓例外一路炸穿到 claim 端變成使用者收不到任何
 * 回覆。
 *
 * review 發現：跟 spawn-create-mr.ts 的 TICKET_RE 對等的格式防護原本漏掉
 * ——這裡不是唯一防線（demand-claim.ts 的 stillCandidate 檢查已經先擋過
 * 一次），但 run-demand-pipeline.ts 本身是可獨立執行的 CLI 進入點，缺這道
 * 防護會讓「脫離 demand-claim.ts 呼叫鏈直接呼叫」的情境完全沒有格式檢查，
 * 已補上，防禦深度跟 Bug pipeline 對等。
 */
export function spawnDemandPipeline(
  ticket: string,
  assigneeEmail: string,
  triggeredBy?: TechUser,
): { ok: true; pid: number | undefined } | { ok: false; reason: 'concurrency_limit' | 'spawn_error' } {
  if (!TICKET_RE.test(ticket)) {
    throw new Error(`拒絕 spawn：ticket 格式不對（${ticket}），可能是注入嘗試`)
  }

  if (!concurrencyLimiter.tryAcquire()) {
    return { ok: false, reason: 'concurrency_limit' }
  }

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const base = `${ticket}.${timestamp}.demand-pipeline`
    const stdoutPath = join(LOG_DIR, `${base}.stdout.log`)
    const stderrPath = join(LOG_DIR, `${base}.stderr.log`)

    // 比照 spawn-create-mr.ts 同名 sidecar 機制，見該檔案註解。
    if (triggeredBy) {
      try {
        writeFileSync(
          join(LOG_DIR, `${base}.triggered-by.json`),
          JSON.stringify({ name: triggeredBy.notion_user_name, email: triggeredBy.email, at: new Date().toISOString() }),
        )
      } catch {
        // best-effort，理由同 spawn-create-mr.ts。
      }
    }

    // T26 review 修正：標記「這張需求單是 dispatcher 觸發的」，理由與作法比照
    // spawn-create-mr.ts（見 active-pipeline-marker.ts 檔頭註解）——
    // stale-lock-reaper.ts 只會對有這份標記的 ticket 動手。
    markPipelineActive(ticket)

    const pid = spawnDetachedProcess('bash', ['-c', WRAPPER_SCRIPT, 'run-demand-pipeline', ticket, assigneeEmail], {
      cwd: '/Users/user/aladdin/telegram-dispatcher',
      stdoutPath,
      stderrPath,
      onExit: () => {
        concurrencyLimiter.release()
        clearPipelineActive(ticket)
      },
    })
    return { ok: true, pid }
  } catch (err) {
    concurrencyLimiter.release()
    clearPipelineActive(ticket)
    mkdirSync(dirname(SPAWN_ERROR_LOG), { recursive: true })
    appendFileSync(SPAWN_ERROR_LOG, `${new Date().toISOString()} spawnDemandPipeline 失敗（${ticket}）: ${err}\n`)
    return { ok: false, reason: 'spawn_error' }
  }
}
