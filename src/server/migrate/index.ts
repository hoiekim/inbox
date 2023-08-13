import { importConfig, setModulePaths } from "../config";

importConfig();
setModulePaths();

import { convertMail } from "./convert";
import Elastic from "./elastic";
import { elasticsearchClient } from "server";

const ELASTIC_HOST = process.env.ELASTIC_HOST || "http://elastic:9200";
const ELASTIC_USERNAME = process.env.ELASTIC_USERNAME || "";
const ELASTIC_PASSWORD = process.env.ELASTIC_PASSWORD || "";
const ELASTIC_INDEX = process.env.ELASTIC_INDEX_MAILS || "mails";

const Mail = new Elastic(
  ELASTIC_HOST,
  ELASTIC_USERNAME,
  ELASTIC_PASSWORD,
  ELASTIC_INDEX
);

const run = async () => {
  const response = await Mail.request("_search", "POST", {
    query: {
      match_all: {}
    },
    sort: { date: "desc" },
    from: 0,
    size: 10000
  });

  response.hits.hits.reduce(async (acc: any, hit: any, i: number) => {
    await acc;
    console.log(hit._id);
    const mail = await convertMail(hit._source);
    return elasticsearchClient.index({
      id: hit._id,
      document: { type: "mail", mail, updated: mail.date }
    });
  }, new Promise((res) => res(undefined)));
};

run();
