import { Model } from "../Model";

export class Insight extends Model<Insight> {
  declare summary: string[];
  declare action_items: string[];
  declare suggested_reply: string;

  constructor(data?: Partial<Insight>) {
    super(data);
    if (!data?.summary) this.summary = [];
    if (!data?.action_items) this.action_items = [];
    if (!data?.suggested_reply) this.suggested_reply = "";
  }
}
