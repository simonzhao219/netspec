# 網通邊界條件分類學（Edge Case Taxonomy）

## 使用說明
在 Phase 2 引導對話時，根據用戶的功能需求類型，從以下分類中選取最相關的邊界條件進行追問。每次選 2-3 個，避免一次傾倒太多。

---

## L2 層功能（Switching / VLAN / STP）

### VLAN
- VLAN ID 邊界值：0, 1, 4094, 4095 的行為
- native VLAN mismatch（兩端設定不一致）
- VLAN 數量上限（4094 個 VLAN 同時存在時的 CAM 行為）
- double tagging（QinQ）與標準 802.1Q 的互通
- PVLAN（Private VLAN）與一般 VLAN ACL 的交互

### STP / RSTP / MSTP
- TCN（Topology Change Notification）風暴
- root bridge 選舉競態（兩台設備同時宣告更低 bridge ID）
- port 在 listening/learning/forwarding 切換時的封包遺失窗口
- BPDU guard 觸發後的恢復機制（auto-recovery timeout）
- MSTP region mismatch 時的 fallback 行為

### MAC Table
- MAC table 滿溢（flooding behavior when table full）
- MAC flapping（同一 MAC 在多個 port 快速切換）
- static MAC entry 與動態學習衝突
- aging time 設為 0 的行為（部分廠商視為 disable aging）

---

## L3 層功能（Routing / Forwarding）

### 靜態路由
- 遞迴查找深度上限（recursive lookup depth）
- floating static route 的 AD 值邊界
- null0 route 與 default route 的優先順序

### OSPF
- Area 0 斷裂後的 virtual link 行為
- MTU mismatch 導致的 EXSTART 卡死
- LSA 年齡到期（MaxAge=3600s）時的 reflooding 衝擊
- 同一 subnet 上超過 255 個 neighbor 的 DR/BDR 選舉
- stub area 收到 type-5 LSA 的處理

### BGP
- AS_PATH prepend 超過 255 hops
- BGP session 建立中收到 NOTIFICATION 的 FSM 處理
- route reflector cluster_list loop detection
- 4-byte AS number 與 2-byte AS 設備的互通（RFC 6793）
- UPDATE message 超過 4096 bytes 的分片行為
- hold timer 設為 0（禁用 keepalive）時的 session 穩定性
- 收到 withdraw 的 prefix 數量超過 routing table 容量

### ECMP
- ECMP member 數量超過硬體支援上限時的 fallback
- Hash collision 導致的不均勻分佈
- Unequal-cost load balancing 的 weight 精度
- ECMP 成員一個失效時的 reconvergence 時序

---

## 協定互通與版本

### IPv4/IPv6 雙棧
- IPv4-mapped IPv6 address 的處理
- 同一介面上 IPv4 和 IPv6 routing 的 metric 獨立性
- 6in4 tunnel 的 TTL 遞減行為
- DHCPv4 與 DHCPv6 在同一介面上的競態

### MPLS
- label stack 深度超過硬體支援（通常 3-4 層）
- TTL propagation 在 PHP（Penultimate Hop Popping）時的行為
- LDP session 建立時的 loop detection
- MPLS 與 IP ACL 的互動（IP lookup 發生在 label swap 前後？）

---

## QoS

### 分類與標記
- DSCP 值重標記後，下游設備的信任策略衝突
- 802.1p CoS 與 DSCP 的對應表差異（不同廠商預設不同）
- trust boundary 設定遺漏時的行為（通常 untrust = 標記為 BE）

### 佇列與調度
- 嚴格優先佇列（SP）中高優先流量完全佔用導致低優先飢餓
- WFQ/DWRR weight 加總超過 100% 的正規化行為
- token bucket burst size 設為 0 的邊界行為
- 佇列滿溢時的 tail drop vs WRED 的 ECN 標記

### 速率限制
- policer 在 line-rate burst 時的 conforming/exceeding/violating action
- 雙向速率限制（ingress + egress）的互動
- sub-interface 上的速率限制是否吃到 parent interface 的上限

---

## 高可用性（HA / Failover）

