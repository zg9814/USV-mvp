# 运行与排障

## 常用检查命令

云端：

```bash
pm2 describe usv-cloud-mvp
pm2 logs usv-cloud-mvp --lines 120 --nostream
curl -i http://127.0.0.1:4100/api/state
curl -i "http://127.0.0.1:4100/api/logs/events?limit=20"
```

本地：

```powershell
npm run build
npm run dev
```

## SQLite 数据库

默认路径：

```text
data/usv-events.sqlite
```

包含表：

| 表 | 说明 |
| --- | --- |
| `event_logs` | 结构化事件日志 |
| `telemetry_samples` | 1 秒遥测采样 |
| `capture_plans` | 拍摄计划 |
| `capture_images` | 图片元数据 |

事件日志保留默认 30 天，启动时清理一次，之后每小时清理一次。

日志写入失败只输出 `console.warn`，不应阻断控制链路。

## 事件日志分类

重点关注：

| category/type | 含义 |
| --- | --- |
| `link/remote_changed` | 船端 UDP remote endpoint 变化 |
| `link/offline` | 云端短时间未收到船端 MAVLink |
| `gps/rtk_lost` | 主 GPS RTK 退化 |
| `gps/rtk_degraded_status` | RTK 退化后的诊断快照 |
| `gps/gps2_rtk_lost` | 第二 GPS RTK 退化 |
| `power/low_voltage` | 低电压 |
| `power/low_voltage_return_home` | 低电压触发自动返航 |
| `mission/upload_failed` | 航线上传失败 |
| `capture/reupload_requested` | 云端要求树莓派补传 |
| `capture/incomplete` | 多次补传后仍缺图 |
| `capture/detection_queued` | 图片已进入排口识别队列 |
| `capture/detection_complete` | 排口识别完成 |
| `capture/detection_failed` | 排口识别失败 |
| `capture/detection_skipped` | AI 识别过滤关闭，跳过识别 |

## Remote endpoint 变化

`Remote endpoint changed to <ip>:<port>` 表示云端收到 MAVLink 包的公网源地址或端口变化。

常见原因：

- 船控 4G 网络 NAT 重新分配端口。
- 4G 断线重连。
- 路由器或运营商 CGNAT 刷新映射。
- 设备侧网络栈重启。

remote 变化本身不必然导致 RTK 退化。若 RTK 和船控使用不同 4G 卡，二者没有直接网络链路依赖。但如果多次出现“remote 变化后 RTK 退化”，可能说明两张 4G 卡处在同一现场环境，受到共同因素影响，例如供电波动、天线遮挡、设备重启、震动、基站切换或电磁干扰。

## RTK/GPS 退化排查

优先看事件顺序：

1. `gps/rtk_lost` 或 `gps/quality_changed`
2. `gps/rtk_degraded_status`
3. `link/remote_changed`
4. `link/offline`
5. `power/voltage_drop`
6. `power/low_voltage`
7. `STATUSTEXT`

判断方向：

| 现象 | 可能原因 |
| --- | --- |
| RTK 先退化，remote 后变化 | RTK 链路/定位质量先异常，船控 4G 后续也重连；可能是现场环境或供电共同影响 |
| remote 先变化，RTK 后退化 | 可能是设备网络/供电/现场环境共同扰动，不代表船控 remote 必然影响 RTK |
| 卫星数稳定但 RTK 退化 | 差分链路、基站数据、RTCM 输入或 RTK 模块状态问题 |
| 卫星数下降且 HDOP 变差 | 天线遮挡、安装位置、室内/树荫/建筑反射 |
| 电压同时压降 | 电源、接线、负载突变、DC-DC 稳压问题 |

船静止在地面时，如果运行一段时间后 RTK 退化，重点排查：

- RTK 模块供电是否稳定。
- RTK 天线是否牢固、无遮挡、远离干扰源。
- 差分数据链路是否持续。
- 两张 4G 卡是否同时发生信号切换或重连。
- RTK 模块温度、线缆、接口是否异常。

## 低电压保护

后端逻辑：

- 电压连续 5 次低于 `21.6V` 后触发自动返航。
- 电压恢复到 `22.0V` 及以上后重置触发锁。
- 触发自动返航前必须已设置 Home，并且飞控接受了 SET_HOME。

