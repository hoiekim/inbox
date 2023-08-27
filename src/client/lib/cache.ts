import { Updater } from "react-query/types/core/utils";
import { queryClient } from "client";

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
  const item = window.localStorage.getItem(key);
  return item && JSON.parse(item);
};

export const setLocalStorageItem = (key: string, item: any) => {
  console.log(key, item);
  window.localStorage.setItem(key, JSON.stringify(item));
};
