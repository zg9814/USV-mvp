# 树莓派拍照模块对接说明

本文档面向树莓派摄像头硬件及嵌入式工程师，用于对接 USV 云端的航点拍照功能。

## 1. 系统目标

云端负责规划航线、生成拍摄计划、接收照片、校验缺图并下发补传指令。

飞控只负责按航线行驶，并在拍照航点通过 AUX/继电器信号通知树莓派开始拍照。飞控不等待云端确认，也不会因为照片缺失暂停任务。

树莓派负责：

- 监听飞控 AUX 触发信号。
- 在本地完成拍摄和缓存。
- 通过 WebSocket 从云端获取当前拍摄计划。
- 按 `deviceId + captureDate + pointIndex + photoIndex` 上传照片。
- 接收云端补传指令，并重传本地缓存照片。

## 2. 当前云端地址

本地开发环境示例：

```text
HTTP:      http://127.0.0.1:4100
Pi WS:     ws://127.0.0.1:4100/api/pi/ws
Upload:    http://127.0.0.1:4100/api/captures/upload
```

云端生产环境示例：

```text
HTTP:      http://123.207.218.215:4100
Pi WS:     ws://123.207.218.215:4100/api/pi/ws
Upload:    http://123.207.218.215:4100/api/captures/upload
```

目前第一版没有用户认证，树莓派可以直接连接以上接口。后续若增加认证，会另行补充 token 或签名字段。

## 3. 航点与拍摄计划

前端规划航线时，每个航点可以设置为拍照点。拍照点包含：

| 字段 | 含义 | 默认值 |
| --- | --- | --- |
| `captureEnabled` | 是否拍照点 | `false` |
| `pointIndex` | 当天拍照点序号，由树莓派按 AUX 触发次数递增 | 从 `1` 开始 |
| `expectedPhotoCount` | 该点预计照片数量 | `10` |
| `captureStepDeg` | 每张照片的角度间隔 | `36` |
| `waitSeconds` | 船在该航点停留时间 | 拍照点默认 `60` 秒 |

树莓派上传照片不再依赖 `missionId`。每次 AUX 触发表示当天一个新的拍照点，树莓派按 `pointIndex=1,2,3...` 标记点位，并用 `captureDate=YYYYMMDD` 标记拍摄日期。

云端唯一键为：

```text
deviceId + captureDate + pointIndex + photoIndex
```

重复上传同一唯一键会覆盖原记录，不会产生重复照片记录。

## 4. 飞控 AUX 触发

拍照航点在飞控任务中会生成以下任务项：

1. `NAV_WAYPOINT`，包含 `waitSeconds`，用于让船在拍照点附近停留。
2. `MAV_CMD_DO_SET_RELAY = 181`，`param1=relay`、`param2=1`，将 Relay/AUX 拉高。
3. `MAV_CMD_CONDITION_DELAY = 112`，延迟 `CAPTURE_AUX_PULSE_SECONDS` 秒。
4. `MAV_CMD_DO_SET_RELAY = 181`，`param1=relay`、`param2=0`，将 Relay/AUX 拉低。

因此自动航线拍照点和前端“触发拍摄”测试按钮现在都使用“拉高 -> 延迟 -> 拉低”的脉冲语义。事件日志中可看到：

```text
MISSION_AUX_CAPTURE_HIGH
MISSION_AUX_CAPTURE_DELAY
MISSION_AUX_CAPTURE_LOW
```

当前默认参数：

| 配置项 | 默认值 | 说明 |
| --- | ---: | --- |
| `CAPTURE_AUX_RELAY` | `0` | 使用的 relay 编号 |
| `CAPTURE_AUX_PULSE_SECONDS` | `1` | 期望触发脉冲秒数 |

嵌入式侧建议将 AUX/继电器信号作为“开始拍摄当前点位”的边沿触发信号处理。树莓派不应依赖云端实时确认后再拍摄。

注意：不同 ArduPilot 版本对 mission 中的 `CONDITION_DELAY` 和后续 DO 命令执行顺序可能存在差异。若手动“触发拍摄”正常而自动航线仍不能触发，应同时检查飞控任务 readback 是否包含 `HIGH/DELAY/LOW` 三段、AUTO 任务是否执行到该拍照点、以及实际 AUX/Relay 口是否有电平变化。

## 5. 树莓派 WebSocket 协议

连接地址：

```text
ws://<server>:4100/api/pi/ws
```

所有 WebSocket 消息统一为 JSON：

```json
{
  "type": "message.type",
  "data": {}
}
```

### 5.1 注册

