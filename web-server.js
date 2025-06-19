#!/usr/bin/env node

import http from 'http'
import { promises as fs } from 'fs'
import path from 'path'
import url from 'url'

// 配置
const PORT = process.env.WEB_PORT || 3000
const HOST = process.env.HOST || '0.0.0.0'

// MIME 类型映射
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject'
}

// 获取文件的 MIME 类型
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return mimeTypes[ext] || 'application/octet-stream'
}

// 创建 HTTP 服务器
const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = url.parse(req.url, true)
    let pathname = parsedUrl.pathname

    // 设置 CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    // 处理根路径，默认返回 index.html
    if (pathname === '/') {
      pathname = '/index.html'
    }

    // 构造文件路径
    const filePath = path.join(process.cwd(), pathname)
    
    // 安全检查：确保请求的文件在当前目录内
    const normalizedPath = path.normalize(filePath)
    const currentDir = process.cwd()
    if (!normalizedPath.startsWith(currentDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Forbidden: Access denied')
      return
    }

    try {
      // 检查文件是否存在
      const stats = await fs.stat(normalizedPath)
      
      if (stats.isFile()) {
        // 读取文件内容
        const data = await fs.readFile(normalizedPath)
        const mimeType = getMimeType(normalizedPath)
        
        res.writeHead(200, { 
          'Content-Type': mimeType,
          'Content-Length': data.length,
          'Cache-Control': 'no-cache' // 禁用缓存以便开发时实时更新
        })
        res.end(data)
        
        console.log(`✅ ${req.method} ${pathname} - ${stats.size} bytes`)
      } else if (stats.isDirectory()) {
        // 如果是目录，尝试返回 index.html
        const indexPath = path.join(normalizedPath, 'index.html')
        try {
          const indexData = await fs.readFile(indexPath)
          res.writeHead(200, { 
            'Content-Type': 'text/html',
            'Content-Length': indexData.length
          })
          res.end(indexData)
          console.log(`✅ ${req.method} ${pathname} -> index.html`)
        } catch (indexError) {
          // 返回目录列表
          const files = await fs.readdir(normalizedPath)
          const fileList = files.map(file => 
            `<li><a href="${path.join(pathname, file)}">${file}</a></li>`
          ).join('')
          
          const html = `
            <!DOCTYPE html>
            <html>
            <head>
              <title>Directory listing for ${pathname}</title>
              <style>
                body { font-family: Arial, sans-serif; margin: 40px; }
                h1 { color: #333; }
                ul { list-style: none; padding: 0; }
                li { margin: 8px 0; }
                a { text-decoration: none; color: #2196f3; }
                a:hover { text-decoration: underline; }
              </style>
            </head>
            <body>
              <h1>Directory listing for ${pathname}</h1>
              <ul>${fileList}</ul>
            </body>
            </html>
          `
          
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(html)
          console.log(`📁 ${req.method} ${pathname} - directory listing`)
        }
      }
    } catch (fileError) {
      // 文件不存在
      if (fileError.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' })
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>404 Not Found</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; margin-top: 100px; }
              h1 { color: #f44336; }
              p { color: #666; }
              a { color: #2196f3; text-decoration: none; }
              a:hover { text-decoration: underline; }
            </style>
          </head>
          <body>
            <h1>404 - File Not Found</h1>
            <p>The requested file <strong>${pathname}</strong> was not found.</p>
            <p><a href="/">Return to Home</a></p>
          </body>
          </html>
        `)
        console.log(`❌ ${req.method} ${pathname} - Not Found`)
      } else {
        throw fileError
      }
    }
  } catch (error) {
    console.error('Server error:', error)
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Internal Server Error')
  }
})

// 启动服务器
server.listen(PORT, HOST, () => {
  console.log(`🌐 Web Server started at http://${HOST}:${PORT}`)
  console.log(`📁 Serving files from: ${process.cwd()}`)
  console.log(`🔗 Open http://${HOST}:${PORT} to access the application`)
  console.log('Press Ctrl+C to stop the server')
})

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down web server...')
  server.close(() => {
    console.log('Web server closed')
    process.exit(0)
  })
})

// 错误处理
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use`)
    console.log(`Try using a different port: WEB_PORT=3001 npm run start`)
  } else {
    console.error('Server error:', error)
  }
  process.exit(1)
})

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason)
  process.exit(1)
}) 