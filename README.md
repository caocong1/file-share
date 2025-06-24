# 局域网 P2P 文件传输系统

基于 WebRTC 的局域网内浏览器直传文件方案，无需服务器中转，支持并行传输和断点续传。

## ✨ 功能特点

- 🔍 **自动扫描局域网设备**
- ⚡ **P2P 直连，传输速度快**
- 📁 **多文件并行传输**
- 📊 **实时进度显示**
- 📥 **自动接收下载**
- 📋 **多种传输方式**：拖拽、点击选择、快捷键粘贴
- 🖼️ **支持所有文件类型**（文件夹需压缩后传输）
- 🔧 **智能断线重连**
- 🛡️ **可选数据完整性校验**

## 🚀 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 启动应用
npm run dev

# 3. 访问应用
# http://localhost:3000
```

详细安装和使用说明请查看：**[用户指南 →](docs/user/quick-start.md)**

## 📚 文档目录

### 用户文档
- **[快速开始指南](docs/user/quick-start.md)** - 安装、启动和基本使用
- **[配置说明](docs/user/configuration.md)** - 服务器配置和网络设置
- **[故障排除](docs/user/troubleshooting.md)** - 常见问题和解决方案

### 技术文档
- **[并行传输原理](docs/technical/parallel-transfer.md)** - 并行文件传输的实现机制
- **[二进制协议规范](docs/technical/binary-protocol.md)** - P2P 通信的二进制协议详细说明
- **[WebRTC 限制说明](docs/technical/webrtc-limits.md)** - WebRTC 数据通道的技术限制
- **[缓冲区管理](docs/technical/buffer-management.md)** - RTCDataChannel 缓冲区优化

### 测试文档
- **[断线测试说明](docs/testing/disconnect-test.md)** - 文件传输中断处理的测试方法

## 🏗️ 技术架构

```
┌─────────────────┐    ┌─────────────────┐
│   Web Server    │    │  Signal Server  │
│   (port 3000)   │    │   (port 3001)   │
│                 │    │                 │
│ 提供静态文件     │    │ WebSocket 信令   │
│ - index.html    │    │ - 用户注册       │
│ - *.js          │    │ - 在线列表       │
│ - *.css         │    │ - P2P 信令转发   │
└─────────────────┘    └─────────────────┘
         │                       │
         └───────────┬───────────┘
                     │
         ┌─────────────────┐
         │   Browser App   │
         │                 │
         │ - P2P 连接管理   │
         │ - 文件传输       │
         │ - 用户界面       │
         └─────────────────┘
```

**核心技术栈：**
- **WebRTC DataChannel**: P2P 数据传输
- **WebSocket**: 信令交换
- **二进制协议**: 高效数据传输
- **并行传输**: 多块同时传输提高效率

## 🔧 开发说明

### 环境要求
- Node.js 16+
- 现代浏览器（Chrome/Firefox/Edge）
- 同一局域网环境

### 项目结构
```
file-share/
├── index.html              # 主界面
├── web-server.js           # HTTP 静态文件服务器
├── ws-signal-server.js     # WebSocket 信令服务器
├── p2p-manager-ws.js       # P2P 连接管理器
├── p2p-connection.js       # P2P 连接实现
├── config.js               # 配置文件
├── package.json            # 项目配置
└── docs/                   # 文档目录
    ├── user/               # 用户文档
    ├── technical/          # 技术文档
    └── testing/            # 测试文档
```

### 开发模式
```bash
npm run dev        # 开发模式启动
npm run prod       # 生产模式（PM2）
npm run pm2:logs   # 查看日志
```

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License

---

**需要帮助？** 查看 [故障排除指南](docs/user/troubleshooting.md) 或提交 Issue。 