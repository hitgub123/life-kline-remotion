# BGM 曲库生成单（给 Flow Music 用）

目标：建一个按风格命名的曲库，之后 LLM 按文档＋文件名给每条视频自动选曲。
风格 id 与 `tools/bgm-styles.json` 一一对应，不许自创名字。

## 结构要求（所有风格通用）

视频只有 60–75 秒，混音取音频前段，所以曲子的时间轴必须前置：

- 总长约 **75 秒**（生成不出来这么短也行，但高潮位置按这个时间轴走）
- 0:00–0:10 安静引入（钩子卡＋开头旁白）
- 0:10 起开始爬升
- **0:30–0:40 主高潮**（对上视频中后段的人生巅峰）
- 0:55 左右再补一记提升（对上片尾总结段）
- 之后短收尾、干净结束

## 操作

1. 每个风格用下面的提示词生成 **2 首**（同一提示词再摇一次即可，天然是两个版本）。
2. 全部要**纯器乐**：提示词里已写明 no vocals / no lyrics，别删。
3. 下载后按规则改名，放进 `assets/bgm/`。**音频不入 git**（已在 .gitignore），
   留在本地即可，不用 push。扩展名 **mp3 或 m4a 都可以**（扫描与混音都支持）。
   命名：`<风格id>-01.mp3`、`<风格id>-02.mp3`，例如 `epic-soaring-01.mp3`。
   老曲子归档放 `assets/bgm/old/` 子文件夹：扫描器只看顶层，自动跳过归档区。
   生成工具自带的名字（如 `ghibli-nostalgia-*`）不用改名：扫描器里有别名映射表
   （PREFIX_ALIASES），会自动把 styles 补成目录 id（ghibli-nostalgia→hisaishi-style、
   acoustic-warmth→warm-folk、cyberpunk-drive→electronic-pulse）。
   文件名前缀就是风格 id，登记和自动选曲都靠它。**文件名禁止空格和括号**
   （命令行不加引号就会断词、找不到文件），中文可以但推荐全用英文小写。
4. 登记方式：在仓库根目录跑 `node tools/scan-bgm.mjs`——它在本机测出每首的
   时长、BPM、高潮位置并写进 `assets/bgm/manifest.json`，还会标出高潮没落在
   28–45 秒的曲子。之后把 manifest.json 这一个文件 commit 上去即可，
   远端看表就知道曲库全貌。

## 风格与提示词

### cinematic-piano（电影钢琴 · 默认通用）
适用：大多数人物、传记感、情绪叙事。
```
Instrumental cinematic piano score, solo grand piano with a soft string ensemble, emotional and inspiring, 120 BPM. Around 75 seconds in total: gentle solo piano motif for the first 10 seconds, strings enter and build from 0:10, main climax with full piano and swelling strings at 0:30 to 0:40, stay powerful, one final emotional lift around 0:55, then a warm resolve and clean ending. No vocals, no lyrics, film soundtrack quality.
```

### epic-soaring（激昂史诗 · 巅峰/逆袭）
适用：巅峰时刻、逆袭翻盘、热血题材。
```
Instrumental epic orchestral score, soaring strings, heroic French horns and brass, thunderous cinematic drums and taiko hits, fast driving rhythm, 132 BPM. Around 75 seconds in total: powerful drum-and-strings intro for 8 seconds, the theme builds from 0:10, main triumphant climax with the full orchestra at full force at 0:30 to 0:40, stay intense and uplifting, one final even bigger lift around 0:55, ending on a glorious sustained chord. No vocals, no lyrics, no choir.
```

### hisaishi-style（久石让风 · 天空/成长）
适用：成长、回忆、治愈而昂扬的人物；文人、科学家也搭。
```
Instrumental orchestral piece in the style of Joe Hisaishi's Studio Ghibli scores, lyrical solo piano with flowing arpeggios, warm string orchestra, gentle flute and oboe, a touch of celesta, nostalgic wonder, the feeling of sky and childhood summers, 100 BPM. Around 75 seconds in total: soft piano arpeggios for the first 10 seconds, strings and woodwinds join and the melody takes flight from 0:10, emotional climax with the full orchestra carrying the main theme at 0:30 to 0:40, stay luminous, one final lift around 0:55, then a gentle nostalgic resolve and clean ending. No vocals, no lyrics.
```

### warm-folk（温暖民谣 · 温情人物）
适用：温情、治愈、平凡而伟大的人物。
```
Instrumental warm acoustic folk, fingerstyle acoustic guitar, soft piano, gentle strings and light hand percussion, nostalgic and heartwarming, 112 BPM. Around 75 seconds in total: gentle guitar intro for 10 seconds, piano and strings join and build from 0:10, warm uplifting peak at 0:30 to 0:40, stay bright, one final lift around 0:55, then a soft resolve and clean ending. No vocals, no lyrics.
```

### electronic-pulse（电子脉冲 · 科技/当代）
适用：科技人物、当代题材、快节奏叙事。
```
Instrumental electronic score, pulsing synth bass, arpeggiated synths, deep atmospheric pads and modern cinematic drums, futuristic and relentless, 120 BPM. Around 75 seconds in total: pulsing synth intro for 10 seconds, layers build from 0:10, main high-energy peak at 0:30 to 0:40, stay driving, one final lift around 0:55, then a clean electronic ending. No vocals, no lyrics.
```

## 已砍风格（不要再生成）

- jazz-noir（爵士）、guofeng-epic（国风）、rock-anthem（摇滚）：
  2026-10-25 作者试听后认为 AI 生成效果不好听，砍掉。风格目录已同步移除，
  生成器不会再选它们；已生成过的老曲子留在曲库也只作铺底，不进自动选曲。
