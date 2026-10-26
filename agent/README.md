# Discord Agent 使用说明

这个 Agent 是「人生K线视频工厂」的常驻管家：主人在 Discord 里说一句「做一个辛弃疾」，它就调用 `tools/produce.mjs` 把取材、生成、审查、渲染、配音全跑完，成片直接发回聊天里。架构分工：

- `agent/bot.mjs`：Discord 入口。斜杠命令与按钮走确定性路径，自然语言（私信或 @机器人）走 LLM 大脑。
- `agent/brain.mjs`：LLM 函数调用循环（Gemini），只负责理解与转达，工具就是生产链本身。
- `agent/jobs.mjs`：串行任务队列 + `agent/state.json` 状态落盘，重启自动续跑没干完的任务。
- 双模式：`.env` 里 `OWNER_ID` 的人是主人（全功能）；其他人是客人（演示模式）：只能点演示目录，或消耗每日限量做 live 生成（默认每人每天 1 条、全局每天 5 条）。

## 五步配置（约 5 分钟，都在你手里完成）

1. 打开 Discord 开发者后台（discord.com/developers），New Application，随便起个名（如「K线管家」）。
2. 左侧 Bot 页：点 Reset Token 拿到机器人的 token；同页把 **MESSAGE CONTENT INTENT** 开关打开（不开机器人读不到消息内容，只会装傻）。
3. 左侧 OAuth2 → URL Generator：Scopes 勾 `bot` 和 `applications.commands`；Bot Permissions 勾 Send Messages、Attach Files、Read Message History、Use Slash Commands。打开生成的链接，把机器人邀请进你的服务器（演示模式就邀进演示服务器）。
4. 拿你的用户 ID：Discord 设置 → 高级 → 打开开发者模式，然后右键自己的头像 → 复制用户 ID。
5. 在仓库根目录把 `.env.example` 复制为 `.env`，填入 token、你的用户 ID、GEMINI_API_KEY（有 DEEPSEEK_API_KEY 也填上，审查会用它异源核查）。`.env` 已被 git 忽略，不会提交。

## 启动

```bash
npm install        # 第一次
npm run agent      # 或 node agent/bot.mjs
node agent/bot.mjs --dry-run   # 只自检配置与演示目录，不连接 Discord
```

开机自启（可选）：Windows 用任务计划程序建一个登录时触发的任务，程序填 `node`，参数填 `agent\bot.mjs`，起始于填仓库路径即可。

## 用法

- 私信机器人或在频道里 @它，用中文说：「做一个武则天」「苏轼的核查报告给我看」「做到哪了」。
- 斜杠命令：`/make`（带 id 最稳）、`/demo`（演示目录按钮）、`/status`、`/people`。
- 生产完成后机器人会先发带配音的成片，并等你补 BGM：把 mp3/wav 直接发给它，它自动合成最终版并发回；回复「就这样」则不定 BGM 定稿。
- 演示目录在 `agent/demo-catalog.json`：`video` 指向预渲染成片（点选秒回），为 `null` 的点选会现场生产。加人往这个文件里加一项即可。

## 常见问题

- 机器人在线但不理消息：MESSAGE CONTENT INTENT 没开，或消息没 @它（频道里默认只响应 @和命令，私信全响应）。
- `/命令` 不出现：没填 DISCORD_GUILD_ID 时是全局命令，传播要几分钟；填上服务器 ID 重启即立即生效。
- 成片没作为附件发出：超过 Discord 25MB 上限时只会给文件路径。长片可先压缩或走 R2 链接（后续课题）。
- 任务卡住：看 `agent/state.json` 里该任务的状态与 error；重启 Agent 会自动把未完成任务重新入队。

## 出问题怎么查

1. **看日志**：`agent/logs/agent-<日期>.log`（按天一份）记了启动、每条命令/消息、
   任务全生命周期和所有异常。出问题把当天日志最后几十行发出来就能定位。
2. **看进程**：运行 agent 的终端里进程还在不在。不在了就 `npm run agent` 重启，
   启动成功会打印「已登录」和「斜杠命令已注册」；起不来时错误也写在同一份日志里。
3. **看状态**：任务队列在 `agent/state.json`；每条视频的生产细节在 `out/logs/`。
   Discord 里命令「未响应」＝进程没在跑（或刚死），先按 1、2 查。
4. **「大脑调用失败（503/网络错误）」**：Gemini 服务端过载或请求超时，临时故障，
   不是 key 或代码问题。大脑已内置退避重试（单次上限 30 秒、共 3 次）与备用模型
   自动切换（gemini-3.5-flash-lite，超时/网络错误同样触发）；还失败就等几分钟再发一次。
   注意：gemini-2.5-flash 已被谷歌对新用户下线（404），不要再把它设成 BRAIN_MODEL；
   选主力/备用前先跑 `node tools/probe-gemini.mjs --list` 看这把 key 的可用名单。
   日志里搜「大脑」能看到每次失败的状态与是否切了备用模型。
