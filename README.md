# USV Cloud MVP

单船无人船云端 MVP。项目包含：

- Node.js 后端：UDP MAVLink2 接入、HTTP API、WebSocket、SQLite 事件日志、航线任务、Home 返航、低电压保护、拍照任务接入。
- Vue 前端：控制台、地图/航线、事件日志、Home 设置、低压报警、拍摄记录。
- 本地模拟脚本：用于无真船时模拟 MAVLink 上报和联调。

## 快速开始

```powershell
npm install
npm run dev
```

默认访问：

```text
http://127.0.0.1:5173
```

生产构建：

```powershell
npm run build
npm start
```

## 默认端口

| 端口 | 协议 | 用途 |
| ---: | --- | --- |
| `14550` | UDP | 船端 MAVLink2 上报与云端控制回包 |
| `4000` | TCP | 后端 HTTP API + WebSocket + 前端静态文件 |
| `5173` | TCP | Vite 前端开发服务 |

部署到云端时，船端应持续向以下地址发送 MAVLink2：

```text
udp://<server-public-ip>:14550
```

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 同时启动后端和前端开发服务 |
| `npm run dev:server` | 启动后端开发服务 |
| `npm run dev:client` | 启动前端开发服务 |
| `npm run build` | 构建后端和前端 |
| `npm start` | 启动生产构建后的服务 |
| `npm run simulate` | 启动本地 MAVLink 模拟船 |

## 关键功能

- 单船自动注册：收到 `HEARTBEAT` 后按 `system_id` 识别设备。
- UDP NAT 回包：记录最近船端 remote endpoint，并将控制指令发回该地址。
- 实时遥测：模式、解锁、经纬度、速度、航向、电压、电流、电量、GPS/RTK 状态。
- 手动控制：油门、转向、解锁、上锁、急停、模式切换、飞控软重启。
- 航线任务：航点上传、等待时间、任务开始/暂停/继续/清空、任务反读。
- Home 返航：前端设置 Home，同步飞控 Home，手动返航、任务完成返航、低电压自动返航。
- 低电压保护：持续低电压触发报警与自动返航；前端支持报警静音和最小化。
- 事件日志：SQLite 记录控制、ACK、STATUSTEXT、任务、链路、电压、GPS/RTK、拍照事件和 1 秒遥测采样。
- 拍照任务：拍照航点通过 AUX 触发树莓派，树莓派异步上传照片，云端缺图补传。

## 文档入口

- [文档索引](docs/README.md)
- [系统架构](docs/architecture.md)
- [API 与 WebSocket](docs/api.md)
- [部署说明](docs/deployment.md)
- [运行与排障](docs/operations.md)
- [测试与联调](docs/testing.md)
- [树莓派拍照模块对接说明](docs/raspberry-pi-capture-integration.md)
- [变更记录](docs/changelog.md)

## 环境变量

主要环境变量见 [部署说明](docs/deployment.md#环境变量)。

生产云端当前约定：

```text
HTTP_PORT=4100
UDP_PORT=14550
EVENT_DB_PATH=data/usv-events.sqlite
EVENT_LOG_RETENTION_DAYS=30
```

## 数据目录

运行时数据默认保存到：

```text
data/
```

包括：

- `data/usv-events.sqlite`：事件日志、遥测采样、拍摄计划、照片元数据。
- `data/captures/original/`：树莓派上传的原图。

`data/` 不应提交到 Git。

## 文档维护规则

每次改动功能、接口、部署参数、数据结构或联调流程时，必须同步更新 `docs/` 下对应文档。文档索引用于快速判断需要更新哪一份。

