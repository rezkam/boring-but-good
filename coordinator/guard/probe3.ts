import { findRoleShadows } from "./pi-extension.ts";
import { fileURLToPath } from "node:url";
const own = fileURLToPath(new URL("./agents/", import.meta.url)).replace(/\/$/, "");
let start = Date.now();
const clean = findRoleShadows(own, "/Users/rez/.agents/scratch/guard-e2e");
console.log("clean scan:", Date.now() - start, "ms, shadows:", JSON.stringify(clean));
