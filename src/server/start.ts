import "./config";

import {
  initializePostgres,
  initializeAdminUser,
  cleanSubscriptions,
  initializeImap,
  initializeSmtp,
  initializeHttp,
} from "server";

const start = async () => {
  await initializePostgres();
  await initializeAdminUser();
  await initializeHttp();
  await initializeSmtp();
  await initializeImap();
  cleanSubscriptions();
};

start();
