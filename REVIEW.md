# USV Cloud MVP 代码审查报告

**审查日期**: 2026-06-12  
**项目路径**: `C:\Users\Lenovo\Documents\USV`  
**技术栈**: Node.js + TypeScript + Vue 3 + Vite + SQLite (better-sqlite3) + WebSocket (ws)  
**项目规模**: 后端 ~2300 行 (index.ts) + ~925 行 (mavlink.ts) + ~434 行 (eventLog.ts) + ~328 行 (captureStore.ts) + ~112 行 (state.ts) + ~335 行 (simulate-usv.ts)，前端 ~1500 行 (App.vue) + ~1322 行 (styles.css)

---

## 一、项目概述

单船无人船云端 MVP 系统，主要功能：

- UDP `0.0.0.0:14550` 接收 MAVLink2 遥测数据
- 自动注册单船（按 `system_id`），记录 4G/NAT UDP 远端地址
- 解析 HEARTBEAT、SYS_STATUS、GPS_RAW_INT、GLOBAL_POSITION_INT、VFR_HUD、BATTERY_STATUS、STATUSTEXT 等消息
- WebSocket 实时推送遥测状态
- 手动遥控（油门/转向）、解锁/上锁/急停
- 航线规划与上传（支持多航点、循环执行、拍照采集点）
- 返航点设置与低电压自动返航
- GPS/RTK 诊断日志
- 拍照采集管理（树莓派 WebSocket 对接）
- SQLite 事件日志与遥测采样存储

---

## 二、安全问题

### 2.1 天地图 API Key 硬编码

**文件**: `client/src/App.vue:151`  
**严重性**: 中  
**描述**: 天地图 API Key `2a260b5417d4aef7010aae54dbd8ae49` 直接硬编码在前端源码中。如果该 Key 有调用量限制或计费，被公开后可能被盗用。  
**建议**: 通过 Vite 环境变量（`import.meta.env.VITE_TIANDITU_KEY`）注入，构建时从 `.env` 文件读取。

### 2.2 WebSocket 无认证机制

**文件**: `server/src/index.ts:1786-1894`  
**严重性**: 中  
**描述**: `/ws`（前端控制台）和 `/api/pi/ws`（树莓派）两个 WebSocket 端点均无任何认证。任何能访问该端口的客户端均可：
- 通过 `/ws` 发送遥控指令（解锁、急停等）
- 通过 `/api/pi/ws` 注册为树莓派端，接收采集计划

**建议**: MVP 阶段若部署在内网可暂不处理，但上线前应增加 Token 或密钥认证。

### 2.3 CORS 配置过于宽松

**文件**: `server/src/index.ts:2237-2241`  
**严重性**: 低  
**描述**: 所有 HTTP 响应均设置 `Access-Control-Allow-Origin: *`，允许任意来源跨域访问 API。  
**建议**: 生产环境应限制为具体域名。

### 2.4 HTTP API 缺少速率限制

**文件**: `server/src/index.ts:1674-1784`  
**严重性**: 低  
**描述**: 所有 HTTP API 端点无速率限制，恶意客户端可高频调用 `/api/mission/upload` 等接口干扰正常操作。  
**建议**: 对控制类 API 增加简单的速率限制。

---

## 三、Bug 与正确性问题

### 3.1 航线上传竞态条件

**文件**: `server/src/index.ts:1283-1322`  
**严重性**: 高  
**描述**: `uploadMission()` 函数中，`missionUploadInProgress` 标志在 `setTimeout`（300ms 延迟）回调内才设为 `true`（第 1314 行）。在此 300ms 窗口期内：
- `missionUploadInProgress` 仍为 `false`
- 如果客户端再次调用上传，`if (pendingMissionItems !== missionItems)` 守卫无法阻止（因为是不同请求）

这可能导致两次上传同时进行，飞控收到混乱的航点数据。

**建议**: 在 `uploadMission()` 入口处立即检查并设置 `missionUploadInProgress`，或使用锁机制。

### 3.2 MAVLink CRC 校验对未知消息类型跳过

**文件**: `server/src/mavlink.ts:486-489`  
**严重性**: 高  
**描述**: `validateChecksum` 函数中，当 `CRC_EXTRA` Map 不包含某消息 ID 时，直接返回 `true`（跳过校验）：

