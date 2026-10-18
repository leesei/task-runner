import { $ } from "bun";

function padZero(num: number, size: number): string {
  let s = num.toString();
  while (s.length < size) {
    s = "0" + s;
  }
  return s;
}

export function prettyTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  return `${padZero(hours, 2)}:${padZero(minutes, 2)}:${padZero(secs, 2)}`;
}

export function prettyBps(bps: string | number): string {
  let bytesN = 0;
  if (typeof bps == "string") {
    bytesN = parseInt(bps, 10);
  } else {
    bytesN = bps;
  }
  if (bytesN === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  const i = Math.floor(Math.log(bytesN) / Math.log(k));
  return `${parseFloat((bytesN / Math.pow(k, i)).toFixed(2))}${sizes[i]}ps`;
}

export const getMediainfo = async (filepath: string) => {
  const { stdout, stderr, exitCode } =
    await $`mediainfo --Output=JSON "${filepath}"`.nothrow().quiet();
  if (exitCode !== 0) {
    console.error(`Error processing file: ${filepath}`);
    console.error(stderr);
    return null;
  }

  const minfo = JSON.parse(stdout.toString()) as Record<string, any>;
  const vtrack = minfo["media"]["track"].find(
    (track: any) => track["@type"] === "Video",
  );
  if (vtrack) {
    if (!vtrack["BitRate"]) {
      vtrack["BitRate"] = vtrack["BitRate_Maximum"];
    }
  }
  const atrack = minfo["media"]["track"].find(
    (track: any) => track["@type"] === "Audio",
  );
  if (atrack) {
    if (!atrack["BitRate"]) {
      atrack["BitRate"] = vtrack["BitRate_Nominal"];
    }
  }

  return minfo;
};

export function printMediaInfo(
  minfo: Record<string, any>,
  args: Record<string, any>,
): void {
  if (!minfo["media"]) return;
  const file = minfo["media"]["@ref"];
  const vtrack = minfo["media"]["track"].find(
    (track: any) => track["@type"] === "Video",
  );
  const atrack = minfo["media"]["track"].find(
    (track: any) => track["@type"] === "Audio",
  );
  if (!vtrack || !atrack) {
    if (args.debug) {
      console.log(`Skipping file: ${file}`);
    }
    return;
  }

  console.log(
    `${file}: ${prettyTime(atrack["Duration"])} | ${vtrack["Format"]} ${vtrack["Format_Profile"]}/${vtrack["Width"]}x${vtrack["Height"]}@${vtrack["FrameRate"]}/${prettyBps(vtrack["BitRate"])} | ${atrack["Format"]}/${prettyBps(atrack["BitRate"])}`,
  );
}
