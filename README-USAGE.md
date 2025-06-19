# P2P 文件传输应用 - 使用说明

## 🚀 快速启动

### 1. 安装依赖
```bash
# 使用 pnpm（推荐）
pnpm install

# 或使用 npm
npm install
```

### 2. 启动应用
```bash
# 同时启动 Web 服务器和 WebSocket 信令服务器
npm start

# 或使用开发模式（带颜色输出）
npm run dev
```

### 3. 访问应用
打开浏览器访问：**http://localhost:3000**

## 📋 可用脚本

| 命令 | 说明 |
|------|------|
| `npm start` | 同时启动 Web 服务器(3000) 和信令服务器(3001) |
| `npm run dev` | 开发模式启动，带颜色标识的日志输出 |
| `npm run web` | 仅启动 Web 服务器 (端口 3000) |
| `npm run signal` | 仅启动 WebSocket 信令服务器 (端口 3001) |

## 🔧 服务器配置

### 端口配置
- **Web 服务器**: 默认端口 3000
- **信令服务器**: 默认端口 3001

可以通过环境变量自定义端口：
```bash
# 自定义 Web 服务器端口
WEB_PORT=8080 npm run web

# 自定义信令服务器端口
PORT=8001 npm run signal

# 自定义主机地址
HOST=0.0.0.0 npm start
```

### 跨设备连接
如果需要局域网内其他设备访问：

1. 获取本机 IP 地址
2. 使用 IP 地址访问：`http://192.168.1.100:3000`
3. 或通过 URL 参数指定信令服务器：
   ```
   http://192.168.1.100:3000?server=192.168.1.100:3001
   ```

## 🌐 应用架构

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

## 🔍 故障排除

### 端口占用问题
如果端口被占用，您会看到类似错误：
```
❌ Port 3000 is already in use
```

解决方案：
```bash
# 使用不同端口
WEB_PORT=3001 npm run web

# 或终止占用端口的进程
lsof -ti:3000 | xargs kill -9  # macOS/Linux
netstat -ano | findstr :3000   # Windows
```

### 无法连接到信令服务器
确保信令服务器正在运行：
```bash
# 检查信令服务器状态
curl http://localhost:3001/status
```

### 跨设备连接问题
1. 确保设备在同一局域网内
2. 检查防火墙设置
3. 使用 IP 地址而不是 localhost
4. 通过 URL 参数指定正确的信令服务器地址

## 📝 开发说明

### 文件结构
```
file-share/
├── index.html              # 主界面
├── web-server.js           # HTTP 静态文件服务器
├── ws-signal-server.js     # WebSocket 信令服务器
├── p2p-manager-ws.js       # P2P 连接管理器
├── p2p-connection.js       # P2P 连接实现
├── config.js               # 配置文件
└── package.json            # 项目配置
```

### 修改配置
编辑 `config.js` 文件来修改：
- 信令服务器地址
- STUN 服务器设置
- 文件传输参数
- 连接超时设置

### 自定义主机访问
如果需要局域网访问，启动时设置主机：
```bash
HOST=0.0.0.0 npm start
```

然后其他设备可以通过您的 IP 地址访问，例如：
`http://192.168.1.100:3000` 