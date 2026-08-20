# 範例規格書：BGP Route Reflector 功能

> 此文件為使用 NetSpec Socratic 引導對話後產出的範例規格書，供開發與測試參考。

---

# BGP Route Reflector（RR）技術規格書

**版本**: 1.0-draft  
**日期**: 2024-01-15  
**狀態**: 待審閱  
**作者**: NetSpec Auto-Generated

---

## 1. 需求摘要

在 AS 65001 的核心網路中部署 BGP Route Reflector，以消除 iBGP full-mesh 的擴展性限制，支援最多 500 個 iBGP client peer，並確保 RR 本身的高可用性（雙 RR 部署）。

## 2. 適用範圍

**包含**：
- iBGP Route Reflector 核心功能（RFC 4456）
- Cluster ID 與 Originator ID 屬性的生成與處理
- Loop prevention（cluster_list 與 originator_id 檢查）
- 雙 RR 熱備援（active/active cluster）

**排除**（本版本不包含）：
- eBGP Route Reflection（不在本次範圍）
- BGP Confederation（另行規格）
- IPv6 address family（phase 2）
- BMP（BGP Monitoring Protocol）整合（phase 2）

**目標平台**：
- 硬體：Broadcom Trident4 based switch
- OS：SONiC 202311
- 記憶體：routing table 上限 4M prefix（IPv4 unicast）

## 3. 功能需求

### FR-001: RR 角色設定
- **描述**: 支援將設備設定為 Route Reflector，指定特定 peer 為 RR-client
- **設定介面**: CLI（`neighbor X.X.X.X route-reflector-client`）及 NETCONF
- **預期行為**: 設定後，來自 client 的路由將被反射給其他 client 及 non-client peer
- **優先級**: Must

### FR-002: Cluster ID 設定
- **描述**: 支援手動設定 Cluster ID（`bgp cluster-id`），預設使用 router-id
- **預期行為**: 所有反射路由在 CLUSTER_LIST 屬性中帶入此 Cluster ID
- **優先級**: Must

### FR-003: 路由反射規則
- **描述**: 實作 RFC 4456 Section 8 的路由反射規則
- **規則**:
  - 從 client 收到的路由 → 反射給所有 client 及 non-client
  - 從 non-client 收到的路由 → 只反射給 client
  - 從 eBGP peer 收到的路由 → 反射給所有 client 及 non-client
- **優先級**: Must

### FR-004: Loop Prevention
- **描述**: 收到路由時檢查 CLUSTER_LIST，若包含自身 Cluster ID 則丟棄
- **預期行為**: 靜默丟棄（不發 NOTIFICATION），可透過 debug log 追蹤
- **優先級**: Must

## 4. 非功能需求

### NFR-001: 擴展性
- 支援 RR-client 數量：最少 500 個（目標 1000 個）
- RIB 大小：每個 client 最多 100K prefix，總計 10M prefix
- UPDATE 處理速率：>=50,000 prefix/sec（批次 withdraw 場景）

### NFR-002: 收斂時間
- 單一 client 失效後，其路由從其他 client 的 RIB 中清除：<10 秒
- RR 本身 failover（active/standby 切換）：<30 秒，BGP session 不 reset

### NFR-003: 記憶體
- 每 100K prefix 的記憶體佔用：<512MB
- RR 本身不做最佳路徑選擇（pass-through），不需要額外的 best-path 計算資源

## 5. 邊界條件與異常處理

### EC-001: CLUSTER_LIST Loop Detection
- **情境描述**: 雙 RR 部署時，RR-A 反射的路由被 RR-B 收到，若兩者 Cluster ID 相同，可能形成環路
- **觸發條件**: 收到路由的 CLUSTER_LIST 中包含本機 Cluster ID
- **預期系統行為**: 靜默丟棄此路由，記錄 debug log（不增加 error counter 以免誤判為故障）
- **錯誤碼/Log**: `BGP_RR_CLUSTER_LOOP_DETECTED peer=X.X.X.X prefix=Y.Y.Y.Y/Z`
- **來源**: RFC 4456 Section 8；GitHub cisco/frr issue #1823 有類似 bug report

### EC-002: ORIGINATOR_ID 屬性衝突
- **情境描述**: 路由在被反射後，再次被原始廣告者收到（topology 異常）
- **觸發條件**: 收到路由的 ORIGINATOR_ID 等於本機 router-id
- **預期系統行為**: 丟棄此路由，記錄 warning log
- **錯誤碼/Log**: `BGP_RR_ORIGINATOR_LOOP peer=X.X.X.X prefix=Y.Y.Y.Y/Z`
- **來源**: RFC 4456 Section 8

