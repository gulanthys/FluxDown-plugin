import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..");
const sourceDir = join(pluginDir, "src");
const parts = ["runtime.js", "bangumi.js", "dash.js", "subscriptions.js", "entry.js"];
const output = parts.map((name) => readFileSync(join(sourceDir, name), "utf8").trimEnd()).join("\n\n") + "\n";
writeFileSync(join(pluginDir, "resolve.js"), output, "utf8");
console.log(`built resolve.js from ${parts.length} source files`);