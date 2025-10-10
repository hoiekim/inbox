import "./config";

import {
  initializeIndex,
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

const start = async () => {
  await initializeElasticsearch();
  await initializeHttp();
  await initializeSmtp();
  await initializeImap();
  cleanSubscriptions();
};

start();
