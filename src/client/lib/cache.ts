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
    return queryClient.setQueryData<T | undefined>(this.key, callback);
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

export const setLocalStorageItem = (key: string, item: any) => {
  if (item === undefined) {
    window.localStorage.removeItem(key);
  } else {
    window.localStorage.setItem(key, JSON.stringify(item));
  }
};
