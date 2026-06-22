# 变更记录

## 2026-06-12

### 新增：摄像头高电平单独触发测试

- 照片上传归档改为 `deviceId + captureDate + pointIndex + photoIndex`，不再依赖 `missionId`；重复上传同一照片序号会覆盖原记录。
- 树莓派补传指令改为下发 `deviceId`、`captureDate`、`pointIndex` 和 `missing`。
- 摄像头测试页拍摄记录显示改为 `date=YYYYMMDD point=N photo=M`。
- 新增 `POST /api/camera/trigger`，向飞控单独发送 Relay 高电平并自动拉低。
- 前端新增“摄像头测试”页，可触发拍摄并查看 10 张照片上传验收状态。
- 事件日志新增 `capture/manual_trigger_high` 和 `capture/manual_trigger_low`。
- 新增 `POST /api/capture-plan/test`，支持不发飞控任务时创建临时拍摄计划用于树莓派上传测试。
- 新增 `GET /api/pi/status`，摄像头测试页显示树莓派在线、Pi ID、最近注册、心跳和消息。
- 照片上传改为宽松接收：没有 `missionId` 或没有预建拍摄计划时也保存图片，并自动创建接收计划。

### 修复：树莓派 WebSocket 路径接入

- 修复浏览器 `/ws` 和树莓派 `/api/pi/ws` 同时挂载在同一 HTTP 服务时，`/api/pi/ws` 被错误返回 400 的问题。
- WebSocket upgrade 现在按路径手动分发，浏览器控制 WS 和树莓派 WS 可以同时工作。

### 新增：拍照航点与树莓派异步上传

- 航点模型增加拍照点配置：
  - `captureEnabled`
  - `capturePointIndex`
  - `expectedPhotoCount`
  - `captureStepDeg`
  - `waitSeconds`
- 拍照点任务打包为 `NAV_WAYPOINT(waitSeconds)` + AUX relay 触发项。
- 新增 `missionId` 和拍摄计划。
- 新增 SQLite 表：
  - `capture_plans`
  - `capture_images`
- 新增树莓派 WebSocket：
  - `/api/pi/ws`
- 新增照片上传：
  - `POST /api/captures/upload`
- 新增缺图补传：
  - `capture.reupload`
- 前端新增拍照点配置和拍摄记录区域。
- 新增树莓派拍照模块对接文档。

### 新增：项目文档基线

- 修复 README 乱码。
- 新增文档索引、架构、API、部署、运维、测试、变更记录。

## 已有能力基线

- UDP MAVLink2 单船接入。
- 前端实时控制台。
- 手动控制、解锁/上锁、急停、模式切换、飞控软重启。
- 航线任务上传、开始、暂停、继续、清空、反读。
- 航点等待时间。
- 自定义 Home、手动返航、任务完成返航、低电压返航。
- 低电压前端全屏报警、静音、最小化。
- SQLite 事件日志和 1 秒遥测采样。
- GPS/RTK 状态变化日志。
