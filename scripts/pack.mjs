// Собирает zip с папкой extension/ для страницы релиза на GitHub.
import { readFile, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const out = `dist/ultra-skip-${version}.zip`;

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await rm(new URL(`../${out}`, import.meta.url), { force: true });
execFileSync("zip", ["-r", "-X", `../${out}`, ".", "-x", "*.DS_Store"], { cwd: `${root}extension`, stdio: "inherit" });
console.log(out);
