import { spawn, SpawnOptions } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rmdir, rm } from "node:fs/promises";
import type { Plugin as VitePlugin } from "vite";

// Utility to invoke a given sbt task and fetch its output
async function printSbtTask(task: string, cwd?: string): Promise<string> {
  const baseTmp = os.tmpdir();
  const myTmp = await mkdtemp(path.join(baseTmp, "scalajs-vite-plugin-"));
  const myTmpFile = path.join(myTmp, "out");

  /* Converts a string to its representation as a Scala string literal, in a
   * way that is safe to use in a shell argument.
   */
  function scalaString(s: string): string {
    // Escape problematic characters using their \uxxxx representation
    const escaped = s.replace(/[\u0000- \\"']/g,
      (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    return '"' + escaped + '"';
  }

  try {
    const args = [
      "--batch",
      "-no-colors",
      "-Dsbt.supershell=false",
      `set TaskKey[Unit](${scalaString('dummy')}) := sbt.IO.write(file(${scalaString(myTmpFile)}), (${task}).value.toString, java.nio.charset.StandardCharsets.UTF_8)`,
      "dummy"
    ];
    const options: SpawnOptions = {
      cwd: cwd,
      stdio: ['ignore', 'pipe', 'inherit'],
    };
    const child = process.platform === 'win32'
        ? spawn("sbt.bat", args.map(x => `"${x.replace(/"/g, '""')}"`), { shell: true, ...options })
        : spawn("sbt", args, options);

    let fullOutput: string = '';

    child.stdout!.setEncoding('utf-8');
    child.stdout!.on('data', data => {
      fullOutput += data;
      process.stdout.write(data); // tee on my own stdout
    });

    await new Promise<void>((resolve, reject) => {
      child.on('error', err => {
        reject(new Error(`sbt invocation for Scala.js compilation could not start. Is it installed?\n${err}`));
      });
      child.on('close', code => {
        if (code !== 0) {
          let errorMessage = `sbt invocation for Scala.js compilation failed with exit code ${code}.`;
          if (fullOutput.includes("Not a valid command: --")) {
            errorMessage += "\nCause: Your sbt launcher script version is too old (<1.3.3)."
            errorMessage += "\nFix: Re-install the latest version of sbt launcher script from https://www.scala-sbt.org/"
          }
          reject(new Error(errorMessage));
        } else {
          resolve();
        }
      });
    });

    return await readFile(myTmpFile, 'utf-8');
  } finally {
    await rm(myTmpFile, { force: true });
    await rmdir(myTmp);
  }
}

export interface ScalaJSPluginOptions {
  cwd?: string,
  projectID?: string,
  uriPrefix?: string,
}

export default function scalaJSPlugin(options: ScalaJSPluginOptions = {}): VitePlugin {
  const { cwd, projectID, uriPrefix } = options;

  const fullURIPrefix = uriPrefix ? (uriPrefix + ':') : 'scalajs:';

  let isDev: boolean | undefined = undefined;
  let scalaJSOutputDir: string | undefined = undefined;

  return {
    name: "scalajs:sbt-scalajs-plugin",

    // Vite-specific
    configResolved(resolvedConfig) {
      isDev = resolvedConfig.mode === 'development';
    },

    // standard Rollup
    async buildStart(options) {
      if (isDev === undefined)
        throw new Error("configResolved must be called before buildStart");

      const task = isDev ? "fastLinkJSOutput" : "fullLinkJSOutput";
      const projectTask = projectID ? `${projectID}/Compile/${task}` : `Compile/${task}`;
      scalaJSOutputDir = await printSbtTask(projectTask, cwd);
    },

    // standard Rollup
    resolveId(source, importer, options) {
      if (scalaJSOutputDir === undefined)
        throw new Error("buildStart must be called before resolveId");

      if (!source.startsWith(fullURIPrefix))
        return null;
      const path = source.substring(fullURIPrefix.length);

      return `${scalaJSOutputDir}/${path}`;
    },
  };
}
