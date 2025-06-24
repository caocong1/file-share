# RTCDataChannel 缓冲区管理说明

## 问题描述

当文件块过大或并发数过高时，可能出现错误：
```
OperationError: Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel send queue is full
```

## 问题原因

1. **缓冲区限制**：RTCDataChannel 有内部缓冲区限制（通常为 16MB）
2. **块大小过大**：单个块太大会快速填满缓冲区
3. **并发数过高**：同时发送太多块会导致缓冲区溢出

## 解决方案

### 1. 动态并发控制
```javascript
// 根据块大小自动调整并发数
if (chunkSize > 1MB) {
  maxConcurrent = Math.floor(16MB / chunkSize)
}
```

### 2. 严格的缓冲区检查
- 发送前检查 `bufferedAmount`
- 设置合理的缓冲区阈值（最大 16MB）
- 分阶段检查：元数据发送前、数据发送前

### 3. 错误处理和重试
```javascript
try {
  dataChannel.send(buffer)
} catch (error) {
  if (error.message.includes('send queue is full')) {
    // 等待并重试
    await new Promise(resolve => setTimeout(resolve, 500))
    dataChannel.send(buffer)
  }
}
```

### 4. 推荐配置

#### 高速局域网
```javascript
chunkSize: 1 * 1024 * 1024,      // 1MB
maxConcurrentChunks: 5,           // 5个并发
```

#### 普通网络
```javascript
chunkSize: 256 * 1024,            // 256KB
maxConcurrentChunks: 8,           // 8个并发
```

#### 低速网络
```javascript
chunkSize: 64 * 1024,             // 64KB
maxConcurrentChunks: 3,           // 3个并发
```

## 性能优化建议

1. **块大小选择**
   - 局域网：512KB - 2MB
   - 广域网：64KB - 256KB
   - 不建议超过 2MB

2. **并发数选择**
   - 总缓冲量 = 块大小 × 并发数
   - 保持总缓冲量 < 16MB
   - 一般 3-8 个并发较合适

3. **自适应调整**
   - 监控传输速度
   - 根据网络状况动态调整
   - 考虑接收端处理能力

## 故障排除

如果仍然遇到缓冲区问题：

1. 减小块大小
2. 降低并发数
3. 增加等待时间
4. 检查网络状况
5. 确认接收端正常工作 