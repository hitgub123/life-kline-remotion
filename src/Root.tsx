import React from "react";
import { Composition } from "remotion";
import { SCRIPTS } from "./data/registry";
import { TEMPLATES, templateOf } from "./data/templates";
import { totalFrames } from "./lib/series";
import { Cover } from "./Cover";

export const Root: React.FC = () => {
  return (
    <>
      {SCRIPTS.map(({ id, data }) => (
        <Composition
          key={id}
          id={id}
          component={templateOf(data).component}
          durationInFrames={totalFrames(data)}
          fps={30}
          width={1080}
          height={1920}
          defaultProps={{ scriptData: data }}
        />
      ))}
      {/* 封面 still（tools/make-cover.mjs 用 --props 换任意人物脚本）：B站 16:10 / 抖音 3:4 / YouTube 16:9 */}
      {SCRIPTS.length > 0 && (
        <>
          <Composition id="CoverBili" component={Cover} durationInFrames={1} fps={30} width={1600} height={1000} defaultProps={{ scriptData: SCRIPTS[0].data, variant: "bili" }} />
          <Composition id="CoverDouyin" component={Cover} durationInFrames={1} fps={30} width={1200} height={1600} defaultProps={{ scriptData: SCRIPTS[0].data, variant: "douyin" }} />
          <Composition id="CoverYt" component={Cover} durationInFrames={1} fps={30} width={1920} height={1080} defaultProps={{ scriptData: SCRIPTS[0].data, variant: "yt" }} />
        </>
      )}
      {/* 模板一览（无脚本时也能在 Studio 里单独预览模板，挂第一份脚本的数据） */}
      {SCRIPTS.length > 0 &&
        Object.values(TEMPLATES).map((t) => (
          <Composition
            key={`tpl-${t.id}`}
            id={`Template-${t.id}`}
            component={t.component}
            durationInFrames={totalFrames(SCRIPTS[0].data)}
            fps={30}
            width={1080}
            height={1920}
            defaultProps={{ scriptData: SCRIPTS[0].data }}
          />
        ))}
    </>
  );
};
