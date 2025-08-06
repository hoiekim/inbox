import { Client } from "@elastic/elasticsearch";

import {
  AggregateName,
  AggregationsAggregate,
  ClusterHealthRequest,
  DeleteByQueryRequest,
  DeleteRequest,
  GetRequest,
  IndexRequest,
  IndicesCreateRequest,
  IndicesExistsRequest,
  IndicesPutMappingRequest,
  MsearchRequest,
  SearchRequest,
  UpdateByQueryRequest,
  UpdateRequest
} from "@elastic/elasticsearch/lib/api/types";

import { WithOptional, WithRequired } from "common";

import { Document } from "./mappings";
import mappings from "./mappings.json";

const {
  ELASTIC_HOST: node,
  ELASTIC_USERNAME: username,
  ELASTIC_PASSWORD: password,
  ELASTIC_INDEX: indexPrefix
} = process.env;

export const { version } = mappings;
export const index = (indexPrefix || "inbox") + (version ? `-${version}` : "");

const auth = username && password ? { username, password } : undefined;
const client = new Client({ node, auth });

const indexDocument = (r: WithOptional<IndexRequest<Document>, "index">) => {
  return client.index<Document>({ index, ...r });
};

const updateDocument = (
  r: WithOptional<UpdateRequest<WithRequired<Document, "updated">>, "index">
) => {
  return client.update<Document>({ index, ...r });
};

const deleteDocument = (r: WithOptional<DeleteRequest, "index">) => {
  return client.delete({ index, ...r });
};

const searchDocument = <A = Record<AggregateName, AggregationsAggregate>>(
  r: WithOptional<SearchRequest, "index">
) => {
  return client.search<Document, A>({ index, ...r });
};

const multiSearchDocument = <A = Record<AggregateName, AggregationsAggregate>>(
  r: MsearchRequest
) => client.msearch<Document, A>(r);

export const elasticsearchClient = {
  index: indexDocument,
  update: updateDocument,
  updateByQuery: (r: UpdateByQueryRequest) => client.updateByQuery(r),
  delete: deleteDocument,
  deleteByQuery: (r: DeleteByQueryRequest) => client.deleteByQuery(r),
  search: searchDocument,
  msearch: multiSearchDocument,
  count: (r: SearchRequest) => client.count(r),
  get: (r: GetRequest) => client.get<Document>(r),
  cluster: {
    health: (r: ClusterHealthRequest) => client.cluster.health(r)
  },
  indices: {
    exists: (r: IndicesExistsRequest) => client.indices.exists(r),
    create: (r: IndicesCreateRequest) => client.indices.create(r),
    putMapping: (r: IndicesPutMappingRequest) => client.indices.putMapping(r)
  }
};
