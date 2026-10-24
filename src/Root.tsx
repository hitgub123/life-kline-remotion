import React from "react";
import { Composition } from "remotion";
import { SCRIPTS } from "./data/registry";
import { TEMPLATES, templateOf } from "./data/templates";
import { totalFrames } from "./lib/series";

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