树莓派连接后应立即发送：

```json
{
  "type": "pi.register",
  "data": {
    "deviceId": "usv-001",
    "piId": "pi-camera-001",
    "firmwareVersion": "0.1.0",
    "cameraCount": 1
  }
}
```

云端返回：

```json
{
  "type": "pi.registered",
  "data": {
    "deviceId": "usv-001",
    "currentMissionId": "m-20260612-142233-abc123"
  }
}
```

随后云端会发送当前拍摄计划：

```json
{
  "type": "capture.plan",
  "data": {
    "missionId": null,
    "deviceId": "usv-001",
    "captureDate": "20260616",
    "points": [
      {
        "plan": {
          "device_id": "usv-001",
          "capture_date": "20260616",
          "point_index": 1,
          "expected_photo_count": 10,
          "capture_step_deg": 36,
          "status": "receiving"
        },
        "received": 0,
        "missing": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        "complete": false
      }
    ]
  }
}
```

树莓派上传照片时不需要等待该计划存在。云端收到照片后会按上传字段自动创建点位。

### 5.2 心跳

建议树莓派每 5 到 10 秒发送一次：

```json
{
  "type": "pi.heartbeat",
  "data": {
    "deviceId": "usv-001",
    "piId": "pi-camera-001",
    "time": "2026-06-12T06:30:00.000Z",
    "diskFreeMb": 20480,
    "queueLength": 0
  }
}
```

云端返回：

```json
{
  "type": "pi.heartbeat",
  "data": {
    "ok": true
  }
}
```

### 5.3 拍摄状态上报

树莓派收到 AUX 触发并开始拍照时，建议上报：

```json
{
  "type": "capture.status",
  "data": {
    "deviceId": "usv-001",
    "captureDate": "20260616",
    "pointIndex": 1,
    "status": "shooting"
  }
}
```

拍完但还在上传时：

```json
{
  "type": "capture.status",
  "data": {
    "deviceId": "usv-001",
    "captureDate": "20260616",
    "pointIndex": 1,
    "status": "uploading"
  }
}
```

云端返回该点当前完整性：

```json
{
  "type": "capture.status",
  "data": {
    "ok": true,
    "status": {
      "received": 3,
      "missing": [4, 5, 6, 7, 8, 9, 10],
      "complete": false
    }
  }
}
```

状态值建议：

| 状态 | 含义 |
| --- | --- |
| `shooting` | 正在拍摄 |
| `uploading` | 正在上传 |
| `idle` | 空闲 |
| `error` | 树莓派拍摄或上传异常 |

云端自身还会使用：

| 状态 | 含义 |
| --- | --- |
| `planned` | 已生成计划，尚未收到活动 |
| `receiving` | 已收到照片 |
| `reupload_requested` | 已请求补传 |
| `complete` | 该点照片齐全 |
| `incomplete` | 多次补传后仍缺图 |

### 5.4 补传指令

云端从收到第一张照片或收到 `capture.status` 后开始计时。默认 180 秒后检查该点照片是否完整。若缺图，会向树莓派发送：

```json
{
  "type": "capture.reupload",
  "data": {
    "deviceId": "usv-001",
    "captureDate": "20260616",
    "pointIndex": 1,
    "missing": [3, 7, 10]
  }
}
```

树莓派收到后，应从本地缓存中找到对应照片并重新上传。补传完成后建议上报：

```json
{
  "type": "capture.reupload.result",
  "data": {
    "deviceId": "usv-001",
    "captureDate": "20260616",
    "pointIndex": 1,
    "uploaded": [3, 7],
    "failed": [10],
    "message": "photo 10 missing on local storage"
  }
}
```

云端默认最多请求 3 次补传。3 次后仍缺图，会将该点标记为 `incomplete`，但不影响飞控继续任务。

## 6. 照片上传接口

接口：

```text
POST /api/captures/upload
Content-Type: multipart/form-data
```

字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `deviceId` | 是 | 船/设备 ID，例如 `usv-001` |
| `captureDate` | 是 | 拍摄日期，格式 `YYYYMMDD`，例如 `20260616` |
| `pointIndex` | 是 | 当天第几个拍照点，从 `1` 开始 |
| `photoIndex` | 是 | 当前点第几张照片，从 `1` 到 `10` |
| `angleDeg` | 否 | 该照片对应角度 |
| `takenAt` | 否 | 拍摄时间，建议 UTC ISO 字符串 |
| `sizeBytes` | 否 | 图片大小；云端以实际文件大小为准 |
| `file` | 是 | 图片文件 |

示例：

