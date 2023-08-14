import { WithRequired } from "common";
import { Model } from "../Model";

@Model.prefillable
export class Account extends Model<Account> {
  key = ""; // account name
  updated = new Date();
  doc_count = 0;
  unread_doc_count = 0;
  saved_doc_count = 0;

  constructor(init: WithRequired<Partial<Account>, "key" | "updated">) {
    super(init);
  }
}
