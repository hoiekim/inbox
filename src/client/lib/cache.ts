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
