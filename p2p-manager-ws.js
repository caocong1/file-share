// p2p-manager-ws.js
// 支持 WebSocket 信令的 P2P 管理器

import { P2PConnection } from './p2p-connection.js'
import { config } from './config.js'

class P2PManagerWS {
  constructor() {
    this.connections = new Map()
    this.myId = null
    this.ws = null
    this.onFileReceived = null
    this.onPeerConnected = null
    this.onFileStart = null
    this.onFileProgress = null
    this.onFileFailed = null
    this.onUserOnline = null
    this.onUserOffline = null
    this.onUsersListReceived = null
    this.reconnectTimer = null
    this.messageQueue = []
    this.pendingRequests = new Map() // 存储待响应的请求 {requestId: {resolve, reject, timeout}}
    this.requestIdCounter = 0 // 请求ID计数器
  }

  // 初始化
  async init(wsUrl = null) {
    try {
      this.wsUrl = wsUrl || config.signalServer

      if (this.wsUrl) {
        // 转换 http:// 为 ws://
        if (this.wsUrl.startsWith('http://')) {
          this.wsUrl = this.wsUrl.replace('http://', 'ws://')
        } else if (this.wsUrl.startsWith('https://')) {
          this.wsUrl = this.wsUrl.replace('https://', 'wss://')
        }

        await this.connectWebSocket()
        console.log('使用 WebSocket 信令服务器:', this.wsUrl)
      } else {
        console.error('未配置信令服务器地址')
        return false
      }

      return true
    } catch (error) {
      console.error('初始化失败:', error)
      return false
    }
  }

