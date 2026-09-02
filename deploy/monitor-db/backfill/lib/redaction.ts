// backfill/lib/redaction.ts — 歷史 log 回填送 VictoriaLogs 前的遮罩規則表。
//
// 已收斂（Phase 7 落地）：本檔曾是 plan §7.3（BLOCKER-4）11 條規則的
// 「回填先行版」，只給 backfill-logs-vl.ts 這支一次性離線回填腳本用。
// canonical 版現已落在 lib/log-shipper/redaction.ts（規則表定義、三層驗收
// 架構說明皆在該檔），本檔改為單純 re-export，不再維護第二份規則表。
export { REDACTION_RULES, redactLine, type RedactionRule } from '../../../../lib/log-shipper/redaction.ts'
