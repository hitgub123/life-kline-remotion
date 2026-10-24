import React from "react";
import { Composition } from "remotion";
import { LifeKline } from "./LifeKline";
import libai from "./data/libai.json";
import { ScriptData, totalFrames } from "./lib/series";

export const Root: React.FC = () => {
  return (
    <Composition
      id="LifeKline"
      component={LifeKline}
      durationInFrames={totalFrames(libai as unknown as ScriptData)}
      fps={30}
      width={1080}
      height={1920}
    />
  );
};
