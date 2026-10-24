# 人生 K 线 · Remotion 版（life-kline-remotion）

把一个人物的一生画成股票 K 线图的短视频生成器，Remotion 实现版。宣纸底、宋体大标题、密 K 线自动生长，1080×1920 竖屏，约 66 秒。

**完整使用文档在 [docs/USAGE.md](docs/USAGE.md)**：新增人物的全流程、脚本字段规范、给 AI 助手的操作说明、改风格指南、常见问题，只读那一份就能上手。

内容与渲染分离：一人物一份 JSON 脚本（关键点、标题句、诗句），React 组件只读脚本渲染。换人物等于换脚本，模板和风格不动。脚本格式与 Python 原型仓库 [life-kline-factory](https://github.com/hitgub123/life-kline-factory) 完全一致，两边脚本可互换，原型仓库里有格式的详细说明。

样例成片：`samples/libai-remotion-final.mp4`（李白，脚本在 `src/data/libai.json`）。

## 快速开始

依赖：Node 18+、ffmpeg（补静音轨时用）。

```bash
npm install

# 实时预览（改组件立刻能看）
npx remotion studio

# 抽查静帧
npx remotion still LifeKline out/still.png --frame=960

# 渲染全片（约 5 分钟）
npx remotion render LifeKline out/libai-remotion.mp4

# 补一条静音音轨，方便平台发布
ffmpeg -i out/libai-remotion.mp4 -f lavfi -i anullsrc=r=44100:cl=stereo \
  -c:v copy -c:a aac -shortest out/libai-remotion-final.mp4
```

渲染不需要 API key。人物脚本由 LLM 按格式规范生成后放进 `src/data`，在 `src/Root.tsx` 注册成 Composition 即可出片。

## 本地使用（Windows）

第一次：

1. 装 Node.js LTS（nodejs.org 下载安装包）
2. 克隆仓库，进到项目目录

```bat
git clone https://github.com/hitgub123/life-kline-remotion.git
cd life-kline-remotion
npm install
```

日常使用：

```bat
git pull
npx remotion studio
```

Studio 会在浏览器打开，左侧选 Composition 就能实时预览播放。然后渲染：

```bat
npx remotion render LifeKline out\libai.mp4
```

成片在 out 目录。换人物不用改代码，把新脚本 JSON 放进 src/data 并在 src/Root.tsx 注册一个 Composition 即可，这一步通常由 Muse 生成脚本并提交到仓库，用户只需要 pull。

## 实现要点

- `src/lib/series.ts` 带种子的序列生成，关键点之间用对数空间布朗桥填充行情噪声，和 Python 原型同一套算法（随机流实现不同，曲线骨架一致）
- 全部动画都是帧号的纯函数，固定种子，同一脚本在任何电脑上渲染结果一致
- 字体走 FontFace 显式加载项目内字体文件，不要依赖系统字体同名顶替
- 退市印章用 spring 物理，标题转场用 CSS blur，图表用 SVG 矢量绘制

## 目录

- `src/LifeKline.tsx` 主组件（版式、图表、动效）
- `src/lib/series.ts` 序列生成、轴域计算、标注避让排版
- `src/data/` 人物脚本 JSON
- `public/` 字体与纸纹等静态资源
- `samples/` 样例成片
