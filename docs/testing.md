# 测试与联调

## 本地构建

每次提交或部署前执行：

```powershell
npm.cmd run build
```

构建应同时通过：

- server TypeScript 编译
- client Vite 构建

## 本地运行

```powershell
npm run dev
```

或生产构建后：

```powershell
npm run build
npm start
```

## 模拟船

无真船时：

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

验证：

- `/api/state` 返回在线状态。
- 前端控制台显示电压、GPS、模式、解锁状态。
- 事件日志出现 `service/startup`、`link/online`、遥测采样。

## HTTP API 冒烟测试

本地默认端口：

```powershell
curl.exe http://127.0.0.1:4000/api/state
curl.exe "http://127.0.0.1:4000/api/logs/events?limit=5"
curl.exe -I "http://127.0.0.1:4000/api/logs/export.csv?kind=events"
```

云端：

```bash
curl -i http://127.0.0.1:4100/api/state
curl -i "http://127.0.0.1:4100/api/logs/events?limit=5"
curl -I "http://127.0.0.1:4100/api/logs/export.csv?kind=events"
```

## 手动控制回归

验证：

- 解锁。
- 上锁。
- 急停。
- 模式切换。
- 摇杆油门/转向。
- WebSocket 断开后控制归零。
- 油门和转向都为 0 的 manual 控制不刷屏记录事件日志。

注意：真船测试前确认环境安全，必要时断开动力或架空推进器。

## Home 返航测试

1. 设置 Home 为当前位置。
2. 确认飞控返回 `MAV_CMD_DO_SET_HOME=179` ACK accepted。
3. 点击返航。
4. 云端发送 RTL。
5. 距离 Home 小于 `5m` 后云端发送 HOLD。
6. 事件日志出现 `return_home/started` 和 `return_home/arrived`。

异常场景：

- 未设置 Home 时点击返航，应失败且不切 RTL。
- 飞控拒绝 SET_HOME 时，应提示失败。
- 服务重启后 Home 应清空。

## 航线任务测试

基础测试：

1. 新增 2 个航点。
2. 设置等待时间。
3. 上传任务。
4. 检查任务上传 ACK。
5. 执行任务。
6. 任务反读成功。

带 Home：

1. 先设置 Home。
2. 上传任务。
3. 云端应追加最终 Home 航点。
4. 任务到最终 Home 后切 HOLD。

带拍照点：

1. 将一个航点设为拍照点。
2. 默认等待时间为 60 秒。
3. 上传任务后生成 `missionId`。
4. 飞控任务中该点后追加 Relay/AUX 三段脉冲任务。
5. 事件日志出现 `capture/plan_ready`。
6. 事件日志出现：

```text
MISSION_AUX_CAPTURE_HIGH
MISSION_AUX_CAPTURE_DELAY
MISSION_AUX_CAPTURE_LOW
```

7. 任务 readback 中应能读回 `command=181`、`command=112`、`command=181`。

## 低电压测试

前端报警：

1. 模拟电压持续低于 22V。
2. 前端出现全屏报警并播放声音。
3. 点击静音/最小化。
4. 断电重连前不再重复弹出全屏报警。

自动返航：

1. 设置 Home 且飞控接受。
2. 连续 5 次电压低于 21.6V。
3. 云端触发返航。
4. 事件日志出现 `power/low_voltage_return_home`。
5. 电压恢复到 22V 及以上后触发锁重置。

## 树莓派拍照联调

详见 [树莓派拍照模块对接说明](raspberry-pi-capture-integration.md)。

最小测试：

1. 树莓派连接 `/api/pi/ws`。
2. 发送 `pi.register`。
3. 打开前端“摄像头测试”页，确认“树莓派连接”显示在线、Pi ID 和最近心跳。
4. 点击“创建测试拍摄计划”。
5. 树莓派收到 `capture.plan`，或查询 `/api/capture-plan/current`。
6. 按 `deviceId + captureDate + pointIndex + photoIndex` 模拟上传一张图片到 `/api/captures/upload`。
7. 前端 10 格验收区显示已收数量。
8. 故意漏传图片。
9. 等待云端发送 `capture.reupload`。

单独触发高电平测试：

1. 打开前端“摄像头测试”页。
2. 确认船端在线且 UDP remote 已知。
3. 点击“触发拍摄”。
4. 船控 AUX/Relay 输出高电平约 1 秒。
5. 树莓派检测到高电平后执行内部流程：电机转一圈并拍摄 10 张。
6. 页面 10 格验收区显示照片逐步上传。
7. 事件日志中应出现 `capture/manual_trigger_high` 和 `capture/manual_trigger_low`。

自动航线触发拍照测试：

1. 部署包含自动拍照修复的版本。
2. 规划一个短航线，只设置 1 个拍照点。
3. 拍照点等待时间设置为 60 秒。
4. 上传任务，确认日志有 `MISSION_AUX_CAPTURE_HIGH/DELAY/LOW`。
5. 开始任务，让船执行到拍照点。
6. 用万用表、示波器或树莓派日志确认 Relay/AUX 出现高-低脉冲。
7. 确认树莓派上传 10 张照片。
8. 再规划 2 个拍照点，确认第二个点也能触发，避免 Relay 长时间保持高电平导致后续没有上升沿。

AI 识别测试：

1. 打开“摄像头测试”页，确认“AI 识别过滤”开启。
2. 上传一组照片。
3. 事件日志应出现 `capture/detection_queued` 和 `capture/detection_complete`。
4. 前端可打开原图和识别结果图。
5. 关闭“AI 识别过滤”后再次上传，照片应保存，但显示未启用识别，并记录 `capture/detection_skipped`。

## 部署验证

部署后必须确认：

- `pm2 describe usv-cloud-mvp` 为 `online`。
- `pm2 logs` 无启动错误。
- `/api/state` 返回 200。
- `/api/logs/events` 返回 200。
- `/api/logs/export.csv` 返回 200。
- `data/usv-events.sqlite` 存在。
- 前端能打开控制台和事件日志。
- 船端继续向 `udp://<server>:14550` 上报。