```typescript
function validateChecksum(dataWithoutMagic: Buffer, messageId: number, expected: number): boolean {
  const extra = CRC_EXTRA.get(messageId);
  if (extra === undefined) return true; // ← 未知消息直接通过
  return calculateChecksum(dataWithoutMagic, extra) === expected;
}
```

`CRC_EXTRA` Map 仅包含 22 种消息类型，但 MAVLink2 协议有数百种。对于未注册的消息（如 ATTITUDE=30），损坏的数据包也会被当作有效帧处理。

**建议**: 对未知消息 ID 要么拒绝（返回 `false`），要么至少执行无 extra 的基础 CRC 校验。

### 3.3 WebSocket 消息缺少输入验证

**文件**: `server/src/index.ts:1796-1847`  
**严重性**: 中  
**描述**: WebSocket 消息处理器直接使用 `as` 类型断言，未验证字段存在性和类型：

```typescript
const data = message.data as Partial<ManualControlInput>;
sendManualControl({
  throttle: Number(data?.throttle ?? 0),  // Number(undefined) → NaN
  steering: Number(data?.steering ?? 0)
});
```

当客户端发送 `{ "type": "manual.control", "data": { "throttle": "abc" } }` 时，`Number("abc")` 返回 `NaN`，虽然 `buildManualControl` 内有 `clamp` 兜底，但这种依赖隐式行为的方式不够健壮。

**建议**: 在入口处增加基本的类型/范围校验。

### 3.4 `setHomeFromInput` altitude 兜底为 0

**文件**: `server/src/index.ts:899-946`  
**严重性**: 中  
**描述**: 当客户端设置返航点时未提供 altitude，且飞控未上报 GPS 海拔时，`syncHomeToAutopilot` 会向飞控发送 altitude=0（第 942 行：`home.altitude ?? state.gpsAltitude ?? 0`）。对于水上无人船，海拔 0 可能是合理的，但应明确告知用户。

### 3.5 `buildManualControl` 油门字段双重映射

**文件**: `server/src/mavlink.ts:182-195`  
**严重性**: 低（需实船验证）  
**描述**: `MANUAL_CONTROL` 消息中，`x`（前后，字节 0）和 `z`（油门，字节 4）都被设为 `throttle * 1000`。README 中说明 `x` 是前后控制、`z` 是油门，但两者值相同。不同 PX4 参数配置可能对这两个字段有不同解释。

**建议**: 实船联调时确认，必要时拆分为独立控制通道。

### 3.6 HTTP 请求体解析无大小限制

**文件**: `server/src/index.ts:2190-2194`  
**严重性**: 中  
**描述**: `readRawBody` 函数将整个请求体读入内存，无大小限制：

```typescript
async function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
```

恶意客户端可发送超大请求体耗尽服务器内存。

**建议**: 增加 `Content-Length` 检查或流式读取时限制总字节数。

---

## 四、架构与可维护性

### 4.1 `index.ts` 文件过大（2309 行）

**文件**: `server/src/index.ts`  
**严重性**: 中（可维护性）  
**描述**: 主入口文件承担了所有职责：
- UDP MAVLink 数据接收与分发
- HTTP API 路由
- WebSocket 连接管理
- 航线上传/下载/执行逻辑
- 拍照采集管理
- GPS/RTK 诊断
- 电压监控与低电压返航
- 返航点管理
- 事件日志记录

**建议**: 按职责拆分为独立模块：
- `httpRouter.ts` — HTTP API 路由
- `missionManager.ts` — 航线上传/下载/执行
- `captureManager.ts` — 采集点管理
- `voltageMonitor.ts` — 电压监控与低电压返航
- `gpsDiagnostics.ts` — GPS/RTK 诊断
- `wsManager.ts` — WebSocket 连接管理

### 4.2 模块级可变状态过多

**文件**: `server/src/index.ts:85-139`  
**严重性**: 中（可维护性）  
**描述**: 约 55 个 `let` 变量在模块顶层作用域，涵盖任务上传状态、读回状态、电压采样、GPS 诊断、返航状态等。这些状态相互耦合，难以追踪变更路径。

**建议**: 将相关状态封装为类或对象，例如 `MissionUploadState`、`VoltageMonitorState`、`ReturnHomeState`。

### 4.3 `App.vue` 组件过大（~1500+ 行）

**文件**: `client/src/App.vue`  
**严重性**: 中（可维护性）  
**描述**: 单个 Vue 组件包含：天地图集成、摇杆控制、WebSocket 通信、航线管理、采集状态、日志查看、电压告警、键盘控制等全部逻辑。

