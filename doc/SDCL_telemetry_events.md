# NetSpec Telemetry — 事件字典

`v_app_events` 裡會出現的每一個 `event_name`。做 dashboard、寫 Genie instructions、
或是想知道「這個問題該查哪個事件」的時候看這裡。

- 每個事件都帶 `user_email`、`session_id`（瀏覽器分頁）、`event_date`。
- `app_session_id` 是 telemetry 與規格產出之間的 join key，在 session 建立之後的事件才有值。
- `properties` 是 JSON 字串，用 `properties:key::type` 取值。
- **前後端的事件名稱刻意不重複**，同一件事不會被算兩次。前端事件是「使用者做了什麼」，
  後端事件是「系統實際做了什麼／產出了什麼」。

---

## `ui_interaction` — 瀏覽器操作（前端 `track()`）

### 導覽與 session

| event_name | 何時送出 | 重點 properties |
|---|---|---|
| `page_view` | 進入 App | `view`、`workflow` |
| `session_end` | 分頁隱藏或離開（`sendBeacon`） | `reason`、`duration_ms` |
| `panel_viewed` | 切換左側面板 | `panel`、`from`、`workflow` |
| `workflow_switched` | 文字 ↔ Figma 工作流切換 | `from`、`to` |
| `landing_opened` / `landing_entered` | 回到／離開 Landing | `from` |
| `session_reset` | 清空重來 | `from_status`、`iteration` |
| `left_while_running` / `leave_while_running_cancelled` | 執行中想離開（**放棄訊號**） | `steps_completed` |
| `stream_disconnected` | SSE 連線中斷（**只有瀏覽器看得到**） | `at_step`、`status` |

### 文字工作流：需求 → PRD

| event_name | 何時送出 | 重點 properties |
|---|---|---|
| `example_requirement_used` | 用了範例需求（**代表不知道要打什麼**） | `requirement_chars` |
| `detail_level_changed` | 切換規格詳細度 | `from`、`to` |
| `start_blocked` | 按了開始但條件不足 | `requirement_chars`、`detail_level` |
| `analysis_started` | 開始分析 | `detail_level`、`requirement_chars` |
| `analysis_start_failed` | 啟動失敗 | `reason`（`rate_limit`／`daily_limit`／`validation`／`error`） |
| `socratic_answered` | 回答追問 | `round`、`question_count`、`answered_count`、`clarity_score` |
| `socratic_skipped` | 跳過追問 | 同上 |
| `socratic_proceeded` | 直接往下走 | 同上 |
| `socratic_more_questions_requested` | 要求再追問 | `answered_count`、`covered_dimension_count` |
| `search_plan_confirmed` | 確認搜尋計畫 | `modified`、`keyword_count` |
| `spec_ready` | 使用者實際看到規格 | `quality_score`、`validation_passed`、`edge_case_count` |
| `spec_iterate_clicked` | 按下優化 | `from_iteration`、`had_user_direction` |
| `iterate_submitted` | 送出優化（含勾選的驗證問題） | `selected_issue_count`、`total_issue_count` |
| `spec_iterate_request_failed` | 優化請求失敗（前端視角） | `reason` |
| `role_view_requested` / `role_view_received` / `role_view_failed` | 衍生架構師／QA 視圖 | `role`、`based_on_iteration`、`duration_ms` |
| `role_view_switched` | 切換角色視圖分頁 | `from`、`to`、`already_generated` |
| `version_switched` / `spec_version_viewed` | 切換版本 | `to_iteration`、`quality_score` |
| `language_toggled` | 中英切換 | `from`、`to`、`cached` |
| `compact_view_toggled` | 精簡檢視 | `enabled` |
| `spec_translated` | 翻譯完成並存檔 | `iteration`、`chars` |
| `spec_exported` / `spec_printed` | 匯出／列印（**最強的「這份規格有用」訊號**） | `format`、`view`、`iteration`、`chars` |
| `security_block_shown` | 使用者看到安全阻擋 | `category` |
| `history_session_opened` | 開啟歷史 session | `version_count`、`quality_score` |
| `history_deleted` / `history_delete_cancelled` | 刪除歷史 | `count`、`mode` |

### Figma 工作流：設計稿 → User Story

