import type { Bot } from 'grammy'
import { resolveTechUserByChatId } from '../user-resolution/tech-user.ts'
import { sendTopLevelMenu } from '../webhook-server/top-menu.ts'
import { sendTicketList } from '../webhook-server/ticket-list.ts'
import { sendDemandList } from '../webhook-server/demand-list.ts'
import { handleClaim } from '../locking/claim.ts'
import { handleDemandClaim } from '../locking/demand-claim.ts'
import { createReplayGuard } from './replay-guard.ts'
import { handleKitCommand, isKitAdminChat } from '../webhook-server/kit-issue.ts'

// grammy 的 secretToken（見 lib/webhook-server/bot.ts / server.ts）只驗證請求
// 真的來自 Telegram，不驗證是不是授權使用者；chat_id 白名單要在這一層自己做
// （webhook-transport 調查明確指出的分工，見 tasks.json T3 risk_notes）。

/**
 * 掛載 bot.on('message') 與 bot.on('callback_query:data')，白名單外的 chat_id
 * 一律靜默 return，不執行任何後續 Notion/tracker 查詢或 keyboard 組裝。
 * 白名單內的 chat_id 通過後往下流動——訊息走 T30 指令式路由（/bug 直接列
 * 清單 / /req 需求池清單 / /menu 頂層選單 / /kit 核發企劃 starter kit
 * （僅 TG_KIT_ADMIN_CHAT_ID，見 kit-issue.ts） / 其他回用法提示，見 handler
 * 內註解）；callback_query 依 callback_data 分流 menu:bug（T29，觸發 T6/T8
 * 查詢列清單）/ reqpool:noop（T9 建立、T32 接上真實需求池清單）/
 * claim:{ticket}（T10）/ demand-claim:{ticket}（T33，上鎖＋更新 Notion
 * AI分析，不觸發任何自動化 pipeline）。
 *
 * T27：白名單通過之後才做 update_id 重放去重（review 發現：順序放反的話，
 * 白名單外的陌生流量也會消耗共用的追蹤額度，稀釋掉真正該防的重放窗口；
 * 白名單查詢本身很輕量，先做不虧）。去重集合是這個函式呼叫當下建立的
 * closure 變數，不是 module-level singleton——production 只會呼叫一次
 * registerHandlers(bot)（server.ts），效果跟 module-level 一樣；但測試每次
 * 呼叫都拿到全新的 guard，天生互相隔離，不需要靠人工約定不同測試間的
 * update_id 才能避免互相誤判成重放。
 *
 * review 發現並修正：isDuplicate 是「查完立刻記」，若業務邏輯之後才丟出
 * 例外（打 Notion/Telegram API 失敗等），Telegram 依規範會重新投遞同一個
 * update_id——這正是這層去重原本要處理的情境之一，但如果不處理，那次真正
 * 的重試會被誤判成重放而永久吞掉，使用者完全收不到任何回應。兩個 handler
 * 都用 try/catch 包住業務邏輯：失敗時呼叫 replayGuard.forget() 讓之後的
 * 重試可以真的重跑一次，並把例外原樣往上丟（維持跟 T27 之前一致的錯誤
 * 傳遞行為——server.ts 的 app.onError 接住回 500，不吞例外内容）。
 */
