# 快速开始指南 🚀

## 一键启动

```bash
# 1. 安装依赖
pnpm install

# 2. 开发模式（推荐）
npm run dev

# 3. 生产模式（使用 PM2）
npm run prod
```

## 访问应用
- **Web 界面**: http://localhost:3000
- **服务状态**: http://localhost:3001/status

## 常用命令

### 开发模式
```bash
npm start      # 基础启动
npm run dev    # 开发模式（带颜色日志）
```

### 生产模式 (PM2)
```bash
npm run prod              # 启动生产服务
npm run pm2:status        # 查看状态
npm run pm2:logs          # 查看日志
npm run pm2:stop          # 停止服务
npm run pm2:restart       # 重启服务
```

## 服务说明
- **Web 服务器** (3000): 提供静态文件和界面
- **信令服务器** (3001): 处理 P2P 连接信令

## 局域网访问
1. 启动服务：`HOST=0.0.0.0 npm start`
2. 获取本机 IP：`ipconfig` (Windows) 或 `ifconfig` (Mac/Linux)
3. 其他设备访问：`http://[您的IP]:3000`

## 故障排除
- 端口占用：使用 `WEB_PORT=8080 PORT=8001 npm start`
- PM2 问题：检查 `logs/` 目录下的日志文件
- 连接问题：确保防火墙允许端口 3000 和 3001

详细文档请查看 `README-USAGE.md` 