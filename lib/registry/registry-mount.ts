// lib/registry/registry-mount.ts — token-registry 的 TG 告警掛載層（Phase 5 工作包 3 前半，A8 修補）。
//
// 背景：token-registry.ts 檔頭（見該檔 ~:34）明文「本檔不 import notify/*，
// TG 告警接線由掛載端注入」——那個約束保持不動。但 mcps 側兩支 CLI
// （make-starter-kit.ts / manage-tokens.ts）以動態 import 呼叫 token-registry
// 的高階函式時只組 intent、不傳 deps，導致閘門中止的 alert 只印 stderr，
// TG 告警接不上（審查 finding A8）。
//
// 本檔是那條「掛載端」：對外提供與 token-registry.ts 同名同簽名的四支高階
// 函式，行為＝把呼叫端傳入的 deps（若有）補上預設 alert 後轉呼叫
// token-registry；呼叫端已自帶 alert 時不覆蓋。token-registry.ts 本體零改動。
//
// 預設 alert：stderr 照印（CLI 使用者要看得到）＋ TG 告警（notifyOperator，
// best-effort、永不拋）。訊息本身由 token-registry 產生（只含 token_id 與
// 差異分類、永不含 token 明文，該紀律在上游已保證，本檔不再加工內容）。

import {
  issueToken as issueTokenImpl,
  revokeTokens as revokeTokensImpl,
  renameToken as renameTokenImpl,
  reconcileRegistry as reconcileRegistryImpl,
  type IssueIntent,
  type IssueResult,
  type RegistryDeps,
  type RegistryWriteResult,
  type RenameIntent,
  type ReconcileIntent,
  type RevokeIntent,
} from './token-registry.ts'
import { notifyOperator } from '../notify/operator.ts'

/**
 * 把呼叫端傳入的 deps 補上預設 alert（stderr + TG）。呼叫端已自帶 alert
 * 時不覆蓋——測試與其他掛載端仍可完全掌控告警行為。
 *
 * `notify` 可注入（預設 `notifyOperator`），供測試以 fake notify 取代真實
 * execFileSync，不碰真實 tg-notify.sh。
 */
export function createMountedDeps(
  deps: RegistryDeps = {},
  notify: (text: string) => boolean = notifyOperator,
): RegistryDeps {
  if (deps.alert) return deps
  return {
    ...deps,
    alert: (message: string) => {
      console.error(message)
      notify('🔐 token-registry: ' + message)
    },
  }
}

export async function issueToken(intent: IssueIntent, deps: RegistryDeps = {}): Promise<IssueResult> {
  return issueTokenImpl(intent, createMountedDeps(deps))
}

export async function revokeTokens(intent: RevokeIntent, deps: RegistryDeps = {}): Promise<RegistryWriteResult> {
  return revokeTokensImpl(intent, createMountedDeps(deps))
}

export async function renameToken(intent: RenameIntent, deps: RegistryDeps = {}): Promise<RegistryWriteResult> {
  return renameTokenImpl(intent, createMountedDeps(deps))
}

export async function reconcileRegistry(
  intent: ReconcileIntent,
  deps: RegistryDeps = {},
): Promise<RegistryWriteResult> {
  return reconcileRegistryImpl(intent, createMountedDeps(deps))
}