```bash
curl -X POST "http://123.207.218.215:4100/api/captures/upload" \
  -F "deviceId=usv-001" \
  -F "captureDate=20260616" \
  -F "pointIndex=1" \
  -F "photoIndex=7" \
  -F "angleDeg=0" \
  -F "takenAt=2026-06-16T06:30:12.000Z" \
  -F "sizeBytes=123456" \
  -F "file=@/home/pi/photos/usv-001/20260616/1/007.jpg"
```

成功返回：

```json
{
  "code": 200,
  "data": {
    "deviceId": "usv-001",
    "captureDate": "20260616",
    "pointIndex": 1,
    "received": 1,
    "missing": [1, 2, 3, 4, 5, 6, 8, 9, 10],
    "complete": false
  }
}
```

常见错误：

| HTTP | message | 原因 |
| ---: | --- | --- |
| 400 | `multipart boundary missing` | 请求不是标准 multipart |
| 400 | `image file missing` | 没有上传文件字段 |
| 400 | `photoIndex missing or invalid` | 缺少照片序号 |

同一个 `deviceId + captureDate + pointIndex + photoIndex` 重复上传时，云端会覆盖该序号对应的图片元数据和文件路径。

为了便于摄像头单独联调，云端不会因为没有预先创建拍摄计划而拒绝照片。没有对应点位时会自动创建 `expectedPhotoCount=10`、`captureStepDeg=36`、`status=receiving` 的点位记录并保存原图。

生产环境中，`4100` 上的 USV 云端会先保存照片、入库、触发 AI 识别，然后将同一份 multipart 上传请求转发到 `127.0.0.1:8088/api/captures/upload`。树莓派只需要上传到 `123.207.218.215:4100`，不要直接连 `8088`。

## 6.1 AI 识别

云端收到照片后会根据“AI 识别过滤”开关决定是否自动排队识别排口：

- 开启：保存原图后创建识别任务，使用云端模型进行 CPU 推理。
- 关闭：只保存原图和元数据，不创建识别任务。

当前生产模型：

```text
/opt/usv-cloud-mvp/models/outfall_yolov8s.pt
```

当前生产参数：

```text
confidence = 0.50
iou = 0.45
device = cpu
```

树莓派不需要调用模型接口，只需要上传照片。

## 7. 查询接口

### 7.1 查询当前拍摄计划

```text
GET /api/capture-plan/current?deviceId=usv-001
```

返回：

```json
{
  "code": 200,
  "data": {
    "missionId": null,
    "deviceId": "usv-001",
    "captureDate": "20260616",
    "points": []
  }
}
```

### 7.2 查询照片完整性

```text
GET /api/captures?deviceId=usv-001&captureDate=20260616
```

返回：

```json
{
  "code": 200,
  "data": {
    "missionId": null,
    "deviceId": "usv-001",
    "captureDate": "20260616",
    "points": [
      {
        "received": 8,
        "missing": [4, 9],
        "complete": false,
        "plan": {
          "capture_date": "20260616",
          "point_index": 1,
          "expected_photo_count": 10,
          "status": "reupload_requested",
          "reupload_attempts": 1
        },
        "images": []
      }
    ]
  }
}
```

### 7.3 查看原图

```text
GET /api/captures/:id/original
```

其中 `:id` 来自 `capture_images.id`。

## 8. 树莓派本地建议实现

### 8.1 本地缓存目录

建议按以下结构保存：

```text
/data/usv-captures/
  usv-001/
    20260616/
      point-001/
        001.jpg
        002.jpg
        ...
      point-002/
      001.jpg
      002.jpg
```

照片文件名建议使用三位序号，便于补传：

```text
001.jpg, 002.jpg, 003.jpg ...
```

### 8.2 拍摄序号规则

每个拍照点内，`photoIndex` 从 `1` 开始，到 `expectedPhotoCount` 结束。

例如：

```text
captureDate = 20260616
pointIndex = 2
expectedPhotoCount = 10
photoIndex = 1..10
```

如果按 360 度环拍，角度可按以下方式生成：

```text
angleDeg = (photoIndex - 1) * captureStepDeg
```

默认 `captureStepDeg = 36`，即 10 张覆盖 0 到 324 度。

### 8.3 推荐工作流

1. 树莓派开机后连接 `ws://<server>:4100/api/pi/ws`。
2. 发送 `pi.register`。
3. 保存云端下发的 `capture.plan`。
4. 持续发送 `pi.heartbeat`。
5. 检测到飞控 AUX 触发。
6. 将本次 AUX 触发计为当天当前 `pointIndex`。
7. 上报 `capture.status = shooting`。
8. 拍摄 `expectedPhotoCount` 张照片，并保存到本地。
9. 上报 `capture.status = uploading`。
10. 逐张调用 `/api/captures/upload` 上传。
11. 若收到 `capture.reupload`，从本地缓存重传 `missing` 中指定的照片。