| event_name | 何時送出 | 重點 properties |
|---|---|---|
| `figma_oauth_connect_clicked` / `figma_oauth_returned` / `figma_oauth_disconnected` | Figma 授權 | `connected` |
| `figma_list_frames_clicked` / `figma_list_frames_failed` | 載入設計稿 | `force_refresh` |
| `figma_frames_loaded` | 取得 Frame 清單 | `file_key`、`frame_count` |
| `figma_frame_selected` / `figma_frames_toggle_all` | 選取 Frame | `frame_id`、`selected_count` |
| `figma_input_reset` | 重新輸入 | `had_frames` |
| `generate_story_clicked` / `figma_story_started` | 開始生成 Story | `frame_count` |
| `figma_pipeline_start_clicked` / `figma_pipeline_start_failed` | 啟動 pipeline | `force_regenerate` |
| `figma_questions_submitted` / `figma_questions_skipped` | 回答／跳過追問 | `round`、`answered_count` |
| `figma_features_confirm_clicked` | 確認功能清單（**丟掉幾條＝萃取品質**） | `confirmed_count`、`suggested_count`、`dropped_count` |
| `figma_story_confirmed` | 確認單一 Story | `feature_id`、`role` |
| `figma_story_version_saved` / `figma_story_save_failed` | 存檔／進版 | `mode`、`version_num`、`story_count` |
| `figma_history_opened` | 開啟 Figma 歷史 | `version_count`、`feature_count` |
| `monitor_created` / `monitor_deleted` | Frame 監控 | `frame_count`、`has_teams_webhook` |
| `monitor_check_run` / `monitor_check_failed` | 手動／批次比對 | `mode`、`changed` |
| `monitor_teams_notified` | 送 Teams 通知 | `ok` |
| `monitor_file_parsed` / `monitor_file_parse_failed` | 監控設定時解析檔案 | `frame_count` |

---

## `server_event` — 服務端行為（後端 `telemetry.track()`）

| event_name | 何時送出 | 重點 properties |
|---|---|---|
| `service_started` / `service_stopping` | 服務生命週期 | telemetry 診斷資訊 |
| `session_created` | 建立 NetSpec session（**此時綁定使用者身分**） | — |
| `pipeline_started` | Pipeline 開始 | `detail_level`、`requirement_chars`、`demo_mode` |
| `pipeline_step_started` / `pipeline_step_completed` | 每個節點（**`duration_ms` 就是「使用者在哪裡等」**） | `node`、`step`、`title`、`model`、`duration_ms` |
| `pipeline_interrupted` | 追問／計畫確認暫停 | `interrupt_type`、`round`、`clarity_score` |
| `pipeline_completed` | Pipeline 完成 | `quality_score`、`scraped_count`、`duration_ms` |
| `pipeline_failed` | Pipeline 失敗 | `error_type`、`error` |
| `spec_iterated` / `spec_iterate_failed` | 優化迭代 | `iteration`、`quality_score`、`had_user_direction` |
| `security_blocked` / `security_warned` | Phase 0 安全檢查 | `category`、`warning_count` |
| `figma_pipeline_started` / `..._step_started` / `..._step_completed` / `..._interrupted` / `..._completed` / `..._failed` | Figma pipeline | `node`、`feature_id`、`role`、`duration_ms` |
| `figma_questions_answered` / `figma_features_confirmed` | Figma 人機互動 resume | `answer_count`、`confirmed_count` |
| `figma_file_loaded` | 後端實際解析 Figma 檔 | `frame_count`、`comment_count`、`duration_ms` |

---

## `app_output` — 應用產出（Success Criterion #2）

| event_name | 一列代表 | 重點 properties |
|---|---|---|
| `spec_version` | **一個規格版本** | `spec_id`、`iteration`、`origin`、`feature_name`、`quality_score`、`validation_passed`、`approval_state`、`derived_role_views`、`spec_chars` |
| `role_view_generated` | 一個衍生的角色視圖 | `role`、`based_on_iteration`、`document_chars` |
| `figma_story_generated` | 一則 User Story | `feature_id`、`role`、`story_chars` |
| `figma_monitor_checked` | 一次設計稿比對（**規格為何要重做的上游訊號**） | `changed`、`added_count`、`removed_count`、`modified_count` |

用 `v_spec_versions` 查最方便。

### `approval_state`

| 值 | 意思 |
|---|---|
| `draft` | 已生成，但未通過驗證 |
| `pending_approval` | 通過驗證，尚無人確認 |
| `approved_derived` | PM 已確認（衍生了架構師／QA 視圖）|

> NetSpec 目前沒有明確的「核准」按鈕；這是從產品現有的 PM-first 行為推導出來的。
> 邏輯集中在 `text-spec-service/router.py` 的 `_approval_state()`。詳見
> `SDCL_telemetry_deployment.md` 第 8 節。

---

## `llm_call` — AI 成本（Success Criterion #10）

一次模型呼叫一列，從 `llm_client._record_usage()` 這個**所有呼叫都會經過的唯一路徑**
送出，所以呼叫端零埋點。

| properties | 說明 |
|---|---|
| `step` | SDLC 步驟，例如 `7 · PRD 規格生成`（`cost.py` 的 `STEP_BY_TOOL`）|
| `tool` / `model` | 工具名稱與模型 |
| `input_tokens` / `output_tokens` / `total_tokens` | token 用量 |
| `cost_usd` | 估算成本（單價來自 `cost.py` 的 `PRICES`，為公開列表價）|

也會帶 `app_session_id` 與 `user_email`——透過 `telemetry.bind_context()`
從 pipeline 外層傳下去，所以每一分錢都能歸到「哪個人、哪個 session、哪份規格」。
用 `v_ai_cost_by_stage` 查最方便。
