import * as esbuild from "esbuild";

const args = process.argv.slice(2);
const production = args.includes("--production");
const watch = args.includes("--watch");

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

const ctx = await esbuild.context({
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  external: ["vscode"],
});
if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
