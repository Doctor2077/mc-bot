# MC Bot — Voyager 架构的 Minecraft AI 机器人

基于 [mineflayer](https://github.com/PrismarineJS/mineflayer) 的 Minecraft 1.20.1 AI 机器人，Voyager 风格：AI 理解任务后**现场生成 JS 代码**，在 `vm.runInNewContext` 沙箱中执行（同步 10s / 异步 30s 看门狗超时），失败时携带错误信息反馈重试，成功的代码存入 `skills.json` 技能库复用。

## 功能特性

- **任务闭环**：AI 理解 → 生成代码 → 沙箱执行 → 失败带错误反馈重试（最多 3 次）
- **技能库**：`skills.json` 持久化可复用技能，越用越强
- **寻路与采集**：多级找树、漫游、搭柱放方块、砍树站位（mineflayer-collectblock + pathfinder）
- **脱困系统**：垫高 / 寻路，带冷却（30s）+ 连败上限（3 次），防止无限垫高死循环
- **状态面板**：零依赖 HTTP 面板（`127.0.0.1:8123`），`/status` 实时状态 + `/events` 事件流
- **诚实原则**：未真正执行成功的动作绝不声称完成，未命中指令如实说做不到

## 环境要求

- Node.js 18+
- 本地 Minecraft 1.20.1 服务器（`localhost:25565`）已启动
- DeepSeek API Key

## 安装与运行

```bash
git clone https://github.com/Doctor2077/mc-bot.git
cd mc-bot
npm install

# 配置密钥
cp .env.example .env   # Windows: copy .env.example .env，然后填入你的 KEY

# 启动
node bot.js
```

启动后浏览器打开 http://127.0.0.1:8123/status 查看实时状态。

## 项目结构

```
mc-bot/
├── bot.js            # 主文件：mineflayer 连接 + AI 循环 + 沙箱执行 + 脱困系统
├── skills.json       # 技能库（AI 生成的可复用代码）
├── .env.example      # 密钥配置样例
└── claude-live/
    ├── server.js     # 状态面板 HTTP 服务（零依赖）
    └── index.html    # 状态面板页面
```

## 设计决策（踩坑记录）

- **代码生成看门狗**：AI 生成的代码可能包含死循环，`vm.runInNewContext` + 同步 10s / 异步 30s 超时保证主循环永不卡死
- **脱困系统必须有冷却与连败上限**：否则 `pillarUp` 反复失败会形成无限垫高死循环（实测踩过）
- **触发词要收紧**：疑问句式（"放好了吗"）不应触发放置动作
- **防幻觉**：放方块走 `placeNamedBlock` 确认真实存在，不凭空声称

## License

[MIT](LICENSE)
