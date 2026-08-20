# NetSpec App Telemetry — 部署與驗證 Runbook

對應 `doc/SDCL_telemetry.md` 的 Success Criteria **#1（App telemetry capture）**、
**#2（App output data）**、**#10（AI development cost visibility）**，以及 Week 1
分工中的「NetSpec app telemetry」。

這份文件是**從乾淨狀態到看見第一筆資料**的完整步驟（一次性的 Unity Catalog 設定）。
指令可以直接複製貼上，只有標示 `<<< 改這裡` 的地方需要換成你的值。

> **每次改版部署、以及要證明「有沒有達到目的」時，看 `SDCL_telemetry_acceptance.md`** ——
> 那份是 merge 之後的部署順序、逐條打勾的驗收清單，以及查不到資料時的排查流程。

---

## 0. 先看懂設計（兩分鐘）

```
瀏覽器 UI
  → track("generate_spec_clicked", {...})          frontend/lib/track.ts
  → POST /api/events                                frontend/app/api/events/route.ts
  → 從 x-forwarded-email 補上使用者身分（App 平台注入，App 內零認證程式碼）
  → 一行 compact JSON 寫進 stdout
  → Databricks Apps 自動把 stdout 匯出到 Unity Catalog 的 otel_logs
  → v_app_events_otel 把 JSON 還原成 typed columns
```

兩條互不相依的落地路徑：

| 路徑 | 預設 | 需要什麼 | 說明 |
|------|------|----------|------|
| **stdout → `otel_logs`** | **開啟**（程式面零設定） | 在 workspace 幫每個 App 打開 App telemetry | 主路徑，就是 SDCL 文件寫的做法 |
| **直寫 Delta table** | 關閉 | `TELEMETRY_TABLE` + `TELEMETRY_WAREHOUSE_ID` 都要設 | 備援。萬一 App telemetry 沒開、或想要自己完全掌控的 typed table |

兩條路徑產生**完全相同的 record 形狀**，`v_app_events` 會 union 起來並用
`event_id` 去重，所以隨時開關任一條路徑，下游查詢都不用改。

### 事件分類

| `event_type` | 意思 | 例子 |
|---|---|---|
| `ui_interaction` | 瀏覽器裡的一次操作 | `generate_spec_clicked`、`socratic_answered`、`session_end` |
| `server_event` | 服務端做了什麼 | `pipeline_step_completed`、`session_created`、`security_blocked` |
| `app_output` | 應用**產出**了什麼（criterion #2） | `spec_version`、`role_view_generated`、`figma_story_generated` |
| `llm_call` | 一次模型呼叫的 token 與成本（criterion #10） | `llm_call` |

### 兩個 join key

- `app_session_id` — NetSpec 後端 session id。**這是 telemetry 與規格產出之間的連結**。
- `user_email` — 平台注入的身分，App 內完全沒有認證程式碼。

### 隱私

`track()` 與後端 `telemetry.py` 都內建 `scrub()`：需求全文、規格內文、Figma token
等欄位**不會**進到 log。只保留長度、id 與列舉值（例如 `requirement` 會變成
`requirement_chars`）。埋點時請沿用這個習慣：送長度與 id，不要送內容。

---

## 1. 建立 Unity Catalog schema 與表

```bash
# 在 Databricks SQL editor 或 notebook 執行
#   doc/sql/01_setup.sql
# 預設是 ep_dev.netspec，要改的話改檔案最上面兩行
```

建立出來的東西：

- `ep_dev.netspec` schema
- `ep_dev.netspec.app_events` — typed landing table（給直寫路徑用）

> 每個欄位都寫了 `COMMENT`。這不是裝飾——Genie 就是靠 table/column comment 才能
> 正確回答自然語言問題（criterion #6），所以請不要刪掉。

---

## 2. 幫每個 App 打開 App telemetry（主路徑）

三個 App 都要做一次：`netspec`（frontend）、`netspec-backend`、`netspec-figma-backend`。

**Workspace UI**：Compute → Apps → 選 App → Settings → Telemetry → 開啟，
並選 catalog / schema（建議就選 `ep_dev` / `netspec`）。

