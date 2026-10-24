import React from "react";
import { Composition } from "remotion";
import { LifeKline } from "./LifeKline";
import { SCRIPTS } from "./data/registry";
import { totalFrames } from "./lib/series";

export const Root: React.FC = () => {
  return (
    <>
      {SCRIPTS.map(({ id, data }) => (
        <Composition
          key={id}
          id={id}
          component={LifeKline}
          durationInFrames={totalFrames(data)}
          fps={30}
          width={1080}
          height={1920}
          defaultProps={{ scriptData: data }}
        />
      ))}
    </>
  );
};
