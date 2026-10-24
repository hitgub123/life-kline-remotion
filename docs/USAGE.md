# 使用文档：人生 K 线视频工厂

这份文档是自包含的。人或 AI 助手只读这一份，就能完成「新增一个人物并渲染出成片」的全部流程，不需要额外背景知识。

## 这是什么

把一个人物的一生画成股票 K 线图的竖屏短视频（1080×1920，30fps，约 66 秒）。风格：宣纸底、宋体大标题当叙事主角、密 K 线自动生长、关键事件带引线标注、去世时砸「退市」印章、结尾指数滚到 ∞ 并虚线冲顶。无旁白，底部白字是人物本人的一句代表作原文，配乐留给发布时在平台曲库选。

设计原则：内容与渲染分离。一个人物 = 一份 JSON 脚本，渲染器（React 组件）只读脚本。换人物只写新脚本，不改代码。

## 环境与安装

- Node.js 18 或更高版本
- 依赖安装：进入项目目录跑 `npm install`（只需第一次）
- ffmpeg 是系统命令，只有最后给成片补静音轨时才用，不装也能渲染

## 命令速查

以下命令都在项目根目录执行。Windows 把路径里的 `/` 换成 `\` 即可。

```bash
# 实时预览（浏览器打开，左侧选 Composition，可拖动播放）
npx remotion studio

# 抽一张静帧检查，--frame 是帧号（秒数乘 30）
npx remotion still LifeKline out/still.png --frame=960

# 渲染全片，第一个参数是 Composition 的 id
npx remotion render LifeKline out/libai.mp4
npx remotion render Newton out/newton.mp4

