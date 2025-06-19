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
      this.ws = new WebSocket(this.wsUrl)

      this.ws.onopen = () => {
        console.log('WebSocket 已连接')

        // 如果有 ID，立即注册
        if (this.myId) {
          this.registerUser()
        }

        // 发送队列中的消息
        while (this.messageQueue.length > 0) {
          const msg = this.messageQueue.shift()
          this.ws.send(JSON.stringify(msg))
        }

        resolve()
      }

      this.ws.onmessage = (event) => {
        const message = JSON.parse(event.data)
        this.handleSignalMessage(message)
      }

      this.ws.onclose = () => {
        console.log('WebSocket 已断开')
        this.handleDisconnect()
      }

      this.ws.onerror = (error) => {
        console.error('WebSocket 错误:', error)
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
    // 清理所有待响应的请求
    for (const [requestId, request] of this.pendingRequests) {
      clearTimeout(request.timeout)
      request.reject(new Error('WebSocket连接已断开'))
    }
    this.pendingRequests.clear()
    
    // 只有在有用户ID且不是主动重连的情况下才自动重连
    if (!this.reconnectTimer && this.myId && this.ws) {
      this.reconnectTimer = setTimeout(async () => {
        console.log('尝试重新连接...')
        try {
          await this.connectWebSocket()
          this.reconnectTimer = null
        } catch (error) {
          console.error('重连失败:', error)
          this.handleDisconnect() // 继续尝试
        }
      }, 3000)
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

  // 注销用户
  unregisterUser() {
    if (this.myId) {
      console.log('注销用户:', this.myId)
      this.sendSignalMessage({
        type: 'unregister',
        id: this.myId,
      })
    }
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    } else {
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

      case 'error':
        console.error('服务器错误:', message.message)
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
    const connection = this.connections.get(userId)
    if (connection) {
      connection.close()
      this.connections.delete(userId)
    }
    
    // 通知前端用户离线
    this.onUserOffline?.(userId)
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
    // 注销用户
    this.unregisterUser()
    
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
