# 素材与选型说明（模板 / 配音 / BGM）

本文件回答三个问题：东西都放在哪、谁来选、怎么选。
一句话机制：**三个 JSON 目录就是「说明书」，生成脚本的 LLM 读说明书选 id，
写进脚本 JSON，之后的渲染 / 配音 / 混音全按 id 执行。**

## 模板

- 元数据目录：`src/data/templates.json`（id、名称、适用题材、说明）
- 组件映射：`src/data/templates.ts`（id → React 组件）
- 组件本体：`src/LifeKline.tsx`（目前只有 `classic` 一个模板）
- 脚本里记录在 `template` 字段，生成器按目录的题材说明选。
- 新增模板 = templates.json 加一条 + 写一个组件 + templates.ts 注册一行，
  生成器下次自动会选，不用改生成器代码。

## 配音

- 说明书：`tools/voice-profiles.json`（每个音色一条：引擎、音色名、风格说明）
- **配音不是现成音频文件**：它是合成时按档案现合成的。脚本里 `voice.style`
  记录选中的音色 id，`tools/make-voice.mjs` 按档案调对应引擎
  （edge-tts / Gemini TTS / ElevenLabs）生成头尾两句旁白。
- 新增音色 = voice-profiles.json 加一条。

## BGM

- 风格说明书：`tools/bgm-styles.json`（风格 id、标签、说明）。生成器选
  `bgm_style` 并展开成 `bgm_tags`，供 `tools/music-prompt.mjs` 拼作曲提示词。
- 曲库：`assets/bgm/`，逐首登记在同目录 `manifest.json`
  （file / styles / bpm / mood / auto / note）。
  **音频文件不入 git**（.gitignore 已排除，曲库只存在于本机）；
  manifest.json 是文本台账，保留在 git 里，选曲与登记都以它为准。
- **自动选曲（2026-10-25 已接通）**：produce 在合成前按脚本 `bgm_style`
  查 manifest（`tools/pick-bgm.mjs`），命中 `auto: true`、styles 含该风格、
  且文件在本机存在的曲子就直接混音出最终版，不再等人工送歌。排序按高潮点
  与 40 秒的贴合度，前三名里按人物 id 哈希挑一首（同人重渲可复现、人与人
  分散）。原风格无候选回退默认风格；再无候选才回到等送歌的老流程
  （Discord 回传或 `--bgm` 指定，`--no-auto-bgm` 可关掉自动选曲）。
  为某人定制的曲子（如《折線》）不标 styles、保持 auto: false，永不入池。
