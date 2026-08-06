import { Updater } from "react-query/types/core/utils";
import { queryClient } from "./queryClient";

export class QueryCache<T> {
  constructor(key: string) {
    this.key = key;
  }

  public key: string;

  public get = () => queryClient.getQueryData<T>(this.key);

  public set = (callback: Updater<T | undefined, T | undefined>) => {
    if (!this.get()) return;
    // An optimistic local edit is not a server fetch. Carry the existing
    // dataUpdatedAt forward — left to default it would stamp `now`, dating the
    // data to the edit and telling every freshness consumer the server was
    // just heard from.
    const updatedAt = queryClient.getQueryState(this.key)?.dataUpdatedAt;
    return queryClient.setQueryData<T | undefined>(this.key, callback, {
      updatedAt
    });
  };
}

export const getLocalStorageItem = (key: string) => {
  try {
    const item = window.localStorage.getItem(key);
    return item && JSON.parse(item);
  } catch (e) {
    console.log("LocalStorage error");
    console.log(e);
    return undefined;
  }
};

export const setLocalStorageItem = (key: string, item: unknown) => {
  if (item === undefined) {
    window.localStorage.removeItem(key);
  } else {
    window.localStorage.setItem(key, JSON.stringify(item));
  }
};