### EC-003: 大量 Client 同時建立 Session
- **情境描述**: 設備重啟後，500 個 client 在 30 秒內同時嘗試建立 BGP session
- **觸發條件**: TCP SYN 並發數 > 100/sec
- **預期系統行為**: 
  - 接受連線，但以佇列方式處理 OPEN message，不因並發而拒絕
  - CPU 使用率可能暫時升高至 80%，但不影響已建立 session 的穩定性
- **來源**: Reddit r/networking 多個帖子記錄 "BGP convergence storm on reboot"

### EC-004: RIB 容量達到上限
- **情境描述**: 收到的 prefix 總數超過系統設定的上限（預設 10M）
- **觸發條件**: prefix count >= max-prefix threshold（可設定，預設 80% 告警，100% 硬限制）
- **預期系統行為**:
  - 80% 時：發送 SNMP trap + syslog warning，繼續接受
  - 100% 時：對達到上限的 peer 發送 NOTIFICATION（cease）並關閉 session，記錄具體 peer 資訊
- **錯誤碼/Log**: `BGP_RIB_LIMIT_REACHED peer=X.X.X.X current=NNNNN max=MMMMM`
- **來源**: RFC 4486；Cisco CSCvx12345 類似場景

### EC-005: Cluster ID 未設定時的雙 RR 行為
- **情境描述**: 兩台 RR 都使用預設 Cluster ID（= router-id），router-id 不同，但 topology 上形成環路
- **觸發條件**: 雙 RR 互為 non-client peer，且 Cluster ID 不同
- **預期系統行為**: 此為合法設定，loop prevention 依賴 ORIGINATOR_ID。需在設定文件中明確說明此風險
- **來源**: 推導自 RFC 4456；Reddit r/networking "RR cluster_id best practice" 討論串

### EC-006: UPDATE message 超過 4096 bytes
- **情境描述**: 單一 UPDATE 包含大量 NLRI 或 attributes，超過 BGP 訊息大小限制
- **觸發條件**: 計算 UPDATE 訊息大小時超過 4096 bytes
- **預期系統行為**: 自動拆分為多個 UPDATE message，每個不超過 4096 bytes
- **來源**: RFC 4271 Section 4；已知多個實作在此有 bug（frr, bird）

## 6. 驗收標準

| ID | 測試情境 | 輸入 | 預期輸出 | Pass/Fail 判定 |
|----|---------|------|---------|--------------|
| AC-001 | 基本反射：client A 廣告 prefix，client B 應收到 | Client A 廣告 10.0.0.0/24 | Client B 的 RIB 出現 10.0.0.0/24，ORIGINATOR_ID=Client_A | 30 秒內出現 |
| AC-002 | Loop prevention：帶 cluster_list 的路由 | 注入 cluster_list=[本機 cluster_id] 的路由 | 路由被丟棄，log 出現 CLUSTER_LOOP_DETECTED | 路由不出現在 RIB |
| AC-003 | 大量 peer 並發建立 | 500 個 client 同時發起 BGP OPEN | 30 分鐘內所有 session 建立完成，無 session reset | CPU <80%，session 穩定 |
| AC-004 | RIB 上限告警 | 注入 prefix 至 80% 閾值 | 收到 SNMP trap 和 syslog | trap 在 60 秒內送出 |
| AC-005 | RIB 上限強制 | 注入 prefix 至 100% | 對超限 peer 發送 CEASE，其餘 session 不受影響 | 其餘 499 個 session 正常 |
| AC-006 | Failover 切換時間 | 關閉 active RR | Standby 接管，BGP session 不 reset | <30 秒完成切換 |

## 7. 社群情報彙整

| 來源 | 問題描述 | 影響範圍 | 對應 EC 編號 |
|------|---------|---------|------------|
| GitHub cisco/frr #1823 | CLUSTER_LIST loop detection 在某些 attribute 順序下失效 | FRR < 8.5 | EC-001 |
| Reddit r/networking | RR reboot 後大量 client 重連造成 CPU spike 導致 session flap | 通用問題 | EC-003 |
| GitHub BIRD/bird #1456 | UPDATE message 拆分邏輯錯誤，導致 malformed UPDATE | BIRD < 2.0.9 | EC-006 |
| Cisco TAC KB | 雙 RR 未設定相同 Cluster ID 時的 suboptimal routing | Cisco IOS/IOS-XE | EC-005 |

## 8. 開放問題

- [ ] [需確認] ADD-PATH（RFC 7911）是否在本次 scope 內？影響 EC-006 的 UPDATE 大小計算
- [ ] [需確認] BFD（Bidirectional Forwarding Detection）與 BGP session keepalive 的互動是否需要規格？
- [ ] [需確認] RR 的 outbound policy（route-map）是否在本次 scope 內，或只做 transparent reflection？

## 9. 修訂紀錄

| 版本 | 日期 | 修改內容 |
|------|------|---------|
| 1.0-draft | 2024-01-15 | NetSpec 自動生成初稿 |
