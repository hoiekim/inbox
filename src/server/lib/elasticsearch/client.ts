import { Client } from "@elastic/elasticsearch";
import mappings from "./mappings.json";

const {
  ELASTIC_HOST: node,
  ELASTIC_USERNAME: username,
  ELASTIC_PASSWORD: password,
  ELASTIC_INDEX: indexPrefix
} = process.env;

const auth = username && password ? { username, password } : undefined;
export const elasticsearchClient = new Client({ node, auth });

export const { version } = mappings;
export const index = (indexPrefix || "inbox") + (version ? `-${version}` : "");
