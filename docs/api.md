# API 与 WebSocket

默认服务地址：

```text
http://127.0.0.1:4000
ws://127.0.0.1:4000/ws
ws://127.0.0.1:4000/api/pi/ws
```

生产云端常用端口为 `4100`。

所有 JSON HTTP 响应通常为：

```json
{
  "code": 200,
  "data": {}
}
```

错误响应通常包含：

```json
{
  "code": 400,
  "message": "error message"
}
```

## HTTP API

### 状态

```text
GET /api/state
```

返回当前单船状态，包括遥测、任务、Home、返航、拍摄状态。

### 控制

```text
POST /api/control
Content-Type: application/json
```

支持动作：

```json
{ "action": "manual", "throttle": 0.4, "steering": -0.2 }
```

```json
{ "action": "arm" }
```

```json
{ "action": "disarm" }
```

```json
{ "action": "setMode", "mode": "hold" }
```

```json
{ "action": "emergencyStop" }
```

```json
{ "action": "returnHome" }
```

```json
{ "action": "reboot", "confirmed": true }
```

### Home

```text
GET /api/home
POST /api/home
```

设置 Home：

```json
{
  "lat": 30.1234567,
  "lng": 120.1234567,
  "altitude": 0
}
```

云端会保存到内存，并向飞控发送 `MAV_CMD_DO_SET_HOME=179`。

### 航线任务

```text
GET  /api/mission
POST /api/mission/upload
POST /api/mission/start
POST /api/mission/pause
POST /api/mission/resume
POST /api/mission/clear
POST /api/mission/readback
```

上传任务：

```json
{
  "loopCount": 1,
  "waypoints": [
    {
      "order": 1,
      "lat": 30.1234567,
      "lng": 120.1234567,
      "waitSeconds": 60,
      "captureEnabled": true,
      "expectedPhotoCount": 10,
      "captureStepDeg": 36
    }
  ]
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `lat` / `lng` | 航点坐标 |
| `waitSeconds` | 到达航点后的等待时间，范围 `0..600` 秒 |
| `captureEnabled` | 是否拍照点 |
| `expectedPhotoCount` | 预计照片数量 |
| `captureStepDeg` | 拍照角度步进 |

### 事件日志

```text
GET /api/logs/events?from=&to=&level=&category=&type=&limit=&cursor=
GET /api/logs/telemetry?from=&to=&limit=
GET /api/logs/export.csv?kind=events|telemetry&from=&to=&level=&category=&type=
```

默认查询最近 1 小时。`limit` 默认 200，最大 1000。

事件类别包括：

| category | 说明 |
| --- | --- |
| `service` | 服务启动/停止 |
| `link` | remote endpoint、在线/离线 |
| `control` | 控制指令 |
| `mission` | 航线任务 |
| `home` | Home 设置与 ACK |
| `return_home` | 返航 |
| `power` | 电压告警 |
| `gps` | GPS/RTK 状态变化 |
| `capture` | 拍照任务和图片上传 |

### 拍摄计划和照片

```text
GET /api/capture-plan/current?deviceId=usv-001
POST /api/capture-plan/test
GET /api/pi/status?deviceId=usv-001
GET /api/captures?deviceId=usv-001&captureDate=20260616
POST /api/captures/upload
GET /api/captures/:id/original
POST /api/camera/trigger
```

照片上传详见 [树莓派拍照模块对接说明](raspberry-pi-capture-integration.md)。

创建测试拍摄计划：

```json
{
  "deviceId": "usv-001",
  "expectedPhotoCount": 10,
  "captureStepDeg": 36,
  "waitSeconds": 60
}
```

该接口不写入飞控任务，只创建当天 `pointIndex=1` 的测试点位，用于树莓派直接上传测试照片。

照片上传按 `deviceId + captureDate + pointIndex + photoIndex` 归档并去重覆盖。即使没有预先创建点位，也会自动创建接收点位并保存图片；不再依赖 `missionId` 或 `capturePointIndex`。

上传字段：

| 字段 | 必填 | 示例 |
| --- | --- | --- |
| `deviceId` | 是 | `usv-001` |
| `captureDate` | 是 | `20260616` |
| `pointIndex` | 是 | `2` |
| `photoIndex` | 是 | `7` |
| `angleDeg` | 否 | `216` |
| `takenAt` | 否 | `2026-06-16T06:30:12.000Z` |
| `sizeBytes` | 否 | `123456` |
| `file` | 是 | JPEG 文件 |

查询树莓派连接状态：

```json
{
  "online": true,
  "connectionCount": 1,
  "clients": [
    {
      "piId": "pi-camera-001",
      "deviceId": "usv-001",
      "registeredAt": "2026-06-16T02:00:00.000Z",
      "lastHeartbeatAt": "2026-06-16T02:00:10.000Z",
      "lastMessageType": "pi.heartbeat"
    }
  ],
  "lastOutbound": {
    "type": "capture.plan",
    "sentAt": "2026-06-16T02:00:01.000Z"
  }
}
```

单独触发船控高电平：

```json
{
  "relay": 0,
  "pulseSeconds": 1
}
```

该接口向飞控发送 `MAV_CMD_DO_SET_RELAY=181` 高电平，并在指定秒数后自动拉低，仅用于摄像头链路测试。

## 浏览器 WebSocket

连接：

```text
ws://<server>:<port>/ws
```

浏览器到云端：

| type | data |
| --- | --- |
| `manual.control` | `{ "throttle": 0.4, "steering": -0.2 }` |
| `control.arm` | `{}` |
| `control.disarm` | `{}` |
| `control.emergencyStop` | `{}` |
| `control.returnHome` | `{}` |
| `control.reboot` | `{ "confirmed": true }` |
| `control.setMode` | `{ "mode": "hold" }` |
| `mission.upload` | `{ "waypoints": [], "loopCount": 1 }` |
| `mission.start` | `{}` |
| `mission.pause` | `{}` |
| `mission.resume` | `{}` |
| `mission.clear` | `{}` |

云端到浏览器：

| type | 说明 |
| --- | --- |
| `usv.telemetry` | 实时状态 |
| `home.updated` | Home 状态更新 |
| `home.syncAck` | 飞控 SET_HOME ACK |
| `return.home` | 返航状态 |
| `control.sent` | 控制已发送 |
| `mission.uploaded` | 任务上传完成 |
| `capture.plan` | 拍摄计划 |
| `capture.updated` | 拍摄完整性变化 |
| `error` | 错误消息 |

## 树莓派 WebSocket

连接：

```text
ws://<server>:<port>/api/pi/ws
```

树莓派到云端：

| type | 说明 |
| --- | --- |
| `pi.register` | 注册树莓派 |
| `pi.heartbeat` | 心跳 |
| `capture.status` | 拍摄状态 |
| `capture.reupload.result` | 补传结果 |

云端到树莓派：

| type | 说明 |
| --- | --- |
| `pi.registered` | 注册确认 |
| `pi.heartbeat` | 心跳 ACK |
| `capture.plan` | 当前拍摄计划 |
| `capture.reupload` | 缺图补传指令 |
| `error` | 错误消息 |

详细字段见 [树莓派拍照模块对接说明](raspberry-pi-capture-integration.md)。
