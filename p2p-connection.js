// p2p-connection.js
import { config } from './config.js'

class P2PConnection extends EventTarget {
  constructor(peerIP) {
    super()
    this.peerIP = peerIP
    this.pc = null
    this.dataChannel = null
    this.isConnected = false
    this.fileQueue = []
    this.currentTransfer = null
    this.pendingCandidates = [] // 缓存待添加的 ICE 候选
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
      // 合理的缓冲区阈值
      bufferedAmountLowThreshold: 4 * 1024 * 1024, // 4MB
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
        this.dispatchEvent(
          new CustomEvent('icecandidate', {
            detail: event.candidate,
          }),
        )
      }
    }

    this.pc.onconnectionstatechange = () => {
      console.log('连接状态:', this.pc.connectionState)
      if (this.pc.connectionState === 'connected') {
        this.isConnected = true
        this.onconnected?.()
      } else if (this.pc.connectionState === 'failed' || 
                 this.pc.connectionState === 'disconnected' ||
                 this.pc.connectionState === 'closed') {
        this.isConnected = false
        
        // 如果正在接收文件，触发失败事件
        if (this.receivingFile) {
          this.dispatchEvent(
            new CustomEvent('filefailed', {
              detail: {
                id: this.receivingFile.id,
                name: this.receivingFile.name,
                reason: '连接已断开',
                progress: this.receivingFile.receivedSize / this.receivingFile.size
              },
            }),
          )
          this.receivingFile = null
        }
        
        // 如果正在发送文件，拒绝 Promise
        if (this.currentTransfer) {
          this.currentTransfer.reject(new Error('连接已断开'))
          this.currentTransfer = null
        }
        
        this.onerror?.(new Error('连接失败'))
      }
    }
  }

  // 设置数据通道事件
  setupDataChannel() {
    this.dataChannel.binaryType = 'arraybuffer'

    this.dataChannel.onopen = () => {
      console.log('数据通道已打开')
      this.isConnected = true
      // 处理等待中的文件队列
      if (this.fileQueue.length > 0 && !this.currentTransfer) {
        console.log('开始处理文件队列...')
        this.processFileQueue()
      }
    }

    this.dataChannel.onclose = () => {
      console.log('数据通道已关闭')
      this.isConnected = false
      
      // 如果正在接收文件，触发失败事件
      if (this.receivingFile) {
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
      this.handleDataChannelMessage(event.data)
    }

    this.dataChannel.onerror = (error) => {
      console.error('数据通道错误:', error)
      
      // 如果正在传输文件，触发失败事件
      if (this.currentTransfer) {
        this.currentTransfer.reject(new Error('数据通道错误: ' + (error.error?.message || '未知错误')))
        this.currentTransfer = null
      }
      
      // 如果正在接收文件，触发失败事件
      if (this.receivingFile) {
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
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16 | 0
        const v = c === 'x' ? r : (r & 0x3 | 0x8)
        return v.toString(16)
      })
    }
    
    // 最后的备用方案：使用 Math.random（不够安全但能用）
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0
      const v = c === 'x' ? r : (r & 0x3 | 0x8)
      return v.toString(16)
    })
  }

  // 发送文件
  async sendFile(file) {
    return new Promise((resolve, reject) => {
      const transfer = {
        id: this.generateUUID(),
        file,
        resolve,
        reject,
        progress: 0,
      }

      this.fileQueue.push(transfer)

      // 检查连接和数据通道状态
      if (this.isConnected && this.dataChannel && this.dataChannel.readyState === 'open' && !this.currentTransfer) {
        this.processFileQueue()
      } else {
        console.log('连接或数据通道未就绪，文件已加入队列')
        // 如果数据通道还没准备好，会在 onopen 事件中处理队列
      }
    })
  }

  // 处理文件队列
  async processFileQueue() {
    if (this.currentTransfer || this.fileQueue.length === 0) return

    // 确保数据通道已打开
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      console.log('数据通道未打开，等待...')
      // 稍后重试
      setTimeout(() => this.processFileQueue(), 100)
      return
    }

    this.currentTransfer = this.fileQueue.shift()
    const { id, file } = this.currentTransfer

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
      
      // 动态调整并发数，根据队列满情况自动降低
      let queueFullCount = 0
      const initialMaxConcurrent = maxConcurrent

      // 发送单个块的函数
      const sendChunk = async (chunkIndex) => {
        const offset = chunkIndex * chunkSize
        const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size))
        const buffer = await chunk.arrayBuffer()

        // 保守但有效的缓冲区管理策略
        const maxBufferAmount = 16 * 1024 * 1024 // 16MB缓冲，平衡性能和稳定性
        const targetBufferAmount = 8 * 1024 * 1024 // 目标缓冲量8MB
        
        // 等待缓冲区有足够空间
        let waitCount = 0
        while (this.dataChannel.bufferedAmount > maxBufferAmount) {
          if (!this.isConnected || this.dataChannel.readyState !== 'open') {
            throw new Error('连接已断开')
          }
          
          waitCount++
          if (waitCount % 20 === 0) { // 适中的日志输出频率
            console.log(`等待缓冲区清空... 当前: ${(this.dataChannel.bufferedAmount / 1024 / 1024).toFixed(2)}MB`)
          }
          
          await new Promise((resolve) => setTimeout(resolve, 50)) // 给WebRTC足够时间处理
        }

        // 发送块元数据（使用保守的缓冲区检查）
        while (this.dataChannel.bufferedAmount > targetBufferAmount) {
          if (!this.isConnected || this.dataChannel.readyState !== 'open') {
            throw new Error('连接已断开')
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        
        this.sendMessage({
          type: 'file-chunk',
          id,
          chunkIndex,
          chunkSize: buffer.byteLength,
        })

        // 再次检查缓冲区后发送块数据
        while (this.dataChannel.bufferedAmount + buffer.byteLength > maxBufferAmount) {
          if (!this.isConnected || this.dataChannel.readyState !== 'open') {
            throw new Error('连接已断开')
          }
          await new Promise((resolve) => setTimeout(resolve, 30))
        }

        // 尝试发送，带重试机制
        let retries = 0
        const maxRetries = 3
        
        while (retries <= maxRetries) {
          try {
            // 最后检查一次连接状态
            if (!this.isConnected || this.dataChannel.readyState !== 'open') {
              throw new Error('连接已断开')
            }
            
            // WebRTC 数据通道的单个消息大小限制约为 256KB
            // 如果块大于这个限制，需要分片发送
            const MAX_MESSAGE_SIZE = 256 * 1024 // 256KB
            
            if (buffer.byteLength <= MAX_MESSAGE_SIZE) {
              // 小于限制，直接发送
              this.dataChannel.send(buffer)
            } else {
              // 大于限制，分片发送
              console.log(`块大小 ${buffer.byteLength} 超过限制，分片发送...`)
              let offset = 0
              let fragmentIndex = 0
              
              while (offset < buffer.byteLength) {
                const fragmentSize = Math.min(MAX_MESSAGE_SIZE, buffer.byteLength - offset)
                const fragment = buffer.slice(offset, offset + fragmentSize)
                
                // 检查缓冲区
                while (this.dataChannel.bufferedAmount > targetBufferAmount) {
                  if (!this.isConnected || this.dataChannel.readyState !== 'open') {
                    throw new Error('连接已断开')
                  }
                  await new Promise((resolve) => setTimeout(resolve, 20))
                }
                
                this.dataChannel.send(fragment)
                offset += fragmentSize
                fragmentIndex++
              }
              
              console.log(`块分成 ${fragmentIndex} 个片段发送完成`)
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
      const failedChunks = new Set() // 记录失败的块
      let consecutiveFailures = 0
      
      while ((currentChunk < totalChunks || activeTransfers.size > 0 || failedChunks.size > 0) && consecutiveFailures < 5) {
        // 检查连接状态
        if (!this.isConnected || this.dataChannel.readyState !== 'open') {
          // 给一点时间恢复连接
          await new Promise(resolve => setTimeout(resolve, 1000))
          if (!this.isConnected || this.dataChannel.readyState !== 'open') {
            throw new Error('连接已断开')
          }
        }

        // 重试失败的块
        if (failedChunks.size > 0 && activeTransfers.size < maxConcurrent) {
          const retryChunk = failedChunks.values().next().value
          failedChunks.delete(retryChunk)
          console.log(`重试块 ${retryChunk}`)
          
          const transferPromise = sendChunk(retryChunk)
            .then(() => {
              activeTransfers.delete(transferPromise)
              consecutiveFailures = 0 // 重置连续失败计数
            })
            .catch((error) => {
              activeTransfers.delete(transferPromise)
              failedChunks.add(retryChunk) // 重新加入失败队列
              consecutiveFailures++
              console.error(`块 ${retryChunk} 传输失败:`, error.message)
              
              // 如果是队列满错误，降低并发数
              if (error.message && error.message.includes('send queue is full') && maxConcurrent > 2) {
                maxConcurrent = Math.max(2, maxConcurrent - 1)
                console.log(`重试失败，降低并发数到 ${maxConcurrent}`)
              }
            })
          
          activeTransfers.add(transferPromise)
        }

        // 启动新的传输任务
        while (activeTransfers.size < maxConcurrent && currentChunk < totalChunks) {
          const chunkIndex = currentChunk++
          const transferPromise = sendChunk(chunkIndex)
            .then(() => {
              activeTransfers.delete(transferPromise)
              consecutiveFailures = 0 // 重置连续失败计数
            })
            .catch((error) => {
              activeTransfers.delete(transferPromise)
              failedChunks.add(chunkIndex) // 加入失败队列
              consecutiveFailures++
              console.error(`块 ${chunkIndex} 传输失败:`, error.message)
              
              // 如果是队列满错误，降低并发数
              if (error.message && error.message.includes('send queue is full') && maxConcurrent > 2) {
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

      // 发送结束标记
      this.sendMessage({
        type: 'file-end',
        id,
      })

      this.currentTransfer.resolve()
      this.currentTransfer = null

      // 继续处理队列
      this.processFileQueue()
    } catch (error) {
      console.error(error)
      // this.currentTransfer.reject(error)
      this.currentTransfer = null
      this.processFileQueue()
    }
  }

  // 发送消息
  sendMessage(message) {
    // 检查数据通道状态
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('数据通道未打开')
    }

    const data = JSON.stringify(message)
    const encoder = new TextEncoder()
    const msgData = encoder.encode(data)

    // 添加消息长度前缀
    const buffer = new ArrayBuffer(4 + msgData.byteLength)
    const view = new DataView(buffer)
    view.setUint32(0, msgData.byteLength, true)
    new Uint8Array(buffer, 4).set(msgData)

    this.dataChannel.send(buffer)
  }

  // 处理接收到的数据
  handleDataChannelMessage(data) {
    if (data instanceof ArrayBuffer) {
      if (data.byteLength >= 4) {
        const view = new DataView(data)
        const msgLength = view.getUint32(0, true)

        if (data.byteLength === 4 + msgLength) {
          // 这是一个完整的消息
          const msgData = new Uint8Array(data, 4)
          const decoder = new TextDecoder()
          const message = JSON.parse(decoder.decode(msgData))
          this.handleMessage(message)
        } else {
          // 这是文件数据
          this.handleFileData(data)
        }
      } else {
        // 文件数据块
        this.handleFileData(data)
      }
    }
  }

  // 处理消息
  handleMessage(message) {
    switch (message.type) {
      case 'file-start':
        this.startReceivingFile(message)
        break
      case 'file-chunk':
        this.handleFileChunkMetadata(message)
        break
      case 'file-end':
        this.finishReceivingFile(message.id)
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
      pendingChunks: new Map(), // 缓存待处理的块元数据
      unmatchedData: [], // 存储未匹配的数据
      lastProcessedTime: Date.now(),
    }

    this.dispatchEvent(
      new CustomEvent('filestart', {
        detail: metadata,
      }),
    )
  }



  // 处理块元数据
  handleFileChunkMetadata(metadata) {
    if (!this.receivingFile || this.receivingFile.id !== metadata.id) return

    // 添加到待处理列表，支持并行接收多个块
    this.receivingFile.pendingChunks.set(metadata.chunkIndex, {
      index: metadata.chunkIndex,
      size: metadata.chunkSize,
      timestamp: Date.now(),
    })
  }

  // 处理文件数据
  handleFileData(data) {
    if (!this.receivingFile) return

    // 查找匹配的块元数据
    let matchedMetadata = null
    let matchedIndex = null
    
    // 尝试匹配待处理的块
    for (const [index, metadata] of this.receivingFile.pendingChunks.entries()) {
      if (data.byteLength === metadata.size) {
        matchedMetadata = metadata
        matchedIndex = index
        break
      }
    }

    if (matchedMetadata) {
      // 立即处理匹配的数据
      this.receivingFile.chunks.set(matchedMetadata.index, data)
      this.receivingFile.receivedChunks++
      this.receivingFile.receivedSize += data.byteLength
      
      // 从待处理列表中移除
      this.receivingFile.pendingChunks.delete(matchedIndex)
      
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
    } else {
      // 如果没有匹配的元数据，添加到未匹配缓冲区
      if (!this.receivingFile.unmatchedData) {
        this.receivingFile.unmatchedData = []
      }
      
      this.receivingFile.unmatchedData.push({
        data: data.slice(), // 复制数据避免引用问题
        timestamp: Date.now(),
        size: data.byteLength
      })
      
      console.warn(`收到未匹配的数据块，大小: ${data.byteLength}，未匹配总数: ${this.receivingFile.unmatchedData.length}`)
      
      // 定期尝试匹配未匹配的数据
      this.tryMatchUnmatchedData()
    }
  }

  // 尝试匹配未匹配的数据
  tryMatchUnmatchedData() {
    if (!this.receivingFile || !this.receivingFile.unmatchedData || this.receivingFile.unmatchedData.length === 0) {
      return
    }

    const matched = []
    
    // 尝试匹配每个未匹配的数据
    for (let i = 0; i < this.receivingFile.unmatchedData.length; i++) {
      const unmatchedItem = this.receivingFile.unmatchedData[i]
      
      // 查找匹配的元数据
      for (const [index, metadata] of this.receivingFile.pendingChunks.entries()) {
        if (unmatchedItem.size === metadata.size) {
          // 找到匹配，立即处理
          this.receivingFile.chunks.set(metadata.index, unmatchedItem.data)
          this.receivingFile.receivedChunks++
          this.receivingFile.receivedSize += unmatchedItem.data.byteLength
          
          // 从待处理列表中移除
          this.receivingFile.pendingChunks.delete(index)
          
          matched.push(i)
          console.log(`成功匹配未匹配数据块，索引: ${metadata.index}，大小: ${unmatchedItem.size}`)
          break
        }
      }
    }
    
    // 移除已匹配的数据
    for (let i = matched.length - 1; i >= 0; i--) {
      this.receivingFile.unmatchedData.splice(matched[i], 1)
    }
    
    // 如果还有未匹配的数据，延迟重试
    if (this.receivingFile.unmatchedData.length > 0) {
      setTimeout(() => this.tryMatchUnmatchedData(), 100)
    }
  }

  // 执行最终的智能匹配
  performFinalMatching() {
    if (!this.receivingFile) return

    console.log(`开始最终智能匹配...`)
    console.log(`当前已接收块数: ${this.receivingFile.receivedChunks}/${this.receivingFile.totalChunks}`)
    console.log(`待处理元数据数量: ${this.receivingFile.pendingChunks.size}`)
    console.log(`未匹配数据数量: ${this.receivingFile.unmatchedData ? this.receivingFile.unmatchedData.length : 0}`)

    // 如果没有未匹配数据，直接返回
    if (!this.receivingFile.unmatchedData || this.receivingFile.unmatchedData.length === 0) {
      return
    }

    // 找出所有缺失的块索引
    const missingChunks = []
    for (let i = 0; i < this.receivingFile.totalChunks; i++) {
      if (!this.receivingFile.chunks.has(i)) {
        missingChunks.push(i)
      }
    }

    console.log(`缺失的块索引: ${missingChunks.join(', ')}`)

    // 智能匹配策略
    const matched = []
    
    // 策略1: 严格按大小匹配待处理的元数据
    for (let i = 0; i < this.receivingFile.unmatchedData.length; i++) {
      const unmatchedItem = this.receivingFile.unmatchedData[i]
      
      for (const [index, metadata] of this.receivingFile.pendingChunks.entries()) {
        if (unmatchedItem.size === metadata.size) {
          this.receivingFile.chunks.set(metadata.index, unmatchedItem.data)
          this.receivingFile.receivedChunks++
          this.receivingFile.receivedSize += unmatchedItem.data.byteLength
          this.receivingFile.pendingChunks.delete(index)
          matched.push(i)
          console.log(`策略1匹配成功: 块${metadata.index}, 大小${unmatchedItem.size}`)
          break
        }
      }
    }

    // 移除已匹配的数据
    for (let i = matched.length - 1; i >= 0; i--) {
      this.receivingFile.unmatchedData.splice(matched[i], 1)
    }

    // 策略2: 如果还有未匹配数据，尝试按缺失块的期望大小匹配
    if (this.receivingFile.unmatchedData.length > 0 && missingChunks.length > 0) {
      console.log(`尝试策略2: 按缺失块匹配，未匹配数据${this.receivingFile.unmatchedData.length}个，缺失块${missingChunks.length}个`)
      
      const matched2 = []
      const usedChunks = new Set()
      
      for (let i = 0; i < this.receivingFile.unmatchedData.length; i++) {
        const unmatchedItem = this.receivingFile.unmatchedData[i]
        
        // 计算期望的块大小
        for (const chunkIndex of missingChunks) {
          if (usedChunks.has(chunkIndex)) continue
          
          const expectedSize = this.calculateExpectedChunkSize(chunkIndex)
          
          // 允许一定的大小误差（考虑到可能的协议开销）
          const sizeDiff = Math.abs(unmatchedItem.size - expectedSize)
          const tolerance = Math.min(1024, expectedSize * 0.01) // 1KB或1%的误差
          
          if (sizeDiff <= tolerance) {
            this.receivingFile.chunks.set(chunkIndex, unmatchedItem.data)
            this.receivingFile.receivedChunks++
            this.receivingFile.receivedSize += unmatchedItem.data.byteLength
            matched2.push(i)
            usedChunks.add(chunkIndex)
            console.log(`策略2匹配成功: 块${chunkIndex}, 数据大小${unmatchedItem.size}, 期望大小${expectedSize}`)
            break
          }
        }
      }
      
      // 移除已匹配的数据
      for (let i = matched2.length - 1; i >= 0; i--) {
        this.receivingFile.unmatchedData.splice(matched2[i], 1)
      }
    }

    console.log(`最终智能匹配完成，剩余未匹配数据: ${this.receivingFile.unmatchedData.length}`)
  }

  // 计算期望的块大小
  calculateExpectedChunkSize(chunkIndex) {
    if (!this.receivingFile) return 0
    
    const { chunkSize, size, totalChunks } = this.receivingFile
    
    // 最后一个块可能比较小
    if (chunkIndex === totalChunks - 1) {
      const lastChunkSize = size % chunkSize
      return lastChunkSize === 0 ? chunkSize : lastChunkSize
    }
    
    return chunkSize
  }

  // 强制匹配 - 最后的尝试
  performForceMatching(missingChunks) {
    if (!this.receivingFile || !this.receivingFile.unmatchedData || this.receivingFile.unmatchedData.length === 0) {
      return
    }

    console.log(`开始强制匹配，缺失块: ${missingChunks.join(', ')}`)
    console.log(`可用未匹配数据: ${this.receivingFile.unmatchedData.map(item => item.size).join(', ')}`)

    const matched = []
    const usedChunks = new Set()

    // 策略1: 按期望大小匹配，允许更大的误差
    for (let i = 0; i < this.receivingFile.unmatchedData.length; i++) {
      const unmatchedItem = this.receivingFile.unmatchedData[i]
      
      for (const chunkIndex of missingChunks) {
        if (usedChunks.has(chunkIndex)) continue
        
        const expectedSize = this.calculateExpectedChunkSize(chunkIndex)
        const sizeDiff = Math.abs(unmatchedItem.size - expectedSize)
        
        // 更宽松的误差容忍度
        const tolerance = Math.min(10240, expectedSize * 0.05) // 10KB或5%的误差
        
        if (sizeDiff <= tolerance) {
          this.receivingFile.chunks.set(chunkIndex, unmatchedItem.data)
          this.receivingFile.receivedChunks++
          this.receivingFile.receivedSize += unmatchedItem.data.byteLength
          matched.push(i)
          usedChunks.add(chunkIndex)
          console.log(`强制匹配成功: 块${chunkIndex}, 数据大小${unmatchedItem.size}, 期望大小${expectedSize}, 误差${sizeDiff}`)
          break
        }
      }
    }

    // 移除已匹配的数据
    for (let i = matched.length - 1; i >= 0; i--) {
      this.receivingFile.unmatchedData.splice(matched[i], 1)
    }

    // 策略2: 如果数据块数量匹配，按顺序强制分配
    const remainingMissing = missingChunks.filter(index => !usedChunks.has(index))
    const remainingUnmatched = this.receivingFile.unmatchedData

    if (remainingMissing.length === remainingUnmatched.length && remainingMissing.length > 0) {
      console.log(`尝试按顺序强制分配 ${remainingMissing.length} 个剩余块`)
      
      // 按块索引排序
      remainingMissing.sort((a, b) => a - b)
      // 按数据大小排序（假设大块在前）
      remainingUnmatched.sort((a, b) => b.size - a.size)
      
      for (let i = 0; i < remainingMissing.length; i++) {
        const chunkIndex = remainingMissing[i]
        const unmatchedItem = remainingUnmatched[i]
        
        this.receivingFile.chunks.set(chunkIndex, unmatchedItem.data)
        this.receivingFile.receivedChunks++
        this.receivingFile.receivedSize += unmatchedItem.data.byteLength
        console.log(`强制顺序分配: 块${chunkIndex} <- 数据大小${unmatchedItem.size}`)
      }
      
      // 清空未匹配数据
      this.receivingFile.unmatchedData = []
    }

    console.log(`强制匹配完成，当前已接收: ${this.receivingFile.receivedChunks}/${this.receivingFile.totalChunks}`)
  }

  // 完成接收文件
  finishReceivingFile(id) {
    if (!this.receivingFile || this.receivingFile.id !== id) return

    // 最后尝试匹配所有未匹配的数据
    console.log(`文件传输结束，最后尝试匹配未匹配数据...`)
    
    // 智能匹配：不仅按大小匹配，还要考虑缺失的块
    this.performFinalMatching()
    
    // 多次尝试匹配，处理可能的时序问题
    for (let attempt = 0; attempt < 5; attempt++) {
      this.tryMatchUnmatchedData()
      
      // 如果没有未匹配数据了，跳出循环
      if (!this.receivingFile.unmatchedData || this.receivingFile.unmatchedData.length === 0) {
        break
      }
      
      console.log(`第${attempt + 1}次匹配尝试，剩余未匹配数据: ${this.receivingFile.unmatchedData.length}`)
    }

    // 检查是否接收到所有块
    if (this.receivingFile.receivedChunks !== this.receivingFile.totalChunks) {
      console.error(`文件块不完整: 收到 ${this.receivingFile.receivedChunks}/${this.receivingFile.totalChunks}`)
      
      // 输出缺失的块信息
      const missingChunks = []
      for (let i = 0; i < this.receivingFile.totalChunks; i++) {
        if (!this.receivingFile.chunks.has(i)) {
          missingChunks.push(i)
        }
      }
      console.error(`缺失的块: ${missingChunks.join(', ')}`)
      
      // 输出未匹配数据的信息
      if (this.receivingFile.unmatchedData && this.receivingFile.unmatchedData.length > 0) {
        console.error(`未匹配数据块数量: ${this.receivingFile.unmatchedData.length}`)
        const unmatchedSizes = this.receivingFile.unmatchedData.map(item => item.size)
        console.error(`未匹配数据大小: ${unmatchedSizes.join(', ')}`)
        
        // 尝试最后一次强制匹配
        console.log(`尝试最后一次强制匹配...`)
        this.performForceMatching(missingChunks)
        
        // 重新检查
        if (this.receivingFile.receivedChunks === this.receivingFile.totalChunks) {
          console.log(`强制匹配成功！继续完成文件接收`)
        } else {
          console.error(`强制匹配后仍然缺失 ${this.receivingFile.totalChunks - this.receivingFile.receivedChunks} 个块`)
        }
      }
      
      // 输出待处理元数据信息
      if (this.receivingFile.pendingChunks.size > 0) {
        console.error(`剩余待处理元数据: ${this.receivingFile.pendingChunks.size}`)
        const pendingSizes = Array.from(this.receivingFile.pendingChunks.values()).map(item => item.size)
        console.error(`待处理块大小: ${pendingSizes.join(', ')}`)
        
        // 输出期望的块大小对比
        for (const chunkIndex of missingChunks) {
          const expectedSize = this.calculateExpectedChunkSize(chunkIndex)
          console.error(`缺失块 ${chunkIndex} 期望大小: ${expectedSize}`)
        }
      }
      
      // 如果强制匹配后仍然不完整，报告失败
      if (this.receivingFile.receivedChunks !== this.receivingFile.totalChunks) {
        this.dispatchEvent(
          new CustomEvent('filefailed', {
            detail: {
              id: this.receivingFile.id,
              name: this.receivingFile.name,
              reason: '文件块不完整',
              progress: this.receivingFile.receivedSize / this.receivingFile.size,
              missingChunks: missingChunks
            },
          }),
        )
        this.receivingFile = null
        return
      }
    }

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
