import { WithRequired } from "common";
import { Model } from "../Model";

export class Account extends Model<Account> {
  declare key: string;
  declare updated: Date;
  declare doc_count: number;
  declare unread_doc_count: number;
  declare saved_doc_count: number;

  constructor(init: WithRequired<Partial<Account>, "key" | "updated">) {
    super(init);
    if (!init.key) this.key = "";
    if (!init.updated) this.updated = new Date();
    if (!init.doc_count) this.doc_count = 0;
    if (!init.unread_doc_count) this.unread_doc_count = 0;
    if (!init.saved_doc_count) this.saved_doc_count = 0;
  }
}