啟用後 Databricks 會自動建立 `otel_logs`、`otel_spans`、`otel_metrics` 三張表。
**必須重新 deploy 一次 App，`otel_logs` 才會開始有資料。**

確認表名（有些 workspace 會加 prefix）：

```sql
SHOW TABLES IN ep_dev.netspec LIKE '*otel_logs*';
```

---

## 3. 建立 view

```bash
#   doc/sql/02_bronze_from_otel.sql   <<< 改這裡：FROM 子句換成上一步查到的表名
#   doc/sql/03_views.sql
```

`03_views.sql` 建立四個 view：

| View | 用途 |
|---|---|
| `v_app_events` | **所有查詢的起點**。union 兩條路徑並去重 |
| `v_spec_versions` | criterion #2 — NetSpec 產出的每一版規格，含 `approval_state` |
| `v_ai_cost_by_stage` | criterion #10 — 每次模型呼叫的 token 與成本，掛到 SDLC 步驟 |
| `v_sessions` | criterion #1 — 一個 browser session 一列，做漏斗與 dwell time |

> 如果第 2 步還沒做完（`v_app_events_otel` 不存在），把 `v_app_events` 裡
> `UNION ALL` 的第二段刪掉再執行即可，其他 view 一律照常運作。

---

## 4. 部署三個 App

```bash
EMAIL=your_email@asus.com   # 小寫

databricks sync ./backend/text-spec-service /Workspace/Users/$EMAIL/netspec-backend --full
databricks apps deploy netspec-backend --source-code-path /Workspace/Users/$EMAIL/netspec-backend

databricks sync ./backend/figma-service /Workspace/Users/$EMAIL/netspec-figma-backend --full
databricks apps deploy netspec-figma-backend --source-code-path /Workspace/Users/$EMAIL/netspec-figma-backend

databricks sync ./frontend /Workspace/Users/$EMAIL/netspec --full
databricks apps deploy netspec --source-code-path /Workspace/Users/$EMAIL/netspec
```

App 建立、service principal 授權、Secret ACL、Volume 三層權限這些**既有步驟不變**，
見 `README.md` 的「部署到 Databricks Apps」。這次沒有新增任何 secret。

> **注意：目前只能手動部署。** `.github/workflows/databricks-test.yml`（Deploy Apps to Dev）
> 的觸發條件是 `on: push: branches: [dev]`，但這個 repo 的分支是 `main` / `develop`，
> **沒有 `dev` 分支**，所以這個 workflow 從來沒有跑過。要改成自動部署的話是把
> workflow 裡的 `dev` 改成 `develop` —— 但那會讓「合併進 develop」＝「直接部署到
> Databricks workspace」，這是你的決定，我沒有自己改。

---

## 5. 驗證：看見第一筆資料

### 5a. 不用寫 SQL 的快速檢查

```bash
curl -s https://<netspec-backend-url>/api/health | jq .telemetry
```

應該看到：

```json
{
  "app": "netspec",
  "service": "text-spec-service",
  "stdout_sink": true,
  "delta_sink": false,
  "delta_table": "ep_dev.netspec.app_events",
  "delta_warehouse_id": null,
  "delta_pending_rows": 0,
  "delta_failed": false
}
```

前端的 ingest 端點也有 liveness probe：

```bash
curl -s https://<netspec-frontend-url>/api/events    # {"ok":true,...}
```

### 5b. 產生資料

打開 NetSpec，做一次完整流程：輸入需求 → 回答追問 → 確認搜尋計畫 → 拿到規格 →
切一次角色視圖 → 匯出。然後**關掉分頁**（`session_end` 是在分頁隱藏時才送出的）。

### 5c. 查資料

執行 `doc/sql/04_verify.sql`。每一段都寫了「PASS 是什麼」。最關鍵的一句是
criterion #1 的驗收標準——瀏覽器裡的一次點擊，變成一列帶著正確 email 的 typed row：