前端逻辑：

- 持续低电压时显示全屏报警并播放声音。
- 用户可静音和最小化。
- 点击隐藏后，在断电重连前不重复弹出全屏报警。

排查：

- 看 `/api/state` 中电压。
- 看事件日志 `power/low_voltage` 和 `power/low_voltage_return_home`。
- 看前端浏览器是否允许音频播放。

## Home 返航

Home 保存在运行内存中，服务重启后清空。

返航失败常见原因：

| 错误 | 排查 |
| --- | --- |
| `home is not set` | 前端还没有设置 Home |
| `home has not been accepted by autopilot` | 飞控没有接受 `MAV_CMD_DO_SET_HOME=179` |
| RTL 后不到点 | 飞控 Home、模式、GPS、围栏、参数需要检查 |

## 拍照任务排障

1. 前端确认航点开启“拍照点”。
2. 上传任务后查看事件日志 `capture/plan_ready`。
3. 树莓派连接 `/api/pi/ws` 后应收到 `capture.plan`。
4. 到达拍照点后应检测到 AUX/relay 触发。
5. 图片上传后查看 `capture/image_uploaded`。
6. 缺图时查看 `capture/reupload_requested`。

自动航线拍照点当前应写入三段飞控任务：

```text
MISSION_AUX_CAPTURE_HIGH
MISSION_AUX_CAPTURE_DELAY
MISSION_AUX_CAPTURE_LOW
```

如果手动“触发拍摄”可以触发，但航线拍照不能触发，优先检查：

- 上传任务日志是否包含以上三段。
- 任务 readback 是否读回 `command=181` high、`command=112` delay、`command=181` low。
- 飞控是否真的执行到拍照航点。
- AUTO 任务中是否允许执行 `DO_SET_RELAY` 和 `CONDITION_DELAY`。
- `CAPTURE_AUX_RELAY` 是否和树莓派实际接线一致，生产默认 `0`。
- 用万用表或示波器确认 AUX/Relay 口是否出现约 1 秒高电平脉冲。

`/api/captures/upload` 现在采用宽松接收策略，没有对应拍摄计划时会自动创建接收计划。若没有看到照片，优先检查 multipart 字段名是否包含 `file`，以及 PM2 日志中是否有上传解析错误。

## AI 识别排障

当前云端模型路径：

```text
/opt/usv-cloud-mvp/models/outfall_yolov8s.pt
```

当前生产推理环境：

```text
OUTFALL_DETECTION_PYTHON=/opt/usv-cloud-mvp/.venv/bin/python
OUTFALL_CONFIDENCE=0.50
OUTFALL_IOU=0.45
```

检查设置：

```bash
curl -i http://127.0.0.1:4100/api/detections/settings
ls -lh /opt/usv-cloud-mvp/models/outfall_yolov8s.pt
```

常见问题：

| 现象 | 排查 |
| --- | --- |
| 上传后没有识别任务 | 前端“AI 识别过滤”是否关闭；看 `capture/detection_skipped` |
| 识别失败 | 看 PM2 日志、Python 路径、`cv2`/`ultralytics` 是否可导入 |
| 识别图打不开 | 看 `data/captures/annotated/` 文件是否存在、路径是否入库 |
| 漏检多 | 降低 `OUTFALL_CONFIDENCE` 或补充真实场景数据重新训练 |
| 误检多 | 提高 `OUTFALL_CONFIDENCE` 或补充负样本重新训练 |

服务器没有 CUDA 时不要安装 GPU 版推理依赖，使用 CPU 环境即可。

## PM2 日志

查看最近日志：

```bash
pm2 logs usv-cloud-mvp --lines 120 --nostream
```

正常情况下不应持续出现启动错误、SQLite 打开错误、端口占用或未捕获异常。

## 文件权限

服务需要能写入：

```text
/opt/usv-cloud-mvp/data/
/opt/usv-cloud-mvp/data/captures/original/
```

如遇权限问题：

```bash
cd /opt/usv-cloud-mvp
mkdir -p data/captures/original
chown -R root:root data
```
