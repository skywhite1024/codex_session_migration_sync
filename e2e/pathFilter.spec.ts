import { expect, test } from "@playwright/test";
import { isWithinDirectory } from "../src/lib/pathFilter";

test("POSIX directory filters preserve case and component boundaries", () => {
  expect(isWithinDirectory("/home/dex/Proj", "/home/dex/Proj")).toBe(true);
  expect(isWithinDirectory("/home/dex/Proj/src", "/home/dex/Proj/")).toBe(true);
  expect(isWithinDirectory("/home/dex/proj", "/home/dex/Proj")).toBe(false);
  expect(isWithinDirectory("/home/dex/Proj-other", "/home/dex/Proj")).toBe(false);
});

test("POSIX literal backslashes are not treated as separators", () => {
  expect(isWithinDirectory("/home/dex/proj\\child", "/home/dex/proj")).toBe(false);
  expect(isWithinDirectory("/home/dex/proj\\child/sub", "/home/dex/proj\\child")).toBe(true);
});

test("Windows paths preserve case-insensitive and mixed-separator matching", () => {
  expect(isWithinDirectory("C:\\Work\\Proj\\src", "c:/work/proj/")).toBe(true);
  expect(isWithinDirectory("C:/Work/Proj-other", "c:\\work\\proj")).toBe(false);
  expect(isWithinDirectory("\\\\SERVER\\Share\\Proj\\src", "//server/share/proj")).toBe(true);
});

test("root and empty filters do not mix path families", () => {
  expect(isWithinDirectory("/home/dex", "/")).toBe(true);
  expect(isWithinDirectory("/", "/")).toBe(true);
  expect(isWithinDirectory("C:\\work", "/")).toBe(false);
  expect(isWithinDirectory("\\\\server\\share\\proj", "/")).toBe(false);
  expect(isWithinDirectory("C:\\work", "c:/")).toBe(true);
  expect(isWithinDirectory("D:\\work", "c:/")).toBe(false);
  expect(isWithinDirectory(null, "/home/dex")).toBe(false);
  expect(isWithinDirectory(null, "")).toBe(true);
});
