# 配置说明

## 配置信令服务器

### 方法 1：编辑 config.js（推荐）

编辑 `config.js` 文件，设置信令服务器地址：

```javascript
export const config = {
  // 设置信令服务器地址
  signalServer: 'http://192.168.1.100:3001',  // 替换为您的服务器地址
  
  // STUN 服务器配置
  stunServer: 'stun:10.10.99.234:3478',
  
  // 其他配置...
};
```

### 方法 2：使用 URL 参数

在访问页面时添加 `server` 参数：

```
http://localhost:8080/?server=192.168.1.100:3001
```

URL 参数会覆盖 config.js 中的配置。

## 使用步骤

### 1. 启动信令服务器

在一台设备上运行：

```bash
node ws-signal-server.js
```

服务器会在 3001 端口启动。

### 2. 配置客户端

**选项 A：** 编辑所有设备上的 `config.js`，设置相同的 `signalServer` 地址

**选项 B：** 所有设备访问时使用相同的 URL 参数

### 3. 使用

1. 每个用户设置自己的 ID（如：alice、bob）
2. 输入对方的 ID 进行连接
3. 连接成功后即可传输文件

## 配置选项说明

### 基础配置

```javascript
export const config = {
  // 信令服务器地址，null 表示使用 BroadcastChannel（仅同设备）
  signalServer: 'http://192.168.1.100:3001',
  
  // STUN 服务器地址，用于获取网络信息
  stunServer: 'stun:stun.l.google.com:19302',
  
  // ICE 候选收集超时时间（毫秒）
  iceGatheringTimeout: 10000,
  
  // 连接建立超时时间（毫秒）
  connectionTimeout: 30000,
  
  // 信令轮询间隔（毫秒）
  pollingInterval: 1000,
  
  // 在线状态广播间隔（毫秒）
  presenceInterval: 30000,
};
```

### 传输配置

```javascript
export const config = {
  options: {
    // 文件传输块大小（字节）
    chunkSize: 256 * 1024, // 256KB
    
    // 最大并发传输块数
    maxConcurrentChunks: 5,
    
    // 启用数据完整性校验（CRC32）
    enableHashVerification: false,
    
    // 传输重试次数
    maxRetries: 3,
    
    // 重试延迟时间（毫秒）
    retryDelay: 1000,
  }
};
```

### 高级配置

```javascript
export const config = {
  // WebRTC 配置
  rtcConfiguration: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      // 可以添加更多 STUN/TURN 服务器
    ],
    iceCandidatePoolSize: 10,
  },
  
  // 数据通道配置
  dataChannelConfig: {
    ordered: true,
    maxRetransmits: 3,
  },
  
  // 调试配置
  debug: {
    enabled: false,
    logLevel: 'info', // 'debug', 'info', 'warn', 'error'
  }
};
```

## 配置优化建议

### 局域网环境（高速网络）
```javascript
config.options = {
  chunkSize: 1 * 1024 * 1024,      // 1MB
  maxConcurrentChunks: 8,           // 8个并发
  enableHashVerification: false,    // 可选校验
}
```

### 广域网环境（普通网络）
```javascript
config.options = {
  chunkSize: 256 * 1024,            // 256KB
  maxConcurrentChunks: 5,           // 5个并发
  enableHashVerification: true,     // 建议启用校验
}
```

### 低速/不稳定网络
```javascript
config.options = {
  chunkSize: 64 * 1024,             // 64KB
  maxConcurrentChunks: 3,           // 3个并发
  enableHashVerification: true,     // 强烈建议启用校验
  maxRetries: 5,                    // 增加重试次数
}
```

## 数据完整性验证配置

### 启用 CRC32 校验
```javascript
config.options.enableHashVerification = true
```

### 特性
- ✅ **检测数据损坏**：每个数据块都有CRC32校验和
- ✅ **自动重传**：校验失败的块会被丢弃并可能触发重传
- ✅ **向后兼容**：未启用时使用标准格式

### 开销
- **计算开销**：每个chunk需要额外的CRC32计算时间
- **传输开销**：每个chunk增加4字节的校验和
- **内存开销**：略微增加CPU和内存使用

### 建议使用场景
- 🌐 **不稳定网络**：WiFi信号弱、移动网络等
- 📁 **重要文件**：需要确保完整性的关键数据
- 🔍 **调试模式**：排查传输问题时

### 性能影响
对于大文件传输，启用CRC32校验大约会：
- 增加 5-10% 的传输时间
- 增加 4字节/块 的网络开销

## 网络拓扑示例

```
设备 A (192.168.1.100)          设备 B (192.168.1.101)
运行信令服务器:3001                    |
        |                              |
        |<----- 信令交换 (HTTP) ------>|
        |                              |
        |<===== 文件传输 (WebRTC) ====>|
```

信令服务器只用于交换连接信息，实际文件通过 WebRTC 直接传输。

## 环境变量配置

### 服务器端口配置
```bash
# Web 服务器端口
WEB_PORT=3000

# 信令服务器端口
PORT=3001

# 主机地址
HOST=0.0.0.0

# 环境模式
NODE_ENV=production
```

### 使用环境变量
```bash
# 启动时指定端口
WEB_PORT=8080 PORT=8001 npm start

# 允许局域网访问
HOST=0.0.0.0 npm start
```

## PM2 配置

### ecosystem.config.cjs 配置文件
```javascript
module.exports = {
  apps: [
    {
      name: 'file-share-web',
      script: 'web-server.js',
      env: {
        WEB_PORT: 3000,
        NODE_ENV: 'development'
      },
      env_production: {
        WEB_PORT: 3000,
        NODE_ENV: 'production'
      }
    },
    {
      name: 'file-share-signal',
      script: 'ws-signal-server.js',
      env: {
        PORT: 3001,
        NODE_ENV: 'development'
      },
      env_production: {
        PORT: 3001,
        NODE_ENV: 'production'
      }
    }
  ]
};
```

## 常见问题

### 无法连接到信令服务器
1. 检查信令服务器是否正在运行
2. 确认防火墙没有阻止端口
3. 验证 config.js 中的服务器地址是否正确

### WebRTC 连接失败
1. 检查 STUN 服务器是否可用
2. 确认网络允许 UDP 连接
3. 尝试使用不同的 STUN 服务器

### 传输速度慢
1. 调整块大小和并发数
2. 检查网络状况
3. 启用数据校验可能会影响速度

---

**下一步：** 如果遇到问题，请查看 [故障排除指南](troubleshooting.md)。 