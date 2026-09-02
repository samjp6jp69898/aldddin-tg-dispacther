// backfill/lib/cli.ts — 回填腳本共用的 CLI 參數解析。
//
// 共同約定（指揮官指派 2026-09-02）：
//   --dry-run           只讀來源、印統計，不對 DB / VictoriaLogs 做任何寫入（必做模式）。
//   --schema <name>     覆寫 MON_DB_SCHEMA（測試用臨時 schema，如 pipeline_monitor_backfill_test）。
//                       必須在建 pool 之前呼叫 parseBackfillArgs()，覆寫才生效。
//   --env-file <path>   覆寫 .env 來源（預設 head 的 telegram-dispatcher/.env）。

export interface BackfillArgs {
  dryRun: boolean
  schema?: string
  envFile?: string
  rest: string[]
}

export function parseBackfillArgs(argv: string[] = process.argv.slice(2)): BackfillArgs {
  const args: BackfillArgs = { dryRun: false, rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--schema') args.schema = argv[++i]
    else if (a === '--env-file') args.envFile = argv[++i]
    else args.rest.push(a)
  }
  if (args.schema) process.env.MON_DB_SCHEMA = args.schema
  return args
}
