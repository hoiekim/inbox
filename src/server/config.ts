import { config } from "dotenv";

const importConfig = () => {
  const { NODE_ENV } = process.env;
  const extraEnv = NODE_ENV ? ".env." + NODE_ENV : "";
  [".env", ".env.local", extraEnv].forEach((path) => config({ path }));
};

const setModulePaths = () => {
  const paths = ["src", "build/server"];
  const isWindows = process.platform === "win32";
  process.env.NODE_PATH = paths.join(isWindows ? ";" : ":");
  require("module").Module._initPaths();
};

importConfig();
setModulePaths();
