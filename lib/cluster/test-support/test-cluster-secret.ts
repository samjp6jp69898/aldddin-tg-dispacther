// lib/cluster/test-support/test-cluster-secret.ts — 給「先設 CLUSTER_SHARED_SECRET
// 環境變數、再動態 import cluster-head.ts」這種測試手法共用的固定 secret。
//
// 為什麼要共用同一個值（2026-09-04 新增，task 2 補這個踩坑）：cluster-head.ts
// 在 module load 當下就讀一次 CLUSTER_SHARED_SECRET 存進模組層 const（見該檔
// `const secret = getClusterSecret()`），且 `bun test` 預設不會給每個測試檔各自
// 獨立的 module registry——同一次 `bun test` 進程裡，不管哪個測試檔先動態
// import 到 cluster-head.ts，那個模組實例（含它捕捉到的 secret 值）會被
// 之後所有測試檔共用。如果各測試檔各自設定不同的 SECRET 字面值，「後動態
// import 的檔案」會拿到「先 import 那個檔案設定的舊值」，導致自己準備的
// token 驗證不過、guard 測試全部誤判成 401（實際踩過：cluster-head-retry.test.ts
// 與 cluster-head-monitor-status.test.ts 同一次 `bun test` 執行時互相踩到）。
//
// 修法：所有需要「動態 import cluster-head.ts 並用真正 secret 打真正路由」的
// 測試檔一律用這裡的同一個常數（值本身是什麼不重要，只要 ≥32 字元、每個
// 測試檔一致），順序就不再影響結果。
export const TEST_CLUSTER_SECRET = 'shared-cluster-head-route-test-secret-0123456789'
