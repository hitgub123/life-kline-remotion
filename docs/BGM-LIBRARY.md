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
   留在本地即可，不用 push。
   命名：`<风格id>-01.mp3`、`<风格id>-02.mp3`，例如 `guofeng-epic-01.mp3`。
   文件名前缀就是风格 id，登记和自动选曲都靠它，不要加空格和中文。
4. 登记方式：把新文件名清单发给 Muse，由它补进 `assets/bgm/manifest.json`
   并实测 BPM 填表（BPM 在本地测）。

## 风格与提示词

### cinematic-piano（电影钢琴 · 默认通用）
适用：大多数人物、传记感、情绪叙事。
```
Instrumental cinematic piano score, solo grand piano with a soft string ensemble, emotional and inspiring, 120 BPM. Around 75 seconds in total: gentle solo piano motif for the first 10 seconds, strings enter and build from 0:10, main climax with full piano and swelling strings at 0:30 to 0:40, stay powerful, one final emotional lift around 0:55, then a warm resolve and clean ending. No vocals, no lyrics, film soundtrack quality.
```

### guofeng-epic（国风史诗 · 古代人物）
适用：中国古代人物、家国情怀、悲壮叙事。
```
Instrumental Chinese epic orchestral score, guzheng, dizi flute, erhu and deep war drums with full strings, heroic and melancholic, 120 BPM. Around 75 seconds in total: quiet solo guzheng opening for 10 seconds, war drums and strings build from 0:10, main climax — grand sweeping drums and full strings — at 0:30 to 0:40, stay epic, one final lift around 0:55, then a short solemn resolve and clean ending. No vocals, no lyrics.
```

### jazz-noir（爵士黑色 · 近代/悬疑）
适用：近代人物、谍战悬疑、命运转折多的题材。
```
Instrumental noir jazz, smoky saxophone lead, brushed drums, upright bass and sparse piano chords, mysterious late-night mood, 90 BPM. Around 75 seconds in total: sparse smoky intro for 10 seconds, tension builds from 0:10, dramatic peak with full saxophone cry at 0:30 to 0:40, keep the suspense high, one final sting around 0:55, then fade into the night with a clean ending. No vocals, no lyrics, vintage detective film feel.
```

### warm-folk（温暖民谣 · 温情人物）
适用：温情、治愈、平凡而伟大的人物。
```
Instrumental warm acoustic folk, fingerstyle acoustic guitar, soft piano, gentle strings and light hand percussion, nostalgic and heartwarming, 112 BPM. Around 75 seconds in total: gentle guitar intro for 10 seconds, piano and strings join and build from 0:10, warm uplifting peak at 0:30 to 0:40, stay bright, one final lift around 0:55, then a soft resolve and clean ending. No vocals, no lyrics.
```

### rock-anthem（摇滚颂歌 · 热血/逆袭）
适用：运动员、企业家、逆袭翻盘型人物。
```
Instrumental stadium rock anthem, driving electric guitars, powerful live drums, bass and piano accents, rebellious and triumphant, 120 BPM. Around 75 seconds in total: single guitar riff intro for 8 seconds, full band builds from 0:10, explosive chorus climax at 0:30 to 0:40, stay big and loud, a final even bigger chorus lift around 0:55, ending on a victorious sustained chord. No vocals, no lyrics.
```

### electronic-pulse（电子脉冲 · 科技/当代）
适用：科技人物、当代题材、快节奏叙事。
```
Instrumental electronic score, pulsing synth bass, arpeggiated synths, deep atmospheric pads and modern cinematic drums, futuristic and relentless, 120 BPM. Around 75 seconds in total: pulsing synth intro for 10 seconds, layers build from 0:10, main high-energy peak at 0:30 to 0:40, stay driving, one final lift around 0:55, then a clean electronic ending. No vocals, no lyrics.
```
