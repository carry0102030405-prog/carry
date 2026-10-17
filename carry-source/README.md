# carry

**carry** 是一个 Chrome 侧边栏扩展：让多个网页版 AI（ChatGPT、Claude、Gemini、Grok）用**你自己已登录的账号**互相对话、讨论甚至辩论，你只需要在旁边引导话题。

基于 [TED-H-com/multi-ai-chat](https://github.com/TED-H-com/multi-ai-chat) 修改。感谢原作者 Theodore Huang 以 MIT 许可证开源了 Multi-AI Chat，carry 的页面读写、侧边栏和工作流框架都来自原项目。

> English summary is at the [bottom](#english).

## 它能做什么

- 你在侧边栏输入一句话，它发给第一个 AI；第一个 AI 回复后，回复会被自动粘贴发送给下一个 AI，依次轮流，直到达到你设定的轮数。
- 使用的是你在浏览器里已经登录的网页版 AI（各家的订阅也照常可用），不需要任何 API Key。
- 对话进行中你可以随时插话，你的话会附在下一位 AI 收到的消息里。

## 相对原项目的主要改动

- **只保留一种模式：自由模式**。去掉了原来的辩论 / 咨询 / 编程 / 圆桌等预设模式和复杂的引导词，内容由人来引导。
- **AI 数量随意**：不再要求四个 AI 同时打开，选 1 个、2 个或更多都可以；点选顺序就是发言顺序，轮数可设 1–50（默认 6）。
- **新的转发格式**（固定文本）：
  - 引导句 L：
    - 2 个 AI：`接下来和你对话的是另一个 AI：{对方}。你的回复会直接转给它。`
    - 3 个及以上：`这是一场多个 AI 的讨论，参与者有 {A、B、C}，按顺序轮流发言。你的回复会转给下一位。`
  - 每个 AI 在本对话中的第一次发言：
    - 第一个 AI 收到：
      ```
      <来自用户>：
      {用户的发言}

      {L}
      ```
    - 其他 AI 收到：
      ```
      <来自用户>：
      {用户的发言}

      {L}
      下面是 {上一位} 的回复：
      <来自 {上一位}>：
      {上一位的回复}
      ```
  - 之后的每一轮只发：`<来自 {上一位}>：` + 换行 + 回复内容。
  - 对话中途插话：只附在下一轮，格式为 `<来自用户>：{你的话}`，空一行，再接 `<来自 {上一位}>：{回复}`。如果下一轮恰好是某个 AI 的第一次发言，就用上面的“第一次发言”格式，把你的话当作用户发言。
  - 在同一个对话里再发一条新消息：第一个 AI 收到 `<来自用户>：{新消息}`；已经介绍过的 AI 不再重复引导句；从未参与过的 AI 收到完整的首次格式。
  - 只有一个 AI 时，直接发送原文。
- **更稳的回复识别与粘贴发送**，特别针对 Grok 和 Gemini：
  - 站点选择器之外，增加通用兜底：以刚发送的提问为锚点，查找新出现的回复块；
  - “正在生成”的信号只有在页面上真的可见时才算数；
  - 文本持续稳定约 14 秒即视为回复完成（兜底）；
  - 后台标签页的定时器会被 Chrome 节流，扩展会每 4 秒从后台唤醒一次检测；
  - 页面 SPA 跳转（如 Grok 发送后改变网址）不会被误判为刷新。
  - 识别失败时可以选择：重新读取回复、手动粘贴回复、重试、跳过或取消。
- **自动切到前台**：Chrome 会限制后台标签页，导致 Gemini / Grok 在后台时生成变慢甚至卡住。轮到某个 AI 时，扩展会把它的标签页切到前台，回复完成（或出错、停止）后切回你原来的页面；连续几轮之间不会来回闪。可在设置中关闭（默认开启）。不会把 Chrome 抢到其他程序前面。
- **＋ 新对话只在扩展内开始新对话**，不会去刷新或新建各个 AI 网页里的对话。
- **聊天区域可以拖动调整大小**：消息区和输入框之间、顶部设置区和消息区之间各有一条拖动条（双击恢复默认），输入框本身也可以上下拉伸；大小会被记住。
- **🩺 诊断按钮**：把各 AI 页面的状态和最近的运行日志保存到“下载”文件夹，同时复制到剪贴板，方便排查识别问题。注意：诊断报告可能包含页面上的对话内容，分享前请自行检查。
- 扩展名称改为 carry。

原项目的其他功能（例如导出 Markdown、发布到 HackMD、实验性的 Meta AI 支持、多语言界面）仍保留。

## 安装（使用 Release 里的 zip）

1. 在本仓库的 Releases 页面下载 `carry-x.y.z.zip`，解压到一个固定的文件夹（之后不要删除或移动它）。
2. 打开 Chrome，地址栏输入 `chrome://extensions`，打开右上角的 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择刚才解压出来、包含 `manifest.json` 的文件夹。
4. 在扩展的 **详情** 页面，确认 **网站访问权限** 中 `chatgpt.com`、`chat.openai.com`、`claude.ai`、`gemini.google.com`、`grok.com` 都已开启。
5. 点击工具栏上的 carry 图标打开侧边栏，在各个 AI 网站登录你的账号，然后在侧边栏里选择参与的 AI 和顺序，开始对话。

更新时：用新版本的文件覆盖同一个文件夹，然后在 `chrome://extensions` 里点该扩展的刷新按钮。

## 从源码构建

需要 Node.js **22.18.0 或更高版本**。

```bash
npm ci
npm run build    # 输出到 dist/，在 Chrome 中“加载已解压的扩展程序”选择 dist 文件夹
npm run verify   # 类型检查 + 全部测试 + 生产构建 + 版本号一致性检查
```

开发时可以用 `npm run dev`（webpack watch）。

## 隐私

- 扩展完全在你的浏览器本地运行，没有任何服务器，不收集、不上传任何数据。
- 它通过页面上的输入框和对话内容与各个 AI 网站交互，使用的是你浏览器里现有的登录状态；扩展本身不读取、不保存你的账号密码。
- 对话记录和设置保存在浏览器本地的扩展存储里。只有当你主动使用“发布到 HackMD”时，内容才会发送到 HackMD。

## 许可证

MIT，见 [LICENSE](LICENSE)。保留原作者的版权声明。

---

## English

**carry** is a Chrome side-panel extension that lets web AIs (ChatGPT, Claude, Gemini, Grok) talk to and debate each other using your own logged-in browser sessions, while you guide the conversation. It is a modified version of [TED-H-com/multi-ai-chat](https://github.com/TED-H-com/multi-ai-chat) by Theodore Huang (MIT).

Main changes vs upstream: a single relay mode ("自由模式") with any number of AIs and a configurable speaking order and turn count; short fixed relay wrappers that only tell each AI who it is talking with; more robust reply detection and paste/send (especially Grok and Gemini); automatic foreground switching so background-tab throttling does not stall a reply; "New chat" starts a new conversation inside the extension only; a resizable chat area; and a diagnostics button.

Install: download the release zip, unzip it, open `chrome://extensions`, enable Developer mode, click "Load unpacked", and make sure site access is on for the AI sites. Build from source with Node.js ≥ 22.18.0: `npm ci && npm run verify` (output in `dist/`). Everything runs locally in your browser; there is no server.