export function registerHandlers(bot: Bot): void {
  const replayGuard = createReplayGuard()

  bot.on('message', async ctx => {
    const chatId = String(ctx.chat.id)
    const techUser = resolveTechUserByChatId(chatId)
    if (techUser === null) return // 白名單外：靜默 return，不做重放判斷

    const updateId = ctx.update.update_id
    if (replayGuard.isDuplicate(updateId)) return // T27：重放的 update，直接忽略

    try {
      // T30（使用者 2026-08-16 於 T22 上線驗收時定案，取代 T29「任何訊息都
      // 回頂層選單」；2026-08-17 使用者收尾驗收時再定案改為斜線指令，取代
      // 原本的裸文字 bug/req，跟 /menu 統一成同一種指令格式，避免裸文字誤觸
      // ——例如閒聊訊息剛好整句就是 "bug" 或 "req"）：
      //   /bug  → 直接列 Bug 候選工單（等同點頂層選單的 BUG 按鈕）
      //   /req  → 直接列需求池候選單（T31/T32，等同點頂層選單的『需求池』
      //           按鈕），行為與 reqpool:noop 一致
      //   /menu → 頂層選單（既有 inline keyboard 流程保留，按鈕路由不變）
      //   其他  → 回覆用法提示。維持「白名單內沒有安靜失敗的路徑」原則，
      //           所以不是靜默忽略；比對大小寫不敏感、含前後空白容忍。
      const rawText = (ctx.message?.text ?? '').trim()
      const text = rawText.toLowerCase()
      const kitAdmin = isKitAdminChat(chatId)
      if (text === '/bug') {
        await ctx.replyWithChatAction('typing') // 跟 menu:bug 按鈕同款：真的打 Notion 前先給讀取中提示
        await sendTicketList(ctx, techUser)
      } else if (text === '/req') {
        await ctx.replyWithChatAction('typing') // 跟 /bug 對稱：真的打 Notion 前先給讀取中提示
        await sendDemandList(ctx, techUser)
      } else if (text === '/menu') {
        await sendTopLevelMenu(ctx)
      } else if (kitAdmin && /^\/kit(\s|$)/i.test(rawText)) {
        // 只有 TG_KIT_ADMIN_CHAT_ID 這個 chat_id 走得到這裡；其他白名單內的
        // 技術打 /kit 會直接落到最下面的 else，回一般用法提示，不洩漏這個
        // 指令存在（見 kit-issue.ts 檔頭註解）。
        await handleKitCommand(ctx, rawText)
      } else {
        const usage = kitAdmin
          ? '可用指令：/bug（列出可認領 Bug 工單）、/req（需求池）、/menu（選單）、/kit <id> <name>（核發企劃 kit）'
          : '可用指令：/bug（列出可認領 Bug 工單）、/req（需求池）、/menu（選單）'
        await ctx.reply(usage)
      }
    } catch (err) {
      replayGuard.forget(updateId)
      throw err
    }
  })

  bot.on('callback_query:data', async ctx => {
    const chatId = String(ctx.chat?.id ?? ctx.from.id)
    const techUser = resolveTechUserByChatId(chatId)
    if (techUser === null) {
      // 理論上白名單外的人永遠收不到 inline keyboard，這裡是防禦性重驗。
      // 仍要 answer 消掉 Telegram 端的 loading 圈，但不做任何查詢或分流。
      await ctx.answerCallbackQuery()
      return
    }

    const updateId = ctx.update.update_id
    if (replayGuard.isDuplicate(updateId)) return // T27：重放的 update，直接忽略（不 answerCallbackQuery——原始的合法請求已經處理過了）

    try {
      const data = ctx.callbackQuery.data
      if (data === 'menu:bug') {
        await ctx.answerCallbackQuery()
        await ctx.replyWithChatAction('typing') // 這裡才是真的打 Notion 查詢的地方（T6），先給讀取中提示
        await sendTicketList(ctx, techUser)
        return
      }
      if (data === 'reqpool:noop') {
        await ctx.answerCallbackQuery()
        await ctx.replyWithChatAction('typing') // 這裡才是真的打 Notion 查詢的地方（T31），先給讀取中提示
        await sendDemandList(ctx, techUser)
        return
      }
      if (data.startsWith('claim:')) {
        await handleClaim(ctx, techUser, data.slice('claim:'.length))
        return
      }
      if (data.startsWith('demand-claim:')) {
        await handleDemandClaim(ctx, techUser, data.slice('demand-claim:'.length))
        return
      }

      // 未知的 callback_data：仍要 answer 消掉 loading 圈。
      await ctx.answerCallbackQuery()
    } catch (err) {
      replayGuard.forget(updateId)
      throw err
    }
  })
}
