// 配置文件
export const config = {
  // 信令服务器地址
  // 如果为 null，则使用 BroadcastChannel（仅同设备）
  // 如果设置了地址，则使用 WebSocket 信令服务器（支持跨设备）
  signalServer: 'http://10.10.99.233:3001', // 默认使用本地信令服务器，可通过 URL 参数覆盖

  // STUN 服务器配置
  stunServer: 'stun:10.10.99.234:3478', // 使用 Google 的公共 STUN 服务器

  // 其他配置选项
  options: {
    // ICE 收集超时时间（毫秒）
    iceGatheringTimeout: 1000,

    // 连接超时时间（毫秒）
    connectionTimeout: 30000,

    // 文件传输块大小（字节）
    // 使用接近但小于256KB的值，留出协议开销空间
    chunkSize: 256 * 1024 - 1024, // 255KB - 保留1KB的协议开销

    // 最大并发传输块数
    // 适中的并发数，平衡速度和稳定性
    maxConcurrentChunks: 8, // 保守但有效的并发数

    // 信令轮询间隔（毫秒）
    pollingInterval: 1000,

    // 在线状态广播间隔（毫秒）
    presenceInterval: 30000,

    // 数据完整性验证
    // 启用每个chunk的CRC32校验（会增加4字节开销和计算时间）
    enableHashVerification: false, // 默认关闭，适合可靠网络环境
  },
}

// 从 URL 参数覆盖配置
export function updateConfigFromURL() {
  const urlParams = new URLSearchParams(window.location.search)
  const server = urlParams.get('server')

  if (server) {
    // 自动添加 http:// 前缀（如果没有）
    if (!server.startsWith('http://') && !server.startsWith('https://')) {
      config.signalServer = `http://${server}`
    } else {
      config.signalServer = server
    }
  }

  return config
}
