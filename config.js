const config = () => {
  let envPath = ".env";
  const NODE_ENV = process.env.NODE_ENV;
  if (NODE_ENV) envPath += "." + NODE_ENV;
  require("dotenv").config({ path: envPath });
};

export default config;
