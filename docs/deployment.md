# 部署说明

## 本地开发

```powershell
npm install
npm run dev
```

前端开发服务：

```text
http://127.0.0.1:5173
```

后端默认：

```text
http://127.0.0.1:4000
udp://127.0.0.1:14550
```

## 本地生产构建

```powershell
npm run build
npm start
```

`npm run build` 会执行：

- `tsc -p server/tsconfig.json`
- `vite build client`

构建后，后端从 `client/dist` 提供前端静态文件。

## 云端部署约定

当前云端约定：

| 项 | 值 |
| --- | --- |
| 服务器 | `121.40.86.143` |
| 用户 | `root` |
| 项目目录 | `/opt/usv-cloud-mvp` |
| PM2 应用名 | `usv-cloud-mvp` |
| HTTP 端口 | `4100` |
| UDP 端口 | `14550` |

生产访问：

```text
http://121.40.86.143:4100/
```

船端上报：

```text
udp://121.40.86.143:14550
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `HTTP_PORT` | `4000` | HTTP/API/WebSocket 端口 |
| `UDP_PORT` | `14550` | MAVLink UDP 监听端口 |
| `OFFLINE_AFTER_MS` | `5000` | 多久未收到包判定离线 |
| `CONTROL_TIMEOUT_MS` | `500` | 手动控制超时自动归零 |
| `REBOOT_DISARM_WAIT_MS` | `3000` | 重启前等待上锁时间 |
| `REBOOT_DISARM_POLL_MS` | `100` | 上锁轮询间隔 |
| `COMM_LOG_INTERVAL_MS` | `1000` | 通讯日志节流 |
| `COMM_TELEMETRY_LOG_INTERVAL_MS` | `10000` | 通讯遥测日志节流 |
| `COMM_LOW_VOLTAGE` | `20` | 通讯层低压日志阈值 |
| `COMM_VOLTAGE_DROP` | `2` | 快速压降日志阈值 |
| `RETURN_HOME_LOW_VOLTAGE` | `21.6` | 自动返航低压阈值 |
| `RETURN_HOME_LOW_VOLTAGE_SAMPLES` | `5` | 连续低压样本数 |
| `RETURN_HOME_RESET_VOLTAGE` | `22` | 低压返航锁重置电压 |
| `RETURN_HOME_ARRIVAL_RADIUS_M` | `5` | 返航到达半径 |
| `EVENT_DB_PATH` | `data/usv-events.sqlite` | SQLite 数据库路径 |
| `EVENT_LOG_RETENTION_DAYS` | `30` | 事件日志保留天数 |
| `LOG_RAW_MAVLINK` | `false` | 是否输出原始 MAVLink 调试 |
| `CAPTURE_DEFAULT_WAIT_SECONDS` | `60` | 拍照点默认等待时间 |
| `CAPTURE_DEFAULT_PHOTO_COUNT` | `10` | 拍照点默认照片数 |
| `CAPTURE_DEFAULT_STEP_DEG` | `36` | 拍照角度步进 |
| `CAPTURE_AUX_RELAY` | `0` | 拍照 AUX relay 编号 |
| `CAPTURE_AUX_PULSE_SECONDS` | `1` | 拍照 AUX 脉冲秒数 |
| `CAPTURE_UPLOAD_CHECK_DELAY_SECONDS` | `180` | 缺图检查延迟 |
| `CAPTURE_REUPLOAD_MAX_ATTEMPTS` | `3` | 最大补传请求次数 |
| `CAMERA_TRIGGER_COOLDOWN_MS` | `5000` | 手动触发高电平最小间隔 |

云端生产建议：

```bash
HTTP_PORT=4100
UDP_PORT=14550
```

不额外设置 `EVENT_DB_PATH` 时，SQLite 默认保存到 `/opt/usv-cloud-mvp/data/usv-events.sqlite`。

## PM2 部署流程

在服务器项目目录执行：

```bash
cd /opt/usv-cloud-mvp
npm install
npm run build
mkdir -p data
HTTP_PORT=4100 UDP_PORT=14550 pm2 restart usv-cloud-mvp --update-env
pm2 save
```

如果 PM2 应用不存在：

```bash
cd /opt/usv-cloud-mvp
HTTP_PORT=4100 UDP_PORT=14550 pm2 start server/dist/index.js --name usv-cloud-mvp
pm2 save
```

## 部署前备份

替换云端旧版本前，建议创建时间戳备份：

```bash
cd /opt/usv-cloud-mvp
ts=$(date +%Y%m%d-%H%M%S)
mkdir -p .deploy-backups/$ts
cp -a package*.json server client .gitignore .deploy-backups/$ts/
```

不要备份或上传：

```text
node_modules/
data/
.git/
*.log
client/dist/
server/dist/
```

## 部署后验证

```bash
pm2 describe usv-cloud-mvp
pm2 logs usv-cloud-mvp --lines 80 --nostream
curl -i http://127.0.0.1:4100/api/state
curl -i "http://127.0.0.1:4100/api/logs/events?limit=5"
curl -I "http://127.0.0.1:4100/api/logs/export.csv?kind=events"
ls -lh /opt/usv-cloud-mvp/data/usv-events.sqlite
```

前端验证：

```text
http://121.40.86.143:4100/
```

确认：

- 控制台可打开。
- 事件日志页可打开并刷新。
- Home 设置区正常。
- 航线可设置等待时间和拍照点。
- 拍摄记录区域可显示。

## 回滚

如果构建或重启失败：

```bash
cd /opt/usv-cloud-mvp
cp -a .deploy-backups/<timestamp>/package*.json .
rm -rf server client
cp -a .deploy-backups/<timestamp>/server .
cp -a .deploy-backups/<timestamp>/client .
npm install
npm run build
HTTP_PORT=4100 UDP_PORT=14550 pm2 restart usv-cloud-mvp --update-env
pm2 save
```

如果只有事件日志或拍照功能异常，但实时控制正常，优先保留服务运行并排查 SQLite、文件权限和 PM2 error log。