**建议**: 提取为 Vue 组合式函数（composables）：
- `useMap.ts` — 天地图相关逻辑
- `useJoystick.ts` — 摇杆控制
- `useWebSocket.ts` — WS 通信与状态同步
- `useMission.ts` — 航线管理
- `useVoltageAlarm.ts` — 电压告警

### 4.4 Haversine 公式重复实现

**文件**: `server/src/index.ts:1039-1053`、`server/src/simulate-usv.ts:321-335`、`client/src/App.vue:1432-1452`  
**严重性**: 低  
**描述**: 相同的 Haversine 距离计算函数在三个文件中各实现了一份。  
**建议**: 提取为共享工具模块。

### 4.5 未使用的函数

**文件**: `server/src/mavlink.ts:787-814`  
**严重性**: 低  
**描述**: `buildMissionDoJump`（非 Int 变体）已定义但从未被调用，只有 `buildMissionDoJumpInt` 被使用。  
**建议**: 删除未使用的代码。

---

## 五、健壮性与运维

### 5.1 无测试覆盖

**严重性**: 高（长期）  
**描述**: 项目中未发现任何测试文件。以下模块尤其需要单元测试：
- MAVLink 帧解码/编码（`mavlink.ts`）
- 航线项构建逻辑（`buildMissionItems`）
- CRC 校验
- 电压监控阈值判断
- Multipart 请求解析

### 5.2 优雅关闭不完整

**文件**: `server/src/index.ts:1900-1908`  
**严重性**: 低  
**描述**: `shutdown` 函数关闭了 SQLite 数据库后直接 `process.exit(0)`，但未关闭 HTTP 服务器（`httpServer.close()`），活跃的 HTTP/WS 连接会被强制断开。

### 5.3 事件日志写入失败静默吞掉

**文件**: `server/src/eventLog.ts:151-173`、`176-203`  
**严重性**: 低  
**描述**: `logEvent` 和 `logTelemetry` 中的异常仅 `console.warn`，不抛出。SQLite 写入持续失败时运维人员可能无法及时发现。  
**建议**: 增加失败计数器或定期告警。

### 5.4 遥测采样间隔冗余

**文件**: `server/src/index.ts:1910-1921`、`1943-1946`  
**严重性**: 低  
**描述**: 主循环每 250ms 运行一次，但 `sampleTelemetry` 内部限速为 1 秒一次。250ms 的 3/4 是无用检查。  
**建议**: 将遥测采样独立为 1 秒间隔的 `setInterval`。

---

## 六、代码风格

### 6.1 无 ESLint / Prettier 配置

**描述**: 项目中未发现 `.eslintrc`、`.prettierrc` 等代码风格配置文件。  
**建议**: 添加统一的代码风格配置，确保团队协作时风格一致。

### 6.2 TypeScript 严格模式未启用

**文件**: `server/tsconfig.json`  
**描述**: 未确认是否启用了 `strict: true`。多处 `as` 类型断言暗示可能未开启严格空值检查。  
**建议**: 启用 `strict: true` 并逐步修复类型错误。

---

## 七、总结

| 类别 | 高严重性 | 中严重性 | 低严重性 |
|------|---------|---------|---------|
| 安全 | 0 | 2 | 2 |
| Bug/正确性 | 2 | 3 | 1 |
| 架构/可维护性 | 0 | 3 | 2 |
| 健壮性/运维 | 1 | 0 | 3 |
| 代码风格 | 0 | 0 | 2 |
| **合计** | **3** | **8** | **10** |

### 优先修复建议

1. **P0 — 立即修复**:
   - MAVLink CRC 校验漏洞（3.2）— 可能导致损坏数据被误处理
   - 航线上传竞态条件（3.1）— 可能导致航点数据混乱

2. **P1 — 尽快修复**:
   - WebSocket 消息输入验证（3.3）
   - HTTP 请求体大小限制（3.6）
   - 天地图 Key 硬编码（2.1）

3. **P2 — 迭代优化**:
   - `index.ts` 拆分（4.1）
   - `App.vue` 拆分（4.3）
   - 添加测试（5.1）
   - WebSocket 认证（2.2）

4. **P3 — 低优先级**:
   - 删除未使用代码（4.5）
   - 代码风格配置（6.1）
   - 优雅关闭完善（5.2）
