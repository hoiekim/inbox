import { Client, ClientOptions } from "@elastic/elasticsearch";
import mappings from "./mappings.json";

const {
  ELASTIC_HOST: node,
  ELASTIC_USERNAME: username,
  ELASTIC_PASSWORD: password,
  ELASTIC_INDEX: indexPrefix
} = process.env;

let auth: ClientOptions["auth"] = undefined;
if (username && password) auth = { username, password };

export const elasticsearchClient = new Client({ node, auth });

export const { version }: any = mappings;
export const index = (indexPrefix || "inbox") + (version ? `-${version}` : "");
