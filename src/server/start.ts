import "./config";

import {
  initializeIndex,
  saveMailHandler,
  initializeAdminUser,
  cleanSubscriptions,
  elasticsearchIsAvailable,
  initializeImap,
  initializeSmtp,
  initializeHttp
} from "server";

const initializeElasticsearch = async () => {
  await elasticsearchIsAvailable();
  await initializeIndex();
  await initializeAdminUser();
};

const initializeMailin = () => {
  const nodeMailin = require("@umpacken/node-mailin");
  nodeMailin.on("message", saveMailHandler);
  nodeMailin.on("error", console.error);
  nodeMailin.start({
    port: 25,
    logLevel: "info"
  });
};

const start = async () => {
  await initializeElasticsearch();
  await initializeHttp();
  initializeMailin();
  await initializeImap();
  await initializeSmtp();
  cleanSubscriptions();
};

start();