  // 连接 WebSocket
  connectWebSocket() {
    return new Promise((resolve, reject) => {
      console.log('[WS-DEBUG] 尝试建立WebSocket连接:', this.wsUrl)
      this.ws = new WebSocket(this.wsUrl)

      this.ws.onopen = () => {
        console.log('[WS-DEBUG] WebSocket连接已建立:', this.wsUrl)
        console.log('[WS-DEBUG] WebSocket连接详情:', {
          readyState: this.ws.readyState,
          url: this.ws.url,
          protocol: this.ws.protocol,
          extensions: this.ws.extensions
        })

        // 如果有 ID，立即注册
        if (this.myId) {
          console.log('[WS-DEBUG] 立即注册用户ID:', this.myId)
          this.registerUser()
        }

        // 发送队列中的消息
        if (this.messageQueue.length > 0) {
          console.log('[WS-DEBUG] 处理待发送消息队列，数量:', this.messageQueue.length)
        }
        while (this.messageQueue.length > 0) {
          const msg = this.messageQueue.shift()
          this.ws.send(JSON.stringify(msg))
        }

        resolve()
      }

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          console.log('[WS-DEBUG] 收到WebSocket消息:', message.type, message.userId || message.from || message.to || '')
          this.handleSignalMessage(message)
        } catch (error) {
          console.error('[WS-DEBUG] 解析WebSocket消息失败:', error, 'Raw data:', event.data)
        }
      }

      this.ws.onclose = (event) => {
        console.log('[WS-DEBUG] WebSocket连接关闭详情:', {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
          timestamp: new Date().toISOString()
        })
        this.handleDisconnect()
      }

      this.ws.onerror = (error) => {
        console.error('[WS-DEBUG] WebSocket连接错误详情:', {
          error: error,
          type: error.type,
          target: error.target?.readyState,
          timestamp: new Date().toISOString()
        })
        reject(error)
      }
    })
  }

  // 重新连接WebSocket
  async reconnectWebSocket(skipAutoRegister = false) {
    console.log('重新连接WebSocket以清理服务器状态...')
    
    // 如果要跳过自动注册，临时保存当前ID并清空
    let tempId = null
    if (skipAutoRegister && this.myId) {
      tempId = this.myId
      this.myId = null
      console.log(`暂时清空ID以避免自动注册: ${tempId}`)
    }
    
    // 关闭现有连接
    if (this.ws) {
      this.ws.onclose = null // 临时移除close处理器，避免触发自动重连
      this.ws.close()
      this.ws = null
    }
    
    // 清除重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    
    // 等待一下再重新连接
    await new Promise(resolve => setTimeout(resolve, 200))
    
    // 重新建立连接
    await this.connectWebSocket()
    
    // 如果跳过了自动注册，返回临时保存的ID
    if (skipAutoRegister && tempId) {
      console.log(`WebSocket重连完成，返回临时ID: ${tempId}`)
      return tempId
    }
    
    console.log('WebSocket重连完成')
  }

  // 处理断开连接
  handleDisconnect() {
    console.log('[WS-DEBUG] 处理WebSocket断开连接，当前状态:', {
      myId: this.myId,
      hasReconnectTimer: !!this.reconnectTimer,
      pendingRequestsCount: this.pendingRequests.size,
      connectionCount: this.connections.size
    })
    
    // 清理所有待响应的请求
    for (const [requestId, request] of this.pendingRequests) {
      clearTimeout(request.timeout)
      request.reject(new Error('WebSocket连接已断开'))
    }
    this.pendingRequests.clear()
    
    // 只有在有用户ID且不是主动重连的情况下才自动重连
    if (!this.reconnectTimer && this.myId && this.ws) {
      console.log('[WS-DEBUG] 启动自动重连定时器')
      this.reconnectTimer = setTimeout(async () => {
        console.log('[WS-DEBUG] 开始自动重连...')
        try {
          await this.connectWebSocket()
          this.reconnectTimer = null
          console.log('[WS-DEBUG] 自动重连成功')
        } catch (error) {
          console.error('[WS-DEBUG] 自动重连失败:', error)
          this.handleDisconnect() // 继续尝试
        }
      }, 3000)
    } else {
      console.log('[WS-DEBUG] 跳过自动重连:', {
        hasReconnectTimer: !!this.reconnectTimer,
        hasMyId: !!this.myId,
        hasWs: !!this.ws
      })
    }
  }

  // 设置我的 ID
  setMyId(id) {
    this.myId = id

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.registerUser()
    }
  }

  // 注册用户
  registerUser() {
    this.sendSignalMessage({
      type: 'register',
      id: this.myId,
    })
  }

  // 注销用户 - 返回Promise
  unregisterUser() {
    if (!this.myId) {
      return Promise.resolve() // 如果没有ID，直接成功
    }
    
    return new Promise((resolve, reject) => {
      const requestId = this.generateRequestId()
      
      // 设置超时
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error('注销用户超时'))
      }, 10000) // 10秒超时
      
      // 保存请求信息
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout
      })
      
      console.log('注销用户:', this.myId)
      
      // 发送请求
      this.sendSignalMessage({
        type: 'unregister',
        id: this.myId,
        requestId: requestId
      })
    })
  }

  // 生成唯一请求ID
  generateRequestId() {
    return `req_${Date.now()}_${++this.requestIdCounter}`
  }

  // 获取在线用户列表 - 返回Promise
  getOnlineUsers() {
    return new Promise((resolve, reject) => {
      const requestId = this.generateRequestId()
      
      // 设置超时
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error('获取在线用户列表超时'))
      }, 10000) // 10秒超时
      
      // 保存请求信息
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout
      })
      
      // 发送请求
      this.sendSignalMessage({
        type: 'get-users',
        requestId: requestId
      })
    })
  }

  // 发送信令消息
  sendSignalMessage(message) {
    console.log('[WS-DEBUG] 尝试发送信令消息:', message.type, {
      wsExists: !!this.ws,
      wsReadyState: this.ws?.readyState,
      isConnected: this.isConnected
    })
    
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
      console.log('[WS-DEBUG] 信令消息已发送')
    } else {
      console.log('[WS-DEBUG] WebSocket未连接，消息加入队列:', {
        wsReadyState: this.ws?.readyState,
        messageType: message.type,
        queueLength: this.messageQueue.length + 1
      })
      // 如果未连接，加入队列
      this.messageQueue.push(message)
    }
  }

  // 连接到对等节点
  async connectToPeer(targetId) {
    if (this.connections.has(targetId)) {
      console.log('已存在连接:', targetId)
      return this.connections.get(targetId)
    }

    const connection = new P2PConnection(targetId)
    this.connections.set(targetId, connection)

    // 设置 STUN 服务器
    connection.iceServers = [
      {
        urls: config.stunServer,
      },
    ]

    // 监听文件接收事件
    connection.addEventListener('filestart', (event) => {
      this.onFileStart?.(event.detail, targetId)
    })

    connection.addEventListener('fileprogress', (event) => {
      this.onFileProgress?.(event.detail)
    })

    connection.addEventListener('filecomplete', (event) => {
      this.handleFileReceived(event.detail.file, targetId)
    })

    connection.addEventListener('filefailed', (event) => {
      this.onFileFailed?.(event.detail, targetId)
    })

    // 监听 ICE 候选
    connection.addEventListener('icecandidate', (event) => {
      this.sendSignalMessage({
        type: 'ice-candidate',
        from: this.myId,
        to: targetId,
        candidate: event.detail.toJSON
          ? event.detail.toJSON()
          : {
              candidate: event.detail.candidate,
              sdpMLineIndex: event.detail.sdpMLineIndex,
              sdpMid: event.detail.sdpMid,
              usernameFragment: event.detail.usernameFragment,
            },
      })
    })

    try {
      // 创建 WebRTC offer
      const offer = await connection.createOffer()

      // 发送 offer
      this.sendSignalMessage({
        type: 'offer',
        from: this.myId,
        to: targetId,
        offer: offer,
      })

      // 等待连接建立
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.connections.delete(targetId)
          reject(new Error('连接超时'))
        }, config.options.connectionTimeout)

        connection.onconnected = () => {
          clearTimeout(timeout)
          this.onPeerConnected?.(targetId)
          resolve(connection)
        }

        connection.onerror = (error) => {
          clearTimeout(timeout)
          this.connections.delete(targetId)
          reject(error)
        }
      })
    } catch (error) {
      this.connections.delete(targetId)
      throw error
    }
  }

  // 处理信令消息
  async handleSignalMessage(message) {
    switch (message.type) {
      case 'registered':
        console.log('注册成功:', message.id)
        break

      case 'unregistered':
        console.log('注销成功:', message.id)
        
        // 如果有requestId，说明这是对unregisterUser请求的响应
        if (message.requestId && this.pendingRequests.has(message.requestId)) {
          const request = this.pendingRequests.get(message.requestId)
          this.pendingRequests.delete(message.requestId)
          clearTimeout(request.timeout)
          request.resolve(message.id)
        }
        break

      case 'error':
        console.error('服务器错误:', message.message)
        
        // 检查是否是对某个请求的错误响应
        if (message.requestId && this.pendingRequests.has(message.requestId)) {
          const request = this.pendingRequests.get(message.requestId)
          this.pendingRequests.delete(message.requestId)
          clearTimeout(request.timeout)
          request.reject(new Error(message.message))
        }
        break

      case 'user-offline':
        console.log(`用户 ${message.userId} 已离线`)
        this.handleUserOffline(message.userId)
        break

      case 'user-online':
        console.log(`用户 ${message.userId} 已上线`)
        this.onUserOnline?.(message.userId)
        break

      case 'users-list':
        console.log('收到在线用户列表:', message.users)
        
        // 如果有requestId，说明这是对getOnlineUsers请求的响应
        if (message.requestId && this.pendingRequests.has(message.requestId)) {
          const request = this.pendingRequests.get(message.requestId)
          this.pendingRequests.delete(message.requestId)
          clearTimeout(request.timeout)
          request.resolve(message.users)
        }
        
        // 同时保持原有的事件回调机制
        this.onUsersListReceived?.(message.users)
        break

      case 'offer':
        if (message.to === this.myId) {
          await this.handleOffer(message)
        }
        break

      case 'answer':
        if (message.to === this.myId) {
          await this.handleAnswer(message)
        }
        break

      case 'ice-candidate':
        if (message.to === this.myId) {
          await this.handleIceCandidate(message)
        }
        break
    }
  }

  // 处理用户离线
  handleUserOffline(userId) {
    console.log('[WS-DEBUG] 处理用户离线:', userId)
    console.log('[WS-DEBUG] 当前P2P连接数:', this.connections.size)
    
    const connection = this.connections.get(userId)
    if (connection) {
      console.log('[WS-DEBUG] P2P连接状态:', {
        isConnected: connection.isConnected,
        dataChannelState: connection.dataChannel?.readyState,
        peerConnectionState: connection.pc?.connectionState,
        hasCurrentTransfer: !!connection.currentTransfer,
        hasReceivingFile: !!connection.receivingFile
      })

      // 检查是否有活跃的文件传输
      const hasActiveTransfer = connection.currentTransfer || connection.receivingFile
      
      if (hasActiveTransfer) {
        console.log('[WS-DEBUG] 检测到活跃文件传输，启动智能保护机制')
        
        // 标记用户为离线状态但暂不关闭连接
        connection.userOfflinePending = true
        connection.offlineStartTime = Date.now()
        
        // 启动智能延迟关闭机制
        this.startTransferProtectionMode(userId, connection)
      } else {
        console.log('[WS-DEBUG] 没有活跃传输，立即关闭与用户的P2P连接:', userId)
        connection.close()
        this.connections.delete(userId)
      }
    } else {
      console.log('[WS-DEBUG] 未找到用户的P2P连接:', userId)
    }
    
    // 通知前端用户离线
    this.onUserOffline?.(userId)
  }

  // 启动传输保护模式
  startTransferProtectionMode(userId, connection) {
    const maxProtectionTime = 5 * 60 * 1000 // 最大保护5分钟
    const checkInterval = 2000 // 每2秒检查一次
    
    console.log('[WS-DEBUG] 启动传输保护模式:', userId)
    
    const checkAndProtect = () => {
      const currentConnection = this.connections.get(userId)
      if (!currentConnection || currentConnection !== connection) {
        console.log('[WS-DEBUG] 连接已被移除，停止保护:', userId)
        return
      }
      
      const elapsedTime = Date.now() - connection.offlineStartTime
      const hasActiveTransfer = connection.currentTransfer || connection.receivingFile
      const isP2PHealthy = connection.isConnected && 
                          connection.dataChannel && 
                          connection.dataChannel.readyState === 'open'
      
      console.log('[WS-DEBUG] 传输保护检查:', {
        userId: userId,
        elapsedTime: Math.round(elapsedTime / 1000) + 's',
        hasActiveTransfer: hasActiveTransfer,
        isP2PHealthy: isP2PHealthy,
        dataChannelState: connection.dataChannel?.readyState,
        peerConnectionState: connection.pc?.connectionState
      })
      
      // 检查是否应该停止保护
      if (!hasActiveTransfer) {
        console.log('[WS-DEBUG] 传输已完成，停止保护并关闭连接:', userId)
        connection.close()
        this.connections.delete(userId)
        return
      }
      
      if (!isP2PHealthy) {
        console.log('[WS-DEBUG] P2P连接异常，停止保护并关闭连接:', userId)
        connection.close()
        this.connections.delete(userId)
        return
      }
      
      if (elapsedTime > maxProtectionTime) {
        console.log('[WS-DEBUG] 保护时间已达上限，强制关闭连接:', userId)
        connection.close()
        this.connections.delete(userId)
        return
      }
      
      // 继续保护，下次检查
      setTimeout(checkAndProtect, checkInterval)
    }
    
    // 开始第一次检查
    setTimeout(checkAndProtect, checkInterval)
  }

  // 处理收到的 offer
  async handleOffer(message) {
    let connection = this.connections.get(message.from)

    if (!connection) {
      connection = new P2PConnection(message.from)
      this.connections.set(message.from, connection)

      connection.iceServers = [
        {
          urls: config.stunServer,
        },
      ]

      connection.addEventListener('filestart', (event) => {
        this.onFileStart?.(event.detail, message.from)
      })

      connection.addEventListener('fileprogress', (event) => {
        this.onFileProgress?.(event.detail)
      })

      connection.addEventListener('filecomplete', (event) => {
        this.handleFileReceived(event.detail.file, message.from)
      })

      connection.addEventListener('filefailed', (event) => {
        this.onFileFailed?.(event.detail, message.from)
      })

      connection.addEventListener('icecandidate', (event) => {
        this.sendSignalMessage({
          type: 'ice-candidate',
          from: this.myId,
          to: message.from,
          candidate: event.detail.toJSON
            ? event.detail.toJSON()
            : {
                candidate: event.detail.candidate,
                sdpMLineIndex: event.detail.sdpMLineIndex,
                sdpMid: event.detail.sdpMid,
                usernameFragment: event.detail.usernameFragment,
              },
        })
      })
    }

    const answer = await connection.handleOffer(message.offer)

    // 发送应答
    this.sendSignalMessage({
      type: 'answer',
      from: this.myId,
      to: message.from,
      answer: answer,
    })

    connection.onconnected = () => {
      this.onPeerConnected?.(message.from)
    }
  }

  // 处理收到的 answer
  async handleAnswer(message) {
    const connection = this.connections.get(message.from)
    if (connection) {
      await connection.handleAnswer(message.answer)
    }
  }

  // 处理 ICE 候选
  async handleIceCandidate(message) {
    const connection = this.connections.get(message.from)
    if (connection) {
      try {
        const candidate = new RTCIceCandidate(message.candidate)
        await connection.addIceCandidate(candidate)
      } catch (error) {
        console.error('处理 ICE 候选失败:', error)
      }
    } else {
      console.warn(`收到来自 ${message.from} 的 ICE 候选，但连接不存在`)
    }
  }

  // 发送文件
  async sendFile(targetId, file, onProgress) {
    const connection = this.connections.get(targetId)
    if (!connection) {
      throw new Error('未找到连接')
    }

    // 等待数据通道打开
    let retries = 0
    while ((!connection.isConnected || !connection.dataChannel || connection.dataChannel.readyState !== 'open') && retries < 50) {
      console.log(`等待数据通道打开... (${retries + 1}/50)`)
      await new Promise(resolve => setTimeout(resolve, 100))
      retries++
    }

    if (!connection.isConnected || !connection.dataChannel || connection.dataChannel.readyState !== 'open') {
      throw new Error('数据通道未能打开')
    }

    if (onProgress) {
      const progressHandler = (event) => {
        onProgress(event.detail)
      }
      connection.addEventListener('progress', progressHandler)

      const cleanup = () => {
        connection.removeEventListener('progress', progressHandler)
      }

      try {
        await connection.sendFile(file)
        cleanup()
      } catch (error) {
        cleanup()
        throw error
      }
    } else {
      return connection.sendFile(file)
    }
  }

  // 处理接收到的文件
  handleFileReceived(file, fromId) {
    this.onFileReceived?.(file, fromId)

    // 自动下载
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    a.click()
    URL.revokeObjectURL(url)
  }

  // 断开所有连接
  disconnectAll() {
    console.log('断开所有P2P连接')
    
    // 关闭所有P2P连接
    for (const [peerId, connection] of this.connections) {
      console.log(`断开与 ${peerId} 的连接`)
      connection.close()
    }
    
    // 清空连接映射
    this.connections.clear()
  }

  // 清理
  cleanup() {
    // 尝试注销用户（不等待结果，因为可能正在清理中）
    this.unregisterUser().catch((error) => {
      console.warn('清理时注销用户失败:', error.message)
    })
    
    // 清理所有待响应的请求
    for (const [requestId, request] of this.pendingRequests) {
      clearTimeout(request.timeout)
      request.reject(new Error('P2P管理器已清理'))
    }
    this.pendingRequests.clear()
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    for (const connection of this.connections.values()) {
      connection.close()
    }
    this.connections.clear()

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
}

export { P2PManagerWS }
