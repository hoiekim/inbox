import mappings from "./mappings.json";
import { elasticsearchClient, index } from "./client";
import { getUser } from "server";

const { properties }: any = mappings;

const elasticsearchIsAvailable = async () => {
  try {
    const { status } = await elasticsearchClient.cluster.health({
      wait_for_status: "yellow",
      timeout: "5s"
    });
    if (!status || status === "red") {
      throw new Error("Elasticsearch is not available");
    }
    console.info(`Elasticsearch is ready (status: ${status})`);
  } catch (error: any) {
    console.error(error.message);
    console.error(error);
    console.info("Checking availability again in 10 seconds.");
    return new Promise((res) => {
      setTimeout(() => res(elasticsearchIsAvailable()), 10000);
    });
  }
};

/**
 * Makes sure an index exists with specified mappings.
 * Then creates or updates admin user with configured password.
 * If this operations fail, budget app might not work in many situations.
 * Check server logs and try resolve the issues in this case.
 */
export const initializeIndex = async () => {
  console.info("Initialization started.");

  await elasticsearchIsAvailable();

  const indexAlreadyExists = await elasticsearchClient.indices.exists({
    index
  });

  if (indexAlreadyExists) {
    console.info("Existing Elasticsearch index is found.");

    const response = await elasticsearchClient.indices
      .putMapping({ index, properties, dynamic: "strict" })
      .catch(console.error);

    if (!response) {
      throw new Error("Failed to setup mappings for Elasticsearch index.");
    }
  } else {
    const response = await elasticsearchClient.indices
      .create({ index, mappings: { properties, dynamic: "strict" } })
      .catch(console.error);

    if (!response) {
      throw new Error("Failed to create Elasticsearch index.");
    }
  }

  console.info(`Successfully initialized Elasticsearch index: ${index}`);
};

export const initializeAdminUser = async () => {
  const { ADMIN_PW } = process.env;

  const existingAdminUser = await getUser({ username: "admin" });

  // const indexingAdminUserResult = await indexUser({
  //   user_id: existingAdminUser?.user_id,
  //   username: "admin",
  //   password: ADMIN_PW || "inbox"
  // });

  console.info("Successfully initialized admin user.");
};
