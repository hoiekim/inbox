const setModulePaths = () => {
  const paths = ["src", "build/server"];
  const isWindows = process.platform === "win32";
  process.env.NODE_PATH = paths.join(isWindows ? ";" : ":");
  require("module").Module._initPaths();
};

setModulePaths();