# 补静音音轨（发布到短视频平台时更稳妥）
ffmpeg -i out/newton.mp4 -f lavfi -i anullsrc=r=44100:cl=stereo -c:v copy -c:a aac -shortest out/newton-final.mp4
```

当前仓库已注册两个 Composition：`LifeKline`（李白）和 `Newton`（牛顿）。

## 新增一个人物：完整流程

### 第 1 步，写脚本

脚本是 JSON，放在 `src/data/` 下，例如 `src/data/newton.json`。先照着 `src/data/libai.json` 抄结构，再换内容。字段如下：

顶层：

- `subject` 人物信息
  - `name` 人名，片头和左上角用书法体显示
  - `title` 片名，一般写「人生K线图」
  - `birth_year` 出生年（公历）。画面右上角的年份按 `birth_year + age - 1` 计算
  - `stock_label` 片头副标，自己编一个，例如「万有引力股份 · 代码 1643」
  - `series` 左上角系列名，一般写「人生切片」
- `hook_dur` 片头标题卡秒数，固定 3.5
- `seed` 随机种子，固定 42，不要改。曲线噪声的形状由它决定，改了整条曲线就变了
- `keypoints` 人生关键点数组，每项 `[年龄, 指数, 标注或 null]`，一般 10 到 13 个
- `segments` 叙事分段数组，一般 10 段

关键点怎么写：

- 指数就是「人生股价」，自己设计：开局约 8 到 10，全片巅峰 45 到 50，谷底 3 到 6。落差越陡，视频越好看
- 标注是图上引线小字，只给最重要的节点写，2 到 5 个字，例如「供奉翰林」「奇迹年」「《原理》」
- 年龄口径要小心：画面显示的年份是 `birth_year + 年龄 - 1`。先定事件发生的年份，再反推年龄填多少，让两者对齐。标题句里尽量不要写精确年龄，用「20多岁」「年过半百」这类说法避开误差
- 事件、年份、年龄必须逐项核查史实，不要凭印象写

分段怎么写，每段对应一个人生阶段：

- `id` 段号，s1、s2 这样排
- `dur` 秒数，6 到 7，全片总时长控制在 60 到 70 秒（不含片头）
- `kp` 本段从第几个关键点走到第几个，写 `[from, to]`，下标从 0 起。相邻两段首尾相接，最后一段的 `kp` 是 `[最后一个, 最后一个]`
- `candles` 本段 K 线根数，10 到 30，阶段越长越多
- `vol` 波动率，0.06 到 0.18。命运动荡的段给大值，平稳期给小值
- `shape` 走势形状，1 是均匀，大于 1 表示后段加速（冲顶段用 1.5 到 1.7），小于 1 表示先急后缓
- `headline` 大标题，整段的叙事句。格式：数组是行，每行是 `[文本, 是否标红]` 片段的数组。一句白话叙事，把股市词或最有戏的词标红，例如腰斩、阴跌、暴涨、封神
  - 长度硬限制：每行所有片段加起来不要超过 10 个汉字（数字和字母算半个），超了会溢出画面。长句就拆成两行
- `quote` 底部白字，放人物本人最有名的一句作品原文或名言，逐句核对出处。没有合适的写 null，不要编造。长度不要超过 15 个汉字
- `stamp` 可选。去世那一段设为 true，本段结尾会砸下「退市」印章
- `rocket` 可选。最后一段设为 true，出现虚线冲顶，指数滚动到 ∞

K 线本体不用写。渲染器在关键点之间用布朗桥自动填充带噪声的小蜡烛，坐标轴自动缩放，成交量、涨停跌停小标签都是自动的。

### 第 2 步，注册 Composition

在 `src/Root.tsx` 里照着 Newton 的写法加一段，id 用人物英文名，`defaultProps` 传入新脚本，`durationInFrames` 用 `totalFrames(脚本)` 计算，不要手填。

### 第 3 步，抽帧检查

先算每段的起始秒数：片头 3.5 秒，之后按每段 `dur` 累加。秒数乘 30 是帧号。用 `npx remotion still <id> out/check.png --frame=<帧号>` 抽这 6 类帧逐张看：

- 片头卡（约第 54 帧）：人名书法体是否正常，副标居中
- 第一段中段：K 线开始生长，左上角人名和指数出现
- 巅峰段：标注不重叠，指数是全片最大值
- 谷底段：曲线跌到底，标注位置正常
- 印章段最后 1 秒：退市印章出现，右上角出现「退市」小字
- 最后一段中段：虚线冲顶画出，指数显示 ∞，底部引言完整不超宽

还要通查三件事：大标题没有溢出画面，纵轴刻度从 0 附近起（出现负数说明关键点指数有负值或过小），标注文字不互相压盖。

### 第 4 步，渲染

抽帧没问题后跑 `npx remotion render <id> out/<名字>.mp4`，约 5 分钟。需要发布的话按命令速查补静音轨。

## 进阶：音乐卡点

视频和音乐共用一张拍点网格，做到段落级对齐：

- 脚本顶层有 `bpm`（缺省 120）。渲染器按半拍（120 BPM 时 0.25 秒）网格安排每根蜡烛的出现时刻，蜡烛跳动天然合拍
- 每段 `dur` 必须是 0.5 的整数倍，段界才会落在拍点上。生成工具会对此报警
- 音乐按同一个 BPM 生成。用 `tools/music-prompt.mjs` 从脚本生成提示词，它会算好段界时间并写成时间标记（高潮落在巅峰段开始、安静段落在谷底段、结尾前收住再扬起）：

```bash
node tools/music-prompt.mjs src/data/newton.json                 # 纯音乐
node tools/music-prompt.mjs src/data/newton.json --mode vocal    # 带人声
```

- 生成不用开网页：`tools/generate-music.mjs` 直接调 Flow Music 背后的同一个模型（Lyria 3.5，Gemini API），提示词由上一步自动拼好：

```bash
GEMINI_API_KEY=xxx node tools/generate-music.mjs --script src/data/newton.json --mode vocal --takes 3
```

曲子落在 `assets/bgm/`，带人声的会同时存一份歌词 `.lyrics.txt`。费用约 $0.08 一首、没有免费层，key 必须来自开了付费的 Google Cloud 项目，AI Pro 订阅额度不能抵 API 的账。API 是单轮生成，没有网页版「只改副歌」那种迭代编辑，不满意就改提示词重生一首。提示词也可以粘进 Flow Music 网页手动生成，效果一样。

- 生成的曲子第一拍常常不在 0 秒。合成时用 `--bgm-offset` 把第一拍平移到 0 秒（数值是第一拍出现秒数的相反数），之后全程对齐：

```bash
node tools/mix-audio.mjs out/newton.mp4 --bgm 曲库/某首.mp3 --bgm-offset -0.24
```

- 既有曲子速度不在网格上时，可以反过来让视频迁就音乐：把脚本 `bpm` 设成曲子的速度（例如 80.6 对应 0.372 秒的脉冲），蜡烛会吸附到曲子的网格上。生成的曲子速度不稳时只能近似对齐，重新按 BPM 生成才是精确解

## 给 AI 助手的操作说明

如果你是 AI 助手，被要求「生成某个人的视频」，按这个顺序做：

1. 先读完本文档和 `src/data/libai.json`、`src/data/newton.json` 两个样例
2. 从可靠来源整理人物生平，列出关键事件并逐项核对年份，不要凭记忆写脚本
3. 按上面的字段规范写新脚本，特别注意标题行长限制和年份口径
4. 注册 Composition，先抽 6 类静帧自查，修掉溢出、重叠、轴域问题，再渲染全片
5. 交付时给出成片文件、脚本文件位置，并说明这是静音版，配乐在发布时选平台曲库

## 修改风格

风格分三层，改哪层动哪个文件：

- 小改（配色、字号、间距）：`src/LifeKline.tsx`。颜色常量在文件前部（INK、ACCENT、UP、DOWN 等），版式坐标和字号在 JSX 里
- 换气质（底纹、字体）：`public/paper.png` 和 `public/fonts/`。注意字体必须走组件里的 FontFace 显式加载，换字体要同步改加载清单
- 大改（换版式结构、加新元素、新动效）：改 `src/LifeKline.tsx` 的 JSX 结构，或者新建一个组件文件当新模板，在 Root.tsx 注册成新的 Composition，老模板保留

图表的几何（绘图区范围、轴域算法）在 `src/lib/series.ts`。

## 进阶：脚本自动生成

仓库带了生成工具 `tools/generate-script.mjs`，把「写脚本 + 注册」一步做完：

```bash
# 需要先设好 key（二选一），key 只走环境变量，不要写进任何文件
export GEMINI_API_KEY=你的key        # 或 DEEPSEEK_API_KEY
node tools/generate-script.mjs "苏轼" --id SuShi              # 默认 Gemini
node tools/generate-script.mjs "苏轼" --id SuShi --provider deepseek
node tools/generate-script.mjs "苏轼" --id SuShi --dry-run    # 只打印提示词，不调 API
```

它会把字段规范和李白样例作为提示词发给模型，拿回 JSON 后做结构校验（关键点递增、分段首尾相接、标题行宽、总时长），通过了才落到 `src/data/` 并自动注册进 `src/data/registry.ts`，之后就能直接 still 和 render。也可以 `--from-file 输出.txt` 把别的渠道拿到的文本当模型输出导入。

红线不变：模型写的年份和引文必须人工再核查一遍，校验只查结构，查不了史实。渲染分层也不变，渲染本身依旧离线、确定性、不需要 key。

## 进阶：BGM

默认流程是**后期合成**，不烘进渲染。好处是视频只渲一次，换曲只花几秒，可以对着成片一首首试听再定；曲库也不进仓库，不占体积、没有版权文件混在代码里。

1. 视频先正常渲出（带不带静音轨都行）
2. BGM 自己准备，放在仓库外任意目录。免版权曲库可以看 Pixabay Music、Uppbeat，下载时留好授权说明；也可以用 Suno 等 AI 作曲，商用授权以平台条款为准
3. 合成（一条命令，视频不重编码）：

```bash
node tools/mix-audio.mjs out/newton.mp4 --bgm ~/音乐/曲库/某首.mp3
```

BGM 会自动循环铺满全片、结尾 2 秒淡出。音量默认 0.6，可用 `--bgm-volume` 改；同时带配音时默认开启人声压乐（见下文配音一节）。不满意就换 `--bgm` 的文件重跑，几秒出一个新版本。

发布时直接用平台曲库仍然可以，是零准备的备选。

渲染内挂载也保留：脚本顶层加 `"bgm": "文件名.mp3"`（文件放 `public/`），适合曲子已经定死、想一步出片的情况。新视频默认不要这么做，曲子定不下来时反复重渲很浪费。

## 模板与风格架构

一套视频的「表现」由三样东西决定，全部写在脚本 JSON 里，生成器按人物气质自动选，人工也可改：

- **视频模板** `template`：渲染组件。注册表在 `src/data/templates.ts`（每套含组件、适合人物、默认风格三件套），Root 按脚本的 `template` 字段选组件渲染。目前只有 `classic`（宣纸杂志风）。新增模板：写一个吃 `scriptData` 的组件，在 templates.ts 里注册一行，生成器那边的模板清单（tools/generate-script.mjs 里的 TEMPLATE_LINES）同步加一行。
- **配音音色** `voice.style`：音色库在 `tools/voice-profiles.json`，一项 = 引擎 + 音色 id + 可选语气指令。现有三类引擎：`edge`（本机免费音色库，云扬/云健/云希/晓晓/晓菡）、`gemini`（用文字描述定制音色与语气，如沧桑老者、纪录片旁白，需 GEMINI_API_KEY）、`elevenlabs`（音色库与声音克隆，需 ELEVENLABS_API_KEY；克隆好把 voice_id 填进 my-clone 那项即可）。make-voice 按 `--style` > 脚本 `voice.style` > 库里 default 的顺序选。
- **BGM 风格** `bgm_tags`：一句英文风格标签（曲风+情绪+乐器），music-prompt 和 generate-music 会带上它生成/取曲。

生成器（generate-script）的校验会兜底：template 和 voice.style 写了不存在的值会被自动改回默认并警告。

## 进阶：配音（头尾两句式）

模板的正片是无旁白设计：大标题句就是旁白，中间配音会和画面定死的段长打架（视频等配音）。采用的折中是**只配头尾**：开头一句介绍人物（落在片头卡和第一段上），结尾一句总结升华（盖在收尾定格上），中间保持纯音乐。

脚本里写 `voice: { intro, outro }`（生成器会自动写，intro 不超 24 字，outro 40-70 字），然后：

```bash
node tools/make-voice.mjs src/data/newton.json --video out/newton.mp4
node tools/mix-audio.mjs out/newton.mp4 --bgm ~/音乐/曲库/某首.mp3 --voice out/voice.wav
```

make-voice 逐句 TTS（默认 edge-tts 音色 zh-CN-YunyangNeural，`pip install edge-tts`；`--voice-name` 可换，`--tts-cmd '命令 {text} {out}'` 可换任何 TTS，`--intro-file/--outro-file` 可喂现成录音），把开头对齐 0 秒、结尾反向对齐到片尾，拼成一条与视频等长的音轨。mix-audio 默认开**人声压乐**：有人声时 BGM 自动压低约 15-20dB，说完自动恢复，中间纯音乐段保持原音量；`--no-duck` 可关掉改全程垫底。

提醒：全片配音不在本模板的设计内——真要做，每段时长得跟着语音走、逐段重渲，那是另一套模板。

## 常见问题

- 人名不是书法体，或者字体看起来不对：多半是字体没加载成功或被系统同名字体顶替。确认 `public/fonts` 里文件齐全，且组件里用的是 FontFace 显式加载，不要改成靠系统字体
- 大标题被切掉一截：那一行超过了 10 个汉字，拆成两行或删字
- 纵轴出现负数：关键点指数给得太小或有负数，把谷底指数抬到 3 以上
- 渲染中断：重新跑同一条 render 命令即可，不要改脚本和 seed，否则前后对不上
- 换电脑渲染结果不一致：确认三件事，代码版本一致、字体和 paper.png 用仓库里的、seed 没改。满足这三条，每一帧逐像素一致