### Redundancy
- active/standby 切換時的 in-flight 封包處理
- hitless failover 的狀態同步完整性（routing table、session table、ARP cache）
- split-brain 情境的處理（兩台同時認為自己是 active）
- failover 觸發條件（心跳遺失次數）的邊界值

### NSF / NSR / GR
- Graceful Restart 的 restart time 超時後的 neighbor 行為
- NSR 同步中收到 topology change 的處理
- helper mode 設備對 GR peer 的 stale route 保留時間

---

## 安全與異常封包

### ACL
- ACL 規則數量上限（TCAM 容量）
- implicit deny 的 logging 行為（高流量時 CPU 影響）
- ACL 套用順序（inbound vs outbound）的遞迴影響
- IPv6 ACL 與 IPv4 ACL 共用 TCAM 時的資源競爭

### 惡意/異常封包
- 超大封包（>MTU）的分片或 drop 行為
- TTL=0 或 TTL=1 的封包處理（是否 punt to CPU）
- IP options 欄位非零的封包（通常 punt to CPU，可能成為 DoS 向量）
- TCP SYN flood 對 control plane 的影響
- 廣播風暴的 CPU protect 機制閾值

---

## 管理平面

### 設定並發
- CLI 和 NETCONF/RESTCONF 同時修改同一設定的行為
- commit 操作的 transaction isolation level
- 設定 rollback 時的部分失敗處理

### SNMP / Telemetry
- SNMP trap 在高頻事件下的 rate limiting
- gRPC streaming telemetry 在 session 斷線後的資料遺失窗口
- OID 不存在時的 GET response（noSuchObject vs noSuchInstance）

---

## 硬體特性邊界

### 記憶體
- TCAM 容量上限（通常 4K-512K 條目）達到時的 overflow 行為（software forwarding fallback？drop？）
- FIB（Forwarding Information Base）與 RIB 不同步時的 traffic black hole
- ARP/ND cache 滿溢時的處理（oldest entry eviction vs error）

### CPU Punt
- punt 到 CPU 的封包類型清單（control plane packets）
- CoPP（Control Plane Policing）未設定時的 CPU 保護機制
- 高速 punt 流量下的 control protocol（BGP、OSPF）飢餓

---

## 排程服務（Scheduler Service）

### 部署環境邊界條件

| 設備類型 | 邊界條件 | 觸發情境 |
|---------|---------|---------|
| AP / 邊緣設備 | RAM 耗盡導致 Scheduler 被 OOM kill | 任務積壓過多，queue 佔用記憶體超過系統可用量 |
| AP / 邊緣設備 | Flash 寫入壽命限制 | Persistent queue 頻繁寫入，縮短 NAND flash 使用壽命 |
| Switch / Gateway | Scheduler CPU 使用率影響 data plane | 大量任務同時觸發，control plane CPU 被佔用，轉發效能下降 |
| Controller | 管理大量設備時的 task fan-out | 同時對 500 台設備下發任務，造成 Controller 端的 scheduling storm |
| 雲端部署 | 網路延遲影響 time-based 排程精度 | RTT 100ms+ 時，「每秒執行一次」的任務實際執行間隔不準確 |
| 混合部署 | Controller 失聯時的本地自主行為 | WAN 斷線，本地 Scheduler 繼續跑，Controller 恢復後任務狀態如何同步 |

### 任務生命週期邊界條件

| 類別 | 邊界條件 | 觸發情境 |
|------|---------|---------|
| Reboot recovery | 設備重開機時 in-flight 任務的狀態 | 任務執行到一半設備斷電，重開後是重跑、跳過，還是標記為 failed |
| 時序衝突 | 定時任務與事件任務同時觸發 | 每小時備份與介面 down 事件在同一秒觸發，queue 競爭資源 |
| 任務超時 | 任務執行時間超過預期上限 | 備份任務因設定量大而跑超時，佔用 queue 導致後續任務全部延誤 |
| 重複執行 | 同一任務被觸發兩次（重連後 Controller 重送） | Controller 斷線重連後，對本地已執行完的任務重新下發，產生重複執行 |
| Clock skew | 設備時間與 Controller 時間不同步 | NTP 未同步時，time-based 任務的執行時間點偏差，影響審計 log 的時序正確性 |
