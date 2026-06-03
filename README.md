# USV Cloud MVP

单船无人船云端 MVP：免登录、UDP MAVLink2 接入、自动注册、实时遥测、电压显示、WebSocket 前端控制台、基础手动遥控。

## 端口

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| 14550 | UDP | 船端 MAVLink2 上报与云端控制回发 |
| 4000 | TCP | 后端 HTTP API + WebSocket |
| 5173 | TCP | Vite 前端开发服务 |

服务器安全组和系统防火墙至少需要开放 `UDP 14550`。前端对外访问时还需要开放 `TCP 5173`，或生产部署时开放 `TCP 4000/80/443`。

## 启动

```powershell
npm install
npm run dev
```

访问：

```text
http://127.0.0.1:5173
```

船端配置为持续向服务器发送 MAVLink2：

```text
udp://<服务器公网IP>:14550
```

## 本地模拟

没有真船时，可以用模拟器向后端发送 MAVLink2 心跳、位置和电压：

```powershell
npm run simulate
```

可选环境变量：

```powershell
$env:SIM_HOST="127.0.0.1"
$env:SIM_PORT="14550"
$env:SIM_SYS_ID="1"
npm run simulate
```

## 已实现

- UDP `0.0.0.0:14550` 接收 MAVLink2。
- 收到 `HEARTBEAT` 后按 `system_id` 自动注册单船，如 `USV-SYS-1`。
- 自动记录最近一次 4G/NAT UDP remote 地址，控制指令回发到该地址。
- 解析 `HEARTBEAT`、`SYS_STATUS`、`GLOBAL_POSITION_INT`、`VFR_HUD`、`BATTERY_STATUS`、`STATUSTEXT`。
- 前端显示在线状态、模式、解锁状态、经纬度、速度、航向、电压、电量。
- WebSocket 实时推送状态。
- WebSocket 手动遥控：油门、转向。
- 基础控制：解锁、上锁、急停。
- 遥控安全保护：停止输入 500ms 自动发送零控制，WebSocket 断开自动归零，离线禁止控制。

## API

```text
GET  /api/state
POST /api/control
WS   /ws
```

`POST /api/control` 示例：

```json
{ "action": "manual", "throttle": 0.4, "steering": -0.2 }
```

```json
{ "action": "arm" }
```

```json
{ "action": "emergencyStop" }
```

## 注意

当前 `MANUAL_CONTROL` 的映射为：

- `x`: 前后控制，范围 `-1000..1000`
- `z`: 油门，范围 `0..1000`
- `r`: 转向，范围 `-1000..1000`

不同 PX4 船控参数可能对手动输入源有要求。实船联调时如果 PX4 不响应 `MANUAL_CONTROL`，下一步应切换或补充 `RC_CHANNELS_OVERRIDE` 方案。
