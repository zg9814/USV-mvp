# USV Cloud MVP 文档索引

本文档目录是项目的维护入口。功能、接口、部署方式、联调流程发生变化时，应即时更新对应文档。

## 必读文档

| 文档 | 适用对象 | 内容 |
| --- | --- | --- |
| [系统架构](architecture.md) | 前后端、嵌入式、运维 | 模块边界、数据流、关键状态 |
| [API 与 WebSocket](api.md) | 前端、树莓派、集成方 | HTTP API、浏览器 WS、树莓派 WS、数据格式 |
| [部署说明](deployment.md) | 运维、开发 | 本地/云端部署、PM2、环境变量、回滚 |
| [运行与排障](operations.md) | 运维、现场联调 | 日志、SQLite、PM2、RTK/GPS、低电压、链路排查 |
| [测试与联调](testing.md) | 开发、测试、现场 | 构建验证、模拟船、任务、Home、拍照、低压测试 |
| [树莓派拍照模块对接说明](raspberry-pi-capture-integration.md) | 硬件/嵌入式 | AUX 触发、Pi WS、照片上传、补传 |
| [变更记录](changelog.md) | 所有人 | 当前版本能力和历史变更 |

## 文档更新要求

以下情况必须同步更新文档：

- 新增、删除或修改 HTTP API / WebSocket 消息。
- 修改 MAVLink 控制、任务打包、Home、返航、低电压策略。
- 修改事件日志字段、SQLite 表结构、数据目录。
- 修改部署端口、环境变量、PM2 应用名或服务器路径。
- 新增脚本、模拟器、联调流程。
- 修改前端关键操作路径。

建议更新位置：

| 改动类型 | 更新文档 |
| --- | --- |
| 接口字段变化 | `api.md`，必要时更新专项对接文档 |
| 部署方式变化 | `deployment.md` |
| 排障经验沉淀 | `operations.md` |
| 联调流程变化 | `testing.md` |
| 拍照/树莓派协议变化 | `raspberry-pi-capture-integration.md` |
| 功能上线 | `changelog.md` |