```sql
SELECT received_at, user_email, event_name, page, session_id, app_session_id, properties
FROM ep_dev.netspec.v_app_events
WHERE event_type = 'ui_interaction'
ORDER BY received_at DESC LIMIT 20;
```

---

## 6.（可選）打開 Delta 直寫備援

只有在 `otel_logs` 這條路走不通、或你想要一張自己完全掌控的 typed table 時才需要。

1. 找一個 SQL warehouse id：`databricks warehouses list`
2. 授權**每個 App 的 service principal**：
   ```bash
   for APP in netspec netspec-backend netspec-figma-backend; do
     SP=$(databricks apps get "$APP" | grep service_principal_client_id | grep -oE '[0-9a-f-]{36}')
     databricks grants update catalog ep_dev \
       --json "{\"changes\":[{\"principal\":\"$SP\",\"add\":[\"USE_CATALOG\"]}]}"
     databricks grants update schema ep_dev.netspec \
       --json "{\"changes\":[{\"principal\":\"$SP\",\"add\":[\"USE_SCHEMA\"]}]}"
     databricks grants update table ep_dev.netspec.app_events \
       --json "{\"changes\":[{\"principal\":\"$SP\",\"add\":[\"MODIFY\",\"SELECT\"]}]}"
     # SQL warehouse 的 CAN_USE 目前要在 UI 授權：SQL Warehouses → 選 warehouse → Permissions
   done
   ```
3. 三個 `app.yaml` 的 `TELEMETRY_WAREHOUSE_ID` 填上 warehouse id，重新 deploy。
4. `/api/health` 的 `telemetry.delta_sink` 應該變成 `true`。

失敗時的行為是**刻意設計**的：Delta sink 只會在 stderr 印一次錯誤然後靜默降級，
stdout 路徑完全不受影響，使用者也不會看到任何異常。`/api/health` 的
`telemetry.delta_failed` 會變成 `true`，就是拿來查這件事的。

---

## 7. Genie space（criterion #6 的前置）

`01_setup.sql` / `03_views.sql` 已經把 table 與 column comment 都寫好了。設定 Genie
space 時把這幾個 view 加進去即可：

- `v_app_events`、`v_spec_versions`、`v_ai_cost_by_stage`、`v_sessions`

建議放進 Genie instructions 的三句話：

1. 一律從 `v_app_events` 開始查，不要直接查 `otel_logs` 或 `app_events`。
2. 時間排序與時間區間一律用 `received_at`；`event_time` 是瀏覽器時鐘，可能有偏移。
3. `properties` 是 JSON 字串，用 `properties:key::type` 取值
   （例如 `properties:quality_score::int`）。

---

## 8. 已知限制 / 明天可以決定的事

- **NetSpec 目前沒有明確的「核准」按鈕。** `approval_state` 是從產品現有行為推導的：
  PM 確認規格後才會衍生架構師／QA 視圖（見 `README.md` 的 PM-first 說明），所以
  「已衍生角色視圖」＝ 目前產品唯一表達「這版被人接受了」的方式。對應邏輯集中在
  `text-spec-service/router.py` 的 `_approval_state()` 一個函式，之後要加真正的核准
  動作，只改那裡。**這點需要你確認是否符合 criterion #2 對 "approval state" 的期待。**
- **`cost_usd` 是估算值。** 單價表在 `cost.py` 的 `PRICES`，是公開列表價。等模型呼叫
  改走 Databricks-hosted Anthropic endpoint 之後，平台 system tables 會有權威數字；
  屆時 `v_ai_cost_by_stage` 的價值會轉為提供**「這筆花費屬於哪個 SDLC 步驟」**這個
  平台不可能知道的維度。
- **Polaris 與 BugZapper 尚未接入。** `app` 欄位與整個 record 契約是為三個 App 共用而
  設計的：那兩個 App 只要送出相同形狀的 record，就會直接出現在同一張表與同一組 view
  裡（criterion #9 的跨 App 時間軸），下游查詢一行都不用改。
- **`otel_logs` 的表名可能有 prefix。** 依 workspace 設定而定，所以
  `02_bronze_from_otel.sql` 的 FROM 子句刻意留給你填。
