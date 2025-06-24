#!/usr/bin/env node

import http from "node:http";
import url from "node:url";
import { WebSocket, WebSocketServer } from "ws";

// 配置
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || "0.0.0.0";

// 存储在线用户
const onlineUsers = new Map(); // userId -> { ws }
const connections = new Map(); // ws -> userId

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
	const parsedUrl = url.parse(req.url, true);

	// 设置 CORS 头
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");

	if (req.method === "OPTIONS") {
		res.writeHead(200);
		res.end();
		return;
	}

	if (parsedUrl.pathname === "/status") {
		// 健康检查端点
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				status: "running",
				onlineUsers: onlineUsers.size,
				timestamp: new Date().toISOString(),
			}),
		);
	} else {
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end(
			"WebSocket Signal Server\n使用 WebSocket 连接到此服务器进行 P2P 信令",
		);
	}
});

// 创建 WebSocket 服务器
const wss = new WebSocketServer({
	server,
	perMessageDeflate: false, // 禁用压缩以提高性能
});

console.log(`WebSocket 信令服务器启动在 ${HOST}:${PORT}`);
console.log(`状态检查: http://${HOST}:${PORT}/status`);

// 广播消息给指定用户
function sendToUser(userId, message) {
	const userInfo = onlineUsers.get(userId);
	if (userInfo && userInfo.ws.readyState === WebSocket.OPEN) {
		try {
			userInfo.ws.send(JSON.stringify(message));
			return true;
		} catch (error) {
			console.error(`发送消息给用户 ${userId} 失败:`, error.message);
			// 清理断开的连接
			cleanupUser(userId);
			return false;
		}
	}
	return false;
}

// 广播消息给所有在线用户
function broadcastToAll(message, excludeUserId = null) {
	let successCount = 0;
	const disconnectedUsers = [];

	for (const [userId, userInfo] of onlineUsers) {
		if (userId === excludeUserId) continue;

		if (userInfo.ws.readyState === WebSocket.OPEN) {
			try {
				userInfo.ws.send(JSON.stringify(message));
				successCount++;
			} catch (error) {
				console.error(`广播消息给用户 ${userId} 失败:`, error.message);
				disconnectedUsers.push(userId);
			}
		} else {
			disconnectedUsers.push(userId);
		}
	}

	// 清理断开的连接
	disconnectedUsers.forEach((userId) => cleanupUser(userId));

	return successCount;
}

// 清理用户连接
function cleanupUser(userId) {
	console.log(`[SERVER-DEBUG] 开始清理用户连接: ${userId}`);
	const userInfo = onlineUsers.get(userId);
	if (userInfo) {
		console.log(`[SERVER-DEBUG] 找到用户信息:`, {
			userId: userId,
			wsReadyState: userInfo.ws.readyState,
		});

		connections.delete(userInfo.ws);
		onlineUsers.delete(userId);
		console.log(
			`[SERVER-DEBUG] 用户 ${userId} 已离线，当前在线用户数: ${onlineUsers.size}`,
		);

		// 通知其他用户该用户离线
		const broadcastCount = broadcastToAll(
			{
				type: "user-offline",
				userId: userId,
			},
			userId,
		);

		console.log(`[SERVER-DEBUG] 向 ${broadcastCount} 个用户广播离线消息`);
	} else {
		console.log(`[SERVER-DEBUG] 未找到用户信息: ${userId}`);
	}
}

// 获取在线用户列表
function getOnlineUsersList() {
	return Array.from(onlineUsers.keys());
}

// WebSocket 连接处理
wss.on("connection", (ws, req) => {
	const clientIP = req.socket.remoteAddress;
	console.log(`新的 WebSocket 连接来自: ${clientIP}`);

	// 连接初始化
	console.log(`[SERVER-DEBUG] WebSocket连接建立完成: ${clientIP}`);

	ws.on("message", (data) => {
		try {
			const message = JSON.parse(data);
			handleMessage(ws, message);
		} catch (error) {
			console.error("解析消息失败:", error.message);
			ws.send(
				JSON.stringify({
					type: "error",
					message: "消息格式无效",
				}),
			);
		}
	});

	ws.on("close", (code, reason) => {
		const userId = connections.get(ws);
		console.log(`[SERVER-DEBUG] WebSocket连接关闭:`, {
			code: code,
			reason: reason?.toString(),
			userId: userId,
			clientIP: clientIP,
			timestamp: new Date().toISOString(),
		});

		if (userId) {
			cleanupUser(userId);
		}
	});

	ws.on("error", (error) => {
		const userId = connections.get(ws);
		console.error(`[SERVER-DEBUG] WebSocket错误:`, {
			error: error.message,
			userId: userId,
			clientIP: clientIP,
			wsReadyState: ws.readyState,
			timestamp: new Date().toISOString(),
		});

		if (userId) {
			cleanupUser(userId);
		}
	});
});

// 处理收到的消息
function handleMessage(ws, message) {
	const userId = connections.get(ws);

	console.log(`[SERVER-DEBUG] 收到消息:`, {
		type: message.type,
		from: message.id || message.from || userId || "unknown",
		to: message.to || "",
		wsReadyState: ws.readyState,
		timestamp: new Date().toISOString(),
	});

	switch (message.type) {
		case "register":
			handleRegister(ws, message);
			break;

		case "unregister":
			handleUnregister(ws, message);
			break;

		case "get-users":
			handleGetUsers(ws, message);
			break;

		case "offer":
		case "answer":
		case "ice-candidate":
			handleSignaling(ws, message);
			break;

		default:
			console.warn("未知消息类型:", message.type);
			ws.send(
				JSON.stringify({
					type: "error",
					message: `未知消息类型: ${message.type}`,
				}),
			);
	}
}

