# BGM 曲库生成单（给 Flow Music 用）

目标：建一个按风格命名的曲库，之后 LLM 按文档＋文件名给每条视频自动选曲。
风格 id 与 `tools/bgm-styles.json` 一一对应，不许自创名字。

## 操作

1. 每个风格用下面的提示词生成 **2 首**（同一提示词再摇一次即可，天然是两个版本）。
2. 全部要**纯器乐**：提示词里已写明 no vocals / no lyrics，别删。
3. 下载后按规则改名，放进 `assets/bgm/`，push 上来即可。
   命名：`<风格id>-01.mp3`、`<风格id>-02.mp3`，例如 `guofeng-epic-01.mp3`。
   文件名前缀就是风格 id，登记和自动选曲都靠它，不要加空格和中文。
4. 长度不限（混音时裁剪＋淡出）；push 后由 Muse 登记进
   `assets/bgm/manifest.json` 并实测 BPM 填表。

## 风格与提示词

### cinematic-piano（电影钢琴 · 默认通用）
适用：大多数人物、传记感、情绪叙事。
```
Instrumental cinematic piano score, solo grand piano with a soft string ensemble, emotional and inspiring. Starts with a gentle solo piano motif, gradually builds with swelling strings to a powerful hopeful climax around two thirds in, then resolves warmly. 120 BPM, no vocals, no lyrics, film soundtrack quality.
```

### guofeng-epic（国风史诗 · 古代人物）
适用：中国古代人物、家国情怀、悲壮叙事。
```
Instrumental Chinese epic orchestral score, guzheng, dizi flute, erhu and deep war drums with full strings, heroic and melancholic. Opens quietly with solo guzheng, builds to a grand sweeping climax of drums and strings, epic historical drama feel. 120 BPM, no vocals, no lyrics.
```

### jazz-noir（爵士黑色 · 近代/悬疑）
适用：近代人物、谍战悬疑、命运转折多的题材。
```
Instrumental noir jazz, smoky saxophone lead, brushed drums, upright bass and sparse piano chords, mysterious late-night mood, slow burn with a tense build toward a dramatic peak, vintage detective film feel. 90 BPM, no vocals, no lyrics.
```

### warm-folk（温暖民谣 · 温情人物）
适用：温情、治愈、平凡而伟大的人物。
```
Instrumental warm acoustic folk, fingerstyle acoustic guitar, soft piano, gentle strings and light hand percussion, nostalgic and heartwarming, sunrise feeling, builds gently to an uplifting warm peak. 112 BPM, no vocals, no lyrics.
```

### rock-anthem（摇滚颂歌 · 热血/逆袭）
适用：运动员、企业家、逆袭翻盘型人物。
```
Instrumental stadium rock anthem, driving electric guitars, powerful live drums, bass and piano accents, rebellious and triumphant. Starts with a single guitar riff, explodes into a full-band chorus climax, ends on a victorious sustained chord. 120 BPM, no vocals, no lyrics.
```

### electronic-pulse（电子脉冲 · 科技/当代）
适用：科技人物、当代题材、快节奏叙事。
```
Instrumental electronic score, pulsing synth bass, arpeggiated synths, deep atmospheric pads and modern cinematic drums, futuristic and relentless, technology and ambition mood, builds in layers to a high-energy peak. 120 BPM, no vocals, no lyrics.
```
