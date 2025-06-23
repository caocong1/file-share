// p2p-connection.js
import { config } from './config.js'

class P2PConnection extends EventTarget {
  constructor(peerIP) {
    super()
    this.peerIP = peerIP
    this.pc = null
    this.dataChannel = null
    this.isConnected = false
    this.currentTransfer = null
    this.pendingCandidates = [] // 缓存待添加的 ICE 候选
    this.crc32Table = null


  }

  // 创建 offer
  async createOffer() {
    this.pc = new RTCPeerConnection({
      iceServers: this.iceServers || [], // 使用自定义的 iceServers 或默认空数组
    })

    this.setupPeerConnection()

    // 创建数据通道
    this.dataChannel = this.pc.createDataChannel('fileTransfer', {
      ordered: true,
      // 适中的重传次数
      maxRetransmits: 5,
    })
    this.setupDataChannel()

    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)

    // 等待 ICE 收集
    await this.waitForIceGathering()

    return {
      sdp: this.pc.localDescription.sdp,
      candidates: await this.getLocalCandidates(),
    }
  }

  // 处理 offer
  async handleOffer(offerData) {
    this.pc = new RTCPeerConnection({
      iceServers: this.iceServers || [], // 使用自定义的 iceServers 或默认空数组
    })

    this.setupPeerConnection()

    await this.pc.setRemoteDescription({
      type: 'offer',
      sdp: offerData.sdp,
    })

    // 处理缓存的 ICE 候选
    await this.processPendingCandidates()

    // 添加 ICE candidates
    if (offerData.candidates) {
      for (const candidate of offerData.candidates) {
        await this.addIceCandidate(candidate)
      }
    }

    // 监听数据通道
    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel
      this.setupDataChannel()
    }

    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)

    await this.waitForIceGathering()

    return {
      sdp: this.pc.localDescription.sdp,
      candidates: await this.getLocalCandidates(),
    }
  }

  // 处理 answer
  async handleAnswer(answerData) {
    await this.pc.setRemoteDescription({
      type: 'answer',
      sdp: answerData.sdp,
    })

    // 处理缓存的 ICE 候选
    await this.processPendingCandidates()

    if (answerData.candidates) {
      for (const candidate of answerData.candidates) {
        await this.addIceCandidate(candidate)
      }
    }
  }

  // 设置 PeerConnection 事件
  setupPeerConnection() {
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('[P2P-DEBUG] 生成ICE候选:', event.candidate.candidate)
        this.dispatchEvent(
          new CustomEvent('icecandidate', {
            detail: event.candidate,
          }),
        )
      } else {
        console.log('[P2P-DEBUG] ICE候选收集完成')
      }
    }

    this.pc.onconnectionstatechange = () => {
      console.log('[P2P-DEBUG] 连接状态变化:', this.pc.connectionState)
      console.log('[P2P-DEBUG] 连接详细状态:', {
        connectionState: this.pc.connectionState,
        iceConnectionState: this.pc.iceConnectionState,
        iceGatheringState: this.pc.iceGatheringState,
        signalingState: this.pc.signalingState
      })

      if (this.pc.connectionState === 'connected') {
        this.isConnected = true
        console.log('[P2P-DEBUG] P2P连接建立成功')
        this.onconnected?.()
      } else if (this.pc.connectionState === 'failed' ||
        this.pc.connectionState === 'disconnected' ||
        this.pc.connectionState === 'closed') {
        console.log('[P2P-DEBUG] P2P连接失败/断开，原因:', this.pc.connectionState)
        this.isConnected = false

        // 如果正在接收文件，触发失败事件
        if (this.receivingFile) {
          console.log('[P2P-DEBUG] 接收文件时连接断开，文件ID:', this.receivingFile.id)
          this.dispatchEvent(
            new CustomEvent('filefailed', {
              detail: {
                id: this.receivingFile.id,
                name: this.receivingFile.name,
                reason: `连接已断开 (${this.pc.connectionState})`,
                progress: this.receivingFile.receivedSize / this.receivingFile.size
              },
            }),
          )
          this.receivingFile = null
        }

        // 如果正在发送文件，拒绝 Promise
        if (this.currentTransfer) {
          console.log('[P2P-DEBUG] 发送文件时连接断开，文件:', this.currentTransfer.file.name)
          this.currentTransfer.reject(new Error(`连接已断开 (${this.pc.connectionState})`))
          this.currentTransfer = null
        }

        this.onerror?.(new Error(`连接失败: ${this.pc.connectionState}`))
      }
    }

    // 添加ICE连接状态变化监听
    this.pc.oniceconnectionstatechange = () => {
      console.log('[P2P-DEBUG] ICE连接状态变化:', this.pc.iceConnectionState)
      if (this.pc.iceConnectionState === 'failed' || this.pc.iceConnectionState === 'disconnected') {
        console.log('[P2P-DEBUG] ICE连接失败/断开')
      }
    }
  }

  // 设置数据通道事件
  setupDataChannel() {
    this.dataChannel.binaryType = 'arraybuffer'

    this.dataChannel.onopen = () => {
      console.log('[P2P-DEBUG] 数据通道已打开')
      console.log('[P2P-DEBUG] 数据通道详细信息:', {
        readyState: this.dataChannel.readyState,
        maxPacketLifeTime: this.dataChannel.maxPacketLifeTime,
        maxRetransmits: this.dataChannel.maxRetransmits,
        negotiated: this.dataChannel.negotiated,
        ordered: this.dataChannel.ordered,
        protocol: this.dataChannel.protocol
      })
      this.isConnected = true
    }

    this.dataChannel.onclose = () => {
      console.log('[P2P-DEBUG] 数据通道已关闭')
      console.log('[P2P-DEBUG] 数据通道关闭时状态:', {
        readyState: this.dataChannel.readyState,
        peerConnectionState: this.pc.connectionState,
        iceConnectionState: this.pc.iceConnectionState
      })
      this.isConnected = false

      // 如果正在接收文件，触发失败事件
      if (this.receivingFile) {
        console.log('[P2P-DEBUG] 接收文件时数据通道关闭，文件ID:', this.receivingFile.id)
        this.dispatchEvent(
          new CustomEvent('filefailed', {
            detail: {
              id: this.receivingFile.id,
              name: this.receivingFile.name,
              reason: '数据通道已关闭',
              progress: this.receivingFile.receivedSize / this.receivingFile.size
            },
          }),
        )
        this.receivingFile = null
      }
    }

    this.dataChannel.onmessage = (event) => {
      // console.log('[P2P-DEBUG] 收到数据通道消息，大小:', event.data.byteLength)
      this.handleDataChannelMessage(event.data)
    }

    this.dataChannel.onerror = (error) => {
      console.error('[P2P-DEBUG] 数据通道错误详情:', {
        error: error,
        errorType: error.type,
        errorMessage: error.error?.message,
        dataChannelState: this.dataChannel.readyState,
        peerConnectionState: this.pc.connectionState,
        timestamp: new Date().toISOString()
      })

      // 如果正在传输文件，触发失败事件
      if (this.currentTransfer) {
        console.log('[P2P-DEBUG] 传输文件时数据通道错误，文件:', this.currentTransfer.file.name)
        this.currentTransfer.reject(new Error('数据通道错误: ' + (error.error?.message || '未知错误')))
        this.currentTransfer = null
      }

      // 如果正在接收文件，触发失败事件
      if (this.receivingFile) {
        console.log('[P2P-DEBUG] 接收文件时数据通道错误，文件ID:', this.receivingFile.id)
        this.dispatchEvent(
          new CustomEvent('filefailed', {
            detail: {
              id: this.receivingFile.id,
              name: this.receivingFile.name,
              reason: '数据通道错误',
              progress: this.receivingFile.receivedSize / this.receivingFile.size
            },
          }),
        )
        this.receivingFile = null
      }
    }
  }

  // 生成兼容的 UUID
  generateUUID() {
    // 优先使用 crypto.randomUUID
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID()
    }

    // 备用方案：使用 crypto.getRandomValues
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16 | 0
        const v = c === 'x' ? r : (r & 0x3 | 0x8)
        return v.toString(16)
      })
    }

    // 最后的备用方案：使用 Math.random（不够安全但能用）
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0
      const v = c === 'x' ? r : (r & 0x3 | 0x8)
      return v.toString(16)
    })
  }

  // UUID字符串转16字节数组
  uuidStringToBytes(uuidString) {
    const hex = uuidString.replace(/-/g, '')
    const bytes = new Uint8Array(16)
    for (let i = 0; i < 16; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
    }
    return bytes
  }

  // 16字节数组转UUID字符串
  uuidBytesToString(bytes) {
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
    return hex.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
  }

  // 写入48位无符号整数（6字节）
  writeUint48(view, offset, value) {
    // 分成高16位和低32位写入
    const high = Math.floor(value / 0x100000000) & 0xFFFF
    const low = value & 0xFFFFFFFF
    view.setUint16(offset, high, true)
    view.setUint32(offset + 2, low, true)
  }

  // 读取48位无符号整数（6字节）
  readUint48(view, offset) {
    const high = view.getUint16(offset, true)
    const low = view.getUint32(offset + 2, true)
    return high * 0x100000000 + low
  }

  // 写入64位无符号整数（8字节）
  writeUint64(view, offset, value) {
    // JavaScript中的安全整数范围是2^53-1，使用BigInt处理大数
    const bigValue = BigInt(value)
    const high = Number(bigValue >> 32n) & 0xFFFFFFFF
    const low = Number(bigValue & 0xFFFFFFFFn) & 0xFFFFFFFF
    view.setUint32(offset, low, true)
    view.setUint32(offset + 4, high, true)
  }

  // 读取64位无符号整数（8字节）
  readUint64(view, offset) {
    const low = view.getUint32(offset, true)
    const high = view.getUint32(offset + 4, true)
    return Number(BigInt(high) << 32n | BigInt(low))
  }

  // 编码二进制消息
  encodeBinaryMessage(message) {
    const messageTypes = {
      'file-start': 0x02,
      'file-end': 0x03,
      'request-retransmit': 0x05
    }

    const messageType = messageTypes[message.type]
    if (!messageType) {
      throw new Error(`不支持的消息类型: ${message.type}`)
    }

    // 通用头部：2字节type + 16字节id
    const idBytes = this.uuidStringToBytes(message.id)

    let buffer, view, uint8View, offset

    switch (message.type) {
      case 'file-start': {
        // 计算变长字段大小
        const nameBytes = new TextEncoder().encode(message.name)
        const typeBytes = new TextEncoder().encode(message.fileType)

        if (nameBytes.length > 65535 || typeBytes.length > 65535) {
          throw new Error('文件名或文件类型过长（最大65535字节）')
        }

        const totalSize = 18 + 8 + 6 + 6 + 2 + nameBytes.length + 2 + typeBytes.length
        buffer = new ArrayBuffer(totalSize)
        view = new DataView(buffer)
        uint8View = new Uint8Array(buffer)

        // 写入头部
        view.setUint16(0, messageType, true)
        uint8View.set(idBytes, 2)

        // 写入文件信息
        this.writeUint64(view, 18, message.size)
        this.writeUint48(view, 26, message.chunkSize)
        this.writeUint48(view, 32, message.totalChunks)

        // 写入文件名
        view.setUint16(38, nameBytes.length, true)
        uint8View.set(nameBytes, 40)

        // 写入文件类型
        offset = 40 + nameBytes.length
        view.setUint16(offset, typeBytes.length, true)
        uint8View.set(typeBytes, offset + 2)

        break
      }

      case 'file-end': {
        buffer = new ArrayBuffer(18)
        view = new DataView(buffer)
        uint8View = new Uint8Array(buffer)

        view.setUint16(0, messageType, true)
        uint8View.set(idBytes, 2)
        break
      }

      case 'request-retransmit': {
        const missingCount = message.missingChunks.length
        buffer = new ArrayBuffer(20 + missingCount * 6)
        view = new DataView(buffer)
        uint8View = new Uint8Array(buffer)

        view.setUint16(0, messageType, true)
        uint8View.set(idBytes, 2)
        view.setUint16(18, missingCount, true)

        // 写入缺失块索引
        for (let i = 0; i < missingCount; i++) {
          this.writeUint48(view, 20 + i * 6, message.missingChunks[i])
        }
        break
      }

      default:
        throw new Error(`未实现的消息类型编码: ${message.type}`)
    }

    return buffer
  }

  // CRC32 计算（用于数据完整性验证）
  generateCRC32Table() {
    if (this.crc32Table) return this.crc32Table
    
    const table = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let crc = i
      for (let j = 0; j < 8; j++) {
        crc = crc & 1 ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1
      }
      table[i] = crc
    }
    this.crc32Table = table
    return table
  }

  calculateCRC32(data) {
    const table = this.generateCRC32Table()
    let crc = 0xFFFFFFFF
    
    const uint8Data = data instanceof Uint8Array ? data : new Uint8Array(data)
    for (let i = 0; i < uint8Data.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ uint8Data[i]) & 0xFF]
    }
    
    return (crc ^ 0xFFFFFFFF) >>> 0
  }

  // 创建文件块组合消息
  createChunkMessage(id, chunkIndex, buffer) {
    const enableHashVerification = config.options.enableHashVerification || false
    
    // 创建二进制格式的组合消息
    // 格式（启用hash时）：[2字节type] [16字节id] [6字节chunkIndex] [6字节chunkSize] [4字节CRC32] [数据块]
    // 格式（未启用hash）：[2字节type] [16字节id] [6字节chunkIndex] [6字节chunkSize] [数据块]
    const BASE_HEADER_SIZE = 30
    const CRC32_SIZE = enableHashVerification ? 4 : 0
    const HEADER_SIZE = BASE_HEADER_SIZE + CRC32_SIZE
    const MAX_MESSAGE_SIZE = 256 * 1024 // 256KB
    const maxDataSize = MAX_MESSAGE_SIZE - HEADER_SIZE

    // 限制数据块大小
    const actualDataSize = Math.min(buffer.byteLength, maxDataSize)
    const actualBuffer = buffer.byteLength > maxDataSize ? buffer.slice(0, maxDataSize) : buffer

    // 计算CRC32（如果启用）
    let crc32 = 0
    if (enableHashVerification) {
      crc32 = this.calculateCRC32(actualBuffer)
    }

    // 创建固定长度的二进制元数据
    const combinedMessage = new ArrayBuffer(HEADER_SIZE + actualDataSize)
    const view = new DataView(combinedMessage)
    const uint8View = new Uint8Array(combinedMessage)

    // 写入type (2字节) - 使用0x01表示file-chunk-with-data（无hash）或0x06表示file-chunk-with-hash
    const messageType = enableHashVerification ? 0x06 : 0x01
    view.setUint16(0, messageType, true)

    // 写入id (16字节) - 将UUID字符串转换为16字节二进制
    const idBytes = this.uuidStringToBytes(id)
    uint8View.set(idBytes, 2)

    // 写入chunkIndex (6字节，48位整数)
    this.writeUint48(view, 18, chunkIndex)

    // 写入chunkSize (6字节，48位整数)
    this.writeUint48(view, 24, actualDataSize)

    let dataOffset = BASE_HEADER_SIZE
    
    // 写入CRC32（如果启用）
    if (enableHashVerification) {
      view.setUint32(BASE_HEADER_SIZE, crc32, true)
      dataOffset += CRC32_SIZE
    }

    // 写入数据块
    uint8View.set(new Uint8Array(actualBuffer), dataOffset)

    return combinedMessage
  }

  // 解码二进制消息
  decodeBinaryMessage(data) {
    if (data.byteLength < 18) {
      throw new Error('消息太短，无法解析')
    }

    const view = new DataView(data)
    const messageType = view.getUint16(0, true)

    // 读取ID
    const idBytes = new Uint8Array(data, 2, 16)
    const id = this.uuidBytesToString(idBytes)

    switch (messageType) {
      case 0x02: { // file-start
        if (data.byteLength < 42) {
          throw new Error('file-start消息长度不足')
        }

        const size = this.readUint64(view, 18)
        const chunkSize = this.readUint48(view, 26)
        const totalChunks = this.readUint48(view, 32)

        const nameLength = view.getUint16(38, true)
        if (data.byteLength < 42 + nameLength) {
          throw new Error('file-start消息长度不足（文件名）')
        }

        const nameBytes = new Uint8Array(data, 40, nameLength)
        const name = new TextDecoder().decode(nameBytes)

        const typeOffset = 40 + nameLength
        if (data.byteLength < typeOffset + 2) {
          throw new Error('file-start消息长度不足（文件类型长度）')
        }

        const typeLength = view.getUint16(typeOffset, true)
        if (data.byteLength < typeOffset + 2 + typeLength) {
          throw new Error('file-start消息长度不足（文件类型）')
        }

        const typeBytes = new Uint8Array(data, typeOffset + 2, typeLength)
        const fileType = new TextDecoder().decode(typeBytes)

        return {
          type: 'file-start',
          id,
          name,
          size,
          fileType,
          chunkSize,
          totalChunks
        }
      }

      case 0x03: { // file-end
        if (data.byteLength !== 18) {
          throw new Error('file-end消息长度错误')
        }

        return {
          type: 'file-end',
          id
        }
      }

      case 0x05: { // request-retransmit
        if (data.byteLength < 20) {
          throw new Error('request-retransmit消息长度不足')
        }

        const missingCount = view.getUint16(18, true)
        const expectedLength = 20 + missingCount * 6

        if (data.byteLength !== expectedLength) {
          throw new Error('request-retransmit消息长度错误')
        }

        const missingChunks = []
        for (let i = 0; i < missingCount; i++) {
          missingChunks.push(this.readUint48(view, 20 + i * 6))
        }

        return {
          type: 'request-retransmit',
          id,
          missingChunks
        }
      }

      default:
        throw new Error(`未知的消息类型: 0x${messageType.toString(16)}`)
    }
  }

  // 发送文件
  async sendFile(file) {
    return new Promise((resolve, reject) => {
      // 检查是否已有正在传输的文件
      if (this.currentTransfer) {
        reject(new Error('当前正在传输文件，请等待完成后再发送新文件'))
        return
      }

      // 检查连接和数据通道状态
      if (!this.isConnected || !this.dataChannel || this.dataChannel.readyState !== 'open') {
        reject(new Error('连接未建立或数据通道未打开'))
        return
      }

      const transfer = {
        id: this.generateUUID(),
        file,
        resolve,
        reject,
        progress: 0,
      }

      // 直接开始传输，不使用队列
      this.currentTransfer = transfer
      this.processFileTransfer()
    })
  }

  // 处理文件传输
  async processFileTransfer() {
    console.log('[P2P-DEBUG] processFileTransfer 被调用，当前状态:', {
      hasCurrentTransfer: !!this.currentTransfer,
      dataChannelState: this.dataChannel?.readyState,
      isConnected: this.isConnected
    })

    if (!this.currentTransfer) {
      console.error('[P2P-DEBUG] 没有当前传输任务')
      return
    }

    const { id, file } = this.currentTransfer

    // 保存文件传输记录以备重传
    this.lastSentFile = { id, file }

    try {
      const chunkSize = config.options.chunkSize
      const totalChunks = Math.ceil(file.size / chunkSize)

      // 发送文件元数据
      this.sendMessage({
        type: 'file-start',
        id,
        name: file.name,
        size: file.size,
        fileType: file.type,
        chunkSize: chunkSize,
        totalChunks: totalChunks,
      })

      // 并行传输配置
      let maxConcurrent = config.options.maxConcurrentChunks || 5 // 最大并发传输数
      let currentChunk = 0
      let completedChunks = 0
      let sentBytes = 0
      const activeTransfers = new Set()
      const failedChunks = new Set() // 记录失败的块
      const sentChunks = new Set() // 记录已发送的块

      // 动态调整并发数，根据队列满情况自动降低
      let queueFullCount = 0
      let consecutiveFailures = 0

      console.log(`[P2P-DEBUG] 开始发送 ${totalChunks} 个块`)

      // 发送单个块的函数
      const sendChunk = async (chunkIndex) => {
        const offset = chunkIndex * chunkSize
        const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size))
        const buffer = await chunk.arrayBuffer()

        // 简化发送逻辑：直接发送，让WebRTC自己处理流量控制

        // 创建组合消息（元数据+数据块）
        const combinedMessage = this.createChunkMessage(id, chunkIndex, buffer)

        // 发送组合消息（元数据+数据块）
        let retries = 0
        const maxRetries = 3

        while (retries <= maxRetries) {
          try {
            // 最后检查一次连接状态
            if (!this.isConnected || this.dataChannel.readyState !== 'open') {
              throw new Error('连接已断开')
            }

            // 二进制格式的组合消息已经限制在256KB以内，直接发送
            if (chunkIndex % 200 === 0) { // 减少日志噪音
              console.log(`[P2P-DEBUG] 发送二进制组合消息，块${chunkIndex}，总大小: ${combinedMessage.byteLength}`)
            }
            this.dataChannel.send(combinedMessage)

            if (chunkIndex % 200 === 0) { // 减少日志噪音
              console.log(`[P2P-DEBUG] ✅ 块${chunkIndex}发送完成`)
            }

            break // 发送成功，退出循环

          } catch (error) {
            retries++

            if (error.name === 'OperationError') {
              if (error.message.includes('send queue is full')) {
                queueFullCount++
                console.warn(`发送队列已满，等待清空... (重试 ${retries}/${maxRetries})`)

                // 动态降低并发数
                if (queueFullCount > 5 && maxConcurrent > 2) {
                  maxConcurrent = Math.max(2, Math.floor(maxConcurrent * 0.7))
                  console.log(`自动降低并发数到 ${maxConcurrent}`)
                }

                await new Promise((resolve) => setTimeout(resolve, 1000 * retries)) // 递增等待时间
              } else if (error.message.includes('Failure to send data')) {
                console.warn(`发送数据失败，可能是网络问题 (重试 ${retries}/${maxRetries})`)
                await new Promise((resolve) => setTimeout(resolve, 2000 * retries)) // 更长的等待时间
              } else {
                throw error // 其他错误直接抛出
              }
            } else {
              throw error // 非操作错误直接抛出
            }

            if (retries > maxRetries) {
              throw new Error(`发送失败，已重试 ${maxRetries} 次: ${error.message}`)
            }
          }
        }

        sentBytes += buffer.byteLength
        completedChunks++

        // 更新进度（增加空指针检查）
        if (this.currentTransfer) {
          this.currentTransfer.progress = sentBytes / file.size
          this.dispatchEvent(
            new CustomEvent('progress', {
              detail: {
                id,
                progress: this.currentTransfer.progress,
                completedChunks,
                totalChunks,
              },
            }),
          )
        }
      }

      // 并行发送块
      while ((currentChunk < totalChunks || activeTransfers.size > 0 || failedChunks.size > 0) && consecutiveFailures < 5) {
        // 检查连接状态
        if (!this.isConnected || this.dataChannel.readyState !== 'open') {
          console.log('[P2P-DEBUG] 检测到连接异常，尝试恢复:', {
            isConnected: this.isConnected,
            dataChannelState: this.dataChannel?.readyState,
            peerConnectionState: this.pc?.connectionState,
            iceConnectionState: this.pc?.iceConnectionState
          })

          // 给一点时间恢复连接
          await new Promise(resolve => setTimeout(resolve, 1000))

          if (!this.isConnected || this.dataChannel.readyState !== 'open') {
            console.error('[P2P-DEBUG] 连接恢复失败，终止传输:', {
              isConnected: this.isConnected,
              dataChannelState: this.dataChannel?.readyState,
              peerConnectionState: this.pc?.connectionState
            })
            throw new Error('连接已断开')
          } else {
            console.log('[P2P-DEBUG] 连接已恢复，继续传输')
          }
        }

        // 重试失败的块
        if (failedChunks.size > 0 && activeTransfers.size < maxConcurrent) {
          const retryChunk = failedChunks.values().next().value
          failedChunks.delete(retryChunk)
          console.log(`重试块 ${retryChunk}`)

          const transferPromise = sendChunk(retryChunk)
            .then(() => {
              console.log(`[P2P-DEBUG] ✅ 重试块 ${retryChunk} 传输成功`)
              sentChunks.add(retryChunk)
              activeTransfers.delete(transferPromise)
              consecutiveFailures = 0 // 重置连续失败计数
            })
            .catch((error) => {
              console.error(`[P2P-DEBUG] ❌ 重试块 ${retryChunk} 传输失败:`, error.message)
              activeTransfers.delete(transferPromise)
              failedChunks.add(retryChunk) // 重新加入失败队列
              consecutiveFailures++

              // 如果是队列满错误，降低并发数
              if (error.message?.includes('send queue is full') && maxConcurrent > 2) {
                maxConcurrent = Math.max(2, maxConcurrent - 1)
                console.log(`重试失败，降低并发数到 ${maxConcurrent}`)
              }
            })

          activeTransfers.add(transferPromise)
        }

        // 启动新的传输任务
        while (activeTransfers.size < maxConcurrent && currentChunk < totalChunks) {
          const chunkIndex = currentChunk++
          if (chunkIndex % 100 === 0) { // 每100个块输出一次进度
            console.log(`[P2P-DEBUG] 🚀 启动块 ${chunkIndex}/${totalChunks} 传输`)
          }

          const transferPromise = sendChunk(chunkIndex)
            .then(() => {
              if (chunkIndex % 100 === 0) { // 每100个块输出一次进度
                console.log(`[P2P-DEBUG] ✅ 块 ${chunkIndex} 传输成功`)
              }
              sentChunks.add(chunkIndex)
              activeTransfers.delete(transferPromise)
              consecutiveFailures = 0 // 重置连续失败计数
            })
            .catch((error) => {
              console.error(`[P2P-DEBUG] ❌ 块 ${chunkIndex} 传输失败:`, error.message)
              activeTransfers.delete(transferPromise)
              failedChunks.add(chunkIndex) // 加入失败队列
              consecutiveFailures++

              // 如果是队列满错误，降低并发数
              if (error.message?.includes('send queue is full') && maxConcurrent > 2) {
                maxConcurrent = Math.max(2, maxConcurrent - 1)
                console.log(`队列满，降低并发数到 ${maxConcurrent}`)
              }
            })

          activeTransfers.add(transferPromise)
        }

        // 等待至少一个传输完成
        if (activeTransfers.size > 0) {
          await Promise.race(activeTransfers)


        } else if (failedChunks.size > 0) {
          // 如果没有活跃传输但有失败的块，等待一下再重试
          console.log(`等待重试 ${failedChunks.size} 个失败的块...`)
          // 如果连续失败次数过多，等待更长时间
          const waitTime = consecutiveFailures > 3 ? 5000 : 2000
          await new Promise(resolve => setTimeout(resolve, waitTime))
        }
      }



      // 检查是否有未完成的块
      if (failedChunks.size > 0 || consecutiveFailures >= 5) {
        throw new Error(`文件传输失败: ${failedChunks.size} 个块未能传输`)
      }

      console.log(`[P2P-DEBUG] 所有块发送完成，发送file-end信号`)

      // 发送文件结束信号
      try {
        this.sendMessage({
          type: 'file-end',
          id: id
        })
        console.log(`[P2P-DEBUG] file-end信号已发送`)
      } catch (error) {
        console.error(`[P2P-DEBUG] 发送file-end信号失败:`, error)
      }

      this.currentTransfer.resolve()
      this.currentTransfer = null

      // 如果用户标记为离线等待状态，清理标记但不立即关闭
      // 让保护机制在下次检查时发现传输完成并处理关闭
      if (this.userOfflinePending) {
        console.log('[P2P-DEBUG] 文件发送完成，用户已离线，等待保护机制处理关闭')
        // 不需要立即关闭，保护机制会在下次检查时发现传输完成
      }

      console.log('[P2P-DEBUG] 文件发送任务完成')
    } catch (error) {
      console.error(error)
      // this.currentTransfer.reject(error)
      this.currentTransfer = null
    }
  }

  // 发送消息
  sendMessage(message) {
    console.log('[P2P-DEBUG] 尝试发送二进制消息:', message.type, {
      dataChannelExists: !!this.dataChannel,
      dataChannelState: this.dataChannel?.readyState,
      isConnected: this.isConnected
    })

    // 检查数据通道状态
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      console.error('[P2P-DEBUG] 发送消息失败 - 数据通道状态:', this.dataChannel?.readyState)
      throw new Error('数据通道未打开')
    }

    // 使用二进制编码
    const binaryData = this.encodeBinaryMessage(message)

    console.log(`[P2P-DEBUG] 发送二进制消息 ${message.type}，大小: ${binaryData.byteLength}字节`)

    this.dataChannel.send(binaryData)
  }

  // 处理接收到的数据
  handleDataChannelMessage(data) {
    if (data instanceof ArrayBuffer) {
      // 检查是否是二进制格式消息
      if (data.byteLength >= 18) { // 至少包含最小头部
        const view = new DataView(data)
        const messageType = view.getUint16(0, true)

        // 检查是否是二进制协议消息类型
        if (messageType >= 0x01 && messageType <= 0x06) {
          try {
            if (messageType === 0x01 || messageType === 0x06) {
              // file-chunk-with-data的特殊处理（包含数据）
              const hasHash = messageType === 0x06
              const baseHeaderSize = 30
              const minHeaderSize = hasHash ? 34 : 30 // 带hash需要额外4字节
              
              if (data.byteLength >= minHeaderSize) {
                // 读取id (16字节)
                const idBytes = new Uint8Array(data, 2, 16)
                const id = this.uuidBytesToString(idBytes)

                // 读取chunkIndex (6字节)
                const chunkIndex = this.readUint48(view, 18)

                // 读取chunkSize (6字节)
                const chunkSize = this.readUint48(view, 24)

                let dataOffset = baseHeaderSize
                let crc32 = null
                
                // 读取CRC32（如果有）
                if (hasHash) {
                  crc32 = view.getUint32(baseHeaderSize, true)
                  dataOffset += 4
                }

                // 提取数据部分
                const fileData = data.slice(dataOffset, dataOffset + chunkSize)

                // 验证CRC32（如果有）
                if (hasHash) {
                  const calculatedCRC32 = this.calculateCRC32(fileData)
                  if (calculatedCRC32 !== crc32) {
                    console.error(`[P2P-DEBUG] ❌ 块${chunkIndex}的CRC32校验失败！期望: ${crc32.toString(16)}, 实际: ${calculatedCRC32.toString(16)}`)
                    // 可以在这里请求重传该块
                    return
                  } else {
                    console.log(`[P2P-DEBUG] ✅ 块${chunkIndex}的CRC32校验成功`)
                  }
                }

                console.log(`[P2P-DEBUG] 收到二进制组合消息，块${chunkIndex}，头部大小${dataOffset}，数据大小${fileData.byteLength}${hasHash ? '，已校验CRC32' : ''}`)

                // 创建兼容的metadata对象
                const metadata = {
                  type: 'file-chunk-with-data',
                  id,
                  chunkIndex,
                  chunkSize: fileData.byteLength,
                  hasHash,
                  crc32Verified: hasHash
                }

                // 直接处理，避免时序问题
                this.handleCombinedChunkMessage(metadata, fileData)
                return
              }
            } else {
              // 其他二进制消息类型的通用处理
              const message = this.decodeBinaryMessage(data)
              console.log(`[P2P-DEBUG] 收到二进制消息: ${message.type}，大小: ${data.byteLength}字节`)
              this.handleMessage(message)
              return
            }
          } catch (error) {
            console.error('[P2P-DEBUG] 解析二进制消息失败:', error)
          }
        } else {
          console.warn('[P2P-DEBUG] 收到未知消息类型:', messageType.toString(16))
        }
      } else {
        console.warn('[P2P-DEBUG] 收到过短的消息，长度:', data.byteLength)
      }
    } else {
      console.warn('[P2P-DEBUG] 收到非ArrayBuffer消息')
    }
  }

  // 处理组合消息（元数据+数据块）
  handleCombinedChunkMessage(metadata, fileData) {
    if (!this.receivingFile || this.receivingFile.id !== metadata.id) return

    // 如果chunkIndex重复传输
    if (!this.receivingFile.chunks.has(metadata.chunkIndex)) {
      this.receivingFile.chunks.set(metadata.chunkIndex, fileData)
      this.receivingFile.receivedChunks++
      this.receivingFile.receivedSize += fileData.byteLength
    } else {
      console.log(`[P2P-DEBUG] 块${metadata.chunkIndex}重复传输，跳过`)
    }

    console.log(`[P2P-DEBUG] 组合消息处理完成，块${metadata.chunkIndex}，进度: ${this.receivingFile.receivedChunks}/${this.receivingFile.totalChunks}`)

    // 发送进度事件（限流）
    const now = Date.now()
    if (now - this.receivingFile.lastProcessedTime > 100) {
      this.receivingFile.lastProcessedTime = now
      this.dispatchEvent(
        new CustomEvent('fileprogress', {
          detail: {
            id: this.receivingFile.id,
            progress: this.receivingFile.receivedSize / this.receivingFile.size,
            receivedChunks: this.receivingFile.receivedChunks,
            totalChunks: this.receivingFile.totalChunks,
          },
        }),
      )
    }

    // 检查是否可以完成文件接收
    this.checkFileCompletion(this.receivingFile.id)
  }

  // 处理消息
  handleMessage(message) {
    switch (message.type) {
      case 'file-start':
        this.startReceivingFile(message)
        break
      case 'file-end':
        this.handleFileEnd(message)
        break
      case 'request-retransmit':
        this.handleRetransmitRequest(message)
        break
    }
  }

  // 开始接收文件
  startReceivingFile(metadata) {
    this.receivingFile = {
      id: metadata.id,
      name: metadata.name,
      size: metadata.size,
      type: metadata.fileType,
      chunkSize: metadata.chunkSize,
      totalChunks: metadata.totalChunks,
      chunks: new Map(), // 使用 Map 存储块，支持乱序接收
      receivedChunks: 0,
      receivedSize: 0,
      lastProcessedTime: Date.now(),
    }



    this.dispatchEvent(
      new CustomEvent('filestart', {
        detail: metadata,
      }),
    )
  }

  // 处理文件结束信号
  handleFileEnd(message) {
    if (!this.receivingFile || this.receivingFile.id !== message.id) {
      console.log(`[P2P-DEBUG] 收到file-end但没有对应的接收文件，ID: ${message.id}`)
      return
    }

    console.log(`[P2P-DEBUG] 收到文件传输结束信号，开始分析接收情况...`)
    console.log(`[P2P-DEBUG] 当前状态: 已收到${this.receivingFile.receivedChunks}/${this.receivingFile.totalChunks}块`)

    // 检查是否所有块都已接收
    if (this.receivingFile.receivedChunks === this.receivingFile.totalChunks) {
      console.log(`[P2P-DEBUG] ✅ 所有块都已接收完成，完美传输！`)
      this.completeFileReception(this.receivingFile.id)
    } else {
      // 找出缺失的块
      const missingChunks = []
      for (let i = 0; i < this.receivingFile.totalChunks; i++) {
        if (!this.receivingFile.chunks.has(i)) {
          missingChunks.push(i)
        }
      }

      console.log(`[P2P-DEBUG] ❌ 检测到丢包情况:`)
      console.log(`[P2P-DEBUG] 总共应接收: ${this.receivingFile.totalChunks} 个块`)
      console.log(`[P2P-DEBUG] 实际接收到: ${this.receivingFile.receivedChunks} 个块`)
      console.log(`[P2P-DEBUG] 丢失数量: ${missingChunks.length} 个块`)
      console.log(`[P2P-DEBUG] 丢失率: ${((missingChunks.length / this.receivingFile.totalChunks) * 100).toFixed(2)}%`)
      console.log(`[P2P-DEBUG] 丢失的块索引: [${missingChunks.join(', ')}]`)

      // 尝试请求重传
      if (missingChunks.length > 0 && missingChunks.length <= 100) {
        console.log(`[P2P-DEBUG] 尝试请求重传 ${missingChunks.length} 个缺失块`)
        try {
          this.sendMessage({
            type: 'request-retransmit',
            id: this.receivingFile.id,
            missingChunks: missingChunks
          })
        } catch (error) {
          console.error(`[P2P-DEBUG] 重传请求发送失败:`, error)
        }
      } else if (missingChunks.length > 100) {
        console.log(`[P2P-DEBUG] 丢失块过多(${missingChunks.length}个)，可能需要重新发送整个文件`)
      }
    }
  }

  // 处理重传请求
  handleRetransmitRequest(message) {
    console.log(`[P2P-DEBUG] 收到重传请求，文件ID: ${message.id}，缺失块: ${message.missingChunks.join(', ')}`)

    // 检查是否有对应的文件传输记录
    if (!this.lastSentFile || this.lastSentFile.id !== message.id) {
      console.error(`[P2P-DEBUG] 没有找到对应的文件传输记录`)
      return
    }

    // 重传缺失的块
    this.retransmitChunks(this.lastSentFile.file, message.id, message.missingChunks)
  }

  // 重传指定的块
  async retransmitChunks(file, fileId, chunkIndexes) {
    console.log(`[P2P-DEBUG] 开始重传 ${chunkIndexes.length} 个块`)

    const chunkSize = config.options.chunkSize

    for (const chunkIndex of chunkIndexes) {
      try {
        const offset = chunkIndex * chunkSize
        const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size))
        const buffer = await chunk.arrayBuffer()

        // 创建组合消息（元数据+数据块）
        const combinedMessage = this.createChunkMessage(fileId, chunkIndex, buffer)

        // 检查连接状态
        if (!this.isConnected || this.dataChannel.readyState !== 'open') {
          throw new Error('连接已断开')
        }

        // 发送重传块
        this.dataChannel.send(combinedMessage)

        console.log(`[P2P-DEBUG] ✅ 重传块${chunkIndex}完成`)

        // 等待一小段时间避免过快发送
        await new Promise(resolve => setTimeout(resolve, 10))

      } catch (error) {
        console.error(`[P2P-DEBUG] 重传块${chunkIndex}失败:`, error)
        throw error // 重传失败直接抛出错误
      }
    }

    console.log(`[P2P-DEBUG] 重传完成`)

    // 重传完成后发送file-end消息
    try {
      this.sendMessage({
        type: 'file-end',
        id: fileId
      })
      console.log(`[P2P-DEBUG] 重传完成后file-end信号已发送`)
    } catch (error) {
      console.error(`[P2P-DEBUG] 发送重传file-end信号失败:`, error)
    }
  }



  // 检查文件是否可以完成
  checkFileCompletion(id) {
    if (!this.receivingFile || this.receivingFile.id !== id) {
      console.log(`[P2P-DEBUG] 文件接收状态已改变，跳过完成检查`)
      return
    }

    console.log(`[P2P-DEBUG] 检查文件完成状态: 已收到${this.receivingFile.receivedChunks}/${this.receivingFile.totalChunks}块`)

    // 检查完成条件：只需要所有块都已接收
    const allChunksReceived = this.receivingFile.receivedChunks === this.receivingFile.totalChunks

    if (allChunksReceived) {
      console.log(`[P2P-DEBUG] 所有块都已接收，立即完成文件接收`)
      this.completeFileReception(id)
    } else {
      console.log(`[P2P-DEBUG] 等待更多数据...`)
    }
  }

  // 完成文件接收
  completeFileReception(id) {
    if (!this.receivingFile || this.receivingFile.id !== id) {
      console.log(`[P2P-DEBUG] 文件接收状态已改变，跳过完成流程`)
      return
    }

    console.log(`[P2P-DEBUG] 开始完成文件接收流程，组装${this.receivingFile.totalChunks}个块...`)

    // 按索引顺序组装文件块
    const orderedChunks = []
    let actualFileSize = 0

    for (let i = 0; i < this.receivingFile.totalChunks; i++) {
      const chunk = this.receivingFile.chunks.get(i)
      if (chunk) {
        orderedChunks.push(chunk)
        actualFileSize += chunk.byteLength
      } else {
        console.error(`组装文件时发现缺失块: ${i}`)
      }
    }

    console.log(`文件组装完成: ${orderedChunks.length}/${this.receivingFile.totalChunks} 块, 总大小: ${actualFileSize}/${this.receivingFile.size}`)

    const blob = new Blob(orderedChunks, {
      type: this.receivingFile.type,
    })
    const file = new File([blob], this.receivingFile.name, {
      type: this.receivingFile.type,
    })

    // 最终验证文件大小
    const sizeError = Math.abs(file.size - this.receivingFile.size)
    if (sizeError > 1024) { // 允许1KB的误差
      console.warn(`文件大小不匹配: 接收到${file.size}, 期望${this.receivingFile.size}, 误差${sizeError}`)
    }

    this.dispatchEvent(
      new CustomEvent('filecomplete', {
        detail: { id, file },
      }),
    )

    this.receivingFile = null

    // 如果用户标记为离线等待状态，立即关闭连接
    if (this.userOfflinePending) {
      console.log('[P2P-DEBUG] 文件接收完成，用户已离线，立即关闭连接')
      setTimeout(() => this.close(), 100) // 稍微延迟以确保事件处理完成
    }
  }

  // 辅助方法
  async waitForIceGathering() {
    return new Promise((resolve) => {
      if (this.pc.iceGatheringState === 'complete') {
        resolve()
      } else {
        this.pc.onicegatheringstatechange = () => {
          if (this.pc.iceGatheringState === 'complete') {
            resolve()
          }
        }
      }
    })
  }

  async getLocalCandidates() {
    const candidates = []

    return new Promise((resolve) => {
      const timeout = setTimeout(
        () => resolve(candidates),
        config.options.iceGatheringTimeout,
      )

      this.pc.onicecandidate = (event) => {
        if (event.candidate) {
          const candidate = event.candidate.candidate
          if (
            candidate.includes('192.168.') ||
            candidate.includes('10.') ||
            candidate.includes('172.')
          ) {
            candidates.push(event.candidate)
          }
        } else {
          clearTimeout(timeout)
          resolve(candidates)
        }
      }
    })
  }

  // 添加 ICE 候选
  async addIceCandidate(candidate) {
    if (!this.pc) {
      console.warn('PeerConnection 尚未创建，缓存 ICE 候选')
      this.pendingCandidates.push(candidate)
      return
    }

    if (!this.pc.remoteDescription) {
      console.warn('远程描述尚未设置，缓存 ICE 候选')
      this.pendingCandidates.push(candidate)
      return
    }

    try {
      await this.pc.addIceCandidate(candidate)
      console.log('成功添加 ICE 候选')
    } catch (error) {
      console.error('添加 ICE 候选失败:', error)
      throw error
    }
  }

  // 处理缓存的 ICE 候选
  async processPendingCandidates() {
    if (this.pendingCandidates.length === 0) return

    console.log(`处理 ${this.pendingCandidates.length} 个缓存的 ICE 候选`)

    for (const candidate of this.pendingCandidates) {
      try {
        await this.pc.addIceCandidate(candidate)
        console.log('成功添加缓存的 ICE 候选')
      } catch (error) {
        console.error('添加缓存的 ICE 候选失败:', error)
      }
    }

    this.pendingCandidates = []
  }

  // 关闭连接
  close() {
    if (this.dataChannel) {
      this.dataChannel.close()
    }
    if (this.pc) {
      this.pc.close()
    }
    this.isConnected = false
    this.pendingCandidates = []
  }
}

export { P2PConnection }