// 处理用户注册
function handleRegister(ws, message) {
	const userId = message.id;

	if (!userId || typeof userId !== "string" || userId.trim() === "") {
		ws.send(
			JSON.stringify({
				type: "error",
				message: "用户 ID 无效",
			}),
		);
		return;
	}

	// 检查 ID 是否已被占用
	if (onlineUsers.has(userId)) {
		const existingUser = onlineUsers.get(userId);
		if (
			existingUser.ws !== ws &&
			existingUser.ws.readyState === WebSocket.OPEN
		) {
			ws.send(
				JSON.stringify({
					type: "error",
					message: `用户 ID "${userId}" 已被占用`,
				}),
			);
			return;
		} else {
			// 清理旧连接
			cleanupUser(userId);
		}
	}

	// 清理当前 WebSocket 的旧注册（如果存在）
	const oldUserId = connections.get(ws);
	if (oldUserId && oldUserId !== userId) {
		cleanupUser(oldUserId);
	}

	// 注册新用户
	onlineUsers.set(userId, {
		ws: ws,
	});
	connections.set(ws, userId);

	console.log(`用户 ${userId} 已注册，当前在线用户数: ${onlineUsers.size}`);

	// 确认注册成功
	ws.send(
		JSON.stringify({
			type: "registered",
			id: userId,
		}),
	);

	// 自动推送当前在线用户列表给新用户
	const currentUsers = getOnlineUsersList().filter((id) => id !== userId);
	ws.send(
		JSON.stringify({
			type: "users-list",
			users: currentUsers,
		}),
	);

	// 通知其他用户新用户上线
	broadcastToAll(
		{
			type: "user-online",
			userId: userId,
		},
		userId,
	);
}

// 处理用户注销
function handleUnregister(ws, message) {
	const userId = message.id || connections.get(ws);

	if (userId) {
		cleanupUser(userId);

		const response = {
			type: "unregistered",
			id: userId,
		};

		// 如果请求中包含requestId，在响应中也包含
		if (message.requestId) {
			response.requestId = message.requestId;
		}

		ws.send(JSON.stringify(response));
	} else {
		// 如果找不到用户ID，返回错误
		const errorResponse = {
			type: "error",
			message: "未找到要注销的用户ID",
		};

		if (message.requestId) {
			errorResponse.requestId = message.requestId;
		}

		ws.send(JSON.stringify(errorResponse));
	}
}

// 处理获取在线用户列表
function handleGetUsers(ws, message = {}) {
	const userId = connections.get(ws);
	if (!userId) {
		const errorResponse = {
			type: "error",
			message: "请先注册用户 ID",
		};
		// 如果有requestId，也包含在错误响应中
		if (message.requestId) {
			errorResponse.requestId = message.requestId;
		}
		ws.send(JSON.stringify(errorResponse));
		return;
	}

	// 返回除自己以外的在线用户
	const users = getOnlineUsersList().filter((id) => id !== userId);

	const response = {
		type: "users-list",
		users: users,
	};

	// 如果请求中包含requestId，在响应中也包含
	if (message.requestId) {
		response.requestId = message.requestId;
	}

	ws.send(JSON.stringify(response));
}

// 处理信令消息（offer, answer, ice-candidate）
function handleSignaling(ws, message) {
	const fromUserId = connections.get(ws);

	if (!fromUserId) {
		ws.send(
			JSON.stringify({
				type: "error",
				message: "请先注册用户 ID",
			}),
		);
		return;
	}

	const { to, from } = message;

	// 验证消息格式
	if (!to) {
		ws.send(
			JSON.stringify({
				type: "error",
				message: "缺少目标用户 ID",
			}),
		);
		return;
	}

	// 确保 from 字段正确
	if (from && from !== fromUserId) {
		console.warn(`用户 ${fromUserId} 尝试冒充用户 ${from}`);
	}
	message.from = fromUserId; // 强制设置正确的发送者

	// 转发消息到目标用户
	const success = sendToUser(to, message);

	if (!success) {
		ws.send(
			JSON.stringify({
				type: "error",
				message: `用户 ${to} 不在线或连接已断开`,
			}),
		);
	}
}

// 定期统计在线用户
setInterval(() => {
	console.log(`当前在线用户数: ${onlineUsers.size}`);
}, 60000);

// 启动服务器
server.listen(PORT, HOST, () => {
	console.log(`服务器已启动: http://${HOST}:${PORT}`);
	console.log("按 Ctrl+C 停止服务器");
});

// 优雅关闭
process.on("SIGINT", () => {
	console.log("\n正在关闭服务器...");

	// 通知所有客户端服务器即将关闭
	broadcastToAll({
		type: "server-shutdown",
		message: "服务器即将关闭",
	});

	// 关闭所有连接
	wss.clients.forEach((ws) => {
		ws.close(1001, "服务器关闭");
	});

	// 关闭服务器
	server.close(() => {
		console.log("服务器已关闭");
		process.exit(0);
	});
});

// 错误处理
process.on("uncaughtException", (error) => {
	console.error("未捕获的异常:", error);
});

process.on("unhandledRejection", (reason, _promise) => {
	console.error("未处理的 Promise 拒绝:", reason);
});