云端前端“摄像头测试”页提供单独高电平触发按钮。该按钮不会控制相机或电机，只会向船控发送一次 Relay 高电平脉冲，便于在不跑完整航线时验证树莓派是否能被船控触发。

如果当前不跑航线任务，也可以直接按 `deviceId + captureDate + pointIndex + photoIndex` 上传照片。云端会自动创建当天点位记录。

## 9. 关键容错要求

树莓派侧必须满足：

- 网络断开时，照片不能丢失，应继续保存在本地。
- WebSocket 断开后自动重连，并重新发送 `pi.register`。
- HTTP 上传失败时应进入本地重试队列。
- 收到 `capture.reupload` 时，只重传云端指定的 `photoIndex`。
- 即使云端不可用，AUX 触发后也要完成本地拍摄。
- 不要因为某张照片上传失败阻塞下一张照片拍摄。
- 不要因为补传失败影响飞控任务。

## 10. 云端补传参数

当前云端默认：

| 配置项 | 默认值 | 说明 |
| --- | ---: | --- |
| `CAPTURE_UPLOAD_CHECK_DELAY_SECONDS` | `180` | 收到首张照片或状态上报后，延迟多久检查完整性 |
| `CAPTURE_REUPLOAD_MAX_ATTEMPTS` | `3` | 最多补传请求次数 |

补传检查每 30 秒运行一次。

## 11. 联调测试清单

### 11.1 WebSocket

- 树莓派能连接 `/api/pi/ws`。
- 发送 `pi.register` 后收到 `pi.registered`。
- 能收到 `capture.plan`。
- 断网恢复后能自动重连并重新获取计划。

### 11.2 AUX 触发

- 手动“触发拍摄”时，树莓派能检测到约 `CAPTURE_AUX_PULSE_SECONDS` 秒的高电平脉冲。
- 拍照航点到达后，树莓派也能检测到飞控 AUX/relay 脉冲。
- 事件日志中自动任务应出现 `MISSION_AUX_CAPTURE_HIGH`、`MISSION_AUX_CAPTURE_DELAY`、`MISSION_AUX_CAPTURE_LOW`。
- 单次触发只启动一次该点拍摄。
- 抖动或重复电平不会导致重复拍摄同一个点位。

### 11.3 上传

- 按 `deviceId + captureDate + pointIndex + photoIndex` 上传图片成功。
- 云端前端“拍摄记录”中能看到已收数量增加。
- 点击原图链接能打开图片。

### 11.4 缺图补传

- 故意漏传第 3、7 张。
- 等待云端补传检查。
- 树莓派收到：

```json
{
  "type": "capture.reupload",
  "data": {
    "missing": [3, 7]
  }
}
```

- 树莓派重传后，云端状态变为 `complete`。

### 11.5 断网缓存

- 拍照期间断开树莓派网络。
- 树莓派继续本地拍摄和保存。
- 网络恢复后自动上传积压照片。
- 云端最终能补齐该点照片。

## 12. 第一版暂不包含

- 图片水印。
- 报告导出。
- 对象存储。
- 多船多用户认证隔离。
- 云端要求飞控等待照片确认。

## 13. 对接风险点

1. `capturePointIndex` 的识别  
   树莓派只收到 AUX 触发信号，本身不知道飞控当前航点序号。第一版建议按触发次数匹配拍摄计划：第 1 次 AUX 对应 `capturePointIndex=1`，第 2 次对应 `2`。如果后续需要更强校验，可以让树莓派同时监听 MAVLink `MISSION_CURRENT`。

2. Relay 脉冲兼容性  
   云端自动任务已经生成 `HIGH -> DELAY -> LOW` 三段任务项，但实际输出仍取决于飞控参数、AUX/Relay 映射和 AUTO mission 对 DO/CONDITION 命令的支持。嵌入式侧仍应做边沿检测和防抖。

3. 时间同步  
   `takenAt` 建议使用 UTC ISO 时间。树莓派应开启 NTP 或从网络时间校准。

4. 本地存储  
   照片必须先落本地再上传，避免 4G 网络抖动导致原图丢失。

5. 重复上传  
   云端允许同一 `photoIndex` 重复上传并覆盖。树莓派可以安全重试，但应避免同一照片无限重试占满网络。
