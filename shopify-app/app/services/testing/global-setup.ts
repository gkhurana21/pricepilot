// Builds the Go engine once before the tests, so they run the real binary.
import { execFileSync } from "node:child_process";
import path from "node:path";

export default function setup(): void {
  const appRoot = process.cwd();
  const repoRoot = path.resolve(appRoot, "..");
  try {
    execFileSync(
      "go",
      ["build", "-o", path.join(appRoot, ".engine", "engine"), "./cmd/engine"],
      { cwd: repoRoot, stdio: "pipe" },
    );
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? "";
    throw new Error(`Could not build the Go engine (is Go installed?): ${stderr || String(error)}`);
  }
}
