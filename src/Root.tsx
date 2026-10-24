import React from "react";
import { Composition } from "remotion";
import { LifeKline } from "./LifeKline";
import libai from "./data/libai.json";
import newton from "./data/newton.json";
import { ScriptData, totalFrames } from "./lib/series";

export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="LifeKline"
        component={LifeKline}
        durationInFrames={totalFrames(libai as unknown as ScriptData)}
        fps={30}
        width={1080}
        height={1920}
      />
      <Composition
        id="Newton"
        component={LifeKline}
        durationInFrames={totalFrames(newton as unknown as ScriptData)}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{ scriptData: newton as unknown as ScriptData }}
      />
    </>
  );
};
