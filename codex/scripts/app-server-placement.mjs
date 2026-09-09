import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";

async function canonicalPath(path) {
  return await realpath(resolve(path));
}

function pathContains(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ""
    || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

export async function validateManagedControllerPlacement({
  sandbox,
  workdir,
  sessionDir,
  credentialPath,
  tmpdir = process.env.TMPDIR,
}) {
  if (sandbox !== "workspace-write" || !sessionDir || !credentialPath) return;

  const writableRootPaths = [workdir ?? process.cwd(), "/tmp"];
  if (tmpdir) writableRootPaths.push(tmpdir);
  const writableRoots = [...new Set(await Promise.all(writableRootPaths.map(canonicalPath)))];
  const controllerPaths = await Promise.all([
    canonicalPath(sessionDir),
    canonicalPath(credentialPath),
  ]);

  for (const controllerPath of controllerPaths) {
    const containingRoot = writableRoots.find((root) => pathContains(root, controllerPath));
    if (containingRoot) {
      throw new Error(
        `managed workspace-write requires its session directory and credential outside every writable root: ${controllerPath} is inside ${containingRoot}`,
      );
    }
  }
}
