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
node local-signal-server.js
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

- `signalServer`: 信令服务器地址，null 表示使用 BroadcastChannel（仅同设备）
- `stunServer`: STUN 服务器地址，用于获取网络信息
- `iceGatheringTimeout`: ICE 候选收集超时时间（毫秒）
- `connectionTimeout`: 连接建立超时时间（毫秒）
- `chunkSize`: 文件传输块大小（字节）
- `pollingInterval`: 信令轮询间隔（毫秒）
- `presenceInterval`: 在线状态广播间隔（毫秒）

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